package sample.relay;

import java.nio.file.Path;
import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * 샘플 설정. 비밀 값(API 키, JWS 비밀키)은 환경 변수나 파일로만 받고 저장소의 설정 파일에는 두지 않는다.
 * 환경 변수 이름은 relaxed binding을 따른다. 예: {@code relay.api-key} = {@code RELAY_API_KEY}.
 */
@ConfigurationProperties("relay")
public record RelayProperties(
        /** Mailo 주소. 예: http://127.0.0.1:3000 */
        String baseUrl,
        /** Mailo가 발급한 호출처 API 키 평문. Authorization: Bearer로 보낸다. */
        String apiKey,
        /** 호출처 id. JWE protected header와 JWS protected header의 caller 값이다. */
        String callerId,
        /** 발신 주소. 비우면 Mailo의 SMTP 발신 계정을 쓴다. */
        String from,
        @DefaultValue("REST") Transport transport,
        /** transport=FILE일 때 쓰는 호출처 폴더(<root>/inbox/<caller_id>). */
        Path fileInboxDir,
        @DefaultValue Signature signature,
        @DefaultValue Encryption encryption,
        @DefaultValue Retry retry,
        @DefaultValue Events events) {

    public enum Transport { REST, FILE }

    /** 파일 채널 JWS(HS256) 서명. Mailo 레지스트리의 signature.mode=required와 짝이다. */
    public record Signature(
            @DefaultValue("false") boolean enabled,
            /** Mailo 레지스트리 signature.keys[].kid */
            String kid,
            /** 32바이트 비밀키 파일(base64 또는 64자 hex). Mailo가 같은 값을 secretVar로 받는다. */
            Path secretFile) {}

    /** JWE 본문 암호화(RSA-OAEP-256 + A256GCM). */
    public record Encryption(
            @DefaultValue("false") boolean enabled,
            /** Mailo가 알려 준 공개키 식별자 */
            String kid,
            /** Mailo 공개키 PEM(SPKI, RSA 3072) */
            Path publicKeyFile) {}

    public record Retry(
            @DefaultValue("5s") Duration pollInterval,
            @DefaultValue("20") int batchSize,
            @DefaultValue("5s") Duration connectTimeout,
            @DefaultValue("10s") Duration requestTimeout,
            @DefaultValue("30s") Duration baseDelay,
            @DefaultValue("2") double multiplier,
            @DefaultValue("1h") Duration maxDelay,
            @DefaultValue("0.2") double jitterRatio,
            /** created_at 기준 최대 재시도 기간. Key 보존 기간(30일)보다 짧아야 한다. */
            @DefaultValue("7d") Duration maxAge) {}

    public record Events(
            @DefaultValue("30s") Duration pollInterval,
            @DefaultValue("100") int limit) {}
}
