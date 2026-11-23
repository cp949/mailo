package sample.relay.relay;

import sample.relay.outbox.OutboxStatus;

/**
 * Mailo의 {@code Job.status}를 outbox 상태로 바꾼다(ADR-0011 구현 순서 1, docs/api/README.md).
 * 200 응답은 같은 Key의 기존 작업 상태를 돌려준다. 이벤트를 이미 소비한 뒤 재전송한 행이 DELIVERED로 남지 않게 종결 상태를 그대로 반영한다.
 *
 * <ul>
 *   <li>{@code SENT}, {@code FAILED}, {@code EXPIRED}: 종결 상태 그대로.
 *   <li>{@code PENDING}, {@code SENDING}, {@code RETRY_WAIT}: 비종결이다. 등록됨({@code DELIVERED})으로 두고 이후 이벤트를 기다린다.
 *   <li>그 밖의 값: 모르는 상태다. 성공이나 등록됨으로 처리하지 않고 {@code NEEDS_CHECK}로 둔다.
 *   <li>null: 응답 본문이 없다(파일 채널). 파일을 썼다는 뜻의 {@code DELIVERED}다.
 * </ul>
 */
public final class JobStatusMapping {

    private JobStatusMapping() {}

    public static String toOutboxStatus(String jobStatus) {
        if (jobStatus == null) {
            return OutboxStatus.DELIVERED;
        }
        return switch (jobStatus) {
            case "SENT" -> OutboxStatus.SENT;
            case "FAILED" -> OutboxStatus.FAILED;
            case "EXPIRED" -> OutboxStatus.EXPIRED;
            case "PENDING", "SENDING", "RETRY_WAIT" -> OutboxStatus.DELIVERED;
            default -> OutboxStatus.NEEDS_CHECK;
        };
    }
}
