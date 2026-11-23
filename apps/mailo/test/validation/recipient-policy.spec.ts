import { describe, expect, it } from "@jest/globals";
import {
  checkDomain,
  findDisallowedRecipients,
} from "../../src/validation/index.js";

// RQ-046, ADR-0011 결정 8: 수신 도메인 허용 목록 판정과 도메인 단독 검사. 주소 값은 결과에 나오면 안 된다(RQ-027).

const recipients = (to: string[], cc: string[] = [], bcc: string[] = []) => ({
  to,
  cc,
  bcc,
});

describe("checkDomain: 접수 검증의 도메인 규칙을 도메인 단독으로 검사한다", () => {
  it.each(["example.com", "mail.example.com", "xn--9n2bp8q.kr", "a-b.example"])(
    "%s는 통과한다",
    (domain) => {
      expect(checkDomain(domain)).toBeUndefined();
    },
  );

  it.each([
    ["라벨이 하나", "localhost"],
    ["끝 점", "example.com."],
    ["선행 점", ".example.com"],
    ["빈 라벨", "example..com"],
    ["와일드카드", "*.example.com"],
    ["하이픈으로 시작하는 라벨", "-a.example.com"],
    ["공백 포함", "exa mple.com"],
    ["마지막 라벨이 숫자뿐(IP 형태)", "1.2.3.4"],
    ["U-label", "예시.kr"],
    ["빈 문자열", ""],
  ])("%s는 거부한다", (_name, domain) => {
    expect(checkDomain(domain)).toBe("ADDRESS_FORMAT");
  });

  it("63자를 넘는 라벨과 주소 상한을 넘는 도메인을 거부한다", () => {
    expect(checkDomain(`${"a".repeat(64)}.com`)).toBe("ADDRESS_FORMAT");
    expect(checkDomain(`${"a".repeat(60)}.`.repeat(5) + "com")).toBe(
      "ADDRESS_TOO_LONG",
    );
  });
});

describe("findDisallowedRecipients (ADR-0011 결정 8)", () => {
  it("허용 목록이 없으면(null) 제한하지 않는다", () => {
    expect(
      findDisallowedRecipients(recipients(["a@anything.test"]), null),
    ).toEqual([]);
  });

  it("도메인을 정확히 비교하고 @ 뒤를 소문자로 바꿔 비교한다", () => {
    const allowed = ["example.com"];
    expect(
      findDisallowedRecipients(recipients(["Kim@EXAMPLE.Com"]), allowed),
    ).toEqual([]);
    expect(
      findDisallowedRecipients(recipients(["kim@example.com"]), allowed),
    ).toEqual([]);
  });

  it("하위 도메인과 상위 도메인, 접미사만 같은 도메인은 허용하지 않는다", () => {
    const allowed = ["example.com"];
    for (const address of [
      "a@mail.example.com",
      "a@com",
      "a@badexample.com",
      "a@example.com.evil.test",
    ]) {
      const bad = findDisallowedRecipients(recipients([address]), allowed);
      expect(bad).toEqual([
        { pointer: "/to/0", code: "RECIPIENT_DOMAIN_NOT_ALLOWED" },
      ]);
    }
  });

  it("A-label로 적은 국제화 도메인은 정확히 일치할 때 허용한다", () => {
    expect(
      findDisallowedRecipients(recipients(["a@xn--9n2bp8q.kr"]), [
        "xn--9n2bp8q.kr",
      ]),
    ).toEqual([]);
  });

  it("to·cc·bcc의 모든 주소를 검사하고 어긴 주소의 위치만 돌려준다(replyTo는 대상이 아니다)", () => {
    const bad = findDisallowedRecipients(
      recipients(
        ["ok@example.com", "bad1@other.test"],
        ["ok@example.com", "ok@example.org", "bad2@other.test"],
        ["bad3@other.test"],
      ),
      ["example.com", "example.org"],
    );
    expect(bad).toEqual([
      { pointer: "/to/1", code: "RECIPIENT_DOMAIN_NOT_ALLOWED" },
      { pointer: "/cc/2", code: "RECIPIENT_DOMAIN_NOT_ALLOWED" },
      { pointer: "/bcc/0", code: "RECIPIENT_DOMAIN_NOT_ALLOWED" },
    ]);
  });

  it("결과에 주소와 도메인 값이 없다(RQ-027)", () => {
    const bad = findDisallowedRecipients(
      recipients(["canary-recipient-a8e1@canary-domain-c0de.test"]),
      ["example.com"],
    );
    expect(JSON.stringify(bad)).not.toContain("canary");
  });
});
