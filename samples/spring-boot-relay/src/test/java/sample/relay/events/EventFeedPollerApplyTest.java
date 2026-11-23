package sample.relay.events;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.TransactionStatus;
import org.springframework.transaction.support.SimpleTransactionStatus;
import org.springframework.transaction.support.TransactionTemplate;
import sample.relay.FakeMailoClient;
import sample.relay.FakeOutbox;
import sample.relay.TestProps;
import sample.relay.outbox.OutboxStatus;

import static sample.relay.FakeMailoClient.response;

/**
 * 이벤트 피드 소비의 "모르는 값" 처리(ADR-0011 구현 순서 1.2·1.4·1.7, docs/api/README.md).
 * DB와 Mailo 없이 대역으로 확인한다. 상태 전이 SQL의 조건은 실행 검증(verify/run-e2e.sh)이 맡는다.
 */
class EventFeedPollerApplyTest {

    private static final UUID ID = UUID.fromString("7c9e6679-7425-40de-944b-e07fc1f90ae7");

    private FakeMailoClient client;
    private FakeEventRepository events;
    private FakeOutbox outbox;
    private EventFeedPoller poller;

    @BeforeEach
    void setUp() {
        client = new FakeMailoClient();
        events = new FakeEventRepository();
        outbox = new FakeOutbox();
        poller = new EventFeedPoller(client, events, outbox, new TransactionTemplate(new NoopTx()), TestProps.create());
    }

    private static String event(String type, String eventId, String key) {
        return "{\"eventId\":\"" + eventId + "\",\"type\":\"" + type + "\",\"occurredAt\":\"2026-11-24T00:00:00Z\","
                + "\"idempotencyKey\":" + (key == null ? "null" : "\"" + key + "\"") + "}";
    }

    private static String page(String eventsJson, String nextCursor, boolean hasMore) {
        return "{\"events\":[" + eventsJson + "],\"nextCursor\":\"" + nextCursor + "\",\"hasMore\":" + hasMore + "}";
    }

    @Test
    void 모르는_이벤트_종류는_해당_행을_확인_필요로_두고_기록한다() throws Exception {
        client.eventResponses.add(response(200, page(event("JOB_PAUSED", "e1", ID.toString()), "c1", false)));

        boolean more = poller.pollOnce();

        assertFalse(more);
        assertEquals(List.of("markNeedsCheck"), outbox.methods());
        assertEquals(ID, outbox.calls.get(0).id());
        assertEquals("UNKNOWN_EVENT_TYPE", outbox.calls.get(0).reason());
        assertEquals(1, events.logged.size());
        assertEquals("JOB_PAUSED", events.logged.get(0).type());
        assertEquals("c1", events.cursor);
    }

    @Test
    void 모르는_이벤트_종류의_Key가_이_사용처_행이_아니면_상태를_바꾸지_않고_기록만_한다() throws Exception {
        client.eventResponses.add(response(200, page(event("JOB_PAUSED", "e1", "outbox-8841"), "c1", false)));

        poller.pollOnce();

        assertTrue(outbox.calls.isEmpty());
        assertEquals(1, events.logged.size());
        assertNull(events.logged.get(0).outboxId());
        assertEquals("c1", events.cursor);
    }

    @Test
    void 모르는_이벤트_종류의_이름은_기록_전에_걸러낸다() throws Exception {
        client.eventResponses.add(response(200, page(event("job-canceled!<x>", "e1", ID.toString()), "c1", false)));

        poller.pollOnce();

        assertEquals("", events.logged.get(0).type());
    }

    @Test
    void JOB_CANCELED는_취소_종결로_반영하고_취소_주체를_사유로_기록한다() throws Exception {
        client.eventResponses.add(response(200, page(
                event("JOB_CANCELED", "e1", ID.toString()).replace("}", ",\"canceledBy\":\"OPERATOR\"}"), "c1", false)));

        poller.pollOnce();

        assertEquals(List.of("applyFeedResult"), outbox.methods());
        assertEquals(OutboxStatus.CANCELED, outbox.calls.get(0).status());
        assertEquals("CANCELED_BY_OPERATOR", outbox.calls.get(0).reason());
        // 모르는 이벤트 종류가 아니므로 확인 필요로 바꾸지 않는다.
        assertEquals("JOB_CANCELED", events.logged.get(0).type());
        assertEquals("CANCELED_BY_OPERATOR", events.logged.get(0).reason());
        assertEquals("c1", events.cursor);
    }

