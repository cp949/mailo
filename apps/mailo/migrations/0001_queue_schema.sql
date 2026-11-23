-- 큐·이벤트·차단기 스키마 (ADR-0002, 0005, 0006, 0007, 0008).
-- 시각은 모두 DB now() 기준이다(ADR-0002 결정 10). PostgreSQL 13 이상이 필요하다(xid8, pg_snapshot_xmin).

-- 발송 작업. 한 건당 한 행이며 Key 보존 기간(종결 후 30일)이 지나야 삭제한다(ADR-0005 결정 7).
CREATE TABLE mail_jobs (
  id uuid PRIMARY KEY,                         -- INSERT 전에 앱이 만든 UUID. 본문 암호화의 AAD다(ADR-0008 결정 6).
  caller_id text NOT NULL,
  idempotency_key text NOT NULL
    CHECK (char_length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key ~ '^[A-Za-z0-9._:-]+$'),
  fingerprint bytea NOT NULL,                  -- HMAC-SHA256(지문 키, 정규화한 평문 요청). ADR-0005 결정 3.
  fingerprint_key_version integer NOT NULL,
  status text NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING', 'SENDING', 'RETRY_WAIT', 'SENT', 'FAILED', 'EXPIRED')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),  -- 최대 시도 횟수에 포함되는 시도 수. 계정 상태 오류는 제외(ADR-0007 결정 2).
  account_trips integer NOT NULL DEFAULT 0 CHECK (account_trips >= 0),  -- 이 작업이 차단기를 연 횟수(ADR-0007 결정 4).
  last_account_response text,                  -- 직전 계정 상태 오류의 "코드 enhanced코드". 같은 응답 판정용.
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  leased_at timestamptz,                       -- 현재 점유 시작 시각. mail_attempts.started_at에 쓴다.
  lease_token uuid,                            -- 점유마다 새로 만든다(ADR-0002 결정 6).
  lease_until timestamptz,
  recipients jsonb NOT NULL,                   -- 수신자는 평문이다(RQ-022). 이벤트에 복사된다.
  envelope jsonb NOT NULL DEFAULT '{}'::jsonb, -- 복호화 없이 필요한 평문 발송 필드(from, replyTo 등). 큐는 내용을 해석하지 않는다.
  body_ciphertext bytea,                       -- 제목·text·html. AES-256-GCM(ADR-0008 결정 6). 삭제 뒤 NULL.
  body_nonce bytea,
  body_key_version integer,
  body_deleted_at timestamptz,
  failure_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,                     -- 종결(SENT·FAILED·EXPIRED) 시각. 보존 기간의 기준이다.
  CONSTRAINT mail_jobs_idempotency UNIQUE (caller_id, idempotency_key),
  CONSTRAINT mail_jobs_lease_state CHECK (
    (status = 'SENDING') = (lease_token IS NOT NULL AND lease_until IS NOT NULL AND leased_at IS NOT NULL)
  ),
  CONSTRAINT mail_jobs_terminal_state CHECK (
    (status IN ('SENT', 'FAILED', 'EXPIRED')) = (finished_at IS NOT NULL)
  ),
  CONSTRAINT mail_jobs_body_state CHECK (
    (body_ciphertext IS NULL) = (body_nonce IS NULL)
    AND (body_ciphertext IS NULL) = (body_key_version IS NULL)
  )
);

-- 점유 대상(ADR-0002 미확정 항목의 부분 인덱스를 둔다).
CREATE INDEX mail_jobs_claim_idx ON mail_jobs (next_attempt_at, id)
  WHERE status IN ('PENDING', 'RETRY_WAIT');
-- 만료 sweep 대상
CREATE INDEX mail_jobs_expiry_idx ON mail_jobs (expires_at)
  WHERE status IN ('PENDING', 'RETRY_WAIT');
-- lease 복구 대상
CREATE INDEX mail_jobs_lease_idx ON mail_jobs (lease_until)
  WHERE status = 'SENDING';
-- 본문 삭제·보존 삭제 대상
CREATE INDEX mail_jobs_finished_idx ON mail_jobs (finished_at)
  WHERE finished_at IS NOT NULL;
CREATE INDEX mail_jobs_body_idx ON mail_jobs (finished_at)
  WHERE finished_at IS NOT NULL AND body_ciphertext IS NOT NULL;

