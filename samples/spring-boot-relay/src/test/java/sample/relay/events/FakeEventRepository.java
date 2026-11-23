package sample.relay.events;

import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** DB 없이 cursor와 이벤트 기록을 메모리에 두는 대역. */
class FakeEventRepository extends EventRepository {

    record Logged(String eventId, String type, UUID outboxId, String reason) {}

    String cursor;
    final List<Logged> logged = new ArrayList<>();
    int cursorDeletes;

    FakeEventRepository() {
        super(null);
    }

    @Override
    Optional<String> loadCursor() {
        return Optional.ofNullable(cursor);
    }

    @Override
    void saveCursor(String cursor) {
        this.cursor = cursor;
    }

    @Override
    void deleteCursor() {
        cursor = null;
        cursorDeletes++;
    }

    @Override
    boolean insertLog(String eventId, String type, UUID outboxId, String reason, String payloadJson,
            OffsetDateTime occurredAt) {
        boolean first = logged.stream().noneMatch(l -> l.eventId().equals(eventId));
        if (first) {
            logged.add(new Logged(eventId, type, outboxId, reason));
        }
        return first;
    }
}
