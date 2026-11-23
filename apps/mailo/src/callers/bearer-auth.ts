import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { createParamDecorator } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import { APP_CONFIG, type AppConfig } from "../config/index.js";
import { problems, type HttpRequest } from "../http/index.js";
import type { CallerRegistry } from "./registry.js";
import { CALLER_REGISTRY } from "./tokens.js";

// 키는 256비트 난수라 base64로 44자 안팎이다. 이보다 훨씬 긴 입력은 해시하지 않고 거부한다.
const MAX_TOKEN_CHARS = 512;
const BEARER = /^Bearer +([^\s]+)$/i;

export type BearerResult =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "caller"; callerId: string }
  | { kind: "operator" };

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** 운영자 토큰과 같은지 본다. 길이를 숨기려고 해시끼리 상수 시간으로 비교한다. */
function matchesOpsToken(token: string, ops: string | undefined): boolean {
  return ops !== undefined && timingSafeEqual(sha256(token), sha256(ops));
}

/** `Authorization` 헤더를 판정한다. 자격 없음, 형식 오류, 틀린 키를 호출자가 구분하지 못하게 `invalid`로 합친다. */
export function checkBearer(
  req: HttpRequest,
  registry: CallerRegistry,
  opsToken?: string,
): BearerResult {
  const header = req.headers["authorization"];
  if (header === undefined) return { kind: "absent" };
  const token =
    typeof header === "string" ? BEARER.exec(header)?.[1] : undefined;
  if (token === undefined || token.length > MAX_TOKEN_CHARS)
    return { kind: "invalid" };
  if (matchesOpsToken(token, opsToken)) return { kind: "operator" };
  const callerId = registry.authenticate(token);
  return callerId === undefined
    ? { kind: "invalid" }
    : { kind: "caller", callerId };
}

/** 업무 endpoint용. 유효한 API 키가 없으면 401 problem+json이다(RQ-028). */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(
    @Inject(CALLER_REGISTRY) private readonly registry: CallerRegistry,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    // 업무 endpoint에는 운영자 토큰을 넘기지 않는다. 운영자 토큰은 `invalid`로 떨어진다.
    const result = checkBearer(req, this.registry);
    if (result.kind !== "caller") throw problems.unauthorized();
    req.callerId = result.callerId;
    return true;
  }
}

/**
 * 헬스 `/health/ready`용. 헤더가 없으면 익명으로 통과하고, 헤더를 보냈는데 자격이 틀리면 401이다.
 * 공개 응답으로 낮춰 반환하지 않는다(openapi.yaml).
 */
@Injectable()
export class OptionalBearerAuthGuard implements CanActivate {
  constructor(
    @Inject(CALLER_REGISTRY) private readonly registry: CallerRegistry,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const result = checkBearer(
      req,
      this.registry,
      this.config.ops.token?.reveal(),
    );
    if (result.kind === "invalid") throw problems.unauthorized();
    if (result.kind === "caller") req.callerId = result.callerId;
    if (result.kind === "operator") req.isOperator = true;
    return true;
  }
}

/** 인증된 호출처 ID를 핸들러 인자로 받는다. 가드 뒤에서만 쓴다. */
export const CallerId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    return context.switchToHttp().getRequest<HttpRequest>().callerId;
  },
);
