package sample.relay.mailo;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.JWSObject;
import com.nimbusds.jose.Payload;
import com.nimbusds.jose.crypto.MACSigner;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import sample.relay.RelayProperties;

/**
 * 파일 채널 JWS(HS256) 서명(ADR-0008 결정 2·4). REST는 서명을 쓰지 않는다.
 *
 * <p>출력은 flattened JWS JSON {@code {"protected","payload","signature"}}이다. protected header는
 * alg, kid, caller, iat(초 단위 숫자) 네 필드뿐이다. 호출 때마다 새 iat로 서명한다.
 */
@Component
@ConditionalOnProperty(prefix = "relay.signature", name = "enabled", havingValue = "true")
public class RequestSigner {

    private final MACSigner signer;
    private final String kid;
    private final String callerId;
    private final ObjectMapper mapper;

    public RequestSigner(RelayProperties props, ObjectMapper mapper) {
        try {
            this.signer = new MACSigner(KeyFiles.readHmacSecret(props.signature().secretFile()));
        } catch (JOSEException e) {
            throw new IllegalStateException("JWS 서명기를 만들 수 없다", e);
        }
        this.kid = props.signature().kid();
        this.callerId = props.callerId();
        this.mapper = mapper;
        if (kid == null || kid.isBlank()) {
            throw new IllegalStateException("relay.signature.kid가 필요하다");
        }
    }

    public String sign(String requestJson) {
        JWSHeader header = new JWSHeader.Builder(JWSAlgorithm.HS256)
                .keyID(kid)
                .customParam("caller", callerId)
                .customParam("iat", Instant.now().getEpochSecond())
                .build();
        JWSObject jws = new JWSObject(header, new Payload(requestJson));
        try {
            jws.sign(signer);
        } catch (JOSEException e) {
            throw new IllegalStateException("JWS 서명 실패", e);
        }
        String[] parts = jws.serialize().split("\\.");
        Map<String, String> flattened = new LinkedHashMap<>();
        flattened.put("protected", parts[0]);
        flattened.put("payload", parts[1]);
        flattened.put("signature", parts[2]);
        try {
            return mapper.writeValueAsString(flattened);
        } catch (JsonProcessingException e) {
            throw new IllegalStateException(e);
        }
    }
}
