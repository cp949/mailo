package sample.relay.relay;

/**
 * HTTP 상태 코드를 relay 동작으로 바꾼다(docs/api/README.md "호출처 relay 재시도 지침", ADR-0005 결정 5).
 *
 * <ul>
 *   <li>200, 202: 등록 완료
 *   <li>409: 격리(영구 실패). 자동 재시도하지 않는다
 *   <li>401: relay 중지
 *   <li>400, 413, 415와 그 밖의 4xx, 3xx: 재시도하지 않는다
 *   <li>429, 5xx(503 포함): 같은 Key로 재시도한다. 429는 Mailo가 쓰지 않지만 앞단 프록시를 대비한다
 * </ul>
 */
public final class SendDecision {

    private SendDecision() {}

    public static Delivery.Kind classify(int status) {
        if (status == 200 || status == 202) {
            return Delivery.Kind.DONE;
        }
        if (status == 409) {
            return Delivery.Kind.QUARANTINE;
        }
        if (status == 401) {
            return Delivery.Kind.AUTH_FAILED;
        }
        if (status == 429 || status >= 500) {
            return Delivery.Kind.RETRY;
        }
        return Delivery.Kind.REJECT;
    }
}
