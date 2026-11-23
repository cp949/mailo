-- mailo:no-transaction
-- 계정 조건이 없는 기존 대기 순서 점유 인덱스를 지운다(ADR-0013 결정 4). 새 인덱스(0013)로 대체한다.
-- 이 릴리스의 마지막 마이그레이션이다. 구버전 인스턴스가 도는 동안 점유가 대기 건수에 비례해 느려질 수 있다.
-- 롤백(코드를 되돌릴 때)은 이 인덱스를 `CREATE INDEX CONCURRENTLY IF NOT EXISTS`로 다시 만드는 것이다(0001의 정의).
-- 문장 하나이고 IF EXISTS라 멱등하다.
DROP INDEX CONCURRENTLY IF EXISTS mail_jobs_claim_idx;
