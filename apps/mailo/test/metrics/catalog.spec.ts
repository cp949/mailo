import { describe, expect, it } from "@jest/globals";
import {
  ALLOWED_LABELS,
  METRICS,
  assertCatalog,
} from "../../src/metrics/index.js";

/**
 * 지표 카탈로그 규칙(RQ-049, ADR-0012 결정 3·6).
 * 이름·종류·분류·라벨 이름은 카탈로그 한 곳에만 있다. 이 테스트가 카탈로그 전체에 규칙을 건다.
 */
const PREFIXES = {
  global: [
    "mailo_queue_",
    "mailo_breaker_",
    "mailo_send_paused",
    "mailo_caller_",
    "mailo_account_",
    "mailo_ops_audit_",
  ],
  instance: [
    "mailo_worker_",
    "mailo_file_poller_",
    "mailo_metrics_",
    "mailo_attempts_total",
    "mailo_attempt_errors_total",
    "mailo_jobs_finished_total",
    "mailo_jobs_outcome_unknown_total",
    "mailo_claim_polls_total",
    "mailo_claimed_jobs_total",
    "mailo_lease_recovered_total",
    "mailo_file_channel_files_total",
    "mailo_event_cursor_gap_total",
  ],
  process: ["process_"],
} as const;

describe("지표 카탈로그 규칙(RQ-049, ADR-0012 결정 3·6)", () => {
  it("이름이 ^[a-z][a-z0-9_]*$ 형식이고 중복이 없다", () => {
    const names = METRICS.map((m) => m.name);
    for (const name of names) expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    expect(new Set(names).size).toBe(names.length);
  });

  it("전역 지표는 gauge뿐이고 정해진 접두를 쓴다", () => {
    for (const m of METRICS.filter((x) => x.scope === "global")) {
      expect(m.type).toBe("gauge");
      expect(PREFIXES.global.some((p) => m.name.startsWith(p))).toBe(true);
    }
  });

  it("counter는 인스턴스·프로세스 분류이고 이름이 _total로 끝난다", () => {
    for (const m of METRICS.filter((x) => x.type === "counter")) {
      expect(m.scope).not.toBe("global");
      expect(m.name.endsWith("_total")).toBe(true);
    }
  });

  it("gauge 이름은 _total로 끝나지 않는다", () => {
    for (const m of METRICS.filter((x) => x.type === "gauge"))
      expect(m.name.endsWith("_total")).toBe(false);
  });

  it("인스턴스·프로세스 지표도 분류별 접두를 쓴다", () => {
    for (const m of METRICS.filter((x) => x.scope !== "global"))
      expect(PREFIXES[m.scope].some((p) => m.name.startsWith(p))).toBe(true);
  });

  it("HELP가 '전역.' 또는 '인스턴스.'로 시작하고 분류와 맞는다", () => {
    for (const m of METRICS) {
      const first = m.help.split(" ")[0];
      expect(first).toBe(m.scope === "global" ? "전역." : "인스턴스.");
    }
  });

  it("시간 값 지표는 _seconds로 끝난다", () => {
    for (const m of METRICS.filter((x) => /(age|time)/.test(x.name)))
      expect(m.name).toMatch(/_seconds(_total)?$/);
  });

  it("라벨 이름은 허용 목록 안에 있고 허용 목록은 ADR 결정 6의 9개다", () => {
    expect([...ALLOWED_LABELS].sort()).toEqual(
      [
        "account_id",
        "caller_id",
        "group",
        "priority",
        "reason",
        "result",
        "stage",
        "state",
        "status",
      ].sort(),
    );
    for (const m of METRICS)
      for (const label of Object.keys(m.labels))
        expect(ALLOWED_LABELS as readonly string[]).toContain(label);
  });

  it("금지 라벨(수신자·작업 ID·Key·토큰 계열)이 하나도 없다", () => {
    const banned =
      /recipient|address|email|subject|body|key|job_id|request_id|lease|token|file|response|message|error/;
    for (const m of METRICS)
      for (const label of Object.keys(m.labels))
        expect(label).not.toMatch(banned);
  });

  it("닫힌 열거 라벨은 값 목록이 있고 fallback이 목록에 있거나 없다", () => {
    for (const m of METRICS)
      for (const spec of Object.values(m.labels)) {
        if (spec.kind !== "enum") continue;
        expect(spec.values.length).toBeGreaterThan(0);
        if (spec.fallback !== undefined)
          expect(spec.values).toContain(spec.fallback);
      }
  });

  it("mailo_caller_quota_used의 HELP는 값이 한도를 넘을 수 있다고 밝히고 한도에서 멈춘다고 쓰지 않는다(RQ-051)", () => {
    const help = METRICS.find(
      (m) => m.name === "mailo_caller_quota_used",
    )!.help;

    expect(help).toContain("한도를 넘을 수 있");
    expect(help).not.toContain("한도에서 멈춘다");
  });

  it("카탈로그 밖의 라벨 이름을 등록하면 던진다(기동 때 검사)", () => {
    expect(() => assertCatalog(METRICS)).not.toThrow();
    expect(() =>
      assertCatalog([
        {
          name: "mailo_bad_total",
          type: "counter",
          scope: "instance",
          help: "인스턴스. 시험",
          labels: { recipient: { kind: "caller" } },
        },
      ]),
    ).toThrow(/recipient/);
  });

  it("ADR-0012 결정 4의 지표 이름이 모두 있다", () => {
    const names = new Set(METRICS.map((m) => m.name));
    for (const expected of [
      "mailo_queue_jobs",
      "mailo_queue_jobs_truncated",
      "mailo_queue_oldest_due_age_seconds",
      "mailo_breaker_state",
      "mailo_breaker_reason_info",
      "mailo_send_paused_all",
      "mailo_send_paused_callers",
      "mailo_caller_paused",
      "mailo_caller_quota_limit",
      "mailo_caller_quota_used",
      "mailo_caller_latest_event_age_seconds",
      "mailo_ops_audit_rows",
      "mailo_ops_audit_rows_truncated",
      "mailo_ops_audit_oldest_age_seconds",
      "mailo_attempts_total",
      "mailo_attempt_errors_total",
      "mailo_jobs_finished_total",
      "mailo_jobs_outcome_unknown_total",
      "mailo_claim_polls_total",
      "mailo_claimed_jobs_total",
      "mailo_lease_recovered_total",
      "mailo_file_channel_files_total",
      "mailo_event_cursor_gap_total",
      "mailo_metrics_dropped_samples_total",
      "mailo_worker_state",
      "mailo_worker_in_flight_jobs",
      "mailo_worker_last_poll_age_seconds",
      "mailo_worker_claim_failure_streak",
      "mailo_worker_poll_loop_crashed",
      "mailo_file_poller_enabled",
      "mailo_file_poller_running",
      "mailo_file_poller_callers",
      "mailo_file_poller_last_poll_age_seconds",
      "mailo_file_poller_last_poll_ok",
      "mailo_metrics_collect_ok",
      "mailo_metrics_snapshot_age_seconds",
      "process_start_time_seconds",
      "process_resident_memory_bytes",
      "process_cpu_seconds_total",
    ])
      expect(names).toContain(expected);
  });

  it("계정 지표(RQ-062, ADR-0013 결정 5)는 계정 라벨 하나만 갖고 전역 gauge 규칙을 따른다", () => {
    const byName = new Map(METRICS.map((m) => [m.name, m]));
    for (const name of [
      "mailo_account_paused",
      "mailo_account_quota_limit",
      "mailo_account_quota_used",
    ]) {
      const def = byName.get(name)!;
      expect(def.type).toBe("gauge");
      expect(def.scope).toBe("global");
      expect(Object.keys(def.labels)).toEqual(["account_id"]);
    }
    expect(byName.get("mailo_send_paused_accounts")).toMatchObject({
      type: "gauge",
      scope: "global",
      labels: {},
    });
    expect(byName.get("mailo_worker_in_flight")).toMatchObject({
      type: "gauge",
      scope: "instance",
    });
    expect(Object.keys(byName.get("mailo_worker_in_flight")!.labels)).toEqual([
      "account_id",
    ]);
  });

  it("mailo_jobs_outcome_unknown_total은 인스턴스 counter이고 라벨은 caller_id·account_id뿐이며 미리 낸다(RQ-074, ADR-0015 결정 10)", () => {
    const def = METRICS.find(
      (m) => m.name === "mailo_jobs_outcome_unknown_total",
    );

    expect(def).toMatchObject({
      type: "counter",
      scope: "instance",
      seed: true,
    });
    // 라벨에 수신자·Key·작업 ID·응답 값을 넣지 않는다. 열린 값은 레지스트리·구성의 ID뿐이다.
    expect(Object.keys(def!.labels)).toEqual(["caller_id", "account_id"]);
    expect(def!.help).toContain("OUTCOME_UNKNOWN");
  });
});
