import { Inject, Injectable, Logger } from "@nestjs/common";
import type pg from "pg";
import { CALLER_REGISTRY, type CallerRegistry } from "../callers/index.js";
import { PG_POOL, withTransaction } from "../db/index.js";
import { problems } from "../http/index.js";
import {
  cancelJobAsOperator,
  clearPause,
  findJobByIdForOperator,
  listPauses,
  setPause,
  type JobView,
  type PauseRecord,
  type SendScope,
} from "../queue/index.js";
import { listAudit, writeAudit, type AuditEntry } from "./audit.js";

const logger = new Logger("ops");

/** 정지·재개 결과. `pause`는 정지 상태일 때만 있다. */
export interface PauseChange {
  scope: SendScope;
  paused: boolean;
  changed: boolean;
  pause?: PauseRecord;
  inRegistry?: boolean;
}

/**
 * 운영 REST의 동작(RQ-042~044, ADR-0011 결정 2·3·4·6). 상태를 바꾸는 동작은 한 트랜잭션에서
 * 상태 변경 → (바뀐 경우만) 감사 기록 순서로 쓴다. 어느 쪽이 실패해도 둘 다 롤백한다.
 * 로그는 `actor`(관리 토큰 이름)와 범위·작업 ID만 남긴다. 토큰 값과 요청 값은 남기지 않는다(RQ-027).
 */
@Injectable()
export class OpsService {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(CALLER_REGISTRY) private readonly registry: CallerRegistry,
  ) {}

  async pause(actor: string, scope: SendScope): Promise<PauseChange> {
    const { changed, pause } = await withTransaction(
      this.pool,
      async (client) => {
        const result = await setPause(client, scope, actor);
        if (result.changed)
          await writeAudit(client, { actor, action: "PAUSE", scope });
        return result;
      },
    );
    if (changed)
      logger.log({ event: "ops_pause_set", actor, ...logScope(scope) });
    return { scope, paused: true, changed, pause, ...this.registryFlag(scope) };
  }

  async resume(actor: string, scope: SendScope): Promise<PauseChange> {
    const { changed } = await withTransaction(this.pool, async (client) => {
      const result = await clearPause(client, scope);
      if (result.changed)
        await writeAudit(client, { actor, action: "RESUME", scope });
      return result;
    });
    if (changed)
      logger.log({ event: "ops_pause_cleared", actor, ...logScope(scope) });
    return { scope, paused: false, changed, ...this.registryFlag(scope) };
  }

  /** 호출처 정지·재개 응답의 `inRegistry`. 오타를 알아보게 한다(ADR-0011 결정 3). 레지스트리에 없어도 정지한다. */
  private registryFlag(scope: SendScope): { inRegistry?: boolean } {
    return scope.type === "caller"
      ? { inRegistry: this.registry.callers.some((c) => c.id === scope.id) }
      : {};
  }

  pauses(): Promise<PauseRecord[]> {
    return listPauses(this.pool);
  }

  /**
   * 관리 토큰으로 작업을 취소한다. 호출처 범위가 없다. 새로 취소한 경우에만 같은 트랜잭션에 감사를 쓴다.
   * 이미 `CANCELED`이면 이벤트·감사·로그를 새로 쓰지 않는다(멱등).
   */
  async cancelJob(actor: string, jobId: string): Promise<JobView> {
    const result = await withTransaction(this.pool, async (client) => {
      const cancel = await cancelJobAsOperator(client, { jobId });
      if (cancel.kind === "canceled")
        await writeAudit(client, { actor, action: "CANCEL_JOB", jobId });
      return cancel;
    });
    if (result.kind === "not_found") throw problems.notFound();
    if (result.kind === "not_cancelable")
      throw problems.jobNotCancelable(result.status);
    if (result.kind === "canceled")
      logger.log({ event: "ops_job_canceled", actor, jobId });
    const job = await findJobByIdForOperator(this.pool, jobId);
    // 취소 직후 보존 삭제와 겹친 경우다.
    if (job === null) throw problems.notFound();
    return job;
  }

  async getJob(jobId: string): Promise<JobView> {
    const job = await findJobByIdForOperator(this.pool, jobId);
    if (job === null) throw problems.notFound();
    return job;
  }

  audit(options: { limit: number; before: string | null }): Promise<{
    entries: AuditEntry[];
    nextBefore: string | null;
  }> {
    return listAudit(this.pool, options);
  }
}

function logScope(scope: SendScope): { scope: string; callerId?: string } {
  return scope.type === "all"
    ? { scope: "all" }
    : { scope: "caller", callerId: scope.id };
}
