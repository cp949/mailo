package sample.relay.relay;

import sample.relay.RelayProperties;

/** exponential backoff + jitter, 상한 있음. 수치는 사용처가 정한다(예시 값: 30초, 배수 2, 상한 1시간, ±20%). */
public final class Backoff {

    private Backoff() {}

    /**
     * @param failures 이번을 포함한 누적 실패 횟수(1부터)
     * @param random01 0 이상 1 미만의 난수. jitter 계산에만 쓴다
     */
    public static double delaySeconds(int failures, RelayProperties.Retry retry, double random01) {
        double cap = retry.maxDelay().toSeconds();
        double raw = retry.baseDelay().toSeconds() * Math.pow(retry.multiplier(), Math.max(0, failures - 1));
        double jitter = 1.0 + (random01 * 2.0 - 1.0) * retry.jitterRatio();
        return Math.min(Math.min(raw, cap) * jitter, cap);
    }
}
