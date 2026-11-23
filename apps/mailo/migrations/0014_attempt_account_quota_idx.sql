-- mailo:no-transaction
-- 계정 24시간 할당의 사용량 인덱스(RQ-055, ADR-0013 결정 3 라·4). 호출처용 `mail_attempts_quota_idx`(0002)와 같은 조건이다.
-- 쿼리의 WHERE가 이 부분 인덱스 조건과 같아야 인덱스를 쓴다(queue/quota-usage.ts의 ACCOUNT_QUOTA_USAGE_SQL).
-- 실행 방식은 0012와 같다(문장 하나, 멱등, INVALID 인덱스는 실행기가 거부).
CREATE INDEX CONCURRENTLY IF NOT EXISTS mail_attempts_account_quota_idx
  ON mail_attempts (account_id, finished_at)
  WHERE counted AND stage IS DISTINCT FROM 'WORKER';
