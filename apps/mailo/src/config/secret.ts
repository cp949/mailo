/**
 * 시크릿 값 래퍼. 설정 객체를 로그에 찍거나 JSON으로 직렬화해도 값이 나오지 않게 한다(RQ-027).
 * 값은 `reveal()`로만 꺼낸다. 꺼내는 곳(풀 생성, SMTP 전송)에서만 평문을 다룬다.
 */
export class Secret<T> {
  readonly #value: T;

  constructor(value: T) {
    this.#value = value;
  }

  reveal(): T {
    return this.#value;
  }

  toString(): string {
    return "[REDACTED]";
  }

  toJSON(): string {
    return "[REDACTED]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "[REDACTED]";
  }
}