-- 시도 이력. 작업 행을 지우면 함께 지운다(ADR-0005 결정 7).
CREATE TABLE mail_attempts (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES mail_jobs (id) ON DELETE CASCADE,
  classification text NOT NULL
    CHECK (classification IN ('SENT', 'TRANSIENT', 'PERMANENT', 'ACCOUNT', 'LEASE_EXPIRED')),
  counted boolean NOT NULL,                    -- 최대 시도 횟수에 포함했는지. ACCOUNT는 false다.
  stage text,                                  -- CONN, TLS, AUTH, MAIL_FROM, RCPT, DATA 등
  response_code integer,
  enhanced_code text,
  response_text text,                          -- 본문은 기록하지 않는다. 수신자 주소가 섞일 수 있다(ADR-0007 미확정).
  rejected_recipients jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX mail_attempts_job_idx ON mail_attempts (job_id, id);

-- 수집 거부 기록. 원본은 남기지 않는다(ADR-0006 결정 3).
CREATE TABLE mail_intake_rejections (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  caller_id text NOT NULL,
  file_name text NOT NULL,
  size_bytes bigint NOT NULL CHECK (size_bytes >= 0),
  sha256 text NOT NULL,                        -- 소문자 hex
  idempotency_key text,                        -- 파싱한 경우만
  reason_code text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_intake_rejections_once UNIQUE (caller_id, file_name, sha256)
);
CREATE INDEX mail_intake_rejections_created_idx ON mail_intake_rejections (created_at);

-- 종결 이벤트 피드(ADR-0006 결정 2·7). 전이와 같은 트랜잭션에서 쓴다.
CREATE TABLE mail_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  txid xid8 NOT NULL DEFAULT pg_current_xact_id(),  -- cursor 경계. 쓰는 트랜잭션의 id다.
  caller_id text NOT NULL,
  type text NOT NULL CHECK (type IN ('JOB_SENT', 'JOB_FAILED', 'JOB_EXPIRED', 'INTAKE_REJECTED')),
  job_id uuid REFERENCES mail_jobs (id) ON DELETE CASCADE,
  rejection_id bigint REFERENCES mail_intake_rejections (id) ON DELETE CASCADE,
  idempotency_key text,
  failure_reason text,
  failure_detail text,                         -- 응답 코드와 enhanced status code만 담는다. 응답 텍스트는 넣지 않는다.
  attempt_count integer,
  recipients jsonb,
  rejected_recipients jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_events_subject CHECK (
    (type = 'INTAKE_REJECTED' AND rejection_id IS NOT NULL AND job_id IS NULL)
    OR (type <> 'INTAKE_REJECTED' AND job_id IS NOT NULL AND rejection_id IS NULL)
  )
);
CREATE INDEX mail_events_feed_idx ON mail_events (caller_id, txid, id);
CREATE INDEX mail_events_job_idx ON mail_events (job_id) WHERE job_id IS NOT NULL;
CREATE INDEX mail_events_rejection_idx ON mail_events (rejection_id) WHERE rejection_id IS NOT NULL;

-- 전역 차단기(ADR-0007 결정 5). SMTP 구성 하나당 한 행이며 1단계는 'default' 한 행이다.
CREATE TABLE mail_circuit_breaker (
  breaker_key text PRIMARY KEY,
  state text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  open_until timestamptz,
  probe_until timestamptz,                     -- half_open 대표 작업의 lease와 같은 값
  probe_job_id uuid,
  consecutive_failures integer NOT NULL DEFAULT 0,
  wait_seconds integer NOT NULL DEFAULT 0,     -- 마지막 open 대기 시간. 대표 작업이 실패할 때마다 2배로 늘린다.
  last_reason text,
  last_trip_job_id uuid,                       -- 직전에 차단기를 연 작업. 대표 선택에서 뒤로 미룬다.
  last_trip_token uuid,                        -- 이 행을 open으로 바꾼 호출을 식별한다(전이 여부 확인용).
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_circuit_breaker_open CHECK (state <> 'open' OR open_until IS NOT NULL),
  CONSTRAINT mail_circuit_breaker_probe CHECK (state <> 'half_open' OR (probe_until IS NOT NULL AND probe_job_id IS NOT NULL))
);
INSERT INTO mail_circuit_breaker (breaker_key) VALUES ('default');
