import type { CallerRegistry } from "../callers/index.js";
import type { FilePollerStatus } from "../file-channel/index.js";
import type { Sample } from "../metrics/index.js";
import { PRIORITIES } from "../queue/index.js";
import type { WorkerStatus } from "../worker/index.js";
import { lastReasonOf } from "./breaker-reason.js";
import { METRICS_GROUPS, type GlobalSnapshot } from "./metrics-collector.js";

const sample = (
  name: string,
  value: number,
  labels: Record<string, string> = {},
): Sample => ({ name, labels, value });

/**
 * 전역 gauge 시리즈(ADR-0012 결정 4, ADR-0013 결정 5). 실패한 그룹은 시리즈를 내지 않는다.
 * 호출처 라벨은 이 인스턴스의 레지스트리 ID, 계정 라벨은 이 인스턴스가 구성한 계정 ID만 쓴다.
 * DB에 남은 레지스트리·구성 밖 호출처·계정의 값은 시리즈로 만들지 않는다(결정 6). 구성 밖 계정의 정지는 `mailo_send_paused_accounts`가 센다.
 */
export function globalSamples(
  snapshot: GlobalSnapshot,
  registry: CallerRegistry,
  accounts: ReadonlyArray<{ id: string; sendQuota24h: number | null }>,
): Sample[] {
  const out: Sample[] = [];

  if (snapshot.queue !== undefined) {
    for (const { id } of accounts) {
      const depth = snapshot.queue.get(id);
      if (depth === undefined) continue;
      const { due, scheduled, sending, backlog } = depth;
      const account = { account_id: id };
      out.push(
        sample("mailo_queue_jobs", due.count, { ...account, state: "due" }),
        sample("mailo_queue_jobs", scheduled.count, {
          ...account,
          state: "scheduled",
        }),
        sample("mailo_queue_jobs", sending, { ...account, state: "sending" }),
        sample("mailo_queue_jobs_truncated", due.truncated ? 1 : 0, {
          ...account,
          state: "due",
        }),
        sample("mailo_queue_jobs_truncated", scheduled.truncated ? 1 : 0, {
          ...account,
          state: "scheduled",
        }),
      );
      for (const priority of PRIORITIES)
        out.push(
          sample(
            "mailo_queue_oldest_due_age_seconds",
            backlog.byPriority[priority].oldestDueAgeSeconds ?? 0,
            { ...account, priority: priority.toLowerCase() },
          ),
        );
    }
  }

  if (snapshot.breaker !== undefined) {
    for (const { id } of accounts) {
      const breaker = snapshot.breaker.get(id);
      if (breaker === undefined) continue;
      const { state, lastReason } = breaker;
      const account = { account_id: id };
      for (const candidate of ["closed", "open", "half_open"] as const)
        out.push(
          sample("mailo_breaker_state", state === candidate ? 1 : 0, {
            ...account,
            state: candidate,
          }),
        );
      if (state !== "closed" && lastReason !== null)
        out.push(
          sample("mailo_breaker_reason_info", 1, {
            ...account,
            reason: lastReasonOf(lastReason),
          }),
        );
    }
  }

  if (snapshot.controls !== undefined) {
    const paused = new Set(snapshot.controls.pausedCallerIds);
    const pausedAccounts = new Set(snapshot.controls.pausedAccountIds);
    out.push(
      sample("mailo_send_paused_all", snapshot.controls.allPaused ? 1 : 0),
      // 레지스트리에 없는 호출처의 정지도 센다.
      sample("mailo_send_paused_callers", paused.size),
      // 구성에 없는 계정의 정지도 센다.
      sample("mailo_send_paused_accounts", pausedAccounts.size),
    );
    for (const caller of registry.callers)
      out.push(
        sample("mailo_caller_paused", paused.has(caller.id) ? 1 : 0, {
          caller_id: caller.id,
        }),
      );
    for (const { id } of accounts)
      out.push(
        sample("mailo_account_paused", pausedAccounts.has(id) ? 1 : 0, {
          account_id: id,
        }),
      );
  }

  if (snapshot.quota !== undefined) {
    for (const caller of registry.callers) {
      if (caller.sendQuota24h === null) continue;
      out.push(
        sample("mailo_caller_quota_limit", caller.sendQuota24h, {
          caller_id: caller.id,
        }),
        sample("mailo_caller_quota_used", snapshot.quota.get(caller.id) ?? 0, {
          caller_id: caller.id,
        }),
      );
    }
  }

  if (snapshot.accountQuota !== undefined) {
    for (const account of accounts) {
      if (account.sendQuota24h === null) continue;
      out.push(
        sample("mailo_account_quota_limit", account.sendQuota24h, {
          account_id: account.id,
        }),
        sample(
          "mailo_account_quota_used",
          snapshot.accountQuota.get(account.id) ?? 0,
          { account_id: account.id },
        ),
      );
    }
  }

  if (snapshot.feed !== undefined) {
    for (const caller of registry.callers) {
      const age = snapshot.feed.get(caller.id);
      if (age !== undefined)
        out.push(
          sample("mailo_caller_latest_event_age_seconds", age, {
            caller_id: caller.id,
          }),
        );
    }
  }

  if (snapshot.audit !== undefined) {
    out.push(
      sample("mailo_ops_audit_rows", snapshot.audit.rows),
      sample(
        "mailo_ops_audit_rows_truncated",
        snapshot.audit.truncated ? 1 : 0,
      ),
      sample(
        "mailo_ops_audit_oldest_age_seconds",
        snapshot.audit.oldestAgeSeconds ?? 0,
      ),
    );
  }
  return out;
}

