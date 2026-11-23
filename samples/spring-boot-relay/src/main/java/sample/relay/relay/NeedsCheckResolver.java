package sample.relay.relay;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import sample.relay.RelayProperties;
import sample.relay.mailo.MailoClient;
import sample.relay.outbox.OutboxRepository;
import sample.relay.outbox.OutboxStatus;

/**
 * {@code NEEDS_CHECK} 행을 {@code GET /jobs?idempotencyKey=}로 확인한다(ADR-0011 구현 순서 1.1·1.5).
 *
 * <ul>
 *   <li>종결 상태(SENT, FAILED, EXPIRED)면 그 상태로 닫는다.
 *   <li>비종결 상태면 등록됨(DELIVERED)으로 되돌린다. 이후 종결 이벤트를 기다린다.
 *   <li>모르는 상태나 404면 확인 필요로 남긴다. 운영자가 정한다(404는 보존 기간 30일이 지난 경우를 포함한다).
 *   <li>HTTP 호출은 트랜잭션 밖이다. 반영 SQL이 NEEDS_CHECK 조건을 걸어 같은 결과를 반복해도 안전하다.
 * </ul>
 */
@Component
public class NeedsCheckResolver {

    private static final Logger log = LoggerFactory.getLogger(NeedsCheckResolver.class);

    private final MailoClient client;
    private final OutboxRepository outbox;
    private final int batchSize;

    public NeedsCheckResolver(MailoClient client, OutboxRepository outbox, RelayProperties props) {
        this.client = client;
        this.outbox = outbox;
        this.batchSize = props.retry().batchSize();
    }

    /** 스케줄러가 부른다. 한 번에 최대 batchSize건을 확인한다. */
    public void resolve() {
        try {
            for (UUID id : outbox.findNeedsCheck(batchSize)) {
                if (!resolveOne(id)) {
                    break;
                }
            }
        } catch (IOException e) {
            log.warn("needs_check_failed error=io");
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        } catch (RuntimeException e) {
            log.error("needs_check_failed error={}", e.getClass().getSimpleName());
        }
    }

    /** 다음 행을 계속 확인해도 되면 true. 401과 5xx는 같은 원인이 다음 행에도 있으므로 false다. */
    private boolean resolveOne(UUID id) throws IOException, InterruptedException {
        MailoClient.Response response = client.getJobByKey(id);
        int http = response.status();
        if (http == 200 && response.body() != null) {
            applyJob(id, response.body());
            return true;
        }
        if (http == 404) {
            outbox.touchNeedsCheck(id);
            log.warn("needs_check_not_found outbox_id={} action=operator_decision", id);
            return true;
        }
        if (http == 401) {
            log.error("needs_check_failed http=401 action=fix_api_key");
            return false;
        }
        log.warn("needs_check_failed outbox_id={} http={}", id, http);
        return http != 429 && http < 500;
    }

    private void applyJob(UUID id, JsonNode job) {
        String jobStatus = job.path("status").asText(null);
        String next = jobStatus == null ? OutboxStatus.NEEDS_CHECK : JobStatusMapping.toOutboxStatus(jobStatus);
        if (OutboxStatus.NEEDS_CHECK.equals(next)) {
            outbox.touchNeedsCheck(id);
            // 서버가 보낸 값은 로그에 넣기 전에 대문자와 밑줄만 남긴다.
            log.warn("needs_check_unresolved outbox_id={} job_status={}", id, jobStatus == null ? "" : jobStatus.replaceAll("[^A-Z_]", ""));
            return;
        }
        String reason = switch (next) {
            case OutboxStatus.FAILED -> job.path("failureReason").asText("UNKNOWN").replaceAll("[^A-Z_]", "");
            case OutboxStatus.EXPIRED -> "EXPIRED";
            default -> null;
        };
        outbox.applyCheckResult(id, next, reason);
        if (OutboxStatus.FAILED.equals(next) || OutboxStatus.EXPIRED.equals(next)) {
            log.error("needs_check_resolved outbox_id={} status={} reason={}", id, next, reason);
        } else {
            log.info("needs_check_resolved outbox_id={} status={}", id, next);
        }
    }
}
