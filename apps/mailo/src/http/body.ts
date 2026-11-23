import type { HttpRequest, HttpResponse } from "./types.js";
import { problems } from "./problem.js";

/** 요청 `Content-Type`이 `application/json`(charset은 utf-8만)인지 확인한다. 아니면 415. */
export function assertJsonContentType(req: HttpRequest): void {
  const header = req.headers["content-type"];
  if (typeof header !== "string") throw problems.unsupportedMediaType();
  const [mediaType, ...params] = header.split(";").map((p) => p.trim());
  if (mediaType?.toLowerCase() !== "application/json")
    throw problems.unsupportedMediaType();
  for (const param of params) {
    const [name, value] = param.split("=");
    if (
      name?.trim().toLowerCase() === "charset" &&
      value?.trim().replace(/"/g, "").toLowerCase() !== "utf-8"
    ) {
      throw problems.unsupportedMediaType();
    }
  }
}

/**
 * 요청 본문을 읽어 JSON으로 파싱한다. 크기 상한을 넘으면 413이다(RQ-030, 원시 요청 2 MiB).
 * - `Content-Length`가 상한을 넘으면 본문을 읽지 않고 거부한다. 계약이 허용한다(openapi.yaml POST /jobs).
 * - 길이를 알 수 없는 본문(chunked)은 읽는 중 누적 바이트가 상한을 넘으면 거부한다.
 * - UTF-8이 아니거나 JSON 구문 오류이면 `malformed-request`(400)다. 오류에 본문 조각을 넣지 않는다.
 */
export async function readJsonBody(
  req: HttpRequest,
  maxBytes: number,
): Promise<unknown> {
  const declared = req.headers["content-length"];
  if (
    typeof declared === "string" &&
    /^\d+$/.test(declared) &&
    Number(declared) > maxBytes
  ) {
    throw problems.payloadTooLarge();
  }

  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk as Uint8Array);
    total += buffer.length;
    if (total > maxBytes) throw problems.payloadTooLarge();
    chunks.push(buffer);
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw problems.malformedRequest();
  }
  try {
    return JSON.parse(text);
  } catch {
    throw problems.malformedRequest();
  }
}

/** JSON 응답을 보낸다. Nest의 기본 상태 코드(POST는 201)를 거치지 않고 상태·헤더를 직접 정한다. */
export function sendJson(
  res: HttpResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const text = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(text));
  for (const [name, value] of Object.entries(headers))
    res.setHeader(name, value);
  res.end(text);
}
