package sample.relay.outbox;

import java.util.UUID;

/** relay가 잠근 outbox 행. {@code expired}는 DB 시각 기준으로 최대 재시도 기간을 넘겼는지다. */
public record OutboxRow(UUID id, String requestJson, int attemptCount, boolean expired) {}
