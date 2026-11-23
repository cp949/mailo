-- 이벤트 삭제 표지(RQ-045, ADR-0011 결정 9·10). 0001~0008은 수정하지 않고 새 테이블만 만든다.
-- 기존 테이블을 잠그지 않으므로 구버전 인스턴스와 함께 적용해도 영향이 없다. 구버전은 이 테이블을 쓰지 않는다.
-- 이 마이그레이션은 되돌리지 않는다.

-- 보존 삭제가 지운 이벤트 중 (txid, id) 순서가 가장 큰 위치를 호출처·종류별로 담는다.
-- 피드가 cursor 뒤에서 이벤트가 삭제됐는지 판정하는 근거다. 값은 줄어들지 않는다.
-- 행 수의 상한은 (호출처 수 × 이벤트 종류 수)이고 삭제 이벤트가 없는 호출처·종류는 행이 없다. 그래서 정리 정책이 없다.
-- type에는 CHECK를 두지 않는다. mail_events.type에서 복사한 값이라 종류가 늘어도 이 테이블을 바꾸지 않는다.
CREATE TABLE mail_event_purges (
  caller_id text NOT NULL,
  type text NOT NULL,
  purged_txid xid8 NOT NULL,
  purged_id bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (caller_id, type)
);
