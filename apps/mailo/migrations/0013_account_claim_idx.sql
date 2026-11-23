-- mailo:no-transaction
-- 계정 단위 대기 순서 점유 인덱스(RQ-054, ADR-0013 결정 3·4). 대기 순서(`fifo`) 경로와 계정별 건수 쿼리가 쓴다.
-- 기존 `mail_jobs_claim_idx`(0001)는 0016이 지운다. 실행 방식은 0012와 같다(문장 하나, 멱등, INVALID 인덱스는 실행기가 거부).
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_jobs_account_claim_idx
  ON mail_jobs (account_id, next_attempt_at, id)
  WHERE status IN ('PENDING', 'RETRY_WAIT');
