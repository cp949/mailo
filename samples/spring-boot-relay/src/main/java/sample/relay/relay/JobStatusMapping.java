package sample.relay.relay;

import sample.relay.outbox.OutboxStatus;

/**
 * Mailo의 {@code Job.status}를 outbox 상태로 바꾼다(ADR-0011 구현 순서 1·1.7, docs/api/README.md).
 * 200 응답은 같은 Key의 기존 작업 상태를 돌려준다. 이벤트를 이미 소비한 뒤 재전송한 행이 DELIVERED로 남지 않게 종결 상태를 그대로 반영한다.
 *
 * <ul>
 *   <li>{@code SENT}, {@code FAILED}, {@code EXPIRED}, {@code CANCELED}: 종결 상태 그대로. 취소는 실패가 아니다.
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
            case "CANCELED" -> OutboxStatus.CANCELED;
            case "PENDING", "SENDING", "RETRY_WAIT" -> OutboxStatus.DELIVERED;
            default -> OutboxStatus.NEEDS_CHECK;
        };
    }

    /**
     * 취소 사유를 outbox의 last_error에 남길 값으로 바꾼다. {@code canceledBy}는 {@code CALLER}나 {@code OPERATOR}다.
     * 서버가 보낸 값이라 대문자와 밑줄만 남기고, 남는 것이 없으면 {@code CANCELED}만 쓴다.
     */
    public static String canceledReason(String canceledBy) {
        String safe = canceledBy == null ? "" : canceledBy.replaceAll("[^A-Z_]", "");
        return safe.isEmpty() ? "CANCELED" : "CANCELED_BY_" + safe;
    }
}
