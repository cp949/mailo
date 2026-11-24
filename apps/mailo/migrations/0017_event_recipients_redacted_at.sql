-- 이벤트 수신자 비움 표지(RQ-072, ADR-0015 결정 3). 0001~0016은 수정하지 않고 컬럼 하나를 더한다.
-- 유지보수 루프의 `recipients` 단계가 `MAILO_RECIPIENT_RETENTION_SECONDS`가 지난 `JOB_*` 이벤트의 `recipients`와
-- `rejected_recipients`를 비울 때 이 컬럼에 시각을 쓴다. NULL이면 아직 비우지 않았다는 뜻이다.
--
-- 기본값 없는 NULL 허용 컬럼 추가는 표를 다시 쓰지 않는다. 백필은 없다. 기존 이벤트는 NULL이고
-- 배포 직후 보존 기간 안의 기존 이벤트(최대 30일치) 중 유예가 지난 것이 비움 대상이 된다.
-- 구버전 인스턴스는 컬럼을 열거해 읽고 쓰므로 이 컬럼을 무시한다. 새 코드는 이 마이그레이션이 적용된 뒤에 띄운다.
-- IF NOT EXISTS라 파일을 다시 실행해도 오류가 없다. 롤백은 코드를 되돌리는 것이고 컬럼은 남긴다.
ALTER TABLE mail_events ADD COLUMN IF NOT EXISTS recipients_redacted_at timestamptz;
