package sample.relay.outbox;

/** mail_outbox.status 값. 종결 상태는 relay가 다시 읽지 않는다. */
public final class OutboxStatus {

    /** relay 대기. 재시도 대기도 이 상태이고 next_attempt_at이 시각을 정한다. */
    public static final String PENDING = "PENDING";
    /** Mailo가 등록했다(202·200). 파일 채널은 파일을 썼다는 뜻이다. 발송 완료가 아니다. */
    public static final String DELIVERED = "DELIVERED";
    /** 이벤트 피드(또는 200 응답의 Job 상태)로 확인한 SMTP 수락. */
    public static final String SENT = "SENT";
    /** Mailo가 JOB_FAILED로 알린 최종 실패. */
    public static final String FAILED = "FAILED";
    /** Mailo가 JOB_EXPIRED로 알린 만료. */
    public static final String EXPIRED = "EXPIRED";
    /** relay 최대 재시도 기간(기본 7일)을 넘겼다. 운영 알림 대상이다. */
    public static final String DEAD = "DEAD";
    /** 재시도해도 같은 결과인 요청 오류(400·401·413·415 등)나 파일 수집 거부. 고친 뒤 PENDING으로 되돌려야 한다. */
    public static final String REJECTED = "REJECTED";
    /** 409(같은 Key에 다른 내용)나 FINGERPRINT_MISMATCH. 호출처 버그를 의심한다. 자동 재시도하지 않는다. */
    public static final String QUARANTINED = "QUARANTINED";

    /**
     * 모르는 이벤트 종류나 모르는 Job 상태를 만났거나 이벤트 공백 신호를 받아 확인이 필요한 행.
     * 종결이 아니다. {@code NeedsCheckResolver}가 {@code GET /jobs}로 확인하고, 확인이 끝날 때까지 운영 알림 대상이다.
     * relay는 이 행을 다시 보내지 않는다(ADR-0011 구현 순서 1, docs/api/README.md).
     */
    public static final String NEEDS_CHECK = "NEEDS_CHECK";

    private OutboxStatus() {}
}
