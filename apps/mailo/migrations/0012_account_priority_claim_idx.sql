-- mailo:no-transaction
-- 계정 단위 우선순위 점유 인덱스(RQ-054, ADR-0013 결정 3·4). `claim`이 계정마다 호출되어 `account_id = 상수`로 읽는다.
-- 기존 `mail_jobs_priority_claim_idx`(0005)는 같은 릴리스의 0015가 지운다. 둘을 함께 두면 계획이 기존 인덱스를 고른다.
-- CONCURRENTLY라 트랜잭션 밖에서 문장 하나로 실행한다. 실패하면 기록되지 않아 다시 실행되므로 IF NOT EXISTS로 멱등하게 둔다.
-- 중단된 CONCURRENTLY는 INVALID 인덱스를 남길 수 있다. 실행기(src/db/migrator.ts)가 기록 전에 INVALID 인덱스를 찾아 실패한다.
-- 복구는 docs/operations/troubleshooting.md의 계정 인덱스 절이다.
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_jobs_account_priority_claim_idx
  ON mail_jobs (account_id, priority DESC, next_attempt_at, id)
  WHERE status IN ('PENDING', 'RETRY_WAIT');
