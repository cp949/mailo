package sample.relay;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.time.Duration;
import org.junit.jupiter.api.Test;
import sample.relay.relay.Backoff;
import sample.relay.relay.Delivery.Kind;
import sample.relay.relay.SendDecision;

class SendDecisionTest {

    @Test
    void _200과_202는_등록_완료다() {
        assertEquals(Kind.DONE, SendDecision.classify(200));
        assertEquals(Kind.DONE, SendDecision.classify(202));
    }

    @Test
    void _409는_격리하고_401은_relay를_멈춘다() {
        assertEquals(Kind.QUARANTINE, SendDecision.classify(409));
        assertEquals(Kind.AUTH_FAILED, SendDecision.classify(401));
    }

    @Test
    void _400_413_415와_그_밖의_4xx는_재시도하지_않는다() {
        for (int status : new int[] {400, 404, 413, 415}) {
            assertEquals(Kind.REJECT, SendDecision.classify(status), "status=" + status);
        }
    }

    @Test
    void _5xx와_429는_같은_Key로_재시도한다() {
        for (int status : new int[] {429, 500, 502, 503, 504}) {
            assertEquals(Kind.RETRY, SendDecision.classify(status), "status=" + status);
        }
    }

    @Test
    void backoff는_배수로_늘고_상한을_넘지_않는다() {
        var retry = new RelayProperties.Retry(
                Duration.ofSeconds(5), 20, Duration.ofSeconds(5), Duration.ofSeconds(10),
                Duration.ofSeconds(30), 2.0, Duration.ofHours(1), 0.2, Duration.ofDays(7));
        assertEquals(30.0, Backoff.delaySeconds(1, retry, 0.5), 0.001);
        assertEquals(60.0, Backoff.delaySeconds(2, retry, 0.5), 0.001);
        assertEquals(3600.0, Backoff.delaySeconds(20, retry, 0.99), 0.001);
        // jitter는 ±20% 범위다.
        assertTrue(Backoff.delaySeconds(1, retry, 0.0) >= 24.0 - 0.001);
        assertTrue(Backoff.delaySeconds(1, retry, 0.9999) <= 36.0 + 0.001);
    }
}
