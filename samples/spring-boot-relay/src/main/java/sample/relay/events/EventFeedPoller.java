package sample.relay.events;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.time.OffsetDateTime;
import java.time.format.DateTimeParseException;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import sample.relay.RelayProperties;
import sample.relay.mailo.MailoClient;
import sample.relay.outbox.OutboxRepository;
import sample.relay.outbox.OutboxStatus;
import sample.relay.relay.JobStatusMapping;

/**
 * 이벤트 피드({@code GET /events}) 소비(RQ-017, ADR-0006).
 *
 * <ul>
 *   <li>cursor는 해석하지 않고 DB에 저장한다. 이벤트 처리와 cursor 저장은 한 트랜잭션이다.
 *   <li>같은 이벤트가 다시 와도 결과가 같다. 기록은 event_id로, outbox 전이는 상태 조건으로 멱등하다.
 *   <li>type 필터를 쓰지 않는다. 모든 종류를 받아 cursor를 하나만 둔다.
 *   <li>모르는 이벤트 종류는 경고만 하고 넘기지 않는다. 기록하고 해당 행을 {@code NEEDS_CHECK}로 둔다(ADR-0011 구현 순서 1.2).
 *   <li>{@code JOB_CANCELED}는 취소 종결이다. {@code canceledBy}를 사유로 남긴다(RQ-040, ADR-0011 구현 순서 1.7).
 *   <li>공백 신호(헤더 {@code Mailo-Cursor-Gap} 또는 410)를 받으면 등록됨 행을 {@code NEEDS_CHECK}로 둔다(ADR-0011 결정 9).
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

    /**
     * 한 페이지를 읽고 반영한다. 이어서 읽어도 되면(hasMore) true다.
     * 200이 아닌 응답은 예외로 던지지 않고 상태 코드를 남긴 채 멈춘다. cursor는 바꾸지 않으므로 다음 주기에 같은 곳부터 읽는다.
     */
    boolean pollOnce() throws IOException, InterruptedException {
        String cursor = events.loadCursor().orElse(null);
        MailoClient.Response response = client.getEvents(cursor, limit);
        if (response.status() == 410) {
            // 이 샘플은 onGap=error를 보내지 않아 지금 서버에서는 오지 않는다. 받으면 cursor를 버리고 남은 이벤트부터 다시 읽는다.
            tx.executeWithoutResult(status -> {
                events.deleteCursor();
                outbox.markDeliveredNeedsCheck("EVENT_GAP");
            });
            log.warn("event_cursor_expired action=reset_cursor_and_check");
            return false;
        }
        if (response.status() != 200 || response.body() == null) {
            logFailure(response.status());
            return false;
        }
        JsonNode page = response.body();
        tx.executeWithoutResult(status -> {
            for (JsonNode event : page.path("events")) {
                apply(event);
            }
            if (response.cursorGap()) {
                // 놓친 이벤트가 어느 행의 것인지 모른다. 종결되지 않은 등록됨 행을 GET /jobs로 확인한다.
                outbox.markDeliveredNeedsCheck("EVENT_GAP");
            }
            JsonNode next = page.path("nextCursor");
            if (next.isTextual()) {
                events.saveCursor(next.asText());
            }
        });
        if (response.cursorGap()) {
            log.warn("event_cursor_gap action=check_delivered_jobs");
        }
        return page.path("hasMore").asBoolean(false);
    }

    private static void logFailure(int status) {
        if (status == 401) {
            log.error("event_poll_failed http=401 action=fix_api_key");
        } else if (status == 429 || status >= 500) {
            log.warn("event_poll_failed http={} action=retry_next_poll", status);
        } else {
            // 모르는 4xx다. 같은 요청을 반복해도 풀리지 않으므로 호출처 코드나 계약을 확인한다.
            log.error("event_poll_failed http={} action=check_contract", status);
        }
    }

    private void apply(JsonNode event) {
        String type = event.path("type").asText();
        String eventId = event.path("eventId").asText();
        OffsetDateTime occurredAt = occurredAt(event);
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
            case "JOB_CANCELED" -> {
                // 호출처가 직접 취소해도 온다. outbox를 이벤트로 닫는 이 샘플은 취소를 종결로 처리한다(실패가 아니다).
                String reason = JobStatusMapping.canceledReason(event.path("canceledBy").asText(null));
                transition(outboxId, OutboxStatus.CANCELED, reason);
                record(eventId, type, outboxId, reason, event, occurredAt);
            }
            case "INTAKE_REJECTED" -> {
                String reason = event.path("reasonCode").asText("UNKNOWN");
                // 같은 Key에 다른 내용을 보낸 파일이다. 이미 등록된 작업을 건드리지 않고 격리 신호만 남긴다.
                transition(outboxId,
                        "FINGERPRINT_MISMATCH".equals(reason) ? OutboxStatus.QUARANTINED : OutboxStatus.REJECTED,
                        reason);
                record(eventId, type, outboxId, reason, event, occurredAt);
            }
            default -> {
                // 모르는 종류를 건너뛰고 cursor를 넘기면 그 이벤트를 다시 알 방법이 없다. 기록하고 행을 확인 필요로 둔다.
                // 서버가 보낸 이름은 로그와 기록에 넣기 전에 대문자와 밑줄만 남긴다.
                String safeType = type.replaceAll("[^A-Z_]", "");
                if (outboxId != null) {
                    outbox.markNeedsCheck(outboxId, "UNKNOWN_EVENT_TYPE");
                }
                record(eventId, safeType, outboxId, "UNKNOWN_EVENT_TYPE", event, occurredAt);
            }
        }
    }

    /** occurredAt을 읽는다. 형식이 틀려도 페이지 전체가 반복 실패하지 않게 현재 시각으로 대신한다. */
    private static OffsetDateTime occurredAt(JsonNode event) {
        try {
            return OffsetDateTime.parse(event.path("occurredAt").asText());
        } catch (DateTimeParseException e) {
            return OffsetDateTime.now();
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
