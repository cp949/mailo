/**
 * 파일 채널 폴러(ADR-0004 결정 3·4·8, RQ-002·024).
 *
 * - 레지스트리에서 `fileChannel: true`인 호출처의 `<root>/inbox/<caller_id>/`만 읽는다. 등록되지 않은 폴더는 보지 않는다.
 * - 폴링으로 수집한다(파일 변경 이벤트에 의존하지 않는다). 한 폴링은 호출처마다 최대 `batchPerCaller`개를 처리하고
 *   다음 호출처로 넘어간다. 한 호출처의 파일이 많아도 다른 호출처가 굶지 않는다.
 *   상한에 걸려 남은 파일이 있고 이번 폴링이 진전했으면 간격을 두지 않고 바로 다음 폴링을 한다.
 * - `*.json`이 아닌 파일과 점(.)으로 시작하는 파일은 수집하지 않는다. 점 파일은 `tempFileMaxAgeSeconds`가 지나면 지운다
 *   (호출처는 목록을 볼 수 없어 직접 정리할 수 없다, ADR-0004 결정 3). 나이는 파일 mtime과 Mailo 시계의 차이다.
 * - 코드는 폴더를 만들거나 chmod하지 않는다(ADR-0004 결정 8, 운영 문서의 몫). 시작할 때 root가 읽을 수 있는 디렉터리인지, `<root>/inbox`가 통과할 수 있는 디렉터리인지만 확인한다(`inbox`가 없으면 기동 실패, 호출처 폴더 하나가 없는 것은 경고).
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
  describeError,
  silentLogger,
  type AppLogger,
} from "../logging/index.js";
import { inspectDir, isPermissive, type DirKind } from "./dir-check.js";
import { FileChannelStartError } from "./errors.js";
import { isStale } from "./errno.js";
import { NlinkZeroTracker } from "./nlink-zero-tracker.js";
import { ingestFile, removeStaleTemp, type IngestDeps } from "./ingest.js";

export interface FilePollerDeps {
  pool: pg.Pool;
  registry: CallerRegistry;
  envelope: OpenRequestDeps;
  cipher: QueueBodyCipher;
  fingerprinter: QueueFingerprinter;
  /** `root`는 폴러를 켠 설정이라 null이 아니다. */
  config: FileChannelConfig & { root: string };
  /** `IngestDeps.jobExpirySeconds`와 같다. */
  jobExpirySeconds: number;
  /** `IngestDeps.defaultFrom`과 같다. */
  defaultFrom: string;
  logger?: AppLogger;
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
  /** 열린 뒤 nlink 0이라 gone으로 본 파일 수. 다른 인스턴스의 삭제 경쟁이면 드물다. 매 폴링 계속 나오면 파일시스템 문제다. */
  nlinkZero: number;
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
// 한 폴링이 폴더에서 모으는 이름 수는 `batchPerCaller`의 이 배수(최대 LIST_LIMIT_MAX)까지다. 처리 대상은 정리된(settled) 파일이
// `batchPerCaller`건이 될 때까지 순회하므로, 읽을 수 없는 파일이 앞 슬롯을 채워도 뒤 정상 파일이 굶지 않는다(ADR-0004 구현 중 확정 8).
// 이름은 메모리에 모으므로 상한을 둔다. 읽을 수 없는 파일이 이 상한을 넘는 폴더는 운영자가 정리해야 한다.
const LIST_LIMIT_FACTOR = 100;
const LIST_LIMIT_MAX = 100_000;
// 같은 파일이 이 횟수만큼 연속 폴링에서 열린 뒤 nlink 0이면 경고한다(ADR-0004 구현 중 확정 36). 다른 인스턴스와의 삭제 경쟁은
// 다음 폴링에서 이름이 사라지므로 연속으로 나오지 않는다.
const NLINK_ZERO_WARN_STREAK = 3;

function emptySummary(callerId: string): CallerPollSummary {
  return {
    callerId,
    registered: 0,
    duplicates: 0,
    rejected: 0,
    rejectedRepeats: 0,
    gone: 0,
    nlinkZero: 0,
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
      s.nlinkZero +
      s.unreadable +
      s.deleteFailed +
      s.tempDeleted +
      s.badNames +
      s.errors >
    0
  );
}

