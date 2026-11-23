package sample.relay.mailo;

import com.nimbusds.jose.EncryptionMethod;
import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWEAlgorithm;
import com.nimbusds.jose.JWEHeader;
import com.nimbusds.jose.JWEObject;
import com.nimbusds.jose.Payload;
import com.nimbusds.jose.crypto.RSAEncrypter;
import java.security.interfaces.RSAPublicKey;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import sample.relay.RelayProperties;

/**
 * 제목·본문 JWE 암호화(ADR-0008 결정 1). {@code relay.encryption.enabled=true}일 때만 만들어진다.
 *
 * <p>protected header는 alg=RSA-OAEP-256, enc=A256GCM, kid(Mailo 공개키), caller(호출처 id)다.
 * caller는 AAD로 인증되며 Mailo가 요청의 caller_id와 비교한다.
 */
@Component
@ConditionalOnProperty(prefix = "relay.encryption", name = "enabled", havingValue = "true")
public class EnvelopeEncryptor {

    private final RSAEncrypter encrypter;
    private final String kid;
    private final String callerId;

    public EnvelopeEncryptor(RelayProperties props) {
        RSAPublicKey publicKey = KeyFiles.readRsaPublicKey(props.encryption().publicKeyFile());
        this.encrypter = new RSAEncrypter(publicKey);
        this.kid = props.encryption().kid();
        this.callerId = props.callerId();
        if (kid == null || kid.isBlank()) {
            throw new IllegalStateException("relay.encryption.kid가 필요하다");
        }
    }

    /** @param plaintextJson UTF-8 JSON {@code {"subject","text","html"}} */
    public String encrypt(String plaintextJson) {
        JWEHeader header = new JWEHeader.Builder(JWEAlgorithm.RSA_OAEP_256, EncryptionMethod.A256GCM)
                .keyID(kid)
                .customParam("caller", callerId)
                .build();
        JWEObject jwe = new JWEObject(header, new Payload(plaintextJson));
        try {
            jwe.encrypt(encrypter);
        } catch (JOSEException e) {
            throw new IllegalStateException("JWE 암호화 실패", e);
        }
        return jwe.serialize(); // compact: 점으로 구분한 5부분
    }
}
