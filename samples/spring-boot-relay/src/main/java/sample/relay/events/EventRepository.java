package sample.relay.events;

import java.time.OffsetDateTime;
import java.util.Optional;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Repository;

@Repository
class EventRepository {

    static final String CURSOR_NAME = "mailo-events";

    private final JdbcClient jdbc;

    EventRepository(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    Optional<String> loadCursor() {
        return jdbc.sql("SELECT cursor FROM mailo_event_cursor WHERE name = :name")
                .param("name", CURSOR_NAME)
                .query(String.class)
                .optional();
    }

    /** cursor는 불투명 문자열이다. 해석하지 않고 그대로 저장한다. */
    void saveCursor(String cursor) {
        jdbc.sql("""
                        INSERT INTO mailo_event_cursor (name, cursor) VALUES (:name, :cursor)
                        ON CONFLICT (name) DO UPDATE SET cursor = EXCLUDED.cursor
                        """)
                .param("name", CURSOR_NAME)
                .param("cursor", cursor)
                .update();
    }

    /** cursor를 지운다. 다음 폴링은 `after` 없이 남아 있는 이벤트부터 읽는다. 이벤트 처리는 멱등이다. */
    void deleteCursor() {
        jdbc.sql("DELETE FROM mailo_event_cursor WHERE name = :name")
                .param("name", CURSOR_NAME)
                .update();
    }

    /** event_id로 멱등하게 기록한다. 이미 있으면 false다. payload는 이벤트 JSON 그대로이고 본문은 들어 있지 않다. */
    boolean insertLog(String eventId, String type, UUID outboxId, String reason, String payloadJson,
            OffsetDateTime occurredAt) {
        return jdbc.sql("""
                        INSERT INTO mailo_event_log (event_id, type, outbox_id, reason, payload, occurred_at)
                        VALUES (:eventId, :type, :outboxId, :reason, CAST(:payload AS jsonb), :occurredAt)
                        ON CONFLICT (event_id) DO NOTHING
                        """)
                .param("eventId", eventId)
                .param("type", type)
                .param("outboxId", outboxId)
                .param("reason", reason)
                .param("payload", payloadJson)
                .param("occurredAt", occurredAt)
                .update() == 1;
    }
}
