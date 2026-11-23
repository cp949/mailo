import { Inject, Injectable, Logger } from "@nestjs/common";
import type pg from "pg";
import { CALLER_REGISTRY, type CallerRegistry } from "../callers/index.js";
import { APP_CONFIG, type AppConfig } from "../config/index.js";
import {
  QUEUE_BODY_CIPHER,
  QUEUE_FINGERPRINTER,
  type QueueBodyCipher,
  type QueueFingerprinter,
} from "../crypto/index.js";
import { PG_POOL } from "../db/index.js";
import {
  InvalidCursorError,
  findRejections,
  hasEventGap,
  listEvents,
  type EventType,
} from "../events/index.js";
import { problems } from "../http/index.js";
import {
  cancelJob,
  findJobById,
  findJobByKey,
  findJobIdByKey,
  findLastErrors,
  register,
  type JobView,
} from "../queue/index.js";
import { toRegisterInput, type OpenRequestSuccess } from "../envelope/index.js";
import { checkRequestPolicy } from "../validation/index.js";
import { presentEvent } from "./presenters.js";

const logger = new Logger("intake");

/** 호출처가 취소할 작업을 고르는 방법. 작업 ID 또는 Idempotency-Key(파일 채널 호출처, ADR-0011 결정 4). */
export type CancelRequest = { jobId: string } | { idempotencyKey: string };

export type CreateJobResult = { status: 202 | 200; job: JobView };

