import type { ValidationErrorItem } from "./error-item.js";
import { isSenderAllowed } from "./sender-policy.js";

/** 수신자 필드(`to`·`cc`·`bcc`). 접수 검증을 통과한 주소여야 한다(`@`가 하나다). */
export interface RequestRecipients {
  to: readonly string[];
  cc: readonly string[];
  bcc: readonly string[];
}

const RECIPIENT_FIELDS = ["to", "cc", "bcc"] as const;

/**
 * 수신 도메인 허용 목록을 어긴 주소의 위치를 모두 돌려준다(RQ-046, ADR-0011 결정 8).
 * 모든 수신자(`to`·`cc`·`bcc`)에서 `@` 뒤를 소문자로 바꿔 목록과 정확히 비교한다. 하위 도메인은 따로 적어야 한다.
 * `allowedDomains`가 null이면 제한이 없다. `replyTo`는 수신자가 아니라 검사하지 않는다.
 * 결과에는 위치(`/to/0`)와 고정 코드만 담는다. 주소와 도메인 값은 담지 않는다(RQ-027).
 * 허용 목록 값은 기동 때 소문자·ASCII로 검증돼 있다고 본다.
 */
export function findDisallowedRecipients(
  recipients: RequestRecipients,
  allowedDomains: readonly string[] | null,
): ValidationErrorItem[] {
  if (allowedDomains === null) return [];
  const allowed = new Set(allowedDomains);
  const errors: ValidationErrorItem[] = [];
  for (const field of RECIPIENT_FIELDS) {
    recipients[field].forEach((address, index) => {
      const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
      if (!allowed.has(domain))
        errors.push({
          pointer: `/${field}/${index}`,
          code: "RECIPIENT_DOMAIN_NOT_ALLOWED",
        });
    });
  }
  return errors;
}

/** 호출처 하나의 요청 정책. REST와 파일 채널이 같은 값으로 `checkRequestPolicy`를 부른다. */
export interface RequestPolicy {
  /** 호출처 계정의 `from`(`SmtpAccount.from`). 이 호출처가 쓸 수 있는 기본 발신 주소다(ADR-0013 결정 6). */
  defaultFrom: string;
  /** 호출처의 `allowedFrom`. */
  allowedFrom: readonly string[];
  /** 호출처의 `allowedRecipientDomains`. null이면 수신자를 제한하지 않는다. */
  allowedRecipientDomains: readonly string[] | null;
}

/**
 * 호출처 정책(발신 주소 허용, 수신 도메인 허용)을 어긴 항목을 모두 돌려준다. 비면 통과다.
 * 새 작업이 될 때만 적용한다. 이미 등록된 Key의 재전송에는 적용하지 않는다(호출자가 `denyNew`로 넘긴다).
 * REST(400 `validation-failed`)와 파일 채널(`VALIDATION_FAILED` 거부)이 같은 판정을 쓴다.
 */
export function checkRequestPolicy(
  request: RequestRecipients & { from: string | null },
  policy: RequestPolicy,
): ValidationErrorItem[] {
  const errors: ValidationErrorItem[] = [];
  if (!isSenderAllowed(request.from, policy.defaultFrom, policy.allowedFrom))
    errors.push({ pointer: "/from", code: "FROM_NOT_ALLOWED" });
  errors.push(
    ...findDisallowedRecipients(request, policy.allowedRecipientDomains),
  );
  return errors;
}
