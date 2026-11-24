/**
 * `openRequest`가 연 요청을 큐 등록 입력(`RegisterInput`)으로 바꾼다. REST와 파일 채널이 같은 변환을 쓴다.
 *
 * 큐에 넘기는 값
 * - 수신자: `{to, cc, bcc}`. 종결 이벤트가 그대로 복사한다.
 * - 봉투(envelope): `{from, replyTo}`. 요청이 생략하면 null이고, Worker가 `from` null을 작업 계정의 `from`으로 채운다.
 * - 계정: 호출처의 `accountId`. 큐가 `mail_jobs.account_id`로 고정한다(RQ-054).
 * - 본문 바이트: UTF-8 JSON `{v:1, subject, text, html}`(`worker/body-content.ts`와 같은 형식). `QueueBodyCipher`가 봉인한다.
 * - 지문 입력: 발송 결과에 영향을 주는 모든 필드(ADR-0005 결정 3). 우선순위 포함(RQ-034).
 * - 우선순위: 요청 등급(RQ-033). 큐가 DB 순위로 바꿔 저장한다.
 * - 결과 불명 처리: 요청 `onUncertainOutcome`(RQ-073). 생략하면 필드를 넣지 않고 큐가 `retry`로 고정한다. 지문에는 지정했을 때만 들어 있다.
 * - 만료 TTL: 요청 `ttlSeconds`(RQ-039). 생략하면 호출자가 넘긴 기본값(`MAILO_JOB_EXPIRY_SECONDS`)이다.
 *   큐가 등록 때 DB `now()`에 더해 만료 시각을 고정한다(ADR-0002 결정 10).
 */
import type { RegisterInput } from "../queue/index.js";
import type { OpenRequestSuccess } from "./open-request.js";

export function toRegisterInput(
  opened: OpenRequestSuccess,
  args: {
    callerId: string;
    /** 호출처의 SMTP 계정 ID(레지스트리 `accountId`, ADR-0013 결정 2). 작업이 등록 때 고정한다. 지문에는 넣지 않는다. */
    accountId: string;
    idempotencyKey: string;
    /** 요청이 `ttlSeconds`를 생략했을 때의 만료 TTL 초(`MAILO_JOB_EXPIRY_SECONDS`). */
    defaultExpiresInSeconds: number;
    /** 새 작업을 만들 수 없는 요청(`RegisterInput.denyNew`). 기본 false다. */
    denyNew?: boolean;
  },
): RegisterInput {
  const mail = opened.request;
  return {
    callerId: args.callerId,
    accountId: args.accountId,
    idempotencyKey: args.idempotencyKey,
    recipients: { to: mail.to, cc: mail.cc, bcc: mail.bcc },
    envelope: { from: mail.from, replyTo: mail.replyTo },
    body: Buffer.from(
      JSON.stringify({
        v: 1,
        subject: mail.subject,
        text: mail.text,
        html: mail.html,
      }),
      "utf8",
    ),
    canonicalRequest: opened.fingerprint.canonicalRequest,
    expiresInSeconds: opened.ttlSeconds ?? args.defaultExpiresInSeconds,
    priority: opened.priority,
    ...(opened.onUncertainOutcome !== null && {
      onUncertain: opened.onUncertainOutcome,
    }),
    ...(args.denyNew === true && { denyNew: true }),
  };
}
