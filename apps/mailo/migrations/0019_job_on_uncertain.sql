-- 결과 불명 시도 뒤의 처리 정책(RQ-073, ADR-0015 결정 9). 0001~0016은 수정하지 않고 추가만 한다.
-- 값은 등록 때 요청 `onUncertainOutcome`으로 정해지고 이후 바뀌지 않는다(`retry` 또는 `fail`). 어떤 SQL도 이 컬럼을 UPDATE하지 않는다.
-- 종결 UPDATE가 `envelope`를 비워도 판정에 쓰여야 하므로 jsonb가 아니라 전용 컬럼에 둔다.
--
-- 상수 DEFAULT 컬럼 추가는 PostgreSQL 11 이상에서 테이블을 다시 쓰지 않는다. 백필은 없다(문서 기준, 테스트가 relfilenode 불변을 확인한다).
-- 기존 행은 읽을 때 'retry'(도입 전 동작)로 보인다. DEFAULT는 영구히 둔다. 롤링 배포 중 이전 버전 인스턴스가 컬럼 없이 쓰는 INSERT도
-- 'retry'가 되어 거부되지 않는다(이전 버전은 컬럼을 열거해 읽고 쓰므로 새 컬럼을 무시한다).
-- 번호 0017·0018은 이벤트·시도 수신자 비움(ADR-0015 결정 3)의 마이그레이션이 쓴다.
ALTER TABLE mail_jobs ADD COLUMN on_uncertain text NOT NULL DEFAULT 'retry';

-- 허용 값. NOT VALID라 기존 행을 훑지 않고 새 행·갱신 행에만 적용한다. 기존 행은 모두 DEFAULT 'retry'라 어긋나는 행이 없고,
-- 그래서 VALIDATE CONSTRAINT가 따로 필요 없다(0003·0004·0010과 같은 방식).
ALTER TABLE mail_jobs ADD CONSTRAINT mail_jobs_on_uncertain_values
  CHECK (on_uncertain IN ('retry', 'fail')) NOT VALID;
