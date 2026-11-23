package sample.relay.mailo;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.UUID;
import org.springframework.stereotype.Component;
import sample.relay.RelayProperties;

/** Mailo REST 클라이언트(JDK java.net.http). 요청·응답 본문은 로그에 남기지 않는다. */
@Component
public class MailoClient {

    /** {@code body}는 JSON이 아니거나 비어 있으면 null이다. */
    public record Response(int status, JsonNode body) {}

    private final HttpClient http;
    private final RelayProperties props;
    private final ObjectMapper mapper;
    private final URI base;

    public MailoClient(RelayProperties props, ObjectMapper mapper) {
        if (props.apiKey() == null || props.apiKey().isBlank()) {
            throw new IllegalStateException("relay.api-key(RELAY_API_KEY)가 필요하다");
        }
        this.props = props;
        this.mapper = mapper;
        this.base = URI.create(props.baseUrl().endsWith("/") ? props.baseUrl() : props.baseUrl() + "/");
        // 리다이렉트는 따라가지 않는다. 잘못된 주소에 API 키를 다른 곳으로 보내지 않기 위해서다.
        this.http = HttpClient.newBuilder()
                .connectTimeout(props.retry().connectTimeout())
                .followRedirects(HttpClient.Redirect.NEVER)
                .build();
    }

    /** {@code POST /jobs}. 타임아웃은 등록 여부를 모르는 상태이므로 호출자가 같은 Key로 재시도한다. */
    public Response postJob(UUID idempotencyKey, String requestJson) throws IOException, InterruptedException {
        HttpRequest request = HttpRequest.newBuilder(base.resolve("jobs"))
                .timeout(props.retry().requestTimeout())
                .header("Authorization", "Bearer " + props.apiKey())
                .header("Idempotency-Key", idempotencyKey.toString())
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(requestJson, StandardCharsets.UTF_8))
                .build();
        return send(request);
    }

    /** {@code GET /events}. 200이 아니면 IOException이다. cursor는 불투명 문자열이므로 그대로 넘긴다. */
    public JsonNode getEvents(String after, int limit) throws IOException, InterruptedException {
        String query = "limit=" + limit;
        if (after != null) {
            query += "&after=" + URLEncoder.encode(after, StandardCharsets.UTF_8);
        }
        HttpRequest request = HttpRequest.newBuilder(base.resolve("events?" + query))
                .timeout(props.retry().requestTimeout())
                .header("Authorization", "Bearer " + props.apiKey())
                .GET()
                .build();
        Response response = send(request);
        if (response.status() != 200 || response.body() == null) {
            throw new IOException("GET /events 실패: HTTP " + response.status());
        }
        return response.body();
    }

    private Response send(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<String> res = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonNode body = null;
        try {
            body = res.body().isEmpty() ? null : mapper.readTree(res.body());
        } catch (IOException ignored) {
            // 본문이 JSON이 아니어도 상태 코드로 판정한다.
        }
        return new Response(res.statusCode(), body);
    }
}
