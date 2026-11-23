import { describe, expect, it } from "@jest/globals";
import { loadConfig } from "../../src/config/index.js";
import {
  defaultBreakerConfig,
  defaultRetryPolicy,
} from "../../src/queue/index.js";
import { testEnv } from "../support/rest-app.js";
import {
  createBodyCipher,
  createKeyRing,
  createQueueBodyCipher,
} from "../../src/crypto/index.js";
import {
  WorkerOptionsError,
  decodeBodyContent,
  defaultWorkerOptions,
  encodeBodyContent,
  toOutcome,
  toWorkerOptions,
  validateWorkerOptions,
} from "../../src/worker/index.js";

describe("Worker 옵션 검증", () => {
  it("기본 옵션은 통과한다", () => {
    expect(() =>
      validateWorkerOptions(defaultWorkerOptions(120)),
    ).not.toThrow();
  });

  it("기본 옵션은 loadConfig의 기본값과 같다: 점검 주기 60초, 재시도·차단기 정책 포함(ADR-0002 구현 중 확정 3, L8)", () => {
    const fromConfig = toWorkerOptions(
      loadConfig(testEnv({ MAILO_CALLERS_FILE: "/unused/callers.json" })),
    );
    const { retry, breaker, ...rest } = defaultWorkerOptions(120);
    const {
      retry: configRetry,
      breaker: configBreaker,
      ...configRest
    } = fromConfig;

    expect(rest).toEqual(configRest);
    expect(rest.sweepIntervalMs).toBe(60_000);
    expect(rest.cleanupIntervalMs).toBe(60_000);
    expect({ ...retry, random: undefined }).toEqual({
      ...configRetry,
      random: undefined,
    });
    expect(breaker).toEqual(configBreaker);
    // 큐 모듈의 테스트용 기본값도 어긋나지 않는다.
    expect({ ...defaultRetryPolicy(), random: undefined }).toEqual({
      ...configRetry,
      random: undefined,
    });
    expect(defaultBreakerConfig()).toEqual(configBreaker);
  });

  it("drain 상한은 lease보다 짧아야 한다 (ADR-0002 결정 12)", () => {
    const o = { ...defaultWorkerOptions(120), drainTimeoutMs: 120_000 };
    expect(() => validateWorkerOptions(o)).toThrow(WorkerOptionsError);
  });

  it("본문 삭제 유예가 보존 기간보다 길면 거부한다 (ADR-0005 결정 7)", () => {
    const o = defaultWorkerOptions(120);
    expect(() =>
      validateWorkerOptions({
        ...o,
        retention: { bodyGraceSeconds: 100, recordSeconds: 50 },
      }),
    ).toThrow(WorkerOptionsError);
  });

  it.each(["concurrency", "pollMs", "poisonMaxAttempts"] as const)(
    "%s가 0이면 거부한다",
    (field) => {
      expect(() =>
        validateWorkerOptions({ ...defaultWorkerOptions(120), [field]: 0 }),
      ).toThrow(WorkerOptionsError);
    },
  );

  it("동시 처리 수는 정수여야 한다", () => {
    expect(() =>
      validateWorkerOptions({ ...defaultWorkerOptions(120), concurrency: 1.5 }),
    ).toThrow(WorkerOptionsError);
  });
});

describe("SMTP 결과를 시도 결과로 변환", () => {
  it("거부된 수신자가 없는 SENT는 rejectedRecipients가 null이다", () => {
    expect(toOutcome({ kind: "SENT", rejectedRecipients: [] })).toEqual({
      classification: "SENT",
      rejectedRecipients: null,
    });
  });

  it("MAIL FROM 이후 단계의 계정 상태 오류는 afterMailFrom이 true다 (ADR-0007 결정 4)", () => {
    const outcome = toOutcome({
      kind: "ACCOUNT",
      reason: "DAILY_LIMIT",
      rule: "x",
      failure: { stage: "RCPT", responseCode: 550, enhancedStatus: "5.4.5" },
    });
    expect(outcome).toMatchObject({
      classification: "ACCOUNT",
      reason: "DAILY_LIMIT",
      afterMailFrom: true,
    });
  });

  it.each([
    ["CONN", "CONNECTION"],
    ["TLS", "TLS"],
    ["AUTH", "AUTH"],
  ] as const)(
    "GENERAL 사유는 %s 단계에서 %s로 바뀌고 afterMailFrom이 false다",
    (stage, reason) => {
      expect(
        toOutcome({
          kind: "ACCOUNT",
          reason: "GENERAL",
          rule: "x",
          failure: { stage },
        }),
      ).toMatchObject({ reason, afterMailFrom: false });
    },
  );

  it("BURST_LIMIT는 RATE_LIMIT 사유로 바뀐다", () => {
    expect(
      toOutcome({
        kind: "ACCOUNT",
        reason: "BURST_LIMIT",
        rule: "x",
        failure: { stage: "MAIL_FROM" },
      }),
    ).toMatchObject({ reason: "RATE_LIMIT", afterMailFrom: true });
  });

  it("TRANSIENT·PERMANENT는 단계와 응답 정보를 그대로 넘긴다", () => {
    expect(
      toOutcome({
        kind: "PERMANENT",
        rule: "x",
        failure: {
          stage: "DATA",
          responseCode: 552,
          enhancedStatus: "5.3.4",
          responseText: "too big",
        },
      }),
    ).toEqual({
      classification: "PERMANENT",
      stage: "DATA",
      responseCode: 552,
      enhancedCode: "5.3.4",
      responseText: "too big",
    });
  });
});

