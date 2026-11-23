package sample.relay.mailo;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.stereotype.Component;
import sample.relay.RelayProperties;

/**
 * Mailo {@code POST /jobs} 본문(docs/api/openapi.yaml {@code SendRequest})을 만든다.
 * 암호화를 켜면 subject·text·html 대신 {@code content}(JWE compact)를 넣는다. 둘을 섞으면 400이다.
 */
@Component
public class MailRequestFactory {

    private final ObjectMapper mapper;
    private final RelayProperties props;
    private final ObjectProvider<EnvelopeEncryptor> encryptor;

    public MailRequestFactory(ObjectMapper mapper, RelayProperties props, ObjectProvider<EnvelopeEncryptor> encryptor) {
        this.mapper = mapper;
        this.props = props;
        this.encryptor = encryptor;
    }

    public String orderConfirmation(String to, UUID orderId, String sku, int quantity) {
        String subject = "주문 접수 안내";
        String text = "주문 " + orderId + "이(가) 접수되었습니다. (" + sku + " x " + quantity + ")";
        return build(to, subject, text);
    }

    String build(String to, String subject, String text) {
        try {
            Map<String, Object> request = new LinkedHashMap<>();
            request.put("to", List.of(to));
            if (props.from() != null && !props.from().isBlank()) {
                request.put("from", props.from());
            }
            EnvelopeEncryptor enc = encryptor.getIfAvailable();
            if (enc == null) {
                request.put("subject", subject);
                request.put("text", text);
            } else {
                Map<String, Object> plaintext = new LinkedHashMap<>();
                plaintext.put("subject", subject);
                plaintext.put("text", text);
                request.put("content", enc.encrypt(mapper.writeValueAsString(plaintext)));
            }
            return mapper.writeValueAsString(request);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
