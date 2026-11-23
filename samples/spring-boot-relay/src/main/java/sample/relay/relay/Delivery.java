package sample.relay.relay;

/**
 * 전송 한 번의 결과.
 *
 * @param httpStatus REST 응답 코드. 네트워크 오류와 파일 쓰기는 null이다.
 * @param jobStatus  200·202 응답 본문의 Job.status(PENDING, SENT 등). 없으면 null이다.
 * @param reason     outbox.last_error에 남기는 고정 사유. 요청·응답의 값(주소, 본문)은 넣지 않는다.
 */
public record Delivery(Kind kind, Integer httpStatus, String jobStatus, String reason) {

    public enum Kind {
        /** 등록됨(202·200) 또는 파일을 씀. */
        DONE,
        /** 같은 Key로 backoff 뒤 다시 보낸다(네트워크 오류, 타임아웃, 5xx, 429). */
        RETRY,
        /** 409. 같은 Key에 다른 내용이다. 격리하고 알린다. */
        QUARANTINE,
        /** 재시도해도 같은 결과인 4xx(400, 413, 415 등). */
        REJECT,
        /** 401. 자격 문제라서 relay를 멈추고 알린다. */
        AUTH_FAILED
    }

    static Delivery retry(Integer httpStatus, String reason) {
        return new Delivery(Kind.RETRY, httpStatus, null, reason);
    }
}
