export { SmtpModule } from "./smtp.module.js";
export {
  ACCOUNT_REASON_POLICY,
  ACCOUNT_TRIPS_LIMIT,
  CLASSIFICATION_RULES,
  RecipientResultError,
  accountOpenSeconds,
  classifySmtpFailure,
  isMessageStage,
  resolveRecipientOutcome,
  shouldPromoteToPermanent,
} from "./classify.js";
export type { AdaptHint } from "./nodemailer-adapter.js";
export type {
  AccountReason,
  AccountReasonPolicy,
  Classification,
  RecipientOutcome,
  RecipientResult,
  RejectedRecipient,
  RuleSource,
  SmtpFailure,
  SmtpStage,
  TransportFault,
} from "./classify.js";
export {
  adaptNodemailerError,
  adaptNodemailerRejectedError,
  adaptNodemailerSendInfo,
  detectStage,
  parseEnhancedStatus,
} from "./nodemailer-adapter.js";
export { MessageIdError, buildMessageId } from "./message-id.js";
export {
  DEFAULT_LEASE_MARGIN_MS,
  DEFAULT_SMTP_TIMEOUTS,
  SmtpAbortedError,
  SmtpConfigError,
  SmtpInternalError,
  StageTracker,
  checkSmtpTimeouts,
  createSmtpSender,
  sanitizeResponseText,
} from "./sender.js";
export type {
  MailSender,
  SendOptions,
  SmtpFailureDetail,
  SmtpMessage,
  SmtpSendResult,
  SmtpSenderConfig,
  SmtpTimeouts,
  TlsMode,
} from "./sender.js";
