-- 작업의 SMTP 계정 고정(RQ-054, ADR-0013 결정 2·4). 0001~0009는 수정하지 않고 추가만 한다.
-- 값은 등록 때 호출처 레지스트리의 `accountId`로 정해지고 이후 바뀌지 않는다. 어떤 SQL도 이 컬럼을 UPDATE하지 않는다.
--
-- 상수 DEFAULT 컬럼 추가는 PostgreSQL 11 이상에서 테이블을 다시 쓰지 않는다. 백필은 없다.
-- 기존 행은 읽을 때 'default'로 보인다. DEFAULT는 영구히 둔다. 롤링 배포 중 이전 버전 인스턴스가 컬럼 없이 쓰는 INSERT도
-- 'default'가 되어 거부되지 않는다(이전 버전은 컬럼을 열거해 읽고 쓰므로 새 컬럼을 무시한다).
ALTER TABLE mail_jobs ADD COLUMN account_id text NOT NULL DEFAULT 'default';

-- 계정 ID 형식(`src/config/smtp-accounts.ts`의 `isAccountId`와 같은 규칙, `unregistered` 예약어 검사는 앱이 한다).
-- NOT VALID라 기존 행을 훑지 않고 새 행·갱신 행에만 적용한다. 기존 행은 모두 'default'라 어긋나는 행이 없고,
-- 그래서 VALIDATE CONSTRAINT가 따로 필요 없다(0003·0004와 같은 방식).
ALTER TABLE mail_jobs ADD CONSTRAINT mail_jobs_account_id_format
  CHECK (account_id ~ '^[a-z0-9][a-z0-9_-]{0,31}$') NOT VALID;
