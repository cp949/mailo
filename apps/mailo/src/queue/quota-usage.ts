import type { Queryable } from "../db/index.js";

/**
 * 호출처별 24시간 할당 사용량 쿼리(RQ-032). 점유 경로(`claim`의 `planQuotas`)와 지표 수집이 같은 문장을 쓴다(ADR-0012 결정 5).
 * 사용량 = 최근 24시간의 "할당에 드는 시도"(counted, 내부 오류 제외)를 한도까지 센 값 + 현재 `SENDING` 수다.
 * 시도 쪽은 `LIMIT 할당`에서 멈추므로 비용이 호출처 수 × 한도로 막힌다. `mail_attempts_quota_idx` 인덱스 전용 스캔이다.
 * 매개변수: `$1` 호출처 ID 배열, `$2` 같은 순서의 한도 배열, `$3` 읽을 호출처 ID 배열. 시각은 DB `now()`다(ADR-0002 결정 10).
 */
export const CALLER_QUOTA_USAGE_SQL = `SELECT q.caller_id,
            ( (SELECT count(*) FROM (
                 SELECT 1 FROM mail_attempts a
                  WHERE a.caller_id = q.caller_id
                    AND a.counted AND a.stage IS DISTINCT FROM 'WORKER'
                    AND a.finished_at > now() - interval '24 hours'
                  LIMIT q.quota) recent)
              + (SELECT count(*) FROM mail_jobs j
                  WHERE j.caller_id = q.caller_id AND j.status = 'SENDING')
            )::int AS used
       FROM unnest($1::text[], $2::int[]) AS q(caller_id, quota)
      WHERE q.caller_id = ANY($3::text[])`;

/**
 * 호출처별 할당 사용량을 읽는다. advisory lock을 잡지 않고 쓰지 않는다. 지표용이다(ADR-0012 결정 5).
 * 시도 쪽 값은 한도에서 멈추지만 점유 중 수를 더하므로 사용량이 한도를 넘을 수 있다. 할당이 없는 호출처는 `quotas`에 넣지 않는다. 호출처가 없으면 쿼리하지 않는다.
 */
export async function getCallerQuotaUsage(
  db: Queryable,
  quotas: ReadonlyMap<string, number>,
): Promise<Map<string, number>> {
  if (quotas.size === 0) return new Map();
  const ids = [...quotas.keys()];
  const limits = ids.map((id) => quotas.get(id)!);
  const { rows } = await db.query<{ caller_id: string; used: number }>(
    CALLER_QUOTA_USAGE_SQL,
    [ids, limits, ids],
  );
  return new Map(rows.map((r) => [r.caller_id, r.used]));
}
