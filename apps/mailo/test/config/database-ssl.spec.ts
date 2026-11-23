import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import tls from "node:tls";
import {
  ConfigError,
  isLocalDatabaseHost,
  loadConfig,
  loadDatabaseOnly,
  toPgSsl,
} from "../../src/config/index.js";
import { testEnv } from "../support/rest-app.js";

const PRODUCTION_DB = {
  NODE_ENV: "production",
  MAILO_DB_USER: "mailo",
  MAILO_DB_NAME: "mailo",
  MAILO_DB_PASSWORD: "real-looking-password-not-the-public-sample",
} as const;

function issues(env: NodeJS.ProcessEnv): string {
  try {
    loadDatabaseOnly(env);
  } catch (error) {
    if (error instanceof ConfigError) return error.message;
    throw error;
  }
  return "";
}

describe("DB 연결 암호화 설정(L7)", () => {
  it("MAILO_DB_SSLMODE를 주지 않으면 ssl은 null이다(현행 동작)", () => {
    const db = loadDatabaseOnly({
      NODE_ENV: "development",
      MAILO_DB_HOST: "postgres",
      MAILO_DB_USER: "mailo",
      MAILO_DB_NAME: "mailo",
    });

    expect(db.ssl).toBeNull();
    expect(db.url.reveal()).not.toContain("sslmode");
  });

  it("허용값은 disable, require, verify-ca, verify-full이고 그 밖은 변수 이름으로 거부한다", () => {
    for (const mode of ["require", "verify-ca", "verify-full"])
      expect(
        loadDatabaseOnly({
          NODE_ENV: "development",
          MAILO_DB_HOST: "db.example.com",
          MAILO_DB_USER: "u",
          MAILO_DB_NAME: "n",
          MAILO_DB_SSLMODE: mode,
        }).ssl,
      ).toEqual({ mode, ca: null });
    expect(
      issues({
        NODE_ENV: "development",
        MAILO_DB_HOST: "db.example.com",
        MAILO_DB_USER: "u",
        MAILO_DB_NAME: "n",
        MAILO_DB_SSLMODE: "prefer",
      }),
    ).toContain(
      "MAILO_DB_SSLMODE는 disable, require, verify-ca, verify-full 중 하나",
    );
  });

  it("MAILO_DATABASE_URL과 MAILO_DB_SSLMODE를 함께 주면 조용히 무시하지 않고 거부한다", () => {
    expect(
      issues({
        NODE_ENV: "development",
        MAILO_DATABASE_URL: "postgres://u:p@localhost:5432/n",
        MAILO_DB_SSLMODE: "require",
      }),
    ).toContain("MAILO_DB_SSLMODE는 MAILO_DB_HOST와 함께 쓴다");
  });

  it("MAILO_DB_SSLROOTCERT_FILE은 verify-ca·verify-full에서만 쓰고, 파일을 읽지 못하면 변수 이름과 errno만 알린다", () => {
    const base = {
      NODE_ENV: "development",
      MAILO_DB_HOST: "db.example.com",
      MAILO_DB_USER: "u",
      MAILO_DB_NAME: "n",
    };

    expect(
      issues({
        ...base,
        MAILO_DB_SSLMODE: "require",
        MAILO_DB_SSLROOTCERT_FILE: "/nope/ca.pem",
      }),
    ).toContain("MAILO_DB_SSLROOTCERT_FILE은");
    const message = issues({
      ...base,
      MAILO_DB_SSLMODE: "verify-full",
      MAILO_DB_SSLROOTCERT_FILE: "/nope/ca.pem",
    });
    expect(message).toContain(
      "MAILO_DB_SSLROOTCERT_FILE이 가리키는 파일을 읽지 못했다(ENOENT)",
    );
    expect(message).not.toContain("/nope");
  });

  it("호스트 판정: 점 없는 단일 라벨·localhost·루프백은 로컬이고 FQDN·사설 IP는 원격이다", () => {
    for (const host of ["postgres", "db", "localhost", "127.0.0.1", "[::1]"])
      expect([host, isLocalDatabaseHost(host)]).toEqual([host, true]);
    for (const host of [
      "db.example.com",
      "10.0.0.5",
      "192.168.1.2",
      "[fd00::1]",
    ])
      expect([host, isLocalDatabaseHost(host)]).toEqual([host, false]);
  });

  describe("production에서 원격 호스트의 암호화 강제", () => {
    it("원격 호스트에 sslmode가 없거나 disable이면 기동을 거부하고 안내에 opt-out 변수 이름이 있다", () => {
      for (const extra of [{}, { MAILO_DB_SSLMODE: "disable" }]) {
        const message = issues({
          ...PRODUCTION_DB,
          MAILO_DB_HOST: "db.example.com",
          ...extra,
        });
        expect(message).toContain("연결 암호화가 꺼져 있다");
        expect(message).toContain("MAILO_DB_ALLOW_INSECURE=true");
        expect(message).not.toContain("real-looking-password");
      }
    });

    it("require 이상이거나 MAILO_DB_ALLOW_INSECURE=true이면 기동한다", () => {
      expect(
        issues({
          ...PRODUCTION_DB,
          MAILO_DB_HOST: "db.example.com",
          MAILO_DB_SSLMODE: "require",
        }),
      ).toBe("");
      expect(
        issues({
          ...PRODUCTION_DB,
          MAILO_DB_HOST: "10.0.0.5",
          MAILO_DB_ALLOW_INSECURE: "true",
        }),
      ).toBe("");
    });

    it("compose 서비스 이름·localhost·루프백은 sslmode 없이도 기동한다(오탐 방지)", () => {
      for (const host of ["postgres", "localhost", "127.0.0.1"])
        expect([
          host,
          issues({ ...PRODUCTION_DB, MAILO_DB_HOST: host }),
        ]).toEqual([host, ""]);
    });

    it("MAILO_DATABASE_URL의 sslmode 매개변수에도 같은 규칙이 적용된다", () => {
      const url = (query: string) =>
        `postgres://mailo:real-looking-password-not-the-public-sample@db.example.com:5432/mailo${query}`;

      expect(
        issues({ NODE_ENV: "production", MAILO_DATABASE_URL: url("") }),
      ).toContain("연결 암호화가 꺼져 있다");
      expect(
        issues({
          NODE_ENV: "production",
          MAILO_DATABASE_URL: url("?sslmode=disable"),
        }),
      ).toContain("연결 암호화가 꺼져 있다");
      expect(
        issues({
          NODE_ENV: "production",
          MAILO_DATABASE_URL: url("?sslmode=verify-full"),
        }),
      ).toBe("");
    });

    it("development·test에서는 강제하지 않는다", () => {
      expect(
        issues({
          NODE_ENV: "test",
          MAILO_DB_HOST: "db.example.com",
          MAILO_DB_USER: "u",
          MAILO_DB_NAME: "n",
        }),
      ).toBe("");
    });

    it("MAILO_DB_ALLOW_INSECURE는 true·false만 받는다", () => {
      expect(
        issues({
          ...PRODUCTION_DB,
          MAILO_DB_HOST: "postgres",
          MAILO_DB_ALLOW_INSECURE: "yes",
        }),
      ).toContain("MAILO_DB_ALLOW_INSECURE는 true 또는 false여야 한다");
    });
  });

  it("loadConfig도 database.ssl을 채운다", () => {
    const config = loadConfig(
      testEnv({
        MAILO_CALLERS_FILE: "/etc/mailo/callers.json",
        MAILO_DATABASE_URL: "",
        MAILO_DB_HOST: "db.example.com",
        MAILO_DB_USER: "u",
        MAILO_DB_NAME: "n",
        MAILO_DB_SSLMODE: "verify-full",
      }),
    );

    expect(config.database.ssl).toEqual({ mode: "verify-full", ca: null });
  });
});

