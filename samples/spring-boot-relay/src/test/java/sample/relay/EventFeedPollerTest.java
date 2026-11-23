package sample.relay;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import sample.relay.events.EventFeedPoller;

class EventFeedPollerTest {

    private final ObjectMapper mapper = new ObjectMapper();
    private final UUID id = UUID.fromString("7c9e6679-7425-40de-944b-e07fc1f90ae7");

    @Test
    void Key가_UUID이면_outbox_행_ID로_쓴다() throws Exception {
        var event = mapper.readTree("{\"idempotencyKey\":\"" + id + "\"}");
        assertEquals(id, EventFeedPoller.outboxIdOf(event));
    }

    @Test
    void INTAKE_REJECTED의_Key가_null이면_파일_이름으로_찾는다() throws Exception {
        var event = mapper.readTree("{\"idempotencyKey\":null,\"fileName\":\"" + id + ".json\"}");
        assertEquals(id, EventFeedPoller.outboxIdOf(event));
    }

    @Test
    void UUID가_아니면_이_사용처의_행이_아니다() throws Exception {
        assertNull(EventFeedPoller.outboxIdOf(mapper.readTree("{\"idempotencyKey\":\"outbox-8841\"}")));
        assertNull(EventFeedPoller.outboxIdOf(mapper.readTree("{\"idempotencyKey\":null,\"fileName\":\"x.txt\"}")));
    }
}
