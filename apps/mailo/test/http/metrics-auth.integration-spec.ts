/**
 * `GET /metrics`의 인증 행렬과 응답 형식(RQ-049, ADR-0012 결정 1·2). 실제 PostgreSQL과 앱을 쓴다.
 * 고정하는 것: 읽기 토큰만 200, 관리 토큰 403, 호출처 키·자격 없음·모르는 값·토큰 미설정 401,
 * 경로 디코딩 오류보다 인증이 먼저(ADR-0011 구현 중 확정 20과 같은 순서), 응답 헤더, 형식, 요청 로그 수준.
 */
import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  duplicateSeries,
  parseMetrics,
  valueOf,
} from "../support/metrics-text.js";
import { migrate } from "../support/queue-fixtures.js";
import { ALPHA_KEY, startRestApp, type RestApp } from "../support/rest-app.js";

// 테스트용 가짜 토큰이다. 실제 시크릿이 아니다. 응답·로그에 나오면 안 된다.
const READ = "ops-read-fake-token-000000000000000000000001";
const ADMIN = "ops-admin-oncall-fake-token-000000000000001";

const get = (app: RestApp, path: string, token?: string) =>
  fetch(`${app.baseUrl}${path}`, {
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  });

describe("REST 통합: /metrics 인증과 형식(RQ-049, ADR-0012 결정 1·2)", () => {
  let db: TestDatabase;
  let app: RestApp;

  beforeAll(async () => {
    db = await createTestDatabase();
    await migrate(db.pool);
    app = await startRestApp({
      pool: db.pool,
      env: {
        MAILO_OPS_TOKEN: READ,
        MAILO_OPS_ADMIN_NAMES: "oncall",
        MAILO_OPS_ADMIN_TOKEN_ONCALL: ADMIN,
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await db.close();
  });

  describe("인증 행렬", () => {
    it("읽기 토큰은 200이다", async () => {
      const res = await get(app, "/metrics", READ);

      expect(res.status).toBe(200);
    });

    it("관리 토큰은 403 forbidden이다(ADR-0011 결정 1의 예외)", async () => {
      const res = await get(app, "/metrics", ADMIN);
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(403);
      expect(res.headers.get("content-type")).toContain(
        "application/problem+json",
      );
      expect(body["type"]).toBe("urn:mailo:problem:forbidden");
      expect(JSON.stringify(body)).not.toContain(ADMIN);
    });

    it.each([
      ["Authorization 헤더 없음", undefined],
      ["모르는 토큰", "unknown-token-0000000000000000000000000000"],
      ["호출처 API 키", ALPHA_KEY],
    ])("%s은 401 unauthorized다", async (_label, token) => {
      const res = await get(app, "/metrics", token);
      const body = (await res.json()) as Record<string, unknown>;

      expect(res.status).toBe(401);
      expect(body["type"]).toBe("urn:mailo:problem:unauthorized");
    });

    it("Bearer 형식이 아닌 헤더는 401이다", async () => {
      const res = await fetch(`${app.baseUrl}/metrics`, {
        headers: { Authorization: `Basic ${READ}` },
      });

      expect(res.status).toBe(401);
    });

    it("읽기 토큰으로 업무 endpoint를 부르면 여전히 401이다(권한이 넓어지지 않는다)", async () => {
      const res = await get(
        app,
        "/jobs/00000000-0000-4000-8000-000000000000",
        READ,
      );

      expect(res.status).toBe(401);
    });

    it("경로 파라미터 디코딩 오류보다 인증이 먼저다: /metrics/%는 자격 없으면 401, 읽기 토큰이면 404", async () => {
      const anonymous = await get(app, "/metrics/%");
      const wrongKey = await get(app, "/metrics/%", ALPHA_KEY);
      const admin = await get(app, "/metrics/%", ADMIN);
      const read = await get(app, "/metrics/%", READ);

      expect(anonymous.status).toBe(401);
      expect(wrongKey.status).toBe(401);
      expect(admin.status).toBe(403);
      expect(read.status).toBe(404);
    });

    it("쿼리에 잘못된 퍼센트 인코딩이 있어도 인증 결과가 먼저 나온다", async () => {
      expect((await get(app, "/metrics?x=%")).status).toBe(401);
      expect((await get(app, "/metrics?x=%E0%A4%A", READ)).status).toBe(200);
    });
  });

  describe("MAILO_OPS_TOKEN이 없으면", () => {
    it("읽기 권한이 없어 어떤 값도 401이고, 관리 토큰만 있으면 관리 토큰은 403이다", async () => {
      const none = await startRestApp({ pool: db.pool });
      const adminOnly = await startRestApp({
        pool: db.pool,
        env: {
          MAILO_OPS_ADMIN_NAMES: "oncall",
          MAILO_OPS_ADMIN_TOKEN_ONCALL: ADMIN,
        },
      });
      try {
        expect((await get(none, "/metrics")).status).toBe(401);
        expect((await get(none, "/metrics", READ)).status).toBe(401);
        expect((await get(none, "/metrics", ALPHA_KEY)).status).toBe(401);
        expect((await get(adminOnly, "/metrics", READ)).status).toBe(401);
        expect((await get(adminOnly, "/metrics", ADMIN)).status).toBe(403);
      } finally {
        await none.close();
        await adminOnly.close();
      }
    });
  });

  describe("응답 형식", () => {
    it("Content-Type은 text/plain 0.0.4이고 Cache-Control은 no-store다", async () => {
      const res = await get(app, "/metrics", READ);

      expect(res.headers.get("content-type")).toBe(
        "text/plain; version=0.0.4; charset=utf-8",
      );
      expect(res.headers.get("cache-control")).toBe("no-store");
    });

    it("본문은 개행으로 끝나고 모든 시리즈 줄이 형식을 지키며 중복 시리즈가 없다", async () => {
      const text = await (await get(app, "/metrics", READ)).text();

      expect(text.endsWith("\n")).toBe(true);
      const samples = parseMetrics(text);
      expect(samples.length).toBeGreaterThan(0);
      expect(duplicateSeries(samples)).toEqual([]);
      // 모든 지표 이름에는 HELP와 TYPE이 한 번씩 있다.
      const names = new Set(samples.map((s) => s.name));
      for (const name of names) {
        expect(text.match(new RegExp(`^# HELP ${name} `, "gm"))).toHaveLength(
          1,
        );
        expect(
          text.match(new RegExp(`^# TYPE ${name} (counter|gauge)$`, "gm")),
        ).toHaveLength(1);
      }
      // 숫자는 모두 유한한 값이다(이 시점에는 NaN·Inf가 나올 이유가 없다).
      for (const s of samples) expect(Number.isFinite(s.value)).toBe(true);
    });

    it("HEAD도 인증 뒤에 같은 헤더를 준다", async () => {
      const denied = await fetch(`${app.baseUrl}/metrics`, { method: "HEAD" });
      const ok = await fetch(`${app.baseUrl}/metrics`, {
        method: "HEAD",
        headers: { Authorization: `Bearer ${READ}` },
      });

      expect(denied.status).toBe(401);
      expect(ok.status).toBe(200);
    });

    it("인스턴스 지표와 process_* 3개가 나오고 Worker·파일 채널이 꺼진 상태를 알린다", async () => {
      const samples = parseMetrics(
        await (await get(app, "/metrics", READ)).text(),
      );

      expect(
        valueOf(samples, "mailo_worker_state", { state: "disabled" }),
      ).toBe(1);
      expect(valueOf(samples, "mailo_worker_state", { state: "running" })).toBe(
        0,
      );
      expect(valueOf(samples, "mailo_worker_in_flight_jobs")).toBeUndefined();
      expect(valueOf(samples, "mailo_file_poller_enabled")).toBe(0);
      expect(valueOf(samples, "mailo_file_poller_running")).toBe(0);
      expect(valueOf(samples, "mailo_metrics_dropped_samples_total")).toBe(0);
      expect(valueOf(samples, "process_start_time_seconds")).toBeGreaterThan(
        1.7e9,
      );
      expect(valueOf(samples, "process_resident_memory_bytes")).toBeGreaterThan(
        0,
      );
      expect(
        valueOf(samples, "process_cpu_seconds_total"),
      ).toBeGreaterThanOrEqual(0);
    });
  });

  describe("요청 로그", () => {
    it("/metrics 요청 로그는 debug이고 info가 아니다(스크레이프가 info 줄을 만들지 않는다)", async () => {
      // Nest 로거는 프로세스 전역이다. 앞 시험이 만든 다른 앱이 덮어쓴 로거를 이 앱 것으로 되돌린다.
      app.app.useLogger(app.logs.logger);
      app.logs.lines.length = 0;

      await (await get(app, "/metrics", READ)).text();
      await (await get(app, "/metrics", READ)).text();
      // 요청 로그는 응답이 끝난 뒤 남는다.
      await new Promise((resolve) => setTimeout(resolve, 50));

      const lines = app.logs.lines
        .map((l) => {
          try {
            return JSON.parse(l) as Record<string, unknown>;
          } catch {
            return null;
          }
        })
        .filter((l) => l !== null && l["event"] === "http_request");
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line!["route"]).toBe("/metrics");
        expect(line!["level"]).toBe("debug");
      }
    });

    it("토큰 값은 로그에 나오지 않는다(RQ-027)", async () => {
      app.app.useLogger(app.logs.logger);
      await (await get(app, "/metrics", READ)).text();
      await (await get(app, "/metrics", ADMIN)).text();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const logs = app.logs.lines.join("\n");
      expect(logs).not.toContain(READ);
      expect(logs).not.toContain(ADMIN);
    });
  });
});
