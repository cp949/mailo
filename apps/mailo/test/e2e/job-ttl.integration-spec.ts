import "reflect-metadata";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import type pg from "pg";
import { listEvents } from "../../src/events/index.js";
import { claim, completeAttempt, sweepExpired } from "../../src/queue/index.js";
import type { MailSender, SmtpSendResult } from "../../src/smtp/index.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import { completeDeps, migrate } from "../support/queue-fixtures.js";
import {
  plainMail,
  postJob,
  startRestApp,
  type RestApp,
} from "../support/rest-app.js";

/**
 * 요청별 만료 시간의 만료 동작(RQ-039, ADR-0010, ADR-0002 결정 7·10). 실제 HTTP -> PostgreSQL -> 큐 함수·Worker.
 * 작업은 REST로 등록해 `ttlSeconds`가 실제 수집 경로로 `expires_at`이 되게 한다.
 * 시간 경과는 작업의 시각 컬럼(`created_at`·`next_attempt_at`·`expires_at`)을 함께 과거로 당겨 흉내 낸다.
 * 만료 판정은 기존 코드(`claim`·`completeAttempt`·`sweepExpired`) 그대로다. 이 파일은 요청 TTL이 그 판정에 쓰임을 고정한다.
 */

const DAY = 86_400;
const breakerReset = `UPDATE mail_circuit_breaker SET state = 'closed', open_until = NULL, probe_until = NULL,
  probe_job_id = NULL, consecutive_failures = 0, wait_seconds = 0, last_reason = NULL,
  last_trip_job_id = NULL, last_trip_token = NULL`;

