import { problems, sendProblem } from "../http/index.js";
import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { OpsConfig } from "../config/index.js";
import { checkBearer, createOpsTokenMatcher } from "./bearer-auth.js";
import type { CallerRegistry } from "./registry.js";

/**
 * `/ops/*`의 인증을 라우트 매칭보다 먼저 한다(ADR-0011 결정 7). `app.use("/ops", ...)`로 걸어야 한다.
 * 이유: `/ops/jobs/%` 같은 경로는 Express가 라우트의 경로 파라미터를 디코딩하다 실패해 가드 전에 오류를 낸다.
 * 이 오류가 인증 실패보다 먼저 나가면 자격 없는 호출자가 400으로 라우트의 존재와 형식을 알아낸다.
 * 이 미들웨어가 먼저 401·403으로 거절하므로 파라미터 오류는 인증된 호출에만 보인다.
 *
 * 권한은 메서드로 가른다. `GET`·`HEAD`는 읽기, 나머지는 관리다. `/ops`의 읽기 endpoint는 모두 `GET`이다.
 * 컨트롤러의 `OpsReadGuard`·`OpsAdminGuard`가 같은 판정을 한 번 더 한다(이중 방어).
 */
export function createOpsAuthMiddleware(
  registry: CallerRegistry,
  opsConfig: OpsConfig,
): (req: HttpRequest, res: HttpResponse, next: () => void) => void {
  const ops = createOpsTokenMatcher(opsConfig);
  return (req, res, next) => {
    const result = checkBearer(req, registry, ops);
    const needsAdmin = req.method !== "GET" && req.method !== "HEAD";
    if (result.kind !== "operator")
      return sendProblem(res, req.requestId, problems.unauthorized());
    if (needsAdmin && result.role !== "admin")
      return sendProblem(res, req.requestId, problems.forbidden());
    next();
  };
}

/**
 * `/metrics`의 인증을 라우트 매칭보다 먼저 한다(ADR-0012 결정 1). `app.use("/metrics", ...)`로 걸어야 한다.
 * `/ops`와 같은 이유다. 경로 디코딩 오류가 인증 실패보다 먼저 나가 라우트의 존재를 드러내지 않게 한다.
 * 읽기 토큰만 통과하고 관리 토큰은 403, 그 밖은 401이다. 컨트롤러의 `MetricsReadGuard`가 같은 판정을 한 번 더 한다(이중 방어).
 */
export function createMetricsAuthMiddleware(
  registry: CallerRegistry,
  opsConfig: OpsConfig,
): (req: HttpRequest, res: HttpResponse, next: () => void) => void {
  const ops = createOpsTokenMatcher(opsConfig);
  return (req, res, next) => {
    const result = checkBearer(req, registry, ops);
    if (result.kind !== "operator")
      return sendProblem(res, req.requestId, problems.unauthorized());
    if (result.role !== "read")
      return sendProblem(res, req.requestId, problems.forbidden());
    next();
  };
}