const WORKER_STATES = [
  "disabled",
  "idle",
  "running",
  "paused",
  "stopping",
  "stopped",
] as const;

/** 이 인스턴스의 Worker·파일 폴러·수집 상태(ADR-0012 결정 4). 메모리 값만 읽는다. */
export function instanceSamples(input: {
  worker: WorkerStatus | undefined;
  /** 이 인스턴스가 구성한 계정 ID. 계정별 진행 중 전송 수 시리즈의 라벨 값이다. */
  accountIds: readonly string[];
  filePoller: FilePollerStatus | undefined;
  snapshot: GlobalSnapshot;
  snapshotAgeSeconds: number;
  nowMs: number;
}): Sample[] {
  const { worker, filePoller, snapshot } = input;
  const out: Sample[] = [];

  const state = worker === undefined ? "disabled" : worker.state;
  for (const candidate of WORKER_STATES)
    out.push(
      sample("mailo_worker_state", state === candidate ? 1 : 0, {
        state: candidate,
      }),
    );
  if (worker !== undefined) {
    out.push(
      sample("mailo_worker_in_flight_jobs", worker.inFlight),
      sample("mailo_worker_claim_failure_streak", worker.claimFailureStreak),
      sample("mailo_worker_poll_loop_crashed", worker.pollLoopCrashed ? 1 : 0),
    );
    for (const id of input.accountIds)
      out.push(
        sample("mailo_worker_in_flight", worker.inFlightByAccount[id] ?? 0, {
          account_id: id,
        }),
      );
    if (worker.lastPollAgeSeconds !== null)
      out.push(
        sample("mailo_worker_last_poll_age_seconds", worker.lastPollAgeSeconds),
      );
  }

  out.push(
    sample("mailo_file_poller_enabled", filePoller === undefined ? 0 : 1),
    sample("mailo_file_poller_running", filePoller?.running ? 1 : 0),
    sample("mailo_file_poller_callers", filePoller?.callers ?? 0),
  );
  if (filePoller?.lastPollAt != null)
    out.push(
      sample(
        "mailo_file_poller_last_poll_age_seconds",
        Math.max(
          0,
          Math.round((input.nowMs - filePoller.lastPollAt.getTime()) / 1000),
        ),
      ),
    );
  if (filePoller?.lastPollOk != null)
    out.push(
      sample("mailo_file_poller_last_poll_ok", filePoller.lastPollOk ? 1 : 0),
    );

  for (const group of METRICS_GROUPS)
    out.push(
      sample("mailo_metrics_collect_ok", snapshot.ok[group] ? 1 : 0, { group }),
    );
  out.push(
    sample(
      "mailo_metrics_snapshot_age_seconds",
      Math.round(input.snapshotAgeSeconds * 10) / 10,
    ),
  );
  return out;
}

/**
 * 프로세스 시작 시각(Unix 초). 모듈을 처음 읽을 때 한 번 계산해 고정한다.
 * 스크레이프마다 `Date.now() - uptime`을 다시 계산하면 반올림 때문에 1ms씩 흔들려 "바뀌면 재시작"이 깨진다.
 */
const PROCESS_START_SECONDS =
  Math.round((Date.now() / 1000 - process.uptime()) * 1000) / 1000;

/** Prometheus 관례 이름의 프로세스 지표 3개(ADR-0012 결정 4). */
export function processSamples(): Sample[] {
  const cpu = process.cpuUsage();
  return [
    sample("process_start_time_seconds", PROCESS_START_SECONDS),
    sample("process_resident_memory_bytes", process.memoryUsage.rss()),
    sample("process_cpu_seconds_total", (cpu.user + cpu.system) / 1e6),
  ];
}
