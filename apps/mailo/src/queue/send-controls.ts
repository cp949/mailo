import type { Queryable } from "../db/index.js";

/**
 * 정지 범위(RQ-043, ADR-0011 결정 2). REST와 `claim`이 쓰는 범위는 `all`과 `caller`뿐이다.
 * 테이블에는 `account` 범위도 있지만 다계정 단계에서 쓰므로 이 모듈은 읽지도 쓰지도 않는다.
 */
export type SendScope = { type: "all" } | { type: "caller"; id: string };

/** 점유 판정에 쓰는 정지 상태. */
export interface SendControls {
  /** 전체 정지. 대표 작업 점유를 포함해 점유하지 않는다. */
  allPaused: boolean;
  /** 정지한 호출처 ID. 할당 계산 전에 점유 대상에서 뺀다. */
  pausedCallerIds: readonly string[];
}

export interface PauseRecord {
  scope: SendScope;
  pausedAt: Date;
  /** 정지를 건 관리 토큰 이름 */
  pausedBy: string;
}

interface ControlRow {
  scope_type: "all" | "caller";
  scope_id: string;
  paused_at: Date;
  paused_by: string;
}

function scopeOf(row: Pick<ControlRow, "scope_type" | "scope_id">): SendScope {
  return row.scope_type === "all"
    ? { type: "all" }
    : { type: "caller", id: row.scope_id };
}

function toRecord(row: ControlRow): PauseRecord {
  return {
    scope: scopeOf(row),
    pausedAt: row.paused_at,
    pausedBy: row.paused_by,
  };
}

function keyOf(scope: SendScope): [string, string] {
  return scope.type === "all" ? ["all", ""] : ["caller", scope.id];
}

/**
 * 점유 트랜잭션이 읽는 정지 상태. 행을 잠그지 않는다(ADR-0011 결정 2).
 * 호출 순서는 차단기 행을 읽은 뒤다. 잠금 순서(작업 행 → 차단기 행)에 영향이 없다.
 * 쿼리 하나이고 행 수는 정지한 범위 수다.
 */
export async function readSendControls(db: Queryable): Promise<SendControls> {
  const { rows } = await db.query<Pick<ControlRow, "scope_type" | "scope_id">>(
    `SELECT scope_type, scope_id FROM mail_send_controls WHERE scope_type IN ('all', 'caller')`,
  );
  return {
    allPaused: rows.some((r) => r.scope_type === "all"),
    pausedCallerIds: rows
      .filter((r) => r.scope_type === "caller")
      .map((r) => r.scope_id),
  };
}

/**
 * 범위를 정지한다. 이미 정지면 아무것도 바꾸지 않고 `changed: false`와 기존 시각·이름을 돌려준다(멱등).
 * 시각은 DB `now()`다(ADR-0002 결정 10). 호출자가 트랜잭션을 열고 감사 기록을 같은 연결로 쓴다(ADR-0011 결정 6).
 * `DO UPDATE`로 같은 값을 다시 써서 동시에 `DELETE`가 와도 행을 잠근 채 항상 한 행을 돌려받는다.
 */
export async function setPause(
  db: Queryable,
  scope: SendScope,
  pausedBy: string,
): Promise<{ changed: boolean; pause: PauseRecord }> {
  const [type, id] = keyOf(scope);
  const { rows } = await db.query<ControlRow & { inserted: boolean }>(
    `INSERT INTO mail_send_controls (scope_type, scope_id, paused_at, paused_by)
     VALUES ($1, $2, now(), $3)
     ON CONFLICT (scope_type, scope_id) DO UPDATE SET scope_type = EXCLUDED.scope_type
     RETURNING scope_type, scope_id, paused_at, paused_by, (xmax = 0) AS inserted`,
    [type, id, pausedBy],
  );
  const row = rows[0]!;
  return { changed: row.inserted, pause: toRecord(row) };
}

/** 범위의 정지를 푼다. 정지가 없으면 `changed: false`다. 정지를 풀어도 차단기 상태는 바뀌지 않는다. */
export async function clearPause(
  db: Queryable,
  scope: SendScope,
): Promise<{ changed: boolean }> {
  const [type, id] = keyOf(scope);
  const { rowCount } = await db.query(
    "DELETE FROM mail_send_controls WHERE scope_type = $1 AND scope_id = $2",
    [type, id],
  );
  return { changed: (rowCount ?? 0) > 0 };
}

/** 정지 목록. `all`과 `caller`만 낸다. 정지 시각 순서다. */
export async function listPauses(db: Queryable): Promise<PauseRecord[]> {
  const { rows } = await db.query<ControlRow>(
    `SELECT scope_type, scope_id, paused_at, paused_by FROM mail_send_controls
      WHERE scope_type IN ('all', 'caller')
      ORDER BY paused_at, scope_type, scope_id`,
  );
  return rows.map(toRecord);
}

/** 호출처 키 `/health/ready`의 `sendPaused`. 그 호출처에 해당하는 정지만 요약하고 `all`이 우선한다(ADR-0011 결정 2). */
export async function getCallerPauseSummary(
  db: Queryable,
  callerId: string,
): Promise<{ paused: boolean; scope: "all" | "caller" | null }> {
  const { rows } = await db.query<{ scope_type: "all" | "caller" }>(
    `SELECT scope_type FROM mail_send_controls
      WHERE (scope_type = 'all') OR (scope_type = 'caller' AND scope_id = $1)
      ORDER BY scope_type`,
    [callerId],
  );
  // `all`이 사전순으로 `caller`보다 앞이다.
  const scope = rows[0]?.scope_type ?? null;
  return { paused: scope !== null, scope };
}

/** 운영자 `/health/ready`의 `sendControls`. 호출처 ID는 담지 않는다(ADR-0011 결정 2). */
export async function getSendControlsSummary(
  db: Queryable,
): Promise<{ allPaused: boolean; pausedCallerCount: number }> {
  const { rows } = await db.query<{ all_paused: boolean; callers: number }>(
    `SELECT bool_or(scope_type = 'all') AS all_paused,
            (count(*) FILTER (WHERE scope_type = 'caller'))::int AS callers
       FROM mail_send_controls WHERE scope_type IN ('all', 'caller')`,
  );
  return {
    allPaused: rows[0]?.all_paused ?? false,
    pausedCallerCount: rows[0]?.callers ?? 0,
  };
}
