// 샘플 검증용 로컬 SMTP 서버. smtp-server 패키지는 저장소의 apps/mailo/node_modules에서 읽는다.
// 받은 메일은 한 줄 JSON(수신자, 제목, Message-ID, 본문 길이, 본문에 canary 포함 여부)으로 LOG_FILE에 덧붙인다.
// 본문은 남기지 않는다. 수신자 도메인이 reject.example이면 RCPT를 550 5.1.1로 거부한다(최종 실패 시연).
// 도메인이 tempfail.example이면 450 4.2.0으로 거부한다(일시 오류. 재시도 대기 중 만료 시연).
// 환경 변수: CERT_DIR(key.pem, cert.pem), PORT, LOG_FILE, CANARY(본문 포함 여부를 검사할 문자열, 선택)
import { appendFileSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(
  new URL("../../../apps/mailo/package.json", import.meta.url),
);
const { SMTPServer } = require("smtp-server");

const certDir = process.env.CERT_DIR;
const port = Number(process.env.PORT ?? 12525);
const logFile = process.env.LOG_FILE;
const canary = process.env.CANARY ?? "";
if (!certDir || !logFile) {
  console.error("CERT_DIR와 LOG_FILE이 필요하다");
  process.exit(1);
}

const server = new SMTPServer({
  key: readFileSync(`${certDir}/key.pem`),
  cert: readFileSync(`${certDir}/cert.pem`),
  authOptional: true,
  // 로컬 가짜 서버라 모든 자격 증명을 받는다.
  onAuth(auth, _session, cb) {
    cb(null, { user: auth.username });
  },
  onRcptTo(address, _session, cb) {
    if (address.address.toLowerCase().endsWith("@reject.example")) {
      return cb(
        Object.assign(new Error("5.1.1 User unknown"), { responseCode: 550 }),
      );
    }
    if (address.address.toLowerCase().endsWith("@tempfail.example")) {
      return cb(
        Object.assign(new Error("4.2.0 Try again later"), {
          responseCode: 450,
        }),
      );
    }
    cb();
  },
  onData(stream, session, cb) {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const decoded = decodeBody(raw);
      appendFileSync(
        logFile,
        `${JSON.stringify({
          event: "RECEIVED",
          rcpt: session.envelope.rcptTo.map((r) => r.address),
          subject: decodeSubject(raw),
          messageId: /^Message-ID:\s*(.+)$/im.exec(raw)?.[1]?.trim() ?? "",
          bytes: raw.length,
          bodyHasCanary: canary !== "" && decoded.includes(canary),
          rawHasCanary: canary !== "" && raw.includes(canary),
        })}\n`,
      );
      cb();
    });
  },
});
server.on("error", () => undefined);
server.listen(port, "127.0.0.1", () => console.log(`LISTENING ${port}`));

function decodeSubject(raw) {
  const line = /^Subject:\s*(.*)$/im.exec(raw)?.[1] ?? "";
  return line.replace(/=\?UTF-8\?[BQ]\?(.*?)\?=/gi, (_m, body) =>
    Buffer.from(body, "base64").toString("utf8"),
  );
}

// 본문 디코딩은 단일 파트(text/plain) 메시지의 base64·quoted-printable만 푸는 최소 구현이다. 검증용이다.
function decodeBody(raw) {
  const split = /\r?\n\r?\n/.exec(raw);
  if (!split) return raw;
  const head = raw.slice(0, split.index);
  const body = raw.slice(split.index + split[0].length);
  if (/^Content-Transfer-Encoding:\s*base64\s*$/im.test(head))
    return Buffer.from(body.replace(/\s+/g, ""), "base64").toString("utf8");
  if (/^Content-Transfer-Encoding:\s*quoted-printable\s*$/im.test(head)) {
    const bytes = body
      .replace(/=\r?\n/g, "")
      .replace(/=([0-9A-F]{2})/g, (_x, h) =>
        String.fromCharCode(parseInt(h, 16)),
      );
    return Buffer.from(bytes, "latin1").toString("utf8");
  }
  return body;
}
