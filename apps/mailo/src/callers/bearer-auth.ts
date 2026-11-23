import {
  Inject,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from "@nestjs/common";
import { createParamDecorator } from "@nestjs/common";
import { createHash, timingSafeEqual } from "node:crypto";
import { APP_CONFIG, type AppConfig, type OpsConfig } from "../config/index.js";
import { problems, type HttpRequest } from "../http/index.js";
import type { CallerRegistry } from "./registry.js";
import { CALLER_REGISTRY } from "./tokens.js";

// 키는 256비트 난수라 base64로 44자 안팎이다. 이보다 훨씬 긴 입력은 해시하지 않고 거부한다.
const MAX_TOKEN_CHARS = 512;
const BEARER = /^Bearer +([^\s]+)$/i;

/** 운영 토큰이 준 권한. 관리 토큰은 읽기 권한을 포함한다(ADR-0011 결정 1). */
export type OperatorRole =
  | { role: "read" }
  | { role: "admin"; /** 감사의 `actor`가 되는 관리 토큰 이름 */ name: string };

export type BearerResult =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "caller"; callerId: string }
  | ({ kind: "operator" } & OperatorRole);

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** 제시된 Bearer 값이 운영 토큰 중 무엇과 같은지 판정한다. */
export interface OpsTokenMatcher {
  match(token: string): OperatorRole | undefined;
}

/**
 * 설정의 운영 토큰으로 판정기를 만든다. 토큰은 해시로만 들고 있고 평문을 보관하지 않는다.
 * 길이를 숨기려고 해시끼리 상수 시간으로 비교하며, 일치한 뒤에도 나머지 토큰을 끝까지 비교한다.
 */
export function createOpsTokenMatcher(ops: OpsConfig): OpsTokenMatcher {
  const read = ops.token === null ? null : sha256(ops.token.reveal());
  const admins = ops.admins.map((a) => ({
    name: a.name,
    hash: sha256(a.token.reveal()),
  }));
  return {
    match(token) {
      const presented = sha256(token);
      let found: OperatorRole | undefined;
      if (read !== null && timingSafeEqual(presented, read))
        found = { role: "read" };
      for (const admin of admins) {
        if (timingSafeEqual(presented, admin.hash))
          found = { role: "admin", name: admin.name };
      }
      return found;
    },
  };
}

/** `Authorization` 헤더를 판정한다. 자격 없음, 형식 오류, 틀린 키를 호출자가 구분하지 못하게 `invalid`로 합친다. */
export function checkBearer(
  req: HttpRequest,
  registry: CallerRegistry,
  ops?: OpsTokenMatcher,
): BearerResult {
  const header = req.headers["authorization"];
  if (header === undefined) return { kind: "absent" };
  const token =
    typeof header === "string" ? BEARER.exec(header)?.[1] : undefined;
  if (token === undefined || token.length > MAX_TOKEN_CHARS)
    return { kind: "invalid" };
  const operator = ops?.match(token);
  if (operator !== undefined) return { kind: "operator", ...operator };
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
  private readonly ops: OpsTokenMatcher;

  constructor(
    @Inject(CALLER_REGISTRY) private readonly registry: CallerRegistry,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ops = createOpsTokenMatcher(config.ops);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const result = checkBearer(req, this.registry, this.ops);
    if (result.kind === "invalid") throw problems.unauthorized();
    if (result.kind === "caller") req.callerId = result.callerId;
    // 읽기·관리 토큰 모두 같은 운영자 응답을 받는다(ADR-0011 결정 1).
    if (result.kind === "operator") req.isOperator = true;
    return true;
  }
}

/**
 * `/ops/*`의 읽기 endpoint용. 읽기 토큰과 관리 토큰을 받는다. 호출처 키와 자격 없음은 401이다(ADR-0011 결정 1·7).
 * 판정한 권한은 `req.operator`에 담는다.
 */
@Injectable()
export class OpsReadGuard implements CanActivate {
  private readonly ops: OpsTokenMatcher;

  constructor(
    @Inject(CALLER_REGISTRY) private readonly registry: CallerRegistry,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ops = createOpsTokenMatcher(config.ops);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const result = checkBearer(req, this.registry, this.ops);
    if (result.kind !== "operator") throw problems.unauthorized();
    req.operator =
      result.role === "admin"
        ? { role: "admin", name: result.name }
        : { role: "read" };
    return true;
  }
}

/**
 * `/ops/*`의 변경 endpoint용. 관리 토큰만 받는다. 읽기 토큰은 403(`forbidden`), 호출처 키와 자격 없음은 401이다.
 * 관리 토큰이 하나도 설정되지 않았으면 어떤 토큰도 관리 권한이 없다(읽기 토큰은 403, 나머지는 401).
 */
@Injectable()
export class OpsAdminGuard implements CanActivate {
  private readonly ops: OpsTokenMatcher;

  constructor(
    @Inject(CALLER_REGISTRY) private readonly registry: CallerRegistry,
    @Inject(APP_CONFIG) config: AppConfig,
  ) {
    this.ops = createOpsTokenMatcher(config.ops);
  }

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<HttpRequest>();
    const result = checkBearer(req, this.registry, this.ops);
    if (result.kind !== "operator") throw problems.unauthorized();
    if (result.role !== "admin") throw problems.forbidden();
    req.operator = { role: "admin", name: result.name };
    return true;
  }
}

/** 인증된 호출처 ID를 핸들러 인자로 받는다. 가드 뒤에서만 쓴다. */
export const CallerId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    return context.switchToHttp().getRequest<HttpRequest>().callerId;
  },
);
