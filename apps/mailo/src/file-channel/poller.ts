/**
 * 파일 채널 폴러(ADR-0004 결정 3·4·8, RQ-002·024).
 *
 * - 레지스트리에서 `fileChannel: true`인 호출처의 `<root>/inbox/<caller_id>/`만 읽는다. 등록되지 않은 폴더는 보지 않는다.
 * - 폴링으로 수집한다(파일 변경 이벤트에 의존하지 않는다). 한 폴링은 호출처마다 최대 `batchPerCaller`개를 처리하고
 *   다음 호출처로 넘어간다. 한 호출처의 파일이 많아도 다른 호출처가 굶지 않는다.
 *   상한에 걸려 남은 파일이 있고 이번 폴링이 진전했으면 간격을 두지 않고 바로 다음 폴링을 한다.
 * - `*.json`이 아닌 파일과 점(.)으로 시작하는 파일은 수집하지 않는다. 점 파일은 `tempFileMaxAgeSeconds`가 지나면 지운다
 *   (호출처는 목록을 볼 수 없어 직접 정리할 수 없다, ADR-0004 결정 3). 나이는 파일 mtime과 Mailo 시계의 차이다.
 * - 코드는 폴더를 만들거나 chmod하지 않는다(ADR-0004 결정 8, 운영 문서의 몫). 시작할 때 root가 읽을 수 있는 디렉터리인지만 확인한다.
 * - 종료: `stop()`은 새 파일을 시작하지 않고 진행 중인 파일의 등록·삭제를 끝낸 뒤 resolve한다.
 * - 여러 인스턴스가 같은 파일을 동시에 읽어도 `register`의 `(caller_id, idempotency_key)` 유일성이 하나만 등록한다.
 */
