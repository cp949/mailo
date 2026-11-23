-- 이벤트 종류 JOB_CANCELED 추가(RQ-040, ADR-0011 결정 4·10). 0006과 같은 방식이다.
-- mail_events만 잠근다. 새 조건은 옛 조건에 JOB_CANCELED를 더한 것이라 기존 행이 모두 만족한다.
ALTER TABLE mail_events DROP CONSTRAINT mail_events_type_check;
ALTER TABLE mail_events ADD CONSTRAINT mail_events_type_check
  CHECK (type IN ('JOB_SENT', 'JOB_FAILED', 'JOB_EXPIRED', 'JOB_CANCELED', 'INTAKE_REJECTED')) NOT VALID;
