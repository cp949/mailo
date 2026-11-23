package sample.relay;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;
import sample.relay.outbox.OutboxStatus;
import sample.relay.relay.JobStatusMapping;

/** Job.status를 outbox 상태로 바꾸는 규칙(ADR-0011 구현 순서 1.3, docs/api/README.md "호출처가 모르는 값을 만났을 때"). */
class JobStatusMappingTest {

    @Test
    void 비종결_상태_세_개는_등록됨_상태로_둔다() {
        for (String status : new String[] {"PENDING", "SENDING", "RETRY_WAIT"}) {
            assertEquals(OutboxStatus.DELIVERED, JobStatusMapping.toOutboxStatus(status), "status=" + status);
        }
    }

    @Test
    void 종결_상태_세_개는_그대로_반영한다() {
        assertEquals(OutboxStatus.SENT, JobStatusMapping.toOutboxStatus("SENT"));
        assertEquals(OutboxStatus.FAILED, JobStatusMapping.toOutboxStatus("FAILED"));
        assertEquals(OutboxStatus.EXPIRED, JobStatusMapping.toOutboxStatus("EXPIRED"));
    }

    @Test
    void 모르는_상태는_확인_필요로_둔다() {
        // CANCELED도 이 샘플이 아직 모르는 값이다. 모르는 상태를 DELIVERED나 성공으로 바꾸지 않는다.
        for (String status : new String[] {"CANCELED", "SOMETHING_NEW", "", "sent"}) {
            assertEquals(OutboxStatus.NEEDS_CHECK, JobStatusMapping.toOutboxStatus(status), "status=" + status);
        }
    }

    @Test
    void 상태가_없으면_등록됨으로_둔다() {
        // 파일 채널 전송은 응답 본문이 없다. 파일을 썼다는 뜻의 DELIVERED다.
        assertEquals(OutboxStatus.DELIVERED, JobStatusMapping.toOutboxStatus(null));
    }
}