/**
 * root와 `<root>/inbox`를 확인한다. 값(경로)은 설정이므로 오류에 변수 이름만 쓴다.
 * - root: 읽을 수 있는 디렉터리여야 한다.
 * - `inbox`: 디렉터리이고 통과(X)할 수 있어야 한다. 읽기(R)는 요구하지 않는다. 운영 권한 모델은 `inbox`를 `0711`(통과만, 호출처 이름 목록을
 *   숨긴다)로 두고 호출처 폴더를 이름으로 직접 연다(ADR-0004 결정 8, nfs.md).
 * `inbox`가 없으면 기동을 거부한다. 호스트 mount(NFS 등)가 끝나기 전에 컨테이너가 떠서 mount 전의 빈 디렉터리를
 * 보고 있는 경우를 걸러내기 위해서다. 호출처 폴더 하나가 없는 것은 호출처를 추가한 직후의 정상 상태라 경고로 둔다.
 */
async function checkRoot(root: string): Promise<void> {
  const check = async (
    dir: string,
    label: string,
    mode: number,
  ): Promise<void> => {
    try {
      if (!(await stat(dir)).isDirectory())
        throw new FileChannelStartError(`${label}가 디렉터리가 아니다`);
      await access(dir, mode);
    } catch (error) {
      if (error instanceof FileChannelStartError) throw error;
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      throw new FileChannelStartError(`${label}를 읽을 수 없다(${code})`);
    }
  };
  await check(root, "MAILO_FILE_CHANNEL_ROOT", constants.R_OK | constants.X_OK);
  await check(
    join(root, "inbox"),
    "MAILO_FILE_CHANNEL_ROOT 아래 inbox 폴더(mount가 끝났는지, 폴더를 만들었는지 확인한다)",
    constants.X_OK,
  );
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
    defaultFrom: deps.defaultFrom,
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
  // 링크·비디렉터리와 넓은 권한도 상태가 바뀔 때(처음 발견할 때)만 로그를 남긴다. 키는 `종류:호출처`다.
  const unsafeDirs = new Set<string>();
  const permissiveDirs = new Set<string>();
  // 열린 뒤 nlink 0으로 gone 처리된 경로의 연속 폴링 횟수. 파일 이름을 키로 쓰되 로그에는 내보내지 않는다(RQ-027).
  const nlinkZeroStreaks = new NlinkZeroTracker(NLINK_ZERO_WARN_STREAK);

  /** 같은 경로가 연속 폴링에서 nlink 0이면 파일시스템이 값을 잘못 보고하는 것이다. 한 번만 경고한다. */
  function noteNlinkZero(callerId: string, path: string): void {
    if (nlinkZeroStreaks.record(path))
      log.warn("file_nlink_zero_repeated", {
        callerId,
        polls: NLINK_ZERO_WARN_STREAK,
      });
  }

  /**
   * 디렉터리가 링크가 아닌 디렉터리인지 확인한다(L3). 읽어도 되면 true다.
   * 없는 디렉터리는 true다(이후 `opendir`의 기존 처리가 맡는다). 링크·비디렉터리는 `file_dir_unsafe` 경고를 남기고 false다.
   * 경로 통과 권한이 없어 확인하지 못한 경우(`why: ACCESS`)도 같은 경고를 남기고 false다. 호출처 폴더는 `errors`로 센다.
   * 일시적이면 다음 폴링에 복구되어 `file_dir_safe`가 남고, 계속되면 폴링마다 `errors`와 `lastPollOk=false`로 드러난다.
   * 권한이 넓으면 `file_channel_dir_permissive` 경고를 남기되 막지 않는다.
   */
  async function dirIsSafe(
    path: string,
    kind: DirKind,
    callerId?: string,
  ): Promise<boolean> {
    const key = `${kind}:${callerId ?? ""}`;
    const state = await inspectDir(path);
    if (state.kind === "unsafe") {
      if (!unsafeDirs.has(key)) {
        unsafeDirs.add(key);
        log.warn("file_dir_unsafe", {
          dir: kind,
          why: state.why,
          ...(callerId !== undefined && { callerId }),
        });
      }
      return false;
    }
    if (unsafeDirs.delete(key))
      log.info("file_dir_safe", {
        dir: kind,
        ...(callerId !== undefined && { callerId }),
      });
    if (state.kind === "ok") {
      if (isPermissive(kind, state.mode)) {
        if (!permissiveDirs.has(key)) {
          permissiveDirs.add(key);
          log.warn("file_channel_dir_permissive", {
            dir: kind,
            mode: state.mode.toString(8).padStart(4, "0"),
            ...(callerId !== undefined && { callerId }),
          });
        }
      } else permissiveDirs.delete(key);
    }
    return true;
  }

  async function pollCaller(
    caller: CallerEntry,
    errorBudget: { consecutive: number },
  ): Promise<CallerPollSummary> {
    const summary = emptySummary(caller.id);
    const dir = join(config.root, "inbox", caller.id);
    const names: string[] = [];
    const temps: string[] = [];
    const listLimit = Math.min(
      config.batchPerCaller * LIST_LIMIT_FACTOR,
      LIST_LIMIT_MAX,
    );
    // 이름 수집이 listLimit에서 잘렸는지. 잘리면 폴더에 아직 안 본 파일이 있다.
    let listTruncated = false;

    if (!(await dirIsSafe(dir, "callerInbox", caller.id))) {
      summary.errors += 1;
      return summary;
    }

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
            if (temps.length < listLimit) temps.push(name);
            continue;
          }
          if (!name.endsWith(".json") || entry.isDirectory()) continue;
          // 깨진 이름은 같은 바이트로 다시 열 수 없다. 건너뛰고 센다.
          if (name.includes("�")) {
            summary.badNames += 1;
            continue;
          }
          if (names.length >= listLimit) {
            listTruncated = true;
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
        listTruncated = false;
        if (attempt >= 2) {
          log.warn("file_inbox_stale", { callerId: caller.id });
          return summary;
        }
      }
    }

    // 이번 목록에 없는 경로는 사라진 파일이다. 연속 횟수를 버린다.
    if (nlinkZeroStreaks.size > 0) {
      nlinkZeroStreaks.prune(
        dir,
        new Set(names.map((name) => join(dir, name))),
      );
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
    // 정리된 파일이 batchPerCaller건이 되면 멈춘다. 남은 이름이 있으면 다음 폴링 대상이다.
    let batchFull = false;
    for (const name of names) {
      if (stopController.signal.aborted) break;
      if (settled >= config.batchPerCaller) {
        batchFull = true;
        break;
      }
      try {
        const path = join(dir, name);
        const result = await ingestFile(ingestDeps, caller, path, name);
        errorBudget.consecutive = 0;
        if (result.outcome !== "gone") nlinkZeroStreaks.clear(path);
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
            if (result.nlinkZero) {
              summary.nlinkZero += 1;
              noteNlinkZero(caller.id, path);
            } else nlinkZeroStreaks.clear(path);
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
    // 한 건도 정리하지 못했으면 바로 다시 폴링해도 소용없으므로 capped로 보지 않는다.
    summary.capped = (batchFull || listTruncated) && settled > 0;
    return summary;
  }

  async function runPoll(): Promise<PollSummary> {
    const summaries: CallerPollSummary[] = [];
    const errorBudget = { consecutive: 0 };
    let failed = false;
    // root·inbox가 링크이면 이번 폴링은 아무것도 읽지 않는다. 호출처가 없으면 확인하지 않는다.
    if (
      callers.length > 0 &&
      !(
        (await dirIsSafe(config.root, "root")) &&
        (await dirIsSafe(join(config.root, "inbox"), "inbox"))
      )
    ) {
      lastPollAt = new Date(now());
      lastPollOk = false;
      return { callers: summaries, more: false };
    }
    for (const caller of callers) {
      if (stopController.signal.aborted) break;
      if (errorBudget.consecutive >= MAX_CONSECUTIVE_ERRORS) {
        failed = true;
        break;
      }
      try {
        const summary = await pollCaller(caller, errorBudget);
        if (summary.errors > 0) failed = true;
        // 오류 예산은 DB 장애 판정용이다. 오류 없이 끝난 호출처는 앞 호출처의 연속 오류를 끊는다.
        else errorBudget.consecutive = 0;
        summaries.push(summary);
        if (hasActivity(summary)) {
          log.info("file_poll", { ...summary });
        }
      } catch (error) {
        // 폴더 목록 읽기 같은 파일시스템 오류다. 호출처별 구성 문제(권한 등)이므로 오류 예산에 넣지 않는다.
        failed = true;
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
