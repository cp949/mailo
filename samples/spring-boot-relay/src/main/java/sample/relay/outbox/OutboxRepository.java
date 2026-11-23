package sample.relay.outbox;

import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

/** mail_outbox 접근. 시각 비교와 기록은 DB now()만 쓴다(애플리케이션 시계에 의존하지 않는다). */
@Repository
public class OutboxRepository {

    private final JdbcClient jdbc;

    public OutboxRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** 비즈니스 트랜잭션 안에서 부른다. 같은 트랜잭션에 참여해야 하므로 호출자가 @Transactional이어야 한다. */
    public void insert(UUID id, String requestJson) {
        jdbc.sql("INSERT INTO mail_outbox (id, request_json) VALUES (:id, :json)")
                .param("id", id)
                .param("json", requestJson)
                .update();
    }

    /**
     * 전송 시각이 된 PENDING 행 하나를 잠가서 읽는다. 다른 relay 인스턴스가 잠근 행은 건너뛴다.
     * 잠금은 호출자의 트랜잭션이 끝날 때까지 유지된다.
     */
    public Optional<OutboxRow> lockNextDue(long maxAgeSeconds) {
        return jdbc.sql("""
                        SELECT id, request_json, attempt_count,
                               (now() - created_at) > make_interval(secs => :maxAge) AS expired
                          FROM mail_outbox
                         WHERE status = 'PENDING' AND next_attempt_at <= now()
                         ORDER BY next_attempt_at
                         LIMIT 1
                           FOR UPDATE SKIP LOCKED
                        """)
                .param("maxAge", (double) maxAgeSeconds)
                .query((rs, n) -> new OutboxRow(
                        rs.getObject("id", UUID.class),
                        rs.getString("request_json"),
                        rs.getInt("attempt_count"),
                        rs.getBoolean("expired")))
                .optional();
    }

    /** 시도 한 번의 결과로 상태를 바꾼다. 시도 횟수를 1 올린다. */
    public void markAttempt(UUID id, String status, Integer httpStatus, String error) {
        jdbc.sql("""
                        UPDATE mail_outbox
                           SET status = :status, attempt_count = attempt_count + 1,
                               last_http_status = :http, last_error = :error, updated_at = now()
                         WHERE id = :id
                        """)
                .param("id", id)
                .param("status", status)
                .param("http", httpStatus)
                .param("error", error)
                .update();
    }

    /** 재시도 예약. 상태는 PENDING으로 두고 다음 시도 시각만 미룬다. */
    public void scheduleRetry(UUID id, double delaySeconds, Integer httpStatus, String error) {
        jdbc.sql("""
                        UPDATE mail_outbox
                           SET attempt_count = attempt_count + 1,
                               next_attempt_at = now() + make_interval(secs => :delay),
                               last_http_status = :http, last_error = :error, updated_at = now()
                         WHERE id = :id
                        """)
                .param("id", id)
                .param("delay", delaySeconds)
                .param("http", httpStatus)
                .param("error", error)
                .update();
    }

    /** 최대 재시도 기간을 넘긴 행을 DEAD로 종결한다. 시도 횟수는 올리지 않는다. */
    public void markDead(UUID id) {
        jdbc.sql("""
                        UPDATE mail_outbox
                           SET status = 'DEAD', last_error = 'RETRY_WINDOW_EXCEEDED', updated_at = now()
                         WHERE id = :id
                        """)
                .param("id", id)
                .update();
    }

    /**
     * 이벤트 피드가 알려 준 결과를 반영한다. 아직 등록·전송 대기 중인 행만 바꾸므로 같은 이벤트가
     * 다시 와도 결과가 같다(멱등). 바뀐 행 수를 돌려준다.
     */
    public int applyFeedResult(UUID id, String status, String reason) {
        return jdbc.sql("""
                        UPDATE mail_outbox
                           SET status = :status, last_error = :reason, updated_at = now()
                         WHERE id = :id AND status IN ('PENDING', 'DELIVERED')
                        """)
                .param("id", id)
                .param("status", status)
                .param("reason", reason)
                .update();
    }
}
