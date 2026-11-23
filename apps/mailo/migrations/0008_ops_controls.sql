-- 발송 정지와 관리 감사(RQ-042~044, ADR-0011 결정 2·6·10). 0001~0007은 수정하지 않고 새 테이블만 만든다.
-- 기존 테이블을 잠그지 않으므로 구버전 인스턴스와 함께 적용해도 영향이 없다. 구버전은 이 테이블을 읽지 않는다.
-- 시각은 DB now() 기준이다(ADR-0002 결정 10). 이 마이그레이션은 되돌리지 않는다.

-- 발송 정지. 행이 있으면 그 범위는 정지다. 자유 텍스트 컬럼은 없다(RQ-027).
-- scope_type 'account'는 다계정 단계(단계 7)에서 마이그레이션 없이 쓰려고 스키마에만 둔다. 이 버전의 REST와 claim은 쓰지 않는다.
CREATE TABLE mail_send_controls (
  scope_type text NOT NULL CHECK (scope_type IN ('all', 'account', 'caller')),
  scope_id text NOT NULL,                      -- all은 빈 문자열, 그 밖은 호출처 ID·계정 ID
  paused_at timestamptz NOT NULL DEFAULT now(),
  paused_by text NOT NULL CHECK (char_length(paused_by) BETWEEN 1 AND 32),  -- 관리 토큰 이름
  PRIMARY KEY (scope_type, scope_id),
  CONSTRAINT mail_send_controls_scope_id CHECK (
    (scope_type = 'all') = (scope_id = '') AND char_length(scope_id) <= 64
  )
);

-- 관리 작업 감사. 상태를 바꾼 요청만 같은 트랜잭션에서 쓴다. 자유 텍스트(사유·메모) 컬럼은 없다(RQ-027).
-- job_id에 외래 키를 두지 않는다. 작업 행이 보존 기간 뒤 지워져도 기록이 남는다.
CREATE TABLE mail_ops_audit (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL DEFAULT now(),
  actor text NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 32),          -- 관리 토큰 이름
  action text NOT NULL CHECK (action IN ('PAUSE', 'RESUME', 'CANCEL_JOB')),
  scope_type text CHECK (scope_type IN ('all', 'account', 'caller')),
  scope_id text,
  job_id uuid,
  -- 동작별 필드 조합. 정지·재개는 범위만, 취소는 작업 ID만 가진다.
  CONSTRAINT mail_ops_audit_shape CHECK (
    (action IN ('PAUSE', 'RESUME')
       AND scope_type IS NOT NULL AND scope_id IS NOT NULL AND job_id IS NULL
       AND (scope_type = 'all') = (scope_id = '') AND char_length(scope_id) <= 64)
    OR
    (action = 'CANCEL_JOB'
       AND job_id IS NOT NULL AND scope_type IS NULL AND scope_id IS NULL)
  )
);
