import {
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { APP_CONFIG, type AppConfig } from "../config/index.js";
import { BearerAuthGuard } from "../callers/index.js";
import {
  ENVELOPE_DEPS,
  NO_SIGNATURE,
  openRequest,
  type OpenRequestDeps,
} from "../envelope/index.js";
import {
  assertJsonContentType,
  problems,
  readJsonBody,
  sendJson,
  type HttpRequest,
  type HttpResponse,
} from "../http/index.js";
import type { ValidationErrorItem } from "../validation/index.js";
import { IntakeService } from "./intake.service.js";
import { presentJob } from "./presenters.js";
import {
  parseEventsQuery,
  parseIdempotencyKey,
  parseJobId,
} from "./query-params.js";
import { presentOpenFailure } from "./open-failure.js";

/**
 * REST 입력 채널과 조회 API(docs/api/openapi.yaml, RQ-001·015·017, ADR-0005·0006).
 * 모든 endpoint는 Bearer 인증이 필요하다. `caller_id`는 키에서 얻고 요청 본문에서 받지 않는다.
 * 응답은 `Res`로 직접 쓴다. Nest의 기본 상태 코드(POST 201)가 202·200 구분과 맞지 않기 때문이다.
 */
@Controller()
@UseGuards(BearerAuthGuard)
export class IntakeController {
  constructor(
    private readonly intake: IntakeService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(ENVELOPE_DEPS) private readonly envelope: OpenRequestDeps,
  ) {}

  /**
   * 검사 순서: 인증(가드) → Content-Type(415) → 본문 읽기(413, JSON 구문 400) → 헤더 검증 →
   * `openRequest`(스키마 검증 → 복호화 → 복호화한 제목·본문 검증 → 지문, ADR-0008 결정 3) → 등록.
   * 헤더 오류와 본문 오류는 한 응답에 함께 담는다. REST는 서명을 요구하지 않는다(ADR-0008 결정 2).
   */
  @Post("jobs")
  async create(
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    assertJsonContentType(req);
    const body = await readJsonBody(req, this.config.http.maxRequestBytes);

    const errors: ValidationErrorItem[] = [];
    const key = parseIdempotencyKey(
      req.headers["idempotency-key"],
      "Idempotency-Key",
    );
    if (!key.ok) errors.push(...key.errors);
    const callerId = req.callerId as string;
    const opened = await openRequest(
      { kind: "rest", body },
      { ...this.envelope, callerId, signature: NO_SIGNATURE },
    );
    if (!opened.ok) errors.push(...presentOpenFailure(opened));
    if (errors.length > 0 || !key.ok || !opened.ok)
      throw problems.validationFailed(errors);

    const { status, job } = await this.intake.create(
      callerId,
      key.value,
      opened,
    );
    sendJson(res, status, presentJob(job), { Location: `/jobs/${job.id}` });
  }

  /** `GET /jobs?idempotencyKey=`. 목록이 아니라 작업 하나를 반환한다. */
  @Get("jobs")
  async getByKey(
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const key = parseIdempotencyKey(
      req.query["idempotencyKey"],
      "idempotencyKey",
    );
    if (!key.ok) throw problems.validationFailed(key.errors);
    const job = await this.intake.getByKey(req.callerId as string, key.value);
    sendJson(res, 200, presentJob(job));
  }

  @Get("events")
  async events(
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const query = parseEventsQuery(req.query);
    if (!query.ok) throw problems.validationFailed(query.errors);
    sendJson(
      res,
      200,
      await this.intake.listEvents(req.callerId as string, query.value),
    );
  }

  @Get("jobs/:jobId")
  async getById(
    @Param("jobId") rawJobId: string,
    @Req() req: HttpRequest,
    @Res() res: HttpResponse,
  ): Promise<void> {
    const jobId = parseJobId(rawJobId);
    if (!jobId.ok) throw problems.validationFailed(jobId.errors);
    sendJson(
      res,
      200,
      presentJob(
        await this.intake.getById(req.callerId as string, jobId.value),
      ),
    );
  }
}
