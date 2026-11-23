import {
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { OpsAdminGuard, OpsReadGuard } from "../callers/index.js";
import {
  problems,
  sendJson,
  type HttpRequest,
  type HttpResponse,
} from "../http/index.js";
import { parseJobId, presentOperatorJob } from "../intake/index.js";
import type { PauseRecord, SendScope } from "../queue/index.js";
import type { AuditEntry } from "./audit.js";
import {
  OpsService,
  type AccountStatus,
  type PauseChange,
} from "./ops.service.js";
import {
  parseAccountId,
  parseAuditQuery,
  parseCallerId,
} from "./query-params.js";

/** 운영 응답은 캐시하지 않는다. 정지 상태와 감사 기록은 최신 값이어야 한다. */
const NO_STORE = { "Cache-Control": "no-store" };

function presentScope(scope: SendScope) {
  switch (scope.type) {
    case "all":
      return { type: "all" };
    case "caller":
      return { type: "caller", id: scope.id };
    case "account":
      return { type: "account", id: scope.id };
  }
}

function presentPauseRecord(record: PauseRecord) {
  return {
    scope: presentScope(record.scope),
    pausedAt: record.pausedAt.toISOString(),
    pausedBy: record.pausedBy,
  };
}

function presentChange(change: PauseChange) {
  return {
    scope: presentScope(change.scope),
    paused: change.paused,
    changed: change.changed,
    ...(change.paused && change.pause
      ? {
          pausedAt: change.pause.pausedAt.toISOString(),
          pausedBy: change.pause.pausedBy,
        }
      : {}),
    ...(change.inRegistry !== undefined
      ? { inRegistry: change.inRegistry }
      : {}),
    ...(change.inConfig !== undefined ? { inConfig: change.inConfig } : {}),
  };
}

function presentAccount(account: AccountStatus) {
  return {
    accountId: account.accountId,
    breaker: {
      state: account.breaker.state,
      openUntil: account.breaker.openUntil?.toISOString() ?? null,
      lastReason: account.breaker.lastReason,
    },
    paused: account.paused,
    sendQuota24h: account.sendQuota24h,
    queue: account.queue,
  };
}

function presentAudit(entry: AuditEntry) {
  return {
    id: entry.id,
    at: entry.at.toISOString(),
    actor: entry.actor,
    action: entry.action,
    ...(entry.scope ? { scope: entry.scope } : {}),
    ...(entry.jobId ? { jobId: entry.jobId } : {}),
  };
}

/** 가드가 채운 관리 토큰 이름. 관리 가드를 거친 요청에만 있다. */
function actorOf(req: HttpRequest): string {
  if (req.operator?.role !== "admin") throw problems.unauthorized();
  return req.operator.name;
}

/**
 * 운영 REST(RQ-042~044, ADR-0011 결정 7). 읽기 endpoint는 읽기·관리 토큰, 변경 endpoint는 관리 토큰만 받는다.
 * 호출처 API 키는 모든 `/ops/*`에서 401이다. 응답은 `Res`로 직접 쓴다(`IntakeController`와 같은 이유).
 * 요청 본문은 읽지 않는다.
 */
@Controller("ops")
export class OpsController {
  constructor(private readonly ops: OpsService) {}

  @Get("pauses")
  @UseGuards(OpsReadGuard)
  async pauses(@Res() res: HttpResponse): Promise<void> {
    const pauses = await this.ops.pauses();
    sendJson(res, 200, { pauses: pauses.map(presentPauseRecord) }, NO_STORE);
  }

  @Get("accounts")
  @UseGuards(OpsReadGuard)
  async accounts(@Res() res: HttpResponse): Promise<void> {
    const accounts = await this.ops.accounts();
    sendJson(res, 200, { accounts: accounts.map(presentAccount) }, NO_STORE);
  }

  @Put("pauses/all")
  @UseGuards(OpsAdminGuard)
  async pauseAll(
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const change = await this.ops.pause(actorOf(req), { type: "all" });
    sendJson(res, 200, presentChange(change), NO_STORE);
  }

  @Delete("pauses/all")
  @UseGuards(OpsAdminGuard)
  async resumeAll(
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const change = await this.ops.resume(actorOf(req), { type: "all" });
    sendJson(res, 200, presentChange(change), NO_STORE);
  }

  @Put("pauses/callers/:callerId")
  @UseGuards(OpsAdminGuard)
  async pauseCaller(
    @Param("callerId") rawCallerId: string,
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const callerId = parseCallerId(rawCallerId);
    if (!callerId.ok) throw problems.validationFailed(callerId.errors);
    const change = await this.ops.pause(actorOf(req), {
      type: "caller",
      id: callerId.value,
    });
    sendJson(res, 200, presentChange(change), NO_STORE);
  }

  @Delete("pauses/callers/:callerId")
  @UseGuards(OpsAdminGuard)
  async resumeCaller(
    @Param("callerId") rawCallerId: string,
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const callerId = parseCallerId(rawCallerId);
    if (!callerId.ok) throw problems.validationFailed(callerId.errors);
    const change = await this.ops.resume(actorOf(req), {
      type: "caller",
      id: callerId.value,
    });
    sendJson(res, 200, presentChange(change), NO_STORE);
  }

  @Put("pauses/accounts/:accountId")
  @UseGuards(OpsAdminGuard)
  async pauseAccount(
    @Param("accountId") rawAccountId: string,
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const accountId = parseAccountId(rawAccountId);
    if (!accountId.ok) throw problems.validationFailed(accountId.errors);
    const change = await this.ops.pause(actorOf(req), {
      type: "account",
      id: accountId.value,
    });
    sendJson(res, 200, presentChange(change), NO_STORE);
  }

  @Delete("pauses/accounts/:accountId")
  @UseGuards(OpsAdminGuard)
  async resumeAccount(
    @Param("accountId") rawAccountId: string,
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const accountId = parseAccountId(rawAccountId);
    if (!accountId.ok) throw problems.validationFailed(accountId.errors);
    const change = await this.ops.resume(actorOf(req), {
      type: "account",
      id: accountId.value,
    });
    sendJson(res, 200, presentChange(change), NO_STORE);
  }

  @Get("jobs/:jobId")
  @UseGuards(OpsReadGuard)
  async getJob(
    @Param("jobId") rawJobId: string,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const jobId = parseJobId(rawJobId);
    if (!jobId.ok) throw problems.validationFailed(jobId.errors);
    sendJson(
      res,
      200,
      presentOperatorJob(await this.ops.getJob(jobId.value)),
      NO_STORE,
    );
  }

  @Post("jobs/:jobId/cancel")
  @UseGuards(OpsAdminGuard)
  async cancelJob(
    @Param("jobId") rawJobId: string,
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const jobId = parseJobId(rawJobId);
    if (!jobId.ok) throw problems.validationFailed(jobId.errors);
    const job = await this.ops.cancelJob(actorOf(req), jobId.value);
    sendJson(res, 200, presentOperatorJob(job), NO_STORE);
  }

  @Get("audit")
  @UseGuards(OpsReadGuard)
  async audit(
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const query = parseAuditQuery(req.query);
    if (!query.ok) throw problems.validationFailed(query.errors);
    const page = await this.ops.audit(query.value);
    sendJson(
      res,
      200,
      { entries: page.entries.map(presentAudit), nextBefore: page.nextBefore },
      NO_STORE,
    );
  }
}
