import { readFileSync } from "node:fs";

/**
 * 환경 변수 읽기 도우미. 오류는 던지지 않고 모아서 `finish()`가 한 번에 던진다.
 * 이름만 보고 고칠 수 있도록 사유는 고정 문구다. 읽은 값은 어떤 사유에도 넣지 않는다.
 */
import { ConfigError } from "./errors.js";

const INTEGER = /^\d{1,15}$/;
const DECIMAL = /^\d{1,9}(\.\d{1,9})?$/;

export class EnvReader {
  readonly issues: string[] = [];

  constructor(readonly env: NodeJS.ProcessEnv) {}

  /** 빈 문자열은 없는 값으로 본다. compose가 `${VAR:-}`로 빈 값을 넘기기 때문이다. */
  raw(name: string): string | undefined {
    const value = this.env[name];
    return value === undefined || value === "" ? undefined : value;
  }

  /**
   * 공개 샘플 값 거부 같은 엄격 검사를 적용할지 본다. `NODE_ENV`가 `development`·`test`로 명시된 경우만 false다.
   * 값이 없거나 알 수 없는 값이면 true다(fail closed). 로컬 시험은 `NODE_ENV=development`를 명시한다.
   */
  strictEnv(): boolean {
    const value = this.raw("NODE_ENV")?.trim();
    return value !== "development" && value !== "test";
  }

  issue(message: string): void {
    this.issues.push(message);
  }

  string(name: string, fallback: string): string {
    return this.raw(name) ?? fallback;
  }

  requiredString(name: string): string | undefined {
    const value = this.raw(name);
    if (value === undefined) this.issue(`${name}이 설정되지 않았다`);
    return value;
  }

  int(
    name: string,
    fallback: number,
    range: { min: number; max: number },
  ): number {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    const text = value.trim();
    const parsed = INTEGER.test(text) ? Number(text) : Number.NaN;
    if (!Number.isInteger(parsed) || parsed < range.min || parsed > range.max) {
      this.issue(
        `${name}은 ${range.min} 이상 ${range.max} 이하의 정수여야 한다`,
      );
      return fallback;
    }
    return parsed;
  }

  decimal(
    name: string,
    fallback: number,
    range: { min: number; max: number; maxExclusive?: boolean },
  ): number {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    const text = value.trim();
    const parsed = DECIMAL.test(text) ? Number(text) : Number.NaN;
    const aboveMax =
      range.maxExclusive === true ? parsed >= range.max : parsed > range.max;
    if (Number.isNaN(parsed) || parsed < range.min || aboveMax) {
      const bound = range.maxExclusive === true ? "미만" : "이하";
      this.issue(
        `${name}은 ${range.min} 이상 ${range.max} ${bound}의 숫자여야 한다`,
      );
      return fallback;
    }
    return parsed;
  }

  oneOf<T extends string>(name: string, allowed: readonly T[], fallback: T): T {
    const value = this.raw(name);
    if (value === undefined) return fallback;
    const found = allowed.find((a) => a === value.trim());
    if (found === undefined) {
      this.issue(`${name}은 ${allowed.join(", ")} 중 하나여야 한다`);
      return fallback;
    }
    return found;
  }

  /**
   * 시크릿을 읽는다. `<NAME>_FILE`(시크릿 파일 마운트)이 `<NAME>`(환경 변수)보다 우선한다.
   * 파일 끝의 개행은 제거한다. 읽기 실패 사유는 errno 코드만 적는다.
   */
  secret(name: string): string | undefined {
    const fileVar = `${name}_FILE`;
    const path = this.raw(fileVar);
    if (path !== undefined) return this.readSecretFile(fileVar, path);
    return this.raw(name);
  }

  readSecretFile(variable: string, path: string): string | undefined {
    try {
      const text = readFileSync(path, "utf8").replace(/\r?\n$/, "");
      if (text === "") {
        this.issue(`${variable}이 가리키는 파일이 비어 있다`);
        return undefined;
      }
      return text;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
      this.issue(`${variable}이 가리키는 파일을 읽지 못했다(${code})`);
      return undefined;
    }
  }

  finish(): void {
    if (this.issues.length > 0) throw new ConfigError(this.issues);
  }
}
