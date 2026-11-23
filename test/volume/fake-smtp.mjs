// 볼륨 e2e용 가짜 SMTP 서버(RQ-002, ADR-0004). smtp-server 패키지는 저장소 node_modules에서 읽는다.
// 받은 메시지는 한 줄 JSON으로 stdout에 남긴다. 본문 전체는 남기지 않고 수신자·제목·Message-ID·크기만 남긴다.
// 응답 지연(SIGKILL 중복 발송 검증용): DATA_DELAY_MS가 양수이면 DATA를 모두 받아 RECEIVED를 남긴 뒤 최종 250 응답을
// DATA_DELAY_MS만큼 미룬다. 앞의 DELAY_FIRST_N(기본 1)통에만 적용하고 그 뒤는 즉시 응답한다. 기본은 지연 없음이다.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

const require = createRequire("/repo/apps/mailo/package.json");
const { SMTPServer } = require("smtp-server");

const certDir = process.env.CERT_DIR ?? "/certs";
const delayMs = Number(process.env.DATA_DELAY_MS ?? 0);
const delayFirstN = Number(process.env.DELAY_FIRST_N ?? 1);
let received = 0;
const server = new SMTPServer({
  key: readFileSync(`${certDir}/key.pem`),
  cert: readFileSync(`${certDir}/cert.pem`),
  authOptional: true,
  // 가짜 서버라 모든 자격 증명을 받는다.
  onAuth(auth, _session, cb) {
    cb(null, { user: auth.username });
  },
  onData(stream, session, cb) {
    const chunks = [];
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const subject = /^Subject: (.*)$/m.exec(raw)?.[1] ?? "";
      const messageId = /^Message-ID: (.*)$/im.exec(raw)?.[1]?.trim() ?? "";
      received += 1;
      const delayed = delayMs > 0 && received <= delayFirstN;
      console.log(
        JSON.stringify({
          event: "RECEIVED",
          at: new Date().toISOString(),
          n: received,
          rcpt: session.envelope.rcptTo.map((r) => r.address),
          subject,
          messageId,
          bytes: raw.length,
          delayedMs: delayed ? delayMs : 0,
        }),
      );
      if (delayed) setTimeout(() => cb(), delayMs);
      else cb();
    });
  },
  onError(err) {
    console.log(JSON.stringify({ event: "ERROR", message: err.message }));
  },
});
server.listen(2525, "0.0.0.0", () =>
  console.log(JSON.stringify({ event: "LISTENING", port: 2525 })),
);
