package sample.relay.relay;

import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.atomic.AtomicBoolean;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import sample.relay.RelayProperties;
import sample.relay.outbox.OutboxRepository;
import sample.relay.outbox.OutboxRow;
import sample.relay.outbox.OutboxStatus;

/**
 * outbox relay. 행 하나마다 짧은 트랜잭션을 열어 {@code FOR UPDATE SKIP LOCKED}로 잠그고 전송한 뒤 결과를 쓴다.
 *
 * <p>전송 중에는 행 잠금이 유지된다(요청 타임아웃이 상한이다). relay가 전송 뒤 결과를 쓰기 전에 죽으면 행은
 * PENDING으로 남고, 같은 Key로 다시 보내면 Mailo가 200으로 중복 등록을 막는다.
 */
@Component
public class RelayWorker {

    private static final Logger log = LoggerFactory.getLogger(RelayWorker.class);

    private final OutboxRepository outbox;
    private final RequestTransport transport;
    private final TransactionTemplate tx;
    private final RelayProperties.Retry retry;
    private final AtomicBoolean authBlocked = new AtomicBoolean(false);

    public RelayWorker(OutboxRepository outbox, RequestTransport transport, TransactionTemplate tx, RelayProperties props) {
        this.outbox = outbox;
        this.transport = transport;
        this.tx = tx;
        this.retry = props.retry();
    }

    /** 스케줄러가 주기적으로 부른다. 한 번에 최대 batchSize건을 처리한다. */
    public void tick() {
        try {
            for (int i = 0; i < retry.batchSize() && !authBlocked.get(); i++) {
                if (!Boolean.TRUE.equals(tx.execute(status -> processOne()))) {
                    break;
                }
            }
        } catch (RuntimeException e) {
            // DB 오류 등. 다음 주기에 다시 시도한다. 메시지에 값이 섞일 수 있어 예외 이름만 남긴다.
            log.error("relay_tick_failed error={}", e.getClass().getSimpleName());
        }
    }

    /** 처리할 행이 있었으면 true. 트랜잭션 안에서 부른다. */
    boolean processOne() {
        OutboxRow row = outbox.lockNextDue(retry.maxAge().toSeconds()).orElse(null);
        if (row == null) {
            return false;
        }
        if (row.expired()) {
            outbox.markDead(row.id());
            log.error("relay_dead outbox_id={} reason=retry_window_exceeded", row.id());
            return true;
        }

        Delivery d;
        try {
            d = transport.send(row.id(), row.requestJson());
        } catch (RuntimeException e) {
            d = Delivery.retry(null, "INTERNAL_" + e.getClass().getSimpleName());
        }

        switch (d.kind()) {
            case DONE -> {
                outbox.markAttempt(row.id(), statusAfterRegistered(d.jobStatus()), d.httpStatus(), null);
                log.info("relay_done outbox_id={} http={} job_status={}", row.id(), d.httpStatus(), d.jobStatus());
            }
            case RETRY -> {
                int failures = row.attemptCount() + 1;
                double delay = Backoff.delaySeconds(failures, retry, ThreadLocalRandom.current().nextDouble());
                outbox.scheduleRetry(row.id(), delay, d.httpStatus(), d.reason());
                log.warn("relay_retry outbox_id={} http={} reason={} attempt={} delay_s={}",
                        row.id(), d.httpStatus(), d.reason(), failures, Math.round(delay));
            }
            case QUARANTINE -> {
                outbox.markAttempt(row.id(), OutboxStatus.QUARANTINED, d.httpStatus(), d.reason());
                log.error("relay_quarantined outbox_id={} http={} reason={}", row.id(), d.httpStatus(), d.reason());
            }
            case REJECT -> {
                outbox.markAttempt(row.id(), OutboxStatus.REJECTED, d.httpStatus(), d.reason());
                log.error("relay_rejected outbox_id={} http={} reason={}", row.id(), d.httpStatus(), d.reason());
            }
            case AUTH_FAILED -> {
                outbox.markAttempt(row.id(), OutboxStatus.REJECTED, d.httpStatus(), d.reason());
                authBlocked.set(true);
                log.error("relay_stopped outbox_id={} http=401 action=fix_api_key_and_restart", row.id());
            }
        }
        return true;
    }

    /**
     * 200 응답은 같은 Key의 기존 작업과 현재 상태를 돌려준다. 이벤트를 이미 소비한 뒤 재전송한 행이 DELIVERED로
     * 남지 않게 종결 상태를 그대로 반영한다.
     */
    private static String statusAfterRegistered(String jobStatus) {
        if (jobStatus == null) {
            return OutboxStatus.DELIVERED;
        }
        return switch (jobStatus) {
            case "SENT" -> OutboxStatus.SENT;
            case "FAILED" -> OutboxStatus.FAILED;
            case "EXPIRED" -> OutboxStatus.EXPIRED;
            default -> OutboxStatus.DELIVERED;
        };
    }
}
