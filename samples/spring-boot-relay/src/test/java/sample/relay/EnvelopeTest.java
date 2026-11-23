package sample.relay;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.nimbusds.jose.JWEObject;
import com.nimbusds.jose.JWSObject;
import com.nimbusds.jose.crypto.MACVerifier;
import com.nimbusds.jose.crypto.RSADecrypter;
import com.nimbusds.jose.util.Base64URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.time.Duration;
import java.util.Base64;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import sample.relay.mailo.EnvelopeEncryptor;
import sample.relay.mailo.RequestSigner;

/** 같은 라이브러리(nimbus)로 왕복해 형식 필드를 확인한다. Mailo(jose)와의 상호 운용은 README의 실행 검증이다. */
class EnvelopeTest {

    private final ObjectMapper mapper = new ObjectMapper();

    private RelayProperties props(Path publicKey, Path secret) {
        return new RelayProperties(
                "http://127.0.0.1:3000", "fake-key", "sample", null, RelayProperties.Transport.REST, null,
                new RelayProperties.Signature(true, "sample-1", secret),
                new RelayProperties.Encryption(true, "mailo-dev-1", publicKey),
                new RelayProperties.Retry(Duration.ofSeconds(5), 20, Duration.ofSeconds(5), Duration.ofSeconds(10),
                        Duration.ofSeconds(30), 2.0, Duration.ofHours(1), 0.2, Duration.ofDays(7)),
                new RelayProperties.Events(Duration.ofSeconds(30), 100));
    }

    @Test
    void JWE는_RSA_OAEP_256과_A256GCM이고_kid와_caller가_protected_header에_있다(@TempDir Path dir) throws Exception {
        KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
        gen.initialize(3072);
        KeyPair pair = gen.generateKeyPair();
        Path pub = dir.resolve("pub.pem");
        Files.writeString(pub, "-----BEGIN PUBLIC KEY-----\n"
                + Base64.getMimeEncoder(64, "\n".getBytes()).encodeToString(pair.getPublic().getEncoded())
                + "\n-----END PUBLIC KEY-----\n");

        String compact = new EnvelopeEncryptor(props(pub, null)).encrypt("{\"subject\":\"s\",\"text\":\"t\"}");

        assertEquals(5, compact.split("\\.").length);
        JWEObject jwe = JWEObject.parse(compact);
        assertEquals("RSA-OAEP-256", jwe.getHeader().getAlgorithm().getName());
        assertEquals("A256GCM", jwe.getHeader().getEncryptionMethod().getName());
        assertEquals("mailo-dev-1", jwe.getHeader().getKeyID());
        assertEquals("sample", jwe.getHeader().getCustomParam("caller"));
        assertFalse(jwe.getHeader().toJSONObject().containsKey("zip"));
        jwe.decrypt(new RSADecrypter(pair.getPrivate()));
        assertEquals("{\"subject\":\"s\",\"text\":\"t\"}", jwe.getPayload().toString());
    }

    @Test
    void JWS는_flattened_JSON이고_protected에_alg_kid_caller_iat_네_필드만_있다(@TempDir Path dir) throws Exception {
        byte[] secret = new byte[32];
        for (int i = 0; i < secret.length; i++) {
            secret[i] = (byte) (i + 1);
        }
        Path file = dir.resolve("secret.txt");
        Files.writeString(file, Base64.getEncoder().encodeToString(secret) + "\n");

        String flattened = new RequestSigner(props(null, file), mapper).sign("{\"version\":1}");

        JsonNode top = mapper.readTree(flattened);
        assertEquals(3, top.size());
        JsonNode header = mapper.readTree(
                new String(Base64.getUrlDecoder().decode(top.get("protected").asText()), StandardCharsets.UTF_8));
        assertEquals(4, header.size());
        assertEquals("HS256", header.get("alg").asText());
        assertEquals("sample-1", header.get("kid").asText());
        assertEquals("sample", header.get("caller").asText());
        assertTrue(header.get("iat").isIntegralNumber());

        JWSObject parsed = JWSObject.parse(top.get("protected").asText() + "." + top.get("payload").asText() + "."
                + top.get("signature").asText());
        assertTrue(parsed.verify(new MACVerifier(secret)));
        assertEquals("{\"version\":1}", new String(Base64URL.from(top.get("payload").asText()).decode(), StandardCharsets.UTF_8));
    }
}
