/**
 * 작업 ID에서 유도한 고정 Message-ID(ADR-0007 결정 8).
 * 같은 작업의 재시도는 같은 값을 쓰고, 도메인은 발신 계정 도메인이다.
 * Gmail이 같은 Message-ID를 중복으로 버리는지는 확인하지 못했다. 중복 완화 수단이며 보장이 아니다.
 * smtp.gmail.com이 클라이언트가 준 Message-ID를 그대로 유지하는지도 확인하지 못했다(미검증).
 */
import { domainToASCII } from "node:url";

export class MessageIdError extends Error {
  constructor(readonly code: "INVALID_JOB_ID" | "INVALID_SENDER_DOMAIN") {
    super(`cannot build message id (code=${code})`);
    this.name = "MessageIdError";
  }
}

// 작업 ID는 UUID다. id-left에 안전한 문자만 허용해 헤더·꺾쇠 주입을 막는다.
const JOB_ID = /^[A-Za-z0-9-]{1,64}$/;
const DOMAIN_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** @param senderAddress 발신 계정 주소(`user@example.com`). 마지막 `@` 뒤를 도메인으로 쓴다. */
export function buildMessageId(jobId: string, senderAddress: string): string {
  if (!JOB_ID.test(jobId)) throw new MessageIdError("INVALID_JOB_ID");

  const at = senderAddress.lastIndexOf("@");
  const rawDomain = at >= 0 ? senderAddress.slice(at + 1).toLowerCase() : "";
  const domain = rawDomain === "" ? "" : domainToASCII(rawDomain);
  if (
    domain === "" ||
    domain.length > 253 ||
    !domain.split(".").every((l) => DOMAIN_LABEL.test(l))
  ) {
    throw new MessageIdError("INVALID_SENDER_DOMAIN");
  }
  return `<${jobId}@${domain}>`;
}
