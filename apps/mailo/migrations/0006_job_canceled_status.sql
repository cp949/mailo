-- 작업 상태 CANCELED 추가(RQ-040, ADR-0011 결정 4·10). 0001~0005는 수정하지 않고 추가만 한다.
--
-- 검증된 CHECK를 DROP한 뒤 같은 이름으로 NOT VALID로 다시 추가한다. 제약은 미검증(convalidated = false)으로 남는다.
-- 기존 행은 옛 CHECK를 이미 통과했고 새 조건은 옛 조건에 CANCELED를 더한 것이라 어긋나는 행이 없다.
-- 그래서 VALIDATE CONSTRAINT가 새로 알려 주는 것이 없고 이 파일은 스캔하지 않는다.
--
-- ALTER TABLE은 mail_jobs에 ACCESS EXCLUSIVE 잠금을 잡는다. mail_events는 0007에서 따로 바꿔
-- 두 테이블의 잠금 대기가 겹치지 않게 한다(파일마다 lock_timeout이 따로 적용된다).
-- 이 마이그레이션은 되돌리지 않는다. CANCELED 행이 생기면 옛 CHECK를 복원하지 못한다.
ALTER TABLE mail_jobs DROP CONSTRAINT mail_jobs_status_check;
ALTER TABLE mail_jobs ADD CONSTRAINT mail_jobs_status_check
  CHECK (status IN ('PENDING', 'SENDING', 'RETRY_WAIT', 'SENT', 'FAILED', 'EXPIRED', 'CANCELED')) NOT VALID;

-- 종결 상태(SENT·FAILED·EXPIRED·CANCELED)와 finished_at은 함께 있거나 함께 없다.
ALTER TABLE mail_jobs DROP CONSTRAINT mail_jobs_terminal_state;
ALTER TABLE mail_jobs ADD CONSTRAINT mail_jobs_terminal_state
  CHECK ((status IN ('SENT', 'FAILED', 'EXPIRED', 'CANCELED')) = (finished_at IS NOT NULL)) NOT VALID;
