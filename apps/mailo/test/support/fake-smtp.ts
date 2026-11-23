import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SecureVersion } from "node:tls";
import { SMTPServer } from "smtp-server";

/**
 * 로컬 가짜 SMTP 서버(smtp-server). MAIL FROM·RCPT TO·DATA 단계마다 응답을 바꿀 수 있다.
 * 실제 nodemailer가 만드는 오류 객체를 어댑터에 통과시키기 위한 것이다(ADR-0007 결정 9).
 */

export interface Reply {
  code: number;
  /** enhanced status code로 시작하는 응답 텍스트. 예: "5.4.5 Daily user sending limit exceeded." */
  text: string;
}

export interface ReceivedMessage {
  raw: string;
  mailFrom: string;
  rcptTo: string[];
  messageId: string | undefined;
  /** 세션이 TLS 위에서 진행됐는지. */
  secure: boolean;
}

export interface FakeSmtpBehavior {
  /** 연결 직후(banner 이후 첫 명령 전). 오류를 돌려주면 연결을 거부한다. */
  connect?: (n: number) => Reply | undefined;
  auth?: (n: number) => Reply | undefined;
  mailFrom?: (n: number) => Reply | undefined;
  /** `n`은 서버가 지금까지 받은 RCPT TO 횟수(0부터). */
  rcpt?: (address: string, n: number) => Reply | undefined;
  /** `n`은 DATA 본문을 받은 횟수(0부터). */
  data?: (n: number) => Reply | undefined;
  /** 본문을 다 받은 뒤 응답 없이 연결을 끊는다. */
  dropAfterData?: (n: number) => boolean;
  /** 본문을 다 받은 뒤 응답하지 않는다. */
  hangAfterData?: (n: number) => boolean;
  /** RCPT TO에 응답하지 않는다. */
  hangAtRcpt?: boolean;
  /** 본문을 받은 뒤 응답 전에 기다리는 시간(ms). */
  dataDelayMs?: (n: number) => number;
}

export interface FakeSmtpOptions {
  /** 연결 즉시 TLS(465 방식). */
  secure?: boolean;
  /** STARTTLS를 광고·허용하지 않는다. */
  disableStarttls?: boolean;
  /** 서버가 허용하는 TLS 범위. 구버전 협상 실패를 만들 때 쓴다. */
  tlsServer?: {
    minVersion?: SecureVersion;
    maxVersion?: SecureVersion;
    ciphers?: string;
  };
  /** 서버 인증서·키(PEM). 생략하면 테스트용 자체 서명 인증서(localhost, 127.0.0.1)를 쓴다. */
  cert?: { key: string; cert: string };
}

export interface FakeSmtp {
  readonly port: number;
  readonly host: string;
  /** 서버 인증서(PEM). 클라이언트의 `trustedCa`로 쓴다. */
  readonly ca: string;
  readonly behavior: FakeSmtpBehavior;
  readonly messages: ReceivedMessage[];
  /** 서버가 받은 이벤트 수. */
  readonly counts: {
    connects: number;
    auths: number;
    mailFroms: number;
    rcpts: number;
    datas: number;
  };
  /** 인증에 쓴 마지막 자격 증명(검증용). */
  readonly lastAuth: { user?: string; password?: string };
  reset(): void;
  close(): Promise<void>;
}

let cachedCert: { key: string; cert: string } | undefined;

/**
 * 테스트용 자체 서명 인증서를 openssl로 만든다(프로세스당 한 번). 개인 키를 저장소에 두지 않으려는 선택이다.
 * 이 인증서는 localhost와 127.0.0.1에만 유효하고 만료는 30일이다.
 */
export function testCertificate(): { key: string; cert: string } {
  if (cachedCert) return cachedCert;
  const dir = mkdtempSync(join(tmpdir(), "mailo-test-cert-"));
  try {
    execFileSync(
      "openssl",
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        join(dir, "key.pem"),
        "-out",
        join(dir, "cert.pem"),
        "-days",
        "30",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=DNS:localhost,IP:127.0.0.1",
      ],
      { stdio: "ignore" },
    );
    cachedCert = {
      key: readFileSync(join(dir, "key.pem"), "utf8"),
      cert: readFileSync(join(dir, "cert.pem"), "utf8"),
    };
    return cachedCert;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function toError(reply: Reply): Error {
  return Object.assign(new Error(reply.text), { responseCode: reply.code });
}

export async function startFakeSmtp(
  options: FakeSmtpOptions = {},
): Promise<FakeSmtp> {
  const pair = options.cert ?? testCertificate();
  const behavior: FakeSmtpBehavior = {};
  const messages: ReceivedMessage[] = [];
  const counts = { connects: 0, auths: 0, mailFroms: 0, rcpts: 0, datas: 0 };
  const lastAuth: { user?: string; password?: string } = {};
  const sockets = new Set<Socket>();

  const server = new SMTPServer({
    secure: options.secure ?? false,
    key: pair.key,
    cert: pair.cert,
    authOptional: true,
    banner: "fake smtp",
    ...(options.disableStarttls && { disabledCommands: ["STARTTLS"] }),
    ...options.tlsServer,
    onConnect(_session, callback) {
      const reply = behavior.connect?.(counts.connects++);
      callback(reply ? toError(reply) : undefined);
    },
    onAuth(auth, _session, callback) {
      const reply = behavior.auth?.(counts.auths++);
      if (reply) return callback(toError(reply));
      if (typeof auth.username === "string") lastAuth.user = auth.username;
      if (typeof auth.password === "string") lastAuth.password = auth.password;
      callback(null, { user: auth.username || "anonymous" });
    },
    onMailFrom(_address, _session, callback) {
      const reply = behavior.mailFrom?.(counts.mailFroms++);
      callback(reply ? toError(reply) : undefined);
    },
    onRcptTo(address, _session, callback) {
      if (behavior.hangAtRcpt) return;
      const reply = behavior.rcpt?.(address.address, counts.rcpts++);
      callback(reply ? toError(reply) : undefined);
    },
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        const n = counts.datas++;
        if (behavior.dropAfterData?.(n)) {
          for (const s of sockets) s.destroy();
          return;
        }
        if (behavior.hangAfterData?.(n)) return;
        const raw = Buffer.concat(chunks).toString("utf8");
        const finish = () => {
          const reply = behavior.data?.(n);
          if (reply) return callback(toError(reply));
          messages.push({
            raw,
            mailFrom: session.envelope.mailFrom
              ? session.envelope.mailFrom.address
              : "",
            rcptTo: session.envelope.rcptTo.map((r) => r.address),
            secure: session.secure,
            messageId: /^message-id:\s*(.+)$/im.exec(raw)?.[1]?.trim(),
          });
          callback();
        };
        const delay = behavior.dataDelayMs?.(n) ?? 0;
        if (delay > 0) setTimeout(finish, delay);
        else finish();
      });
    },
  });
  // 클라이언트가 TLS 검증에 실패해 끊으면 서버에 'error'가 올라온다. 테스트에서는 정상 흐름이다.
  server.on("error", () => undefined);
  server.server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.server.address() as AddressInfo).port;

  return {
    port,
    host: "127.0.0.1",
    ca: pair.cert,
    behavior,
    messages,
    counts,
    lastAuth,
    reset() {
      for (const key of Object.keys(behavior) as Array<keyof FakeSmtpBehavior>)
        delete behavior[key];
      messages.length = 0;
      counts.connects =
        counts.auths =
        counts.mailFroms =
        counts.rcpts =
        counts.datas =
          0;
      delete lastAuth.user;
      delete lastAuth.password;
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
