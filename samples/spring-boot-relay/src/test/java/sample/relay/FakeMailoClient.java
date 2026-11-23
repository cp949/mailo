package sample.relay;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.List;
import java.util.UUID;
import sample.relay.mailo.MailoClient;

/** 준비한 응답을 순서대로 돌려주는 대역. 네트워크를 쓰지 않는다. */
public class FakeMailoClient extends MailoClient {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    public final Deque<Response> eventResponses = new ArrayDeque<>();
    public final Deque<Response> jobResponses = new ArrayDeque<>();
    public final List<String> eventCursors = new ArrayList<>();
    public final List<UUID> jobKeys = new ArrayList<>();
    public IOException jobFailure;

    public FakeMailoClient() {
        super(TestProps.create(), MAPPER);
    }

    public static Response response(int status, String json) {
        return response(status, json, false);
    }

    public static Response response(int status, String json, boolean cursorGap) {
        try {
            return new Response(status, json == null ? null : MAPPER.readTree(json), cursorGap);
        } catch (IOException e) {
            throw new IllegalArgumentException(e);
        }
    }

    @Override
    public Response getEvents(String after, int limit) {
        eventCursors.add(after);
        return eventResponses.removeFirst();
    }

    @Override
    public Response getJobByKey(UUID idempotencyKey) throws IOException {
        jobKeys.add(idempotencyKey);
        if (jobFailure != null) {
            throw jobFailure;
        }
        return jobResponses.removeFirst();
    }
}
