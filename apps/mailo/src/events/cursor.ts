/** 형식이 잘못된 cursor. 원문을 오류 메시지에 넣지 않는다. */
export class InvalidCursorError extends Error {
  constructor() {
    super("cursor 형식이 올바르지 않다");
    this.name = "InvalidCursorError";
  }
}

export interface EventCursor {
  /** xid8를 10진 문자열로 다룬다. 64비트라 number로 변환하면 정밀도를 잃을 수 있다. */
  txid: string;
  id: string;
}

// PostgreSQL 범위: id는 bigint(2^63-1), txid는 xid8(2^64-1). 넘으면 쿼리가 오류를 내 503이 되므로 미리 거부한다.
const MAX_ID = 9223372036854775807n;
const MAX_TXID = 18446744073709551615n;

// 앞자리 0이 없는 10진수만 허용한다. 같은 위치를 다른 문자열로 표현하지 못하게 한다.
const DIGITS = /^(0|[1-9]\d{0,19})$/;

/** `(txid, id)`를 base64url 불투명 문자열로 만든다(ADR-0006 결정 7). */
export function encodeCursor(cursor: EventCursor): string {
  return Buffer.from(`${cursor.txid}:${cursor.id}`, "utf8").toString(
    "base64url",
  );
}

export function decodeCursor(raw: string): EventCursor {
  // base64url 문자 밖의 입력은 Buffer가 조용히 무시하므로 먼저 걸러낸다.
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(raw)) throw new InvalidCursorError();
  const text = Buffer.from(raw, "base64url").toString("utf8");
  const parts = text.split(":");
  const [txid, id] = parts;
  if (
    parts.length !== 2 ||
    txid === undefined ||
    id === undefined ||
    !DIGITS.test(txid) ||
    !DIGITS.test(id)
  ) {
    throw new InvalidCursorError();
  }
  if (BigInt(txid) > MAX_TXID || BigInt(id) > MAX_ID) {
    throw new InvalidCursorError();
  }
  // base64url의 비정규 표기(남는 비트 값 차이)도 거부한다.
  const canonical = encodeCursor({ txid, id });
  if (canonical !== raw) throw new InvalidCursorError();
  return { txid, id };
}
