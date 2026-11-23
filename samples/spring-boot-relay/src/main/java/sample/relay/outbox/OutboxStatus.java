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

    private OutboxStatus() {}
}
