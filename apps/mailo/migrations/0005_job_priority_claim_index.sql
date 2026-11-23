-- mailo:no-transaction
-- 우선순위 점유 경로용 인덱스(RQ-035·038, ADR-0009). 대기 순서 경로와 헬스 전체 수치는 기존 `mail_jobs_claim_idx`를 쓴다.
-- 등급별 헬스 수치(`dueCountByPriority`)도 이 인덱스로 등급마다 상한까지만 읽는다.
-- CONCURRENTLY라 트랜잭션 밖에서 문장 하나로 실행한다. 실패하면 기록되지 않아 다시 실행되므로 IF NOT EXISTS로 멱등하게 둔다.
-- 중단된 CONCURRENTLY는 INVALID 인덱스를 남길 수 있다. IF NOT EXISTS는 그 인덱스를 건너뛰고 성공하지만
-- 실행기(src/db/migrator.ts)가 기록 전에 INVALID 인덱스를 찾아 실패한다. 복구는 docs/operations/troubleshooting.md "등급별 적체"다.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_jobs_priority_claim_idx
  ON mail_jobs (priority DESC, next_attempt_at, id)
  WHERE status IN ('PENDING', 'RETRY_WAIT');
