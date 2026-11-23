/**
 * 발송 우선순위 등급과 DB 순위(RQ-033·035, ADR-0009). 등급 이름과 순위 숫자의 대응은 이 파일에만 둔다.
 * - 요청·응답·지문은 등급 이름만 쓴다. 순위 숫자는 DB 정렬용이며 밖으로 내보내지 않는다(RQ-034·037).
 * - 등급 사이에 간격을 둔다. 나중에 등급을 끼워 넣어도 기존 행을 바꾸지 않기 위해서다(RQ-038).
 * - 숫자를 바꾸면 `migrations/0004_job_priority.sql`의 DEFAULT·CHECK와 함께 새 마이그레이션이 필요하다.
 */

/** 늦게 점유하는 등급부터 나열한다. */
export const PRIORITIES = ["LOW", "NORMAL", "HIGH", "URGENT"] as const;

export type Priority = (typeof PRIORITIES)[number];

/** 요청이 우선순위를 생략했을 때의 등급. 도입 전 작업도 이 등급으로 읽힌다(DB DEFAULT). */
export const DEFAULT_PRIORITY: Priority = "NORMAL";

/** 등급별 DB 순위(`mail_jobs.priority`). 클수록 먼저 점유한다. */
export const PRIORITY_RANK: Readonly<Record<Priority, number>> = {
  LOW: 10,
  NORMAL: 20,
  HIGH: 30,
  URGENT: 40,
};

/** 대소문자를 구분해 등급 이름인지 본다. */
export function isPriority(value: unknown): value is Priority {
  return (
    typeof value === "string" &&
    (PRIORITIES as readonly string[]).includes(value)
  );
}

/**
 * DB 순위를 등급 이름으로 바꾼다. CHECK 제약(`mail_jobs_priority_rank`) 밖의 값이면 예외다.
 * 정의되지 않은 순위를 다른 등급으로 바꿔 보여 주지 않기 위해서다.
 */
export function priorityFromRank(rank: number): Priority {
  const found = PRIORITIES.find((p) => PRIORITY_RANK[p] === rank);
  if (found === undefined)
    throw new Error(`알 수 없는 우선순위 순위다 (rank=${rank})`);
  return found;
}
