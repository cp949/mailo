import { Inject, Injectable } from "@nestjs/common";
import type pg from "pg";
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
  listEvents,
  type EventType,
} from "../events/index.js";
import { problems } from "../http/index.js";
import {
  findJobById,
  findJobByKey,
  findJobIdByKey,
  findLastErrors,
  register,
  type JobView,
} from "../queue/index.js";
import { toRegisterInput, type OpenRequestSuccess } from "../envelope/index.js";
import { presentEvent } from "./presenters.js";

export type CreateJobResult = { status: 202 | 200; job: JobView };

@Injectable()
export class IntakeService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(QUEUE_BODY_CIPHER) private readonly cipher: QueueBodyCipher,
    @Inject(QUEUE_FINGERPRINTER)
    private readonly fingerprinter: QueueFingerprinter,
  ) {}

  /**
   * `openRequest`(복호화·검증·지문 계산)를 마친 요청을 멱등하게 등록한다(RQ-001, RQ-011, ADR-0005 결정 4·5).
   * - 신규: 202. 같은 Key와 같은 내용: 200과 기존 작업. 같은 Key에 다른 내용: 409.
   * - DB·암호화 오류는 예외로 올라가 503이 된다. 등록은 한 트랜잭션이라 반쯤 등록된 작업이 남지 않는다.
   *
   * 큐 입력으로의 변환은 파일 채널과 같은 `toRegisterInput`이다(envelope 모듈).
   */
  async create(
    callerId: string,
    idempotencyKey: string,
    opened: OpenRequestSuccess,
  ): Promise<CreateJobResult> {
    const result = await register(
      this.pool,
      { cipher: this.cipher, fingerprinter: this.fingerprinter },
      toRegisterInput(opened, {
        callerId,
        idempotencyKey,
        expiresInSeconds: this.config.queue.jobExpirySeconds,
      }),
    );

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
   */
  async listEvents(
    callerId: string,
    query: { after: string | null; types: EventType[]; limit: number },
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
      events: page.events.map((e) => presentEvent(e, lastErrors, rejections)),
      nextCursor: page.nextCursor,
      hasMore,
    };
  }
}