describe("e2e: 요청별 만료 시간의 만료 동작 (RQ-039, ADR-0010)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM mail_events");
    await pool.query("DELETE FROM mail_jobs");
    await pool.query(breakerReset);
  });

  async function row(id: string) {
    const { rows } = await pool.query<{
      status: string;
      failure_reason: string | null;
      attempts: number;
    }>("SELECT status, failure_reason, attempts FROM mail_jobs WHERE id = $1", [
      id,
    ]);
    return rows[0]!;
  }

  /** 모든 작업의 시각을 `seconds`만큼 과거로 당긴다. lease 시각은 그대로 둔다(진행 중 전송은 계속 유효). */
  async function elapse(seconds: number): Promise<void> {
    await pool.query(
      `UPDATE mail_jobs SET
         created_at = created_at - make_interval(secs => $1::double precision),
         next_attempt_at = next_attempt_at - make_interval(secs => $1::double precision),
         expires_at = expires_at - make_interval(secs => $1::double precision)`,
      [seconds],
    );
  }

  describe("큐 판정 (claim·completeAttempt·sweepExpired)", () => {
    let app: RestApp;
    // 재시도 대기 60초 고정(jitter 0, base 60). 실제 Worker의 기본 정책과 같은 base다.
    const deps = completeDeps();
    const claimAll = () => claim(pool, { leaseSeconds: 120, limit: 10, deps });

    beforeAll(async () => {
      app = await startRestApp({
        pool,
        env: { MAILO_JOB_EXPIRY_MAX_SECONDS: String(2 * DAY) },
      });
    });

    afterAll(async () => {
      await app.close();
    });

    async function submit(
      key: string,
      extra: Record<string, unknown> = {},
    ): Promise<string> {
      const res = await postJob(app, { key, body: plainMail(extra) });
      expect(res.status).toBe(202);
      return ((await res.json()) as { jobId: string }).jobId;
    }

    it("짧은 ttl의 PENDING 작업은 만료 뒤 점유되지 않고 sweep이 EXPIRED로 바꾸며 기본 TTL 작업은 점유된다", async () => {
      const short = await submit("short", { ttlSeconds: 60 });
      const normal = await submit("normal");
      await elapse(61);

      const claimed = await claimAll();

      expect(claimed.map((j) => j.id)).toEqual([normal]);
      expect(await sweepExpired(pool)).toBe(1);
      expect(await row(short)).toMatchObject({
        status: "EXPIRED",
        failure_reason: "EXPIRED",
        attempts: 0,
      });
      const page = await listEvents(pool, { callerId: "alpha" });
      expect(page.events.map((e) => [e.type, e.jobId])).toEqual([
        ["JOB_EXPIRED", short],
      ]);
      // 이벤트 payload에 ttl을 넣지 않는다(ADR-0010).
      expect(JSON.stringify(page.events)).not.toMatch(/ttl/i);
    });

    it("재시도 대기(RETRY_WAIT) 중 만료 시각이 지나면 다음 시도를 시작하지 않고 sweep이 EXPIRED로 바꾼다", async () => {
      const id = await submit("retry", { ttlSeconds: 600 });
      const [job] = await claimAll();
      const result = await completeAttempt(
        pool,
        { id, leaseToken: job!.leaseToken },
        { classification: "TRANSIENT" },
        deps,
      );
      expect(result).toMatchObject({ applied: true, status: "RETRY_WAIT" });
      await elapse(601);

      expect(await claimAll()).toEqual([]);
      expect(await sweepExpired(pool)).toBe(1);
      expect(await row(id)).toMatchObject({ status: "EXPIRED", attempts: 1 });
    });

    it("다음 재시도 시각이 요청 만료 시각보다 뒤이면 결과 기록 때 바로 EXPIRED이고 기본 TTL 작업은 RETRY_WAIT다", async () => {
      const short = await submit("short", { ttlSeconds: 60 });
      const normal = await submit("normal");
      const claimed = await claimAll();
      expect(claimed).toHaveLength(2);

      const statuses: Record<string, string> = {};
      for (const job of claimed) {
        const result = await completeAttempt(
          pool,
          { id: job.id, leaseToken: job.leaseToken },
          { classification: "TRANSIENT" },
          deps,
        );
        if (!result.applied) throw new Error("기록돼야 한다");
        statuses[job.id] = result.status;
      }

      expect(statuses).toEqual({ [short]: "EXPIRED", [normal]: "RETRY_WAIT" });
    });

    it("차단기 open이 기본 TTL보다 길게 이어지면 기본·짧은 ttl 작업은 만료되고 긴 ttl 작업은 남아 차단기가 닫힌 뒤 점유된다", async () => {
      const short = await submit("short", { ttlSeconds: 60 });
      const normal = await submit("normal");
      const long = await submit("long", { ttlSeconds: 2 * DAY });
      await pool.query(
        "UPDATE mail_circuit_breaker SET state = 'open', open_until = now() + interval '3 days', wait_seconds = 3600",
      );
      await elapse(DAY + 1);

      expect(await claimAll()).toEqual([]);
      expect(await sweepExpired(pool)).toBe(2);
      expect((await row(short)).status).toBe("EXPIRED");
      expect((await row(normal)).status).toBe("EXPIRED");
      expect((await row(long)).status).toBe("PENDING");

      await pool.query(breakerReset);
      expect((await claimAll()).map((j) => j.id)).toEqual([long]);
    });

    it("전송 중(SENDING)에 만료 시각이 지나도 sweep은 건드리지 않고 그 시도가 성공하면 SENT다", async () => {
      const id = await submit("sending", { ttlSeconds: 60 });
      const [job] = await claimAll();
      await elapse(61);

      expect(await sweepExpired(pool)).toBe(0);
      expect((await row(id)).status).toBe("SENDING");
      const result = await completeAttempt(
        pool,
        { id, leaseToken: job!.leaseToken },
        { classification: "SENT" },
        deps,
      );

      expect(result).toMatchObject({ applied: true, status: "SENT" });
    });

    it("전송 중에 만료된 시도가 일시 오류로 끝나면 재시도하지 않고 EXPIRED다", async () => {
      const id = await submit("sending-fail", { ttlSeconds: 600 });
      const [job] = await claimAll();
      await elapse(601);

      const result = await completeAttempt(
        pool,
        { id, leaseToken: job!.leaseToken },
        { classification: "TRANSIENT" },
        deps,
      );

      expect(result).toMatchObject({ applied: true, status: "EXPIRED" });
      expect((await row(id)).attempts).toBe(1);
    });
  });

  describe("Worker 경로", () => {
    let app: RestApp | undefined;

    afterEach(async () => {
      await app?.close();
      app = undefined;
    });

    it("일시 오류가 나면 요청 ttl 60초 작업은 Worker가 EXPIRED로 끝내고 기본 TTL 작업은 RETRY_WAIT로 남긴다", async () => {
      const transient: SmtpSendResult = {
        kind: "TRANSIENT",
        rule: "test-transient",
        failure: { stage: "DATA", responseCode: 451 },
      };
      const sender: MailSender = {
        async send() {
          return transient;
        },
      };
      app = await startRestApp({
        pool,
        env: {
          MAILO_WORKER_POLL_MS: "50",
          // 재시도 대기를 60초로 고정한다. 요청 ttl 60초보다 늦은 재시도라 EXPIRED가 기대값이다.
          MAILO_RETRY_JITTER_RATIO: "0",
        },
        worker: { sender },
      });
      const submit = async (key: string, extra: Record<string, unknown>) =>
        (
          (await (
            await postJob(app!, { key, body: plainMail(extra) })
          ).json()) as { jobId: string }
        ).jobId;
      const short = await submit("worker-short", { ttlSeconds: 60 });
      const normal = await submit("worker-normal", {});

      const started = Date.now();
      for (;;) {
        const [a, b] = [await row(short), await row(normal)];
        if (a.status === "EXPIRED" && b.status === "RETRY_WAIT") break;
        if (Date.now() - started > 10_000)
          throw new Error(`waitFor 시간 초과: ${a.status}, ${b.status}`);
        await new Promise((r) => setTimeout(r, 25));
      }

      expect(await row(short)).toMatchObject({
        status: "EXPIRED",
        failure_reason: "EXPIRED",
        attempts: 1,
      });
      expect(await row(normal)).toMatchObject({
        status: "RETRY_WAIT",
        attempts: 1,
      });
    });
  });
});
