/**
 * 기동 때 계정 구성을 점검해 알린다(RQ-053·055, ADR-0013 결정 1·6). 계정 ID와 호출처 ID만 로그에 싣는다.
 * host·user·from·비밀번호는 싣지 않는다(RQ-027).
 */
import type { SmtpAccount } from "../config/index.js";
import type { AppLogger } from "../logging/index.js";

/** 점검에 필요한 호출처 정보. `callers/`를 import하지 않으려고 구조만 받는다. */
export interface AccountReportCaller {
  id: string;
  accountId: string;
  allowedFrom: readonly string[];
}

/**
 * - `account_unused`(info): 어느 호출처도 참조하지 않는 계정. 허용하지만 알린다.
 * - `allowed_from_other_account`(warn): 호출처의 `allowedFrom`이 다른 계정의 `from`과 같다. 별칭을 계정이 공유할 수 있어 거부하지 않는다.
 * - `account_limits_not_enforced`(warn): 계정에 `sendQuota24h`·`concurrency`를 설정했지만 구현 묶음 B 전에는 점유에 쓰지 않는다.
 * - `accounts_not_isolated`(warn): 계정이 둘 이상이다. 묶음 B 전에는 계정별 차단기·정지·할당이 다른 계정의 점유를 막지 않는다.
 */
export function reportAccountConfig(
  logger: AppLogger,
  accounts: readonly SmtpAccount[],
  callers: readonly AccountReportCaller[],
): void {
  const used = new Set(callers.map((c) => c.accountId));
  for (const account of accounts) {
    if (!used.has(account.id))
      logger.info("account_unused", { accountId: account.id });
    if (account.sendQuota24h !== null || account.concurrency !== null)
      logger.warn("account_limits_not_enforced", {
        accountId: account.id,
        message:
          "sendQuota24h·concurrency는 검증만 하고 아직 점유에 쓰지 않는다(ADR-0013 구현 묶음 B)",
      });
  }
  for (const caller of callers) {
    const others = new Set(
      accounts
        .filter((a) => a.id !== caller.accountId)
        .map((a) => a.from.toLowerCase()),
    );
    if (caller.allowedFrom.some((address) => others.has(address.toLowerCase())))
      logger.warn("allowed_from_other_account", { callerId: caller.id });
  }
  if (accounts.length > 1)
    logger.warn("accounts_not_isolated", {
      accountCount: accounts.length,
      message:
        "계정이 둘 이상이다. 계정별 차단기·정지·할당이 다른 계정의 점유를 막지 않는다(ADR-0013 구현 묶음 B 전)",
    });
}
