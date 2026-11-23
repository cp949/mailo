-- 시도 기록의 SMTP 계정(RQ-054, ADR-0013 결정 4). 계정 24시간 할당(묶음 B)이 조인 없이 세기 위한 복사본이다.
-- 호출처 할당의 `caller_id`(0002)와 같은 이유다. 시도 행은 작업 행의 `account_id`를 복사해 쓴다.
-- 0010과 같은 방식이다: 상수 DEFAULT(표를 다시 쓰지 않음), 백필 없음, NOT VALID CHECK.
-- 테이블마다 파일을 나눠 `ACCESS EXCLUSIVE` 대기가 겹치지 않게 한다.
ALTER TABLE mail_attempts ADD COLUMN account_id text NOT NULL DEFAULT 'default';

ALTER TABLE mail_attempts ADD CONSTRAINT mail_attempts_account_id_format
  CHECK (account_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$') NOT VALID;
