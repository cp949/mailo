package sample.relay;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import sample.relay.outbox.OutboxRepository;

/** DB 없이 outbox 호출을 기록하는 대역. 상태 전이 SQL의 조건은 이 대역으로 확인하지 않는다. */
public class FakeOutbox extends OutboxRepository {

    public record Call(String method, UUID id, String status, String reason) {}

    public final List<Call> calls = new ArrayList<>();
    public List<UUID> needsCheck = new ArrayList<>();

    public FakeOutbox() {
        super(null);
    }

    @Override
    public int applyFeedResult(UUID id, String status, String reason) {
        calls.add(new Call("applyFeedResult", id, status, reason));
        return 1;
    }

    @Override
    public int markNeedsCheck(UUID id, String reason) {
        calls.add(new Call("markNeedsCheck", id, null, reason));
        return 1;
    }

    @Override
    public int markDeliveredNeedsCheck(String reason) {
        calls.add(new Call("markDeliveredNeedsCheck", null, null, reason));
        return 0;
    }

    @Override
    public List<UUID> findNeedsCheck(int limit) {
        return needsCheck;
    }

    @Override
    public int applyCheckResult(UUID id, String status, String reason) {
        calls.add(new Call("applyCheckResult", id, status, reason));
        return 1;
    }

    @Override
    public int touchNeedsCheck(UUID id) {
        calls.add(new Call("touchNeedsCheck", id, null, null));
        return 1;
    }

    public List<String> methods() {
        return calls.stream().map(Call::method).toList();
    }
}
