import { readFileSync } from "node:fs";
import type { ConnectionOptions } from "node:tls";
import type { EnvReader } from "./env-reader.js";

/** `MAILO_DB_SSLMODE`로 켜는 DB 연결 암호화. `disable`이거나 지정하지 않으면 null이다(암호화 없음, 서버 설정을 따른다). */
export interface DatabaseSsl {
  mode: "require" | "verify-ca" | "verify-full";
  /** `verify-ca`·`verify-full`에서 서버 인증서를 검증할 CA(PEM). 없으면 Node 기본 CA를 쓴다. */
  ca: string | null;
}

const SSL_MODES = ["disable", "require", "verify-ca", "verify-full"] as const;
type SslMode = (typeof SSL_MODES)[number];
/** 같은 호스트 안의 접속으로 보는 루프백 주소. 사설 IP(10/8 등)는 원격으로 본다. */
const LOOPBACK = /^(127(\.\d{1,3}){3}|::1|\[::1\])$/;

/**
 * DB 호스트가 같은 호스트·같은 compose 네트워크 안인지 본다. 점 없는 단일 라벨(compose 서비스 이름), `localhost`, 루프백이면 true다.
 * 그 밖(FQDN, 사설 IP 포함)은 원격이다. 단일 라벨이 실제로는 원격 호스트 이름일 수 있다(예: `/etc/hosts`의 별칭). 그 경우는 판정하지 못한다.
 */
export function isLocalDatabaseHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "localhost" ||
    LOOPBACK.test(h) ||
    h.startsWith("/") || // unix 소켓 디렉터리
    (!h.includes(".") && !h.includes(":") && h !== "")
  );
}

/**
 * `MAILO_DB_SSLMODE`·`MAILO_DB_SSLROOTCERT_FILE`·`MAILO_DB_ALLOW_INSECURE`를 읽는다(L7).
 * - 분리 변수(`MAILO_DB_HOST`) 경로: `MAILO_DB_SSLMODE`를 pg의 `ssl` 객체로 직접 옮긴다(`toPgSsl`).
 *   URL의 `sslmode`는 pg-connection-string이 `require`·`verify-ca`를 `verify-full`로 다루고 경고하므로 이 경로는 URL에 넣지 않는다.
 * - `MAILO_DATABASE_URL` 경로: URL의 `sslmode`를 pg가 그대로 해석한다. `MAILO_DB_SSLMODE`는 함께 쓸 수 없다(조용히 무시되지 않게 거부).
 * - 강제: production(`NODE_ENV`가 development·test가 아님)에서 호스트가 원격이고 sslmode가 없거나 `disable`이면 기동을 거부한다.
 *   `MAILO_DB_ALLOW_INSECURE=true`로 끈다.
 * @param url `loadDatabaseUrl`이 만든 접속 URL(없으면 이미 다른 오류가 난 것이다)
 */
export function loadDatabaseSsl(
  reader: EnvReader,
  url: string | undefined,
): DatabaseSsl | null {
  const splitVariables = reader.raw("MAILO_DB_HOST") !== undefined;
  const rawMode = reader.raw("MAILO_DB_SSLMODE")?.trim();
  const rootCertFile = reader.raw("MAILO_DB_SSLROOTCERT_FILE");

  let mode: SslMode | undefined;
  if (rawMode !== undefined) {
    if (!(SSL_MODES as readonly string[]).includes(rawMode))
      reader.issue(
        `MAILO_DB_SSLMODE는 ${SSL_MODES.join(", ")} 중 하나여야 한다`,
      );
    else if (!splitVariables)
      reader.issue(
        "MAILO_DB_SSLMODE는 MAILO_DB_HOST와 함께 쓴다. MAILO_DATABASE_URL에는 URL의 sslmode 매개변수를 쓴다",
      );
    else mode = rawMode as SslMode;
  }

  let host: string | undefined;
  if (splitVariables) host = reader.raw("MAILO_DB_HOST");
  else if (url !== undefined) {
    try {
      const parsed = new URL(url);
      host = decodeURIComponent(parsed.hostname);
      const fromUrl = parsed.searchParams.get("sslmode");
      if (fromUrl !== null) mode = fromUrl as SslMode;
    } catch {
      // 형식 오류는 loadDatabaseUrl이 이미 보고했다.
    }
  }

  const allowRaw = reader.raw("MAILO_DB_ALLOW_INSECURE");
  if (allowRaw !== undefined && allowRaw !== "true" && allowRaw !== "false")
    reader.issue("MAILO_DB_ALLOW_INSECURE는 true 또는 false여야 한다");
  const allowInsecure = allowRaw === "true";

  const verifies = mode === "verify-ca" || mode === "verify-full";
  if (rootCertFile !== undefined && !(splitVariables && verifies)) {
    reader.issue(
      "MAILO_DB_SSLROOTCERT_FILE은 MAILO_DB_HOST와 MAILO_DB_SSLMODE=verify-ca 또는 verify-full에서만 쓴다",
    );
  }

  if (
    reader.strictEnv() &&
    !allowInsecure &&
    host !== undefined &&
    !isLocalDatabaseHost(host) &&
    (mode === undefined || mode === "disable")
  )
    reader.issue(
      "DB 호스트가 원격인데 연결 암호화가 꺼져 있다. production에서는 MAILO_DB_SSLMODE를 require 이상(권장 verify-full)으로 설정한다. 암호화 없이 쓰려면 MAILO_DB_ALLOW_INSECURE=true를 설정한다",
    );

  if (!splitVariables || mode === undefined || mode === "disable") return null;
  let ca: string | null = null;
  if (rootCertFile !== undefined && verifies) {
    try {
      ca = readFileSync(rootCertFile, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      reader.issue(
        `MAILO_DB_SSLROOTCERT_FILE이 가리키는 파일을 읽지 못했다(${code})`,
      );
    }
  }
  return { mode, ca };
}

/**
 * `DatabaseSsl`을 pg(`tls.connect`)의 ssl 옵션으로 옮긴다.
 * - `require`: 암호화만 하고 인증서를 검증하지 않는다(`rejectUnauthorized: false`). 중간자 공격은 막지 못한다.
 * - `verify-ca`: 인증서 체인을 CA로 검증하고 호스트 이름은 검사하지 않는다(`checkServerIdentity`가 항상 통과).
 * - `verify-full`: 체인과 호스트 이름을 모두 검증한다(Node 기본 `checkServerIdentity`).
 */
export function toPgSsl(
  ssl: DatabaseSsl | null,
): ConnectionOptions | undefined {
  if (ssl === null) return undefined;
  switch (ssl.mode) {
    case "require":
      return { rejectUnauthorized: false };
    case "verify-ca":
      return {
        rejectUnauthorized: true,
        checkServerIdentity: () => undefined,
        ...(ssl.ca !== null && { ca: ssl.ca }),
      };
    case "verify-full":
      return {
        rejectUnauthorized: true,
        ...(ssl.ca !== null && { ca: ssl.ca }),
      };
  }
}
