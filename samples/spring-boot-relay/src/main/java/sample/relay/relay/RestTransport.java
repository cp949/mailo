package sample.relay.relay;

import com.fasterxml.jackson.databind.JsonNode;
import java.io.IOException;
import java.util.StringJoiner;
import java.util.UUID;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import sample.relay.mailo.MailoClient;

/** {@code POST /jobs}. Idempotency-Key는 outbox 행 ID다. */
@Component
@ConditionalOnProperty(prefix = "relay", name = "transport", havingValue = "REST", matchIfMissing = true)
public class RestTransport implements RequestTransport {

    private final MailoClient client;

    public RestTransport(MailoClient client) {
        this.client = client;
    }

    @Override
    public Delivery send(UUID id, String requestJson) {
        try {
            MailoClient.Response response = client.postJob(id, requestJson);
            Delivery.Kind kind = SendDecision.classify(response.status());
            String jobStatus = kind == Delivery.Kind.DONE && response.body() != null
                    ? response.body().path("status").asText(null)
                    : null;
            return new Delivery(kind, response.status(), jobStatus, reason(response));
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            return Delivery.retry(null, "INTERRUPTED");
        } catch (IOException e) {
            // 연결 실패, 타임아웃(HttpTimeoutException 포함). 등록 여부를 모르므로 같은 Key로 재시도한다.
            return Delivery.retry(null, "NETWORK_ERROR");
        }
    }

    /** 오류 응답의 problem type과 검증 오류 코드만 남긴다. detail·title·값은 남기지 않는다. */
    private static String reason(MailoClient.Response response) {
        if (response.status() == 200 || response.status() == 202) {
            return null;
        }
        StringBuilder sb = new StringBuilder("HTTP_").append(response.status());
        JsonNode body = response.body();
        if (body != null) {
            String type = body.path("type").asText("");
            int at = type.lastIndexOf(':');
            if (at >= 0 && at + 1 < type.length()) {
                sb.append(' ').append(type.substring(at + 1).replaceAll("[^A-Za-z0-9_-]", ""));
            }
            StringJoiner codes = new StringJoiner(",");
            for (JsonNode e : body.path("errors")) {
                codes.add(e.path("code").asText("").replaceAll("[^A-Z_]", ""));
            }
            if (codes.length() > 0) {
                sb.append(' ').append(codes);
            }
        }
        return sb.length() > 200 ? sb.substring(0, 200) : sb.toString();
    }
}
