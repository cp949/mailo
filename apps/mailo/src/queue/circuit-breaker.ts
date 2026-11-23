import { randomUUID } from "node:crypto";
import type { Queryable } from "../db/index.js";
import { breakerInitialWait, breakerWaitCap } from "./retry-policy.js";
import type {
  AccountErrorReason,
  BreakerConfig,
  BreakerSnapshot,
  BreakerState,
} from "./types.js";

interface BreakerRow {
  state: BreakerState;
  open_until: Date | null;
  probe_until: Date | null;
  probe_job_id: string | null;
  consecutive_failures: number;
  wait_seconds: number;
  last_reason: string | null;
}

const SNAPSHOT_COLUMNS = `state, open_until, probe_until, probe_job_id,
  consecutive_failures, wait_seconds, last_reason`;

function toSnapshot(row: BreakerRow): BreakerSnapshot {
  return {
    state: row.state,
    openUntil: row.open_until,
    probeUntil: row.probe_until,
    probeJobId: row.probe_job_id,
    consecutiveFailures: row.consecutive_failures,
    waitSeconds: row.wait_seconds,
    lastReason: row.last_reason,
  };
}

/** 차단기 현재 상태. 헬스 응답(RQ-031)과 claim 사전 확인이 쓴다. */
export async function getBreakerState(
  db: Queryable,
  config: Pick<BreakerConfig, "breakerKey">,
): Promise<BreakerSnapshot> {
  const { rows } = await db.query<BreakerRow>(
    `SELECT ${SNAPSHOT_COLUMNS} FROM mail_circuit_breaker WHERE breaker_key = $1`,
    [config.breakerKey],
  );
  const row = rows[0];
  if (!row) throw new Error("차단기 행이 없다. 마이그레이션을 확인한다");
  return toSnapshot(row);
}

export interface AccountFailureResult {
  snapshot: BreakerSnapshot;
  /** 이 호출이 차단기를 open으로 바꿨는지(closed→open 또는 half_open→open) */
  tripped: boolean;
}

/**
 * 계정 상태 오류를 차단기에 기록한다. 연속 실패 수 증가와 상태 전이를 `UPDATE ... RETURNING` 한 문장으로 한다(ADR-0007 결정 5).
 *
 * - closed: 연속 실패 수를 1 늘린다. 임계값에 이르거나 한도 초과 사유이면 open으로 바꾼다.
 *   대기 시간은 사유별 초기값이다.
 * - half_open이고 `jobId`가 대표 작업이면 open으로 되돌린다. 대기 시간은 이전의 2배이며 사유별 상한을 넘지 않는다.
 *   대기 시간은 사유별 초기값 아래로 내려가지 않는다.
 * - 그 밖(open 중이거나 대표가 아닌 작업의 늦은 실패)은 상태를 바꾸지 않는다.
 *
 * 호출 순서 규칙: 작업 행 잠금을 먼저 잡고 이 함수를 부른다. claim도 같은 순서(작업 → 차단기)라서 교착이 없다.
 */
export async function recordAccountFailure(
  db: Queryable,
  config: BreakerConfig,
  params: { jobId: string; reason: AccountErrorReason },
): Promise<AccountFailureResult> {
  const initial = breakerInitialWait(config, params.reason);
  const cap = breakerWaitCap(config, params.reason);
  const immediate = config.immediateOpenReasons.includes(params.reason);
  const token = randomUUID();

  // $1 jobId, $2 임계값, $3 즉시 open 여부, $4 초기 대기, $5 상한, $6 키, $7 사유, $8 전이 식별 토큰
  const trip = `(state = 'closed' AND (consecutive_failures + 1 >= $2::int OR $3::boolean))`;
  const reopen = `(state = 'half_open' AND probe_job_id = $1::uuid)`;
  const doubled = `LEAST($5::int, GREATEST($4::int, wait_seconds * 2))`;

  const { rows } = await db.query<BreakerRow & { tripped: boolean }>(
    `UPDATE mail_circuit_breaker SET
       consecutive_failures = CASE WHEN state = 'closed'
         THEN consecutive_failures + 1 ELSE consecutive_failures END,
       wait_seconds = CASE
         WHEN ${trip} THEN $4::int
         WHEN ${reopen} THEN ${doubled}
         ELSE wait_seconds END,
       open_until = CASE
         WHEN ${trip} THEN now() + make_interval(secs => $4::int)
         WHEN ${reopen} THEN now() + make_interval(secs => ${doubled})
         ELSE open_until END,
       probe_until = CASE WHEN ${trip} OR ${reopen} THEN NULL ELSE probe_until END,
       probe_job_id = CASE WHEN ${trip} OR ${reopen} THEN NULL ELSE probe_job_id END,
       last_trip_job_id = CASE WHEN ${trip} OR ${reopen} THEN $1::uuid ELSE last_trip_job_id END,
       last_trip_token = CASE WHEN ${trip} OR ${reopen} THEN $8::uuid ELSE last_trip_token END,
       last_reason = CASE WHEN state = 'closed' OR ${reopen} THEN $7::text ELSE last_reason END,
       state = CASE WHEN ${trip} OR ${reopen} THEN 'open' ELSE state END,
       updated_at = now()
     WHERE breaker_key = $6
     RETURNING ${SNAPSHOT_COLUMNS}, (last_trip_token = $8::uuid) AS tripped`,
    [
      params.jobId,
      config.failureThreshold,
      immediate,
      initial,
      cap,
      config.breakerKey,
      params.reason,
      token,
    ],
  );
  const row = rows[0];
  if (!row) throw new Error("차단기 행이 없다. 마이그레이션을 확인한다");
  return { snapshot: toSnapshot(row), tripped: row.tripped };
}

/**
 * 계정이 정상으로 보이는 결과(SENT, 메시지 오류)를 기록한다. 연속 실패 수를 0으로 만들고,
 * half_open의 대표 작업이면 closed로 돌아간다(ADR-0007 결정 5). `UPDATE ... RETURNING` 한 문장이다.
 * 바꿀 것이 없으면(연속 실패 0이고 대표 작업이 아님) 행을 잠그지 않는다. 모든 Worker가 이 행을 두고 경합하지 않게 하기 위해서다.
 * @returns 갱신했으면 새 상태, 아니면 null
 */
export async function recordAccountOk(
  db: Queryable,
  config: Pick<BreakerConfig, "breakerKey">,
  params: { jobId: string },
): Promise<BreakerSnapshot | null> {
  const closing = `(state = 'half_open' AND probe_job_id = $1::uuid)`;
  const { rows } = await db.query<BreakerRow>(
    `UPDATE mail_circuit_breaker SET
       consecutive_failures = 0,
       wait_seconds = CASE WHEN ${closing} THEN 0 ELSE wait_seconds END,
       open_until = CASE WHEN ${closing} THEN NULL ELSE open_until END,
       probe_until = CASE WHEN ${closing} THEN NULL ELSE probe_until END,
       probe_job_id = CASE WHEN ${closing} THEN NULL ELSE probe_job_id END,
       state = CASE WHEN ${closing} THEN 'closed' ELSE state END,
       updated_at = now()
     WHERE breaker_key = $2
       AND (consecutive_failures > 0 OR ${closing})
     RETURNING ${SNAPSHOT_COLUMNS}`,
    [params.jobId, config.breakerKey],
  );
  const row = rows[0];
  return row ? toSnapshot(row) : null;
}
