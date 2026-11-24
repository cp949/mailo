-- mailo:no-transaction
-- 이벤트 수신자 비움 대상 인덱스(RQ-072, ADR-0015 결정 3). 비우지 않은 `JOB_*` 이벤트만 시각순으로 담는 부분 인덱스다.
-- 비운 이벤트(`recipients_redacted_at`이 채워진 행)는 인덱스에서 빠지므로 크기가 비움 대기 이벤트 수로 제한된다.
-- `INTAKE_REJECTED`는 수신자가 없어 대상이 아니다. 비움 쿼리(`redactEventRecipients`)의 조건을 이 정의와 글자 그대로 맞춘다.
-- 갱신 열이 인덱스 조건에 들어가므로 비움 UPDATE는 HOT 갱신이 되지 않을 수 있다(미측정, ADR-0015 결정 3 위험).
-- CONCURRENTLY라 트랜잭션 밖에서 문장 하나로 실행한다. 실패하면 기록되지 않아 다시 실행되므로 IF NOT EXISTS로 멱등하게 둔다.
-- 중단된 CONCURRENTLY는 INVALID 인덱스를 남길 수 있다. IF NOT EXISTS는 그 인덱스를 건너뛰고 성공하지만
-- 실행기(src/db/migrator.ts)가 기록 전에 INVALID 인덱스를 찾아 실패한다. 복구는 docs/operations/troubleshooting.md "이벤트 수신자 비움 인덱스"다.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_events_recipients_redact_idx
  ON mail_events (created_at, id)
  WHERE type IN ('JOB_SENT', 'JOB_FAILED', 'JOB_EXPIRED', 'JOB_CANCELED')
    AND recipients_redacted_at IS NULL;
