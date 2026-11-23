import type { Queryable } from "../db/index.js";
import { decodeCursor } from "./cursor.js";
import type { EventType } from "./types.js";

/**
 * 같은 `(caller_id, type)`의 기존 표지보다 큰 위치만 올린다. 표지는 줄어들지 않는다.
 * 후보는 지울 이벤트 중 호출처·종류별 `(txid, id)` 최대 한 건이다(`DISTINCT ON`).
 * `txid`·`id`는 숫자 순서로 정렬한다(별칭 없이 원본 컬럼을 쓴다).
 */
const UPSERT_PURGE_MARKS = (selector: string) => `
  INSERT INTO mail_event_purges (caller_id, type, purged_txid, purged_id)
  SELECT DISTINCT ON (caller_id, type) caller_id, type, txid, id
    FROM mail_events
   WHERE ${selector}
   ORDER BY caller_id, type, txid DESC, id DESC
  ON CONFLICT (caller_id, type) DO UPDATE
     SET purged_txid = EXCLUDED.purged_txid,
         purged_id = EXCLUDED.purged_id,
         updated_at = now()
   WHERE (mail_event_purges.purged_txid, mail_event_purges.purged_id)
         < (EXCLUDED.purged_txid, EXCLUDED.purged_id)`;

/**
 * 지우려는 작업의 이벤트를 삭제 표지에 올린다(ADR-0011 결정 9). 작업 삭제 전에, 같은 트랜잭션의 client로 부른다.
 * 이벤트는 외래 키 `ON DELETE CASCADE`로 지워져 `DELETE ... RETURNING`에 나오지 않으므로 삭제 전에 읽어야 한다.
 * 호출자는 `jobIds` 행을 `FOR UPDATE`로 잡은 상태여야 한다. 종결된 작업에는 새 이벤트가 생기지 않으므로 읽은 값이 삭제 값과 같다.
 */
export async function recordPurgedJobEvents(
  db: Queryable,
  jobIds: readonly string[],
): Promise<void> {
  if (jobIds.length === 0) return;
  await db.query(UPSERT_PURGE_MARKS("job_id = ANY($1::uuid[])"), [jobIds]);
}

/** 지우려는 수집 거부 기록의 `INTAKE_REJECTED` 이벤트를 삭제 표지에 올린다. 조건은 `recordPurgedJobEvents`와 같다. */
export async function recordPurgedRejectionEvents(
  db: Queryable,
  rejectionIds: readonly string[],
): Promise<void> {
  if (rejectionIds.length === 0) return;
  await db.query(UPSERT_PURGE_MARKS("rejection_id = ANY($1::bigint[])"), [
    rejectionIds,
  ]);
}

export interface EventGapOptions {
  callerId: string;
  /** 요청의 `after`. 이 모듈이 만든 cursor여야 한다. */
  after: string;
  /** 요청의 `type` 필터. 비면 모든 종류다. */
  types?: readonly EventType[] | null;
}

/**
 * `after` 뒤에서 이벤트가 삭제됐는지 판정한다(ADR-0011 결정 9).
 * 요청한 종류(필터가 없으면 모든 종류)의 삭제 표지 중 하나라도 cursor보다 크면 공백이다.
 * 표지가 cursor와 같거나 작으면 호출처가 이미 지나온 이벤트라 누락이 아니다.
 * 이벤트를 읽은 뒤에 불러야 한다. 반대 순서면 두 조회 사이에 커밋된 삭제의 누락을 놓친다.
 * @throws InvalidCursorError `after`가 이 모듈이 만든 cursor가 아닐 때
 */
export async function hasEventGap(
  db: Queryable,
  options: EventGapOptions,
): Promise<boolean> {
  const cursor = decodeCursor(options.after);
  const types =
    options.types && options.types.length > 0 ? [...options.types] : null;
  const { rows } = await db.query<{ gap: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM mail_event_purges
        WHERE caller_id = $1
          AND ($2::text[] IS NULL OR type = ANY($2::text[]))
          AND (purged_txid, purged_id) > ($3::xid8, $4::bigint)
     ) AS gap`,
    [options.callerId, types, cursor.txid, cursor.id],
  );
  return rows[0]?.gap === true;
}
