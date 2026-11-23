package sample.relay.relay;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static sample.relay.FakeMailoClient.response;

import java.io.IOException;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import sample.relay.FakeMailoClient;
import sample.relay.FakeOutbox;
import sample.relay.TestProps;
import sample.relay.outbox.OutboxStatus;

/** 확인 필요 행을 GET /jobs로 확인하는 절차(ADR-0011 구현 순서 1.1·1.5). DB와 Mailo 없이 대역으로 확인한다. */
class NeedsCheckResolverTest {

    private static final UUID ID = UUID.fromString("7c9e6679-7425-40de-944b-e07fc1f90ae7");
    private static final UUID ID2 = UUID.fromString("0f8fad5b-d9cb-469f-a165-70867728950e");

    private FakeMailoClient client;
    private FakeOutbox outbox;
    private NeedsCheckResolver resolver;

    @BeforeEach
    void setUp() {
        client = new FakeMailoClient();
        outbox = new FakeOutbox();
        outbox.needsCheck = List.of(ID);
        resolver = new NeedsCheckResolver(client, outbox, TestProps.create());
    }

    @Test
    void 조회_결과가_종결이면_그_상태로_닫는다() {
        client.jobResponses.add(response(200, "{\"status\":\"SENT\"}"));

        resolver.resolve();

        assertEquals(List.of(ID), client.jobKeys);
        assertEquals(List.of("applyCheckResult"), outbox.methods());
        assertEquals(OutboxStatus.SENT, outbox.calls.get(0).status());
    }

    @Test
    void 실패면_failureReason을_사유로_남긴다() {
        client.jobResponses.add(response(200, "{\"status\":\"FAILED\",\"failureReason\":\"PERMANENT_ERROR\"}"));

        resolver.resolve();

        assertEquals(OutboxStatus.FAILED, outbox.calls.get(0).status());
        assertEquals("PERMANENT_ERROR", outbox.calls.get(0).reason());
    }

    @Test
    void 조회_결과가_비종결이면_등록됨으로_되돌려_다음_이벤트를_기다린다() {
        client.jobResponses.add(response(200, "{\"status\":\"RETRY_WAIT\"}"));

        resolver.resolve();

        assertEquals(OutboxStatus.DELIVERED, outbox.calls.get(0).status());
    }

    @Test
    void 조회_결과도_모르는_상태면_확인_필요로_남긴다() {
        client.jobResponses.add(response(200, "{\"status\":\"CANCELED\"}"));

        resolver.resolve();

        assertEquals(List.of("touchNeedsCheck"), outbox.methods());
    }

    @Test
    void 조회가_404이면_확인_필요로_남기고_다음_행으로_넘어간다() {
        outbox.needsCheck = List.of(ID, ID2);
        client.jobResponses.add(response(404, "{\"type\":\"urn:mailo:problem:not-found\"}"));
        client.jobResponses.add(response(200, "{\"status\":\"SENT\"}"));

        resolver.resolve();

        assertEquals(List.of(ID, ID2), client.jobKeys);
        assertEquals(List.of("touchNeedsCheck", "applyCheckResult"), outbox.methods());
    }

    @Test
    void 조회가_401이면_나머지_행을_조회하지_않는다() {
        outbox.needsCheck = List.of(ID, ID2);
        client.jobResponses.add(response(401, null));

        resolver.resolve();

        assertEquals(List.of(ID), client.jobKeys);
        assertTrue(outbox.calls.isEmpty());
    }

    @Test
    void 네트워크_오류면_상태를_바꾸지_않고_다음_주기로_넘긴다() {
        client.jobFailure = new IOException("연결 실패");

        resolver.resolve();

        assertTrue(outbox.calls.isEmpty());
    }
}
