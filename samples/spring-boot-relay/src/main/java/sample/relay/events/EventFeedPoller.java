package sample.relay.events;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.time.OffsetDateTime;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import sample.relay.RelayProperties;
import sample.relay.mailo.MailoClient;
import sample.relay.outbox.OutboxRepository;
import sample.relay.outbox.OutboxStatus;

/**
 * 이벤트 피드({@code GET /events}) 소비(RQ-017, ADR-0006).
 *
 * <ul>
 *   <li>cursor는 해석하지 않고 DB에 저장한다. 이벤트 처리와 cursor 저장은 한 트랜잭션이다.
 *   <li>같은 이벤트가 다시 와도 결과가 같다. 기록은 event_id로, outbox 전이는 상태 조건으로 멱등하다.
 *   <li>type 필터를 쓰지 않는다. 모든 종류를 받아 cursor를 하나만 둔다.
 * </ul>
 */
@Component
public class EventFeedPoller {

    private static final Logger log = LoggerFactory.getLogger(EventFeedPoller.class);

    private final MailoClient client;
    private final EventRepository events;
    private final OutboxRepository outbox;
    private final TransactionTemplate tx;
    private final int limit;

    public EventFeedPoller(MailoClient client, EventRepository events, OutboxRepository outbox,
            TransactionTemplate tx, RelayProperties props) {
        this.client = client;
        this.events = events;
        this.outbox = outbox;
        this.tx = tx;
        this.limit = props.events().limit();
    }

    /** 스케줄러가 부른다. hasMore가 true인 동안 바로 이어서 읽는다. */
    public void poll() {
        try {
            boolean more;
            do {
                more = pollOnce();
            } while (more);
        } catch (IOException e) {
            log.warn("event_poll_failed error=io");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            log.error("event_poll_failed error={}", e.getClass().getSimpleName());
        }
    }

    /** 한 페이지를 읽고 반영한다. hasMore를 돌려준다. */
    boolean pollOnce() throws IOException, InterruptedException {
        String cursor = events.loadCursor().orElse(null);
        JsonNode page = client.getEvents(cursor, limit);
        tx.executeWithoutResult(status -> {
            for (JsonNode event : page.path("events")) {
                apply(event);
            }
            JsonNode next = page.path("nextCursor");
            if (next.isTextual()) {
                events.saveCursor(next.asText());
            }
        });
        return page.path("hasMore").asBoolean(false);
    }

    private void apply(JsonNode event) {
        String type = event.path("type").asText();
        String eventId = event.path("eventId").asText();
        OffsetDateTime occurredAt = OffsetDateTime.parse(event.path("occurredAt").asText());
        UUID outboxId = outboxIdOf(event);

        switch (type) {
            case "JOB_SENT" -> {
                transition(outboxId, OutboxStatus.SENT, null);
                // 일부 수신자가 거부된 SENT는 기록해 두고 알림 여부는 사용처가 정한다.
                if (event.path("rejectedRecipients").size() > 0) {
                    record(eventId, type, outboxId, "REJECTED_RECIPIENTS", event, occurredAt);
                }
            }
            case "JOB_FAILED" -> {
                String reason = event.path("failureReason").asText("UNKNOWN");
                transition(outboxId, OutboxStatus.FAILED, reason);
                record(eventId, type, outboxId, reason, event, occurredAt);
            }
            case "JOB_EXPIRED" -> {
                transition(outboxId, OutboxStatus.EXPIRED, "EXPIRED");
                record(eventId, type, outboxId, "EXPIRED", event, occurredAt);
            }
            case "INTAKE_REJECTED" -> {
                String reason = event.path("reasonCode").asText("UNKNOWN");
                // 같은 Key에 다른 내용을 보낸 파일이다. 이미 등록된 작업을 건드리지 않고 격리 신호만 남긴다.
                transition(outboxId,
                        "FINGERPRINT_MISMATCH".equals(reason) ? OutboxStatus.QUARANTINED : OutboxStatus.REJECTED,
                        reason);
                record(eventId, type, outboxId, reason, event, occurredAt);
            }
            default -> log.warn("event_unknown_type type={}", type.replaceAll("[^A-Z_]", ""));
        }
    }

    private void transition(UUID outboxId, String status, String reason) {
        if (outboxId == null) {
            return; // Key나 파일 이름이 UUID가 아니다. 이 사용처의 outbox 행이 아니다.
        }
        outbox.applyFeedResult(outboxId, status, reason);
    }

    private void record(String eventId, String type, UUID outboxId, String reason, JsonNode event,
            OffsetDateTime occurredAt) {
        boolean first = events.insertLog(eventId, type, outboxId, reason, event.toString(), occurredAt);
        if (first) {
            log.error("mailo_event type={} event_id={} outbox_id={} reason={}", type, eventId, outboxId, reason);
        }
    }

    /** idempotencyKey가 outbox 행 ID다. INTAKE_REJECTED는 Key가 null일 수 있어 파일 이름(<id>.json)으로 찾는다. */
    public static UUID outboxIdOf(JsonNode event) {
        String key = event.path("idempotencyKey").asText(null);
        if (key == null || key.isEmpty()) {
            String fileName = event.path("fileName").asText("");
            key = fileName.endsWith(".json") ? fileName.substring(0, fileName.length() - ".json".length()) : null;
        }
        try {
            return key == null ? null : UUID.fromString(key);
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
