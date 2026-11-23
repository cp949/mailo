-- mailo:no-transaction
-- 계정 조건이 없는 기존 우선순위 점유 인덱스를 지운다(ADR-0013 결정 4). 새 인덱스(0012)와 함께 두면 계획이 이 인덱스를 고른다.
-- 이 인덱스를 지우면 구버전 인스턴스의 점유는 대기 건수에 비례해 느려진다(정확성은 영향받지 않는다).
-- 롤백(코드를 되돌릴 때)은 이 인덱스를 `CREATE INDEX CONCURRENTLY IF NOT EXISTS`로 다시 만드는 것이다(0005의 문장).
-- 문장 하나이고 IF EXISTS라 멱등하다.
DROP INDEX CONCURRENTLY IF EXISTS mail_jobs_priority_claim_idx;
