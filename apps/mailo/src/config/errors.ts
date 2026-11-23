/**
 * 설정 오류. 메시지는 변수 이름과 고정 사유만 담는다. 값(비밀번호, 키, DB URL)은 넣지 않는다(RQ-027).
 */
export class ConfigError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`설정이 올바르지 않다:\n${issues.map((i) => `- ${i}`).join("\n")}`);
    this.name = "ConfigError";
  }
}