describe("본문 평문 형식과 crypto 어댑터", () => {
  const keyRing = createKeyRing({
    currentVersion: 1,
    keys: new Map([[1, Buffer.alloc(32, 9)]]),
  });
  const cipher = createQueueBodyCipher(createBodyCipher(keyRing));
  const content = { subject: "제목", text: "본문", html: null };

  it("encode와 decode가 왕복한다", () => {
    expect(decodeBodyContent(encodeBodyContent(content))).toEqual(content);
  });

  it("형식이 다른 평문은 원문 없이 BODY_MALFORMED로 거부한다", () => {
    expect(() => decodeBodyContent(Buffer.from("CANARY-NOT-JSON"))).toThrow(
      expect.objectContaining({
        code: "BODY_MALFORMED",
        message: expect.not.stringContaining("CANARY"),
      }),
    );
    expect(() =>
      decodeBodyContent(
        Buffer.from('{"v":2,"subject":"x","text":null,"html":null}'),
      ),
    ).toThrow(expect.objectContaining({ code: "BODY_MALFORMED" }));
  });

  it("crypto BodyCipher를 queue BodyCipher로 맞춰 암복호화가 왕복한다 (nonce·ciphertext 분리 저장)", async () => {
    const jobId = "33333333-3333-4333-8333-333333333333";
    const encrypted = await cipher.encrypt(jobId, encodeBodyContent(content));
    expect(encrypted.nonce).toHaveLength(12);
    expect(encrypted.keyVersion).toBe(1);
    expect(
      Buffer.from(encrypted.ciphertext).includes(Buffer.from("본문")),
    ).toBe(false);
    expect(decodeBodyContent(await cipher.decrypt(jobId, encrypted))).toEqual(
      content,
    );
  });

  it("worker 평문 형식 {v:1,subject,text,html}과 crypto 어댑터가 호환된다: 복호화 바이트가 encodeBodyContent와 같다", async () => {
    const jobId = "44444444-4444-4444-8444-444444444444";
    const plain = encodeBodyContent(content);

    const decrypted = await cipher.decrypt(
      jobId,
      await cipher.encrypt(jobId, plain),
    );

    expect(Buffer.from(decrypted).toString("utf8")).toBe(
      '{"v":1,"subject":"제목","text":"본문","html":null}',
    );
    expect(Buffer.from(decrypted).equals(Buffer.from(plain))).toBe(true);
  });

  it("intake가 등록 때 쓰는 JSON 형식(v 포함·생략 모두)을 어댑터가 받고, worker가 복호화 결과를 읽는다", async () => {
    const jobId = "55555555-5555-4555-8555-555555555555";
    const withHtml = { subject: "s", text: null, html: "<p>x</p>" };
    for (const raw of [
      JSON.stringify({ v: 1, ...withHtml }),
      JSON.stringify(withHtml),
    ]) {
      const sealed = await cipher.encrypt(jobId, Buffer.from(raw, "utf8"));
      expect(decodeBodyContent(await cipher.decrypt(jobId, sealed))).toEqual(
        withHtml,
      );
    }
  });

  it("다른 작업 ID로는 복호화되지 않는다 (AAD = jobId)", async () => {
    const encrypted = await cipher.encrypt("job-a", encodeBodyContent(content));
    await expect(
      Promise.resolve().then(() => cipher.decrypt("job-b", encrypted)),
    ).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
    });
  });
});

describe("호출처 할당과 보존 기간 (RQ-032)", () => {
  it("호출처 할당이 있는데 작업 기록 보존이 24시간보다 짧으면 거부한다", () => {
    const o = defaultWorkerOptions(120);
    expect(() =>
      validateWorkerOptions({
        ...o,
        callerQuotas: new Map([["alpha", 10]]),
        retention: { bodyGraceSeconds: 3600, recordSeconds: 86_399 },
      }),
    ).toThrow(WorkerOptionsError);
  });

  it("보존이 24시간 이상이면 통과하고, 할당이 없으면 보존이 짧아도 통과한다", () => {
    const o = defaultWorkerOptions(120);
    expect(() =>
      validateWorkerOptions({
        ...o,
        callerQuotas: new Map([["alpha", 10]]),
        retention: { bodyGraceSeconds: 3600, recordSeconds: 86_400 },
      }),
    ).not.toThrow();
    expect(() =>
      validateWorkerOptions({
        ...o,
        retention: { bodyGraceSeconds: 3600, recordSeconds: 7200 },
      }),
    ).not.toThrow();
  });
});
