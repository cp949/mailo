package sample.relay;

import java.time.Duration;

/** 테스트용 설정. 가짜 값만 쓴다(RQ-027). */
public final class TestProps {

    private TestProps() {}

    public static RelayProperties create() {
        return new RelayProperties(
                "http://127.0.0.1:1",
                "test-api-key-not-real",
                "sample",
                null,
                RelayProperties.Transport.REST,
                null,
                new RelayProperties.Signature(false, null, null),
                new RelayProperties.Encryption(false, null, null),
                new RelayProperties.Retry(Duration.ofSeconds(5), 20, Duration.ofSeconds(5), Duration.ofSeconds(10),
                        Duration.ofSeconds(30), 2, Duration.ofHours(1), 0.2, Duration.ofDays(7)),
                new RelayProperties.Events(Duration.ofSeconds(30), 100));
    }
}
