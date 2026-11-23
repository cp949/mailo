package sample.relay.relay;

import java.util.UUID;

/** outbox 요청 한 건을 Mailo에 전달하는 방법. REST가 기본이고 파일 채널은 옵션이다. */
public interface RequestTransport {

    /** 예외를 던지지 않고 결과로 돌려준다. */
    Delivery send(UUID id, String requestJson);
}
