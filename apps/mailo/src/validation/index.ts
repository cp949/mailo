export type { ValidationErrorCode, ValidationErrorItem } from "./error-item.js";
export { isSenderAllowed } from "./sender-policy.js";
export {
  checkRequestPolicy,
  findDisallowedRecipients,
} from "./recipient-policy.js";
export type { RequestPolicy, RequestRecipients } from "./recipient-policy.js";
export {
  DEFAULT_MAIL_REQUEST_LIMITS,
  MailValidationError,
  assertValidMailRequest,
  checkAddress,
  checkDomain,
  validateIdempotencyKey,
  validateMailRequest,
} from "./mail-request.js";
export type {
  MailRequestLimits,
  ValidateMailRequestOptions,
  ValidatedMailRequest,
  ValidationCode,
  ValidationIssue,
  ValidationResult,
} from "./mail-request.js";
