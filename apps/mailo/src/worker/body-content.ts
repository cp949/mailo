/**
 * 큐에 암호화해 저장하는 본문 평문의 형식. `register`의 `body`(Uint8Array)와 Worker 복호화 결과가 쓰는
 * 같은 계약이다. `crypto/body-cipher.ts`의 평문 형식(`{"v":1,"subject","text","html"}`)과 같다.
 * 오류에는 원문을 넣지 않고 코드만 쓴다(RQ-027).
 */
export interface MailContent {
  subject: string;
  text: string | null;
  html: string | null;
}

export class BodyContentError extends Error {
  constructor(readonly code: "BODY_MALFORMED") {
    super(`body content is malformed (code=${code})`);
    this.name = "BodyContentError";
  }
}

const FORMAT_VERSION = 1;

export function encodeBodyContent(content: MailContent): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      v: FORMAT_VERSION,
      subject: content.subject,
      text: content.text,
      html: content.html,
    }),
    "utf8",
  );
}

export function decodeBodyContent(plaintext: Uint8Array): MailContent {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(plaintext).toString("utf8"));
  } catch {
    throw new BodyContentError("BODY_MALFORMED");
  }
  const rec = parsed as Record<string, unknown> | null;
  const nullableString = (v: unknown): v is string | null =>
    v === null || typeof v === "string";
  if (
    rec === null ||
    typeof rec !== "object" ||
    rec["v"] !== FORMAT_VERSION ||
    typeof rec["subject"] !== "string" ||
    !nullableString(rec["text"]) ||
    !nullableString(rec["html"])
  ) {
    throw new BodyContentError("BODY_MALFORMED");
  }
  return { subject: rec["subject"], text: rec["text"], html: rec["html"] };
}
