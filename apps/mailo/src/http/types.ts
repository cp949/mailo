import type { IncomingMessage, ServerResponse } from "node:http";

/**
 * 요청 객체. Express 타입에 의존하지 않고 쓰는 필드만 선언한다.
 * Express가 `query`를 채우고, 미들웨어와 가드가 `requestId`와 `callerId`를 채운다.
 */
export interface HttpRequest extends IncomingMessage {
  requestId: string;
  /** 인증된 호출처. 가드가 채운다. */
  callerId?: string;
  /** 운영자 토큰(`MAILO_OPS_TOKEN`)으로 인증됐다. `/health/ready`의 가드만 채운다. */
  isOperator?: boolean;
  query: Record<string, unknown>;
  params: Record<string, string>;
  /** Express가 라우트 매칭 뒤 채운다. 로그에는 원본 URL 대신 이 패턴을 쓴다. */
  route?: { path: string };
}

export type HttpResponse = ServerResponse;