describe("DB 연결 암호화의 pg ssl 옵션 매핑(L7)", () => {
  it("null은 옵션이 없다(pg 기본)", () => {
    expect(toPgSsl(null)).toBeUndefined();
  });

  it("require는 검증하지 않고, verify-ca는 체인만, verify-full은 체인과 호스트 이름을 검증한다", () => {
    const require = toPgSsl({ mode: "require", ca: null })!;
    const verifyCa = toPgSsl({ mode: "verify-ca", ca: "PEM" })!;
    const verifyFull = toPgSsl({ mode: "verify-full", ca: "PEM" })!;

    expect(require).toEqual({ rejectUnauthorized: false });
    expect(verifyCa).toMatchObject({ rejectUnauthorized: true, ca: "PEM" });
    expect(verifyCa.checkServerIdentity?.("x", {} as never)).toBeUndefined();
    expect(verifyFull).toEqual({ rejectUnauthorized: true, ca: "PEM" });
  });

  describe("실제 TLS 핸드셰이크(자체 CA, 인증서 이름 db.internal)", () => {
    let dir: string;
    let server: tls.Server;
    let port: number;
    let ca: string;

    beforeAll(async () => {
      dir = mkdtempSync(path.join(tmpdir(), "mailo-ssl-"));
      const key = path.join(dir, "key.pem");
      const cert = path.join(dir, "cert.pem");
      execFileSync(
        "openssl",
        [
          "req",
          "-x509",
          "-newkey",
          "rsa:2048",
          "-nodes",
          "-keyout",
          key,
          "-out",
          cert,
          "-days",
          "2",
          "-subj",
          "/CN=db.internal",
          "-addext",
          "subjectAltName=DNS:db.internal",
        ],
        { stdio: "ignore" },
      );
      ca = readFileSync(cert, "utf8");
      writeFileSync(path.join(dir, "ca.pem"), ca);
      server = tls.createServer(
        { key: readFileSync(key), cert: ca },
        (socket) => socket.end(),
      );
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      port = (server.address() as { port: number }).port;
    });

    afterAll(async () => {
      await new Promise((resolve) => server.close(resolve));
      rmSync(dir, { recursive: true, force: true });
    });

    const handshake = (
      ssl: ReturnType<typeof toPgSsl>,
      servername: string,
    ): Promise<string> =>
      new Promise((resolve) => {
        const socket = tls.connect({
          host: "127.0.0.1",
          port,
          servername,
          ...ssl,
        });
        socket.once("secureConnect", () => {
          socket.destroy();
          resolve("ok");
        });
        socket.once("error", (error: NodeJS.ErrnoException) =>
          resolve(error.code ?? error.message),
        );
      });

    it("require는 CA 없이 연결되고, verify-full은 CA가 없으면 실패한다", async () => {
      expect(
        await handshake(toPgSsl({ mode: "require", ca: null }), "db.internal"),
      ).toBe("ok");
      expect(
        await handshake(
          toPgSsl({ mode: "verify-full", ca: null }),
          "db.internal",
        ),
      ).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    });

    it("verify-full은 호스트 이름이 다르면 실패하고 verify-ca는 연결된다", async () => {
      expect(
        await handshake(toPgSsl({ mode: "verify-full", ca }), "db.internal"),
      ).toBe("ok");
      expect(
        await handshake(toPgSsl({ mode: "verify-full", ca }), "other.example"),
      ).toBe("ERR_TLS_CERT_ALTNAME_INVALID");
      expect(
        await handshake(toPgSsl({ mode: "verify-ca", ca }), "other.example"),
      ).toBe("ok");
    });
  });
});
