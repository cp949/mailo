-- 시도 기록에 기록한 인스턴스를 남긴다(로그의 `instance`와 DB 행 연결). 0001·0002는 수정하지 않고 추가만 한다.
-- 값은 로그의 `instance`와 같다(`MAILO_INSTANCE_ID`, 없으면 호스트 이름). 수신자·본문과 무관하다.
--
-- NULL 허용 컬럼 추가는 PostgreSQL 11 이상에서 테이블을 다시 쓰지 않고 바로 끝난다.
-- NULL이 되는 행: 이 마이그레이션 전에 쓴 행, lease 만료 회수로 기록한 `LEASE_EXPIRED` 시도(회수한 인스턴스는 점유한 인스턴스가 아니다).
-- 롤링 배포 중 이전 버전 인스턴스가 쓰는 행도 NULL이다.
ALTER TABLE mail_attempts ADD COLUMN instance text;

-- 길이 제한(128자). NOT VALID라 기존 행을 훑지 않고 새 행에만 적용한다. 기존 행은 모두 NULL이라 어긋나는 행이 없고, 그래서 VALIDATE CONSTRAINT가 따로 필요 없다.
ALTER TABLE mail_attempts ADD CONSTRAINT mail_attempts_instance_len
  CHECK (instance IS NULL OR char_length(instance) <= 128) NOT VALID;