    @Test
    void JOB_CANCELED의_canceledBy가_없거나_모르는_값이면_취소_사유만_남긴다() throws Exception {
        client.eventResponses.add(response(200, page(event("JOB_CANCELED", "e1", ID.toString()), "c1", false)));
        client.eventResponses.add(response(200, page(
                event("JOB_CANCELED", "e2", ID.toString()).replace("}", ",\"canceledBy\":\"x-1\"}"), "c2", false)));

        poller.pollOnce();
        poller.pollOnce();

        assertEquals("CANCELED", outbox.calls.get(0).reason());
        // 서버가 보낸 값은 대문자와 밑줄만 남긴다. 걸러내고 남는 것이 없으면 취소 사유만 둔다.
        assertEquals("CANCELED", outbox.calls.get(1).reason());
    }

    @Test
    void 모르는_응답_필드_outcomeUncertain은_무시하고_실패_종결은_종전처럼_반영한다() throws Exception {
        // RQ-048: 서버가 JOB_FAILED·JOB_EXPIRED에 더한 필드다. 샘플은 상태 해석에 쓰지 않는다.
        client.eventResponses.add(response(200, page(
                event("JOB_FAILED", "e1", ID.toString())
                        .replace("}", ",\"failureReason\":\"MAX_ATTEMPTS_EXCEEDED\",\"outcomeUncertain\":true}"),
                "c1", false)));

        poller.pollOnce();

        assertEquals(List.of("applyFeedResult"), outbox.methods());
        assertEquals(OutboxStatus.FAILED, outbox.calls.get(0).status());
        assertEquals("MAX_ATTEMPTS_EXCEEDED", outbox.calls.get(0).reason());
        // 모르는 이벤트 종류가 아니므로 확인 필요로 바꾸지 않는다.
        assertEquals("JOB_FAILED", events.logged.get(0).type());
        assertEquals("c1", events.cursor);
    }

    @Test
    void 알려진_종결_이벤트는_종전처럼_반영한다() throws Exception {
        client.eventResponses.add(response(200, page(event("JOB_SENT", "e1", ID.toString()), "c1", false)));

        poller.pollOnce();

        assertEquals(List.of("applyFeedResult"), outbox.methods());
        assertEquals(OutboxStatus.SENT, outbox.calls.get(0).status());
    }

    @Test
    void 공백_헤더가_있으면_이벤트를_처리하고_등록됨_행을_확인_필요로_바꾼다() throws Exception {
        client.eventResponses.add(response(200, page(event("JOB_SENT", "e1", ID.toString()), "c1", false), true));

        poller.pollOnce();

        assertEquals(List.of("applyFeedResult", "markDeliveredNeedsCheck"), outbox.methods());
        assertEquals("EVENT_GAP", outbox.calls.get(1).reason());
        assertEquals("c1", events.cursor);
    }

    @Test
    void 공백_헤더가_없으면_등록됨_행을_건드리지_않는다() throws Exception {
        client.eventResponses.add(response(200, page("", "c1", false)));

        poller.pollOnce();

        assertTrue(outbox.calls.isEmpty());
    }

    @Test
    void 이벤트가_410이면_cursor를_지우고_등록됨_행을_확인_필요로_바꾼다() throws Exception {
        events.cursor = "old";
        client.eventResponses.add(response(410, "{\"type\":\"urn:mailo:problem:cursor-expired\"}"));

        boolean more = poller.pollOnce();

        assertFalse(more);
        assertNull(events.cursor);
        assertEquals(1, events.cursorDeletes);
        assertEquals(List.of("markDeliveredNeedsCheck"), outbox.methods());
    }

    @Test
    void 이벤트가_200이_아니면_cursor를_바꾸지_않고_예외_없이_멈춘다() throws Exception {
        events.cursor = "old";
        for (int status : new int[] {401, 404, 503}) {
            client.eventResponses.add(response(status, null));

            assertFalse(poller.pollOnce(), "status=" + status);
        }

        assertEquals("old", events.cursor);
        assertTrue(outbox.calls.isEmpty());
    }

    @Test
    void 이벤트_본문이_JSON이_아니어도_다음_주기에_다시_읽는다() throws Exception {
        events.cursor = "old";
        client.eventResponses.add(response(200, null));

        assertFalse(poller.pollOnce());

        assertEquals("old", events.cursor);
    }

    /** 트랜잭션 경계만 흉내 낸다. */
    private static final class NoopTx implements PlatformTransactionManager {
        @Override
        public TransactionStatus getTransaction(TransactionDefinition definition) {
            return new SimpleTransactionStatus();
        }

        @Override
        public void commit(TransactionStatus status) {}

        @Override
        public void rollback(TransactionStatus status) {}
    }
}