import { access, constants, opendir, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type pg from "pg";
import type { CallerEntry, CallerRegistry } from "../callers/index.js";
import type { FileChannelConfig } from "../config/index.js";
import type { QueueBodyCipher, QueueFingerprinter } from "../crypto/index.js";
import type { OpenRequestDeps } from "../envelope/index.js";
import {
  createJsonLogger,
  describeError,
  silentLogger,
  type WorkerLogger,
} from "../worker/index.js";
import { FileChannelStartError } from "./errors.js";
import { isStale } from "./errno.js";
import { ingestFile, removeStaleTemp, type IngestDeps } from "./ingest.js";

export interface FilePollerDeps {
  pool: pg.Pool;
  registry: CallerRegistry;
  envelope: OpenRequestDeps;
  cipher: QueueBodyCipher;
  fingerprinter: QueueFingerprinter;
  /** `root`는 폴러를 켠 설정이라 null이 아니다. */
  config: FileChannelConfig & { root: string };
  jobExpirySeconds: number;
  logger?: WorkerLogger;
  /** 현재 시각(ms). 임시 파일 나이 계산에 쓴다. */
  now?: () => number;
  /** `IngestDeps.beforeDelete`와 같다. 테스트용이다. */
  beforeDelete?: IngestDeps["beforeDelete"];
}

/** 호출처 하나의 한 폴링 결과. 파일 이름과 내용은 담지 않는다. */
export interface CallerPollSummary {
  callerId: string;
  registered: number;
  duplicates: number;
  rejected: number;
  rejectedRepeats: number;
  gone: number;
  /** 권한 때문에 열지 못한 파일. 거부하지 않고 남긴다. */
  unreadable: number;
  /** 등록·거부 기록은 커밋했지만 원본 삭제에 실패한 파일. 다음 폴링에서 같은 Key·같은 거부로 걸러진다. */
  deleteFailed: number;
  tempDeleted: number;
  /** UTF-8로 읽을 수 없는 이름(수집하지 않는다). */
  badNames: number;
  errors: number;
  /** 배치 상한에 걸려 이 폴더에 처리하지 못한 파일이 남았을 수 있다. */
  capped: boolean;
  inboxMissing: boolean;
}

export interface PollSummary {
  callers: CallerPollSummary[];
  /** 바로 다음 폴링을 해야 한다(상한에 걸렸고 진전이 있었다). */
  more: boolean;
}

export interface FilePollerStatus {
  /** 처리 대상 호출처 수(`fileChannel: true`). */
  callers: number;
  /** 마지막 폴링이 끝난 시각. 아직 한 번도 안 돌았으면 null. */
  lastPollAt: Date | null;
  /** 마지막 폴링이 오류 없이 끝났는가. 아직 안 돌았으면 null. */
  lastPollOk: boolean | null;
  running: boolean;
}

export interface FilePoller {
  /** root를 검증하고 폴링 루프를 시작한다. 검증에 실패하면 `FileChannelStartError`다. 두 번 불러도 한 번만 시작한다. */
  start(): Promise<void>;
  /** 새 파일을 시작하지 않고 진행 중인 파일을 끝낸 뒤 resolve한다. */
  stop(): Promise<void>;
  /** 한 번 폴링한다. 테스트와 루프가 쓴다. 동시에 부르면 차례대로 실행한다. */
  pollOnce(): Promise<PollSummary>;
  status(): FilePollerStatus;
}

// DB 장애처럼 파일과 무관한 오류가 이어지면 폴링을 접는다. 다음 간격에 다시 시도한다.
const MAX_CONSECUTIVE_ERRORS = 3;

function emptySummary(callerId: string): CallerPollSummary {
  return {
    callerId,
    registered: 0,
    duplicates: 0,
    rejected: 0,
    rejectedRepeats: 0,
    gone: 0,
    unreadable: 0,
    deleteFailed: 0,
    tempDeleted: 0,
    badNames: 0,
    errors: 0,
    capped: false,
    inboxMissing: false,
  };
}

function hasActivity(s: CallerPollSummary): boolean {
  return (
    s.registered +
      s.duplicates +
      s.rejected +
      s.rejectedRepeats +
      s.unreadable +
      s.deleteFailed +
      s.tempDeleted +
      s.badNames +
      s.errors >
    0
  );
}

/** root가 읽을 수 있는 디렉터리인지 확인한다. 값(경로)은 설정이므로 오류에 변수 이름만 쓴다. */
async function checkRoot(root: string): Promise<void> {
  try {
    if (!(await stat(root)).isDirectory())
      throw new FileChannelStartError(
        "MAILO_FILE_CHANNEL_ROOT가 디렉터리가 아니다",
      );
    await access(root, constants.R_OK | constants.X_OK);
  } catch (error) {
    if (error instanceof FileChannelStartError) throw error;
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    throw new FileChannelStartError(
      `MAILO_FILE_CHANNEL_ROOT를 읽을 수 없다(${code})`,
    );
  }
}

export function createFilePoller(deps: FilePollerDeps): FilePoller {
  const { config } = deps;
  const log = deps.logger ?? silentLogger;
  const now = deps.now ?? Date.now;
  const callers = deps.registry.callers.filter((c) => c.fileChannel);
  const ingestDeps: IngestDeps = {
    pool: deps.pool,
    envelope: deps.envelope,
    cipher: deps.cipher,
    fingerprinter: deps.fingerprinter,
    maxFileBytes: config.maxFileBytes,
    jobExpirySeconds: deps.jobExpirySeconds,
    logger: log,
    ...(deps.beforeDelete && { beforeDelete: deps.beforeDelete }),
  };

  const stopController = new AbortController();
  let state: "idle" | "running" | "stopped" = "idle";
  let loop: Promise<void> | undefined;
  let stopPromise: Promise<void> | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let lastPollAt: Date | null = null;
  let lastPollOk: boolean | null = null;
  // 폴더가 없는 상태가 바뀔 때만 로그를 남겨 폴링마다 반복되지 않게 한다.
  const missingInbox = new Set<string>();

  async function pollCaller(
    caller: CallerEntry,
    errorBudget: { consecutive: number },
  ): Promise<CallerPollSummary> {
    const summary = emptySummary(caller.id);
    const dir = join(config.root, "inbox", caller.id);
    const names: string[] = [];
    const temps: string[] = [];

    // 폴더 목록을 읽는다. 폴더가 없으면 false다.
    async function list(): Promise<boolean> {
      let handle;
      try {
        handle = await opendir(dir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          summary.inboxMissing = true;
          if (!missingInbox.has(caller.id)) {
            missingInbox.add(caller.id);
            log.warn("file_inbox_missing", { callerId: caller.id, code });
          }
          return false;
        }
        throw error;
      }
      if (missingInbox.delete(caller.id))
        log.info("file_inbox_found", { callerId: caller.id });

      try {
        for await (const entry of handle) {
          const name = entry.name;
          if (name.startsWith(".")) {
            if (temps.length < config.batchPerCaller) temps.push(name);
            continue;
          }
          if (!name.endsWith(".json") || entry.isDirectory()) continue;
          // 깨진 이름은 같은 바이트로 다시 열 수 없다. 건너뛰고 센다.
          if (name.includes("�")) {
            summary.badNames += 1;
            continue;
          }
          if (names.length >= config.batchPerCaller) {
            summary.capped = true;
            break;
          }
          names.push(name);
        }
      } finally {
        await handle.close().catch(() => undefined);
      }
      return true;
    }

    // NFS에서 폴더가 다른 곳에서 지워지거나 다시 만들어지면 readdir가 ESTALE로 실패한다(errno.ts). 커널이 캐시를 버리므로
    // 한 번 다시 읽으면 대개 성립한다. 두 번째도 실패하면 이번 폴링은 이 호출처를 건너뛰고 다음 간격에 다시 본다(오류로 세지 않는다).
    for (let attempt = 1; ; attempt++) {
      try {
        if (!(await list())) return summary;
        break;
      } catch (error) {
        if (!isStale(error)) throw error;
        names.length = 0;
        temps.length = 0;
        summary.badNames = 0;
        summary.capped = false;
        if (attempt >= 2) {
          log.warn("file_inbox_stale", { callerId: caller.id });
          return summary;
        }
      }
    }

    for (const name of temps) {
      if (stopController.signal.aborted) break;
      try {
        if (
          await removeStaleTemp(
            join(dir, name),
            now(),
            config.tempFileMaxAgeSeconds * 1000,
          )
        )
          summary.tempDeleted += 1;
      } catch (error) {
        summary.errors += 1;
        log.warn("file_temp_delete_failed", {
          callerId: caller.id,
          error: describeError(error),
        });
      }
    }

    let settled = 0;
    for (const name of names) {
      if (stopController.signal.aborted) break;
      try {
        const result = await ingestFile(
          ingestDeps,
          caller,
          join(dir, name),
          name,
        );
        errorBudget.consecutive = 0;
        if (result.settled) settled += 1;
        if (result.deleteFailed !== undefined) summary.deleteFailed += 1;
        switch (result.outcome) {
          case "registered":
            summary.registered += 1;
            break;
          case "duplicate":
            summary.duplicates += 1;
            break;
          case "rejected":
            summary.rejected += 1;
            break;
          case "rejected_repeat":
            summary.rejectedRepeats += 1;
            break;
          case "gone":
            summary.gone += 1;
            break;
          case "unreadable":
            summary.unreadable += 1;
            break;
        }
      } catch (error) {
        summary.errors += 1;
        errorBudget.consecutive += 1;
        // 등록·기록 뒤 삭제 실패와 그 앞의 오류는 사유 코드만 다르다. 이름·내용은 남기지 않는다.
        log.error("file_ingest_failed", {
          callerId: caller.id,
          error: describeError(error),
        });
        if (errorBudget.consecutive >= MAX_CONSECUTIVE_ERRORS) break;
      }
    }
    summary.capped = summary.capped && settled > 0;
    return summary;
  }

  async function runPoll(): Promise<PollSummary> {
    const summaries: CallerPollSummary[] = [];
    const errorBudget = { consecutive: 0 };
    let failed = false;
    for (const caller of callers) {
      if (stopController.signal.aborted) break;
      if (errorBudget.consecutive >= MAX_CONSECUTIVE_ERRORS) {
        failed = true;
        break;
      }
      try {
        const summary = await pollCaller(caller, errorBudget);
        if (summary.errors > 0) failed = true;
        summaries.push(summary);
        if (hasActivity(summary)) {
          log.info("file_poll", { ...summary });
        }
      } catch (error) {
        failed = true;
        errorBudget.consecutive += 1;
        log.error("file_poll_failed", {
          callerId: caller.id,
          error: describeError(error),
        });
      }
    }
    lastPollAt = new Date(now());
    lastPollOk = !failed;
    return { callers: summaries, more: summaries.some((s) => s.capped) };
  }

  function pollOnce(): Promise<PollSummary> {
    const next = chain.then(runPoll, runPoll);
    chain = next.catch(() => undefined);
    return next;
  }

  async function runLoop(): Promise<void> {
    while (!stopController.signal.aborted) {
      let more = false;
      try {
        more = (await pollOnce()).more;
      } catch (error) {
        log.error("file_poll_crashed", { error: describeError(error) });
      }
      if (more) continue;
      // 인스턴스들이 같은 순간에 폴더를 읽지 않게 간격을 ±10% 흩뿌린다.
      const delay = Math.round(
        config.pollIntervalMs * (1 + 0.1 * (2 * Math.random() - 1)),
      );
      try {
        await sleep(delay, undefined, { signal: stopController.signal });
      } catch {
        return; // 종료 신호
      }
    }
  }

  return {
    async start() {
      if (state === "stopped") throw new Error("file poller already stopped");
      if (state === "running") return;
      await checkRoot(config.root);
      state = "running";
      if (callers.length === 0) log.warn("file_channel_no_callers");
      loop = runLoop();
      log.info("file_channel_started", {
        callers: callers.length,
        pollIntervalMs: config.pollIntervalMs,
        batchPerCaller: config.batchPerCaller,
      });
    },

    stop() {
      stopPromise ??= (async () => {
        const wasRunning = state === "running";
        state = "stopped";
        stopController.abort();
        await loop;
        await chain.catch(() => undefined);
        if (wasRunning) log.info("file_channel_stopped");
      })();
      return stopPromise;
    },

    pollOnce,

    status() {
      return {
        callers: callers.length,
        lastPollAt,
        lastPollOk,
        running: state === "running",
      };
    },
  };
}

/** 운영 로그: 표준 출력 한 줄 JSON. Worker와 같은 형식이다. */
export function createStdoutLogger(): WorkerLogger {
  return createJsonLogger((line) => void process.stdout.write(`${line}\n`));
}
