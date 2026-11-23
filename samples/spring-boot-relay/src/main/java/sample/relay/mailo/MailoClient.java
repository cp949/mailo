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

    /**
     * @param body JSON이 아니거나 비어 있으면 null이다.
     * @param cursorGap 응답 헤더 {@code Mailo-Cursor-Gap: true}가 있다. cursor 뒤에서 이벤트가 삭제됐다는 신호다(ADR-0011 결정 9).
     */
    public record Response(int status, JsonNode body, boolean cursorGap) {}

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

    /**
     * {@code GET /events}. 상태 코드와 관계없이 응답을 돌려준다. 200 판정, 410 복구, 그 밖의 오류 처리는 호출자가 한다.
     * 네트워크 오류만 IOException이다. cursor는 불투명 문자열이므로 그대로 넘긴다.
     * 410을 받는 {@code onGap=error}는 보내지 않는다. 공백은 헤더({@link Response#cursorGap})로 받는다.
     */
    public Response getEvents(String after, int limit) throws IOException, InterruptedException {
        String query = "limit=" + limit;
        if (after != null) {
            query += "&after=" + URLEncoder.encode(after, StandardCharsets.UTF_8);
        }
        return send(get("events?" + query));
    }

    /** {@code GET /jobs?idempotencyKey=}. 같은 호출처의 작업만 조회된다. 없으면 404다. */
    public Response getJobByKey(UUID idempotencyKey) throws IOException, InterruptedException {
        return send(get("jobs?idempotencyKey=" + URLEncoder.encode(idempotencyKey.toString(), StandardCharsets.UTF_8)));
    }

    /** {@code GET /jobs/{jobId}}. 등록 응답이나 이벤트로 받은 작업 ID로 조회한다. */
    public Response getJob(UUID jobId) throws IOException, InterruptedException {
        return send(get("jobs/" + jobId));
    }

    private HttpRequest get(String relativeUri) {
        return HttpRequest.newBuilder(base.resolve(relativeUri))
                .timeout(props.retry().requestTimeout())
                .header("Authorization", "Bearer " + props.apiKey())
                .GET()
                .build();
    }

    private Response send(HttpRequest request) throws IOException, InterruptedException {
        HttpResponse<String> res = http.send(request, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        JsonNode body = null;
        try {
            body = res.body().isEmpty() ? null : mapper.readTree(res.body());
        } catch (IOException ignored) {
            // 본문이 JSON이 아니어도 상태 코드로 판정한다.
        }
        boolean gap = res.headers().firstValue("Mailo-Cursor-Gap").map("true"::equalsIgnoreCase).orElse(false);
        return new Response(res.statusCode(), body, gap);
    }
}