@Injectable()
export class IntakeService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(QUEUE_BODY_CIPHER) private readonly cipher: QueueBodyCipher,
    @Inject(QUEUE_FINGERPRINTER)
    private readonly fingerprinter: QueueFingerprinter,
    @Inject(CALLER_REGISTRY) private readonly registry: CallerRegistry,
  ) {}

  /**
   * `openRequest`(복호화·검증·지문 계산)를 마친 요청을 멱등하게 등록한다(RQ-001, RQ-011, ADR-0005 결정 4·5).
   * - 신규: 202. 같은 Key와 같은 내용: 200과 기존 작업. 같은 Key에 다른 내용: 409.
   * - 요청의 `from`이 호출처의 허용 발신 주소에 없거나(`FROM_NOT_ALLOWED`), 수신자 도메인이 `allowedRecipientDomains`에 없으면
   *   (`RECIPIENT_DOMAIN_NOT_ALLOWED`, RQ-046) 새 작업을 만들지 않고 400 validation-failed다. 어긴 항목을 모두 `errors`에 담고 값은 담지 않는다.
   *   수신자 하나라도 어기면 요청 전체를 거부한다(부분 등록 없음).
   *   이미 등록된 Key의 재전송은 허용 여부와 무관하게 기존 작업(200)이나 409를 그대로 돌려준다. 정책을 바꾼 뒤에도
   *   relay의 멱등 재시도가 영구 실패로 바뀌지 않게 하려는 것이다.
   * - DB·암호화 오류는 예외로 올라가 503이 된다. 등록은 한 트랜잭션이라 반쯤 등록된 작업이 남지 않는다.
   *
   * 큐 입력으로의 변환은 파일 채널과 같은 `toRegisterInput`이다(envelope 모듈).
   */
  async create(
    callerId: string,
    idempotencyKey: string,
    opened: OpenRequestSuccess,
  ): Promise<CreateJobResult> {
    // 호출처 정책(발신 주소·수신 도메인)을 어기면 새 작업을 만들지 않는다. 파일 채널과 같은 판정이다.
    const caller = this.registry.callers.find((c) => c.id === callerId);
    const violations = checkRequestPolicy(opened.request, {
      defaultFrom: this.config.smtp.defaultFrom,
      allowedFrom: caller?.allowedFrom ?? [],
      allowedRecipientDomains: caller?.allowedRecipientDomains ?? null,
    });
    const result = await register(
      this.pool,
      { cipher: this.cipher, fingerprinter: this.fingerprinter },
      toRegisterInput(opened, {
        callerId,
        idempotencyKey,
        defaultExpiresInSeconds: this.config.queue.jobExpirySeconds,
        denyNew: violations.length > 0,
      }),
    );
    if (result.kind === "denied") throw problems.validationFailed(violations);

    if (result.kind === "fingerprint_mismatch") {
      throw problems.idempotencyConflict(
        await findJobIdByKey(this.pool, callerId, idempotencyKey),
      );
    }
    const job = await findJobById(this.pool, callerId, result.jobId);
    // 방금 등록·확인한 행이 사라졌다면 보존 삭제와의 경합이다. 같은 Key로 재시도하면 새 요청으로 처리된다.
    if (job === null) throw new Error("등록한 작업을 읽지 못했다");
    return { status: result.kind === "created" ? 202 : 200, job };
  }

  /**
   * 호출처 자신의 대기 작업을 취소한다(RQ-040, ADR-0011 결정 4).
   * - 취소했거나 이미 `CANCELED`이면 현재 `Job`을 돌려준다(200). 이미 취소된 작업은 이벤트와 로그를 새로 쓰지 않는다.
   * - `SENDING`과 `SENT`·`FAILED`·`EXPIRED`는 409 `job-not-cancelable`이다.
   * - 다른 호출처의 작업과 없는 작업은 구분하지 않고 404다.
   * 로그에는 작업 ID와 호출처 ID만 남긴다. Key는 요청 값이라 남기지 않는다(RQ-027).
   */
  async cancel(callerId: string, request: CancelRequest): Promise<JobView> {
    const result = await cancelJob(
      this.pool,
      { callerId, ...request },
      "CALLER",
    );
    if (result.kind === "not_found") throw problems.notFound();
    if (result.kind === "not_cancelable")
      throw problems.jobNotCancelable(result.status);
    if (result.kind === "canceled")
      logger.log({
        event: "job_canceled",
        jobId: result.jobId,
        callerId,
        canceledBy: "CALLER",
      });
    const job = await findJobById(this.pool, callerId, result.jobId);
    // 취소 직후 보존 삭제와 겹친 경우다. 호출처에는 없는 작업과 같다.
    if (job === null) throw problems.notFound();
    return job;
  }

  /** 다른 호출처의 작업과 없는 작업은 구분하지 않고 404다. */
  async getById(callerId: string, jobId: string): Promise<JobView> {
    const job = await findJobById(this.pool, callerId, jobId);
    if (job === null) throw problems.notFound();
    return job;
  }

  async getByKey(callerId: string, idempotencyKey: string): Promise<JobView> {
    const job = await findJobByKey(this.pool, callerId, idempotencyKey);
    if (job === null) throw problems.notFound();
    return job;
  }

  /**
   * 호출처의 종결 이벤트 피드(ADR-0006 결정 2·7). 응답 모양은 `{events, nextCursor, hasMore}`다.
   * `hasMore`는 한 페이지가 가득 찼을 때만 다음 페이지를 한 건 더 읽어 확인한다.
   *
   * `after`가 있으면 cursor 뒤에서 이벤트가 삭제됐는지 판정한다(ADR-0011 결정 9, RQ-045).
   * 공백이면 `event_cursor_gap`(warn)을 한 줄 남기고, `errorOnGap`이면 410이다. 아니면 `gap: true`로 알려 컨트롤러가 헤더를 붙인다.
   * 판정은 이벤트를 읽은 뒤에 한다. 반대 순서면 두 조회 사이에 커밋된 삭제를 놓친다.
   */
  async listEvents(
    callerId: string,
    query: {
      after: string | null;
      types: EventType[];
      limit: number;
      errorOnGap: boolean;
    },
  ) {
    let page;
    try {
      page = await listEvents(this.pool, {
        callerId,
        after: query.after,
        types: query.types,
        limit: query.limit,
      });
    } catch (error) {
      if (error instanceof InvalidCursorError) {
        throw problems.validationFailed([
          { parameter: "after", code: "INVALID_FORMAT" },
        ]);
      }
      throw error;
    }

    let gap = false;
    if (query.after !== null) {
      gap = await hasEventGap(this.pool, {
        callerId,
        after: query.after,
        types: query.types,
      });
      if (gap) {
        logger.warn({ event: "event_cursor_gap", callerId });
        if (query.errorOnGap) throw problems.cursorExpired();
      }
    }

    let hasMore = false;
    if (page.events.length >= query.limit && page.nextCursor !== null) {
      const probe = await listEvents(this.pool, {
        callerId,
        after: page.nextCursor,
        types: query.types,
        limit: 1,
      });
      hasMore = probe.events.length > 0;
    }

    const jobIds = page.events.flatMap((e) =>
      e.jobId !== null && (e.type === "JOB_FAILED" || e.type === "JOB_EXPIRED")
        ? [e.jobId]
        : [],
    );
    const rejectionIds = page.events.flatMap((e) =>
      e.rejectionId !== null ? [e.rejectionId] : [],
    );
    const [lastErrors, rejections] = await Promise.all([
      findLastErrors(this.pool, jobIds),
      findRejections(this.pool, callerId, rejectionIds),
    ]);

    return {
      body: {
        events: page.events.map((e) => presentEvent(e, lastErrors, rejections)),
        nextCursor: page.nextCursor,
        hasMore,
      },
      gap,
    };
  }
}
