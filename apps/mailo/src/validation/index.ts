export type { ValidationErrorCode, ValidationErrorItem } from "./error-item.js";
export { isSenderAllowed } from "./sender-policy.js";
export {
  DEFAULT_MAIL_REQUEST_LIMITS,
  MailValidationError,
  assertValidMailRequest,
  checkAddress,
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
