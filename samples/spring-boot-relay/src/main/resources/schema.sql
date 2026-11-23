-- 샘플 스키마. 모든 문장이 멱등이라 기동 때마다 실행해도 된다(spring.sql.init.mode=always).
-- 운영에서는 마이그레이션 도구(Flyway 등)로 옮긴다.

-- 비즈니스 테이블 예시
CREATE TABLE IF NOT EXISTS inventory (
  sku   text PRIMARY KEY,
  stock integer NOT NULL CHECK (stock >= 0)
);
CREATE TABLE IF NOT EXISTS orders (
  id             uuid PRIMARY KEY,
  sku            text NOT NULL,
  quantity       integer NOT NULL CHECK (quantity > 0),
  customer_email text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
-- 개발용 재고. SKU-EMPTY는 재고 차감 실패(롤백) 시연용이다.
INSERT INTO inventory (sku, stock) VALUES ('SKU-OK', 1000), ('SKU-EMPTY', 0) ON CONFLICT DO NOTHING;

-- outbox. 비즈니스 트랜잭션이 행을 쓰고 relay가 읽는다.
CREATE TABLE IF NOT EXISTS mail_outbox (
  id               uuid PRIMARY KEY,                 -- Idempotency-Key로 쓴다. 요청 단위로 고유하다
  request_json     text NOT NULL,                    -- 등록 시점에 확정한 REST 본문. 재시도에서 바꾸지 않는다(바꾸면 409)
  status           text NOT NULL DEFAULT 'PENDING',  -- 허용 값은 아래 mail_outbox_status_check
  attempt_count    integer NOT NULL DEFAULT 0,
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  last_http_status integer,
  last_error       text                              -- 고정 사유 코드만. 본문·수신자는 넣지 않는다
);
-- 허용 상태. 이미 만든 테이블에도 새 상태가 적용되도록 매번 교체한다(CREATE TABLE IF NOT EXISTS는 기존 테이블을 바꾸지 않는다).
-- NEEDS_CHECK는 모르는 이벤트·상태를 만나 GET /jobs로 확인하는 중이라는 뜻이다(ADR-0011 구현 순서 1).
ALTER TABLE mail_outbox DROP CONSTRAINT IF EXISTS mail_outbox_status_check;
ALTER TABLE mail_outbox ADD CONSTRAINT mail_outbox_status_check
  CHECK (status IN ('PENDING','DELIVERED','SENT','FAILED','EXPIRED','DEAD','REJECTED','QUARANTINED','NEEDS_CHECK'));
CREATE INDEX IF NOT EXISTS mail_outbox_due_idx ON mail_outbox (next_attempt_at) WHERE status = 'PENDING';

-- 이벤트 피드 cursor(행 하나). 필터를 쓰면 필터 조합마다 name을 나눈다.
CREATE TABLE IF NOT EXISTS mailo_event_cursor (
  name   text PRIMARY KEY,
  cursor text NOT NULL
);

-- FAILED·EXPIRED·INTAKE_REJECTED, 모르는 이벤트 종류(와 거부 수신자가 있는 SENT)를 사용처 쪽에 남기는 기록. event_id로 멱등하다.
CREATE TABLE IF NOT EXISTS mailo_event_log (
  event_id     text PRIMARY KEY,
  type         text NOT NULL,
  outbox_id    uuid,
  reason       text,
  payload      jsonb NOT NULL,
  occurred_at  timestamptz NOT NULL,
  received_at  timestamptz NOT NULL DEFAULT now()
);
