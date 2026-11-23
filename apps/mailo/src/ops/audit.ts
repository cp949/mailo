import type { Queryable } from "../db/index.js";
import type { SendScope } from "../queue/index.js";

/** 감사 항목. 항목은 토큰 이름, 동작, 범위, 대상 ID, 시각뿐이다(ADR-0011 결정 6). 자유 텍스트는 없다(RQ-027). */
export type AuditWrite =
  | { actor: string; action: "PAUSE" | "RESUME"; scope: SendScope }
  | { actor: string; action: "CANCEL_JOB"; jobId: string };

export interface AuditEntry {
  /** bigint identity. 정밀도를 잃지 않게 문자열이다. */
  id: string;
  at: Date;
  actor: string;
  action: string;
  scope?: { type: string; id?: string };
  jobId?: string;
}

/**
 * 감사 행 하나를 쓴다. 상태를 바꾼 요청만 부른다. 호출자가 연 트랜잭션의 연결을 받아 상태 변경과 같은 트랜잭션에서 쓴다.
 * 시각은 DB `now()`다(ADR-0002 결정 10).
 */
export async function writeAudit(
  db: Queryable,
  entry: AuditWrite,
): Promise<void> {
  if (entry.action === "CANCEL_JOB") {
    await db.query(
      `INSERT INTO mail_ops_audit (at, actor, action, job_id) VALUES (now(), $1, 'CANCEL_JOB', $2)`,
      [entry.actor, entry.jobId],
    );
    return;
  }
  await db.query(
    `INSERT INTO mail_ops_audit (at, actor, action, scope_type, scope_id) VALUES (now(), $1, $2, $3, $4)`,
    [
      entry.actor,
      entry.action,
      entry.scope.type,
      entry.scope.type === "all" ? "" : entry.scope.id,
    ],
  );
}

interface AuditRow {
  id: string;
  at: Date;
  actor: string;
  action: string;
  scope_type: string | null;
  scope_id: string | null;
  job_id: string | null;
}

/**
 * 최근 순서로 읽는다. `before`보다 작은 id만 준다. `limit`건을 넘게 있으면 `nextBefore`에 마지막 항목의 id를 준다.
 * 한 건 더 읽어 다음 쪽이 있는지 판정한다. 기본키(`id`) 역순 범위 조회라 쪽 깊이와 무관하게 일정하다.
 */
export async function listAudit(
  db: Queryable,
  options: { limit: number; before: string | null },
): Promise<{ entries: AuditEntry[]; nextBefore: string | null }> {
  const { rows } = await db.query<AuditRow>(
    `SELECT id::text, at, actor, action, scope_type, scope_id, job_id
       FROM mail_ops_audit
      WHERE ($1::bigint IS NULL OR id < $1::bigint)
      ORDER BY id DESC
      LIMIT $2`,
    [options.before, options.limit + 1],
  );
  const page = rows.slice(0, options.limit);
  const entries = page.map((row): AuditEntry => {
    const entry: AuditEntry = {
      id: row.id,
      at: row.at,
      actor: row.actor,
      action: row.action,
    };
    if (row.scope_type !== null)
      entry.scope =
        row.scope_type === "all"
          ? { type: "all" }
          : { type: row.scope_type, id: row.scope_id ?? "" };
    if (row.job_id !== null) entry.jobId = row.job_id;
    return entry;
  });
  return {
    entries,
    nextBefore:
      rows.length > options.limit
        ? (entries[entries.length - 1]?.id ?? null)
        : null,
  };
}

/** 감사 행 수를 세는 상한. 이 수를 넘으면 정확한 수를 세지 않고 `truncated`로 알린다(ADR-0012 결정 8). */
export const AUDIT_COUNT_LIMIT = 100_000;

export interface AuditStats {
  /** 감사 행 수. `AUDIT_COUNT_LIMIT`에서 멈춘다. */
  rows: number;
  /** 행 수가 상한을 넘었다. */
  truncated: boolean;
  /** 가장 오래된 행의 경과 초. 행이 없으면 null이다. */
  oldestAgeSeconds: number | null;
}

/**
 * 감사 테이블 행 수와 가장 오래된 행의 나이. `/metrics`의 `mailo_ops_audit_*`가 쓴다(RQ-049, ADR-0012 결정 8).
 * 행 수는 상한+1까지만 읽고(`LIMIT`), 가장 오래된 행은 기본키 정순 한 행이다. 읽기 전용이다. 시각은 DB `now()`다.
 */
export async function getAuditStats(db: Queryable): Promise<AuditStats> {
  const { rows } = await db.query<{ n: number; oldest: number | null }>(
    `SELECT (SELECT count(*)::int FROM (SELECT 1 FROM mail_ops_audit LIMIT $1) c) AS n,
            (SELECT EXTRACT(EPOCH FROM (now() - at))::float8
               FROM mail_ops_audit ORDER BY id LIMIT 1) AS oldest`,
    [AUDIT_COUNT_LIMIT + 1],
  );
  const n = rows[0]?.n ?? 0;
  const oldest = rows[0]?.oldest ?? null;
  return {
    rows: Math.min(n, AUDIT_COUNT_LIMIT),
    truncated: n > AUDIT_COUNT_LIMIT,
    oldestAgeSeconds: oldest === null ? null : Math.max(0, Math.round(oldest)),
  };
}
