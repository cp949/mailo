import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";

/**
 * AWS Secrets Manager의 SecretString을 읽는 Mailo `SecretSource` 어댑터다(ADR-0016 결정 3·8).
 * 참조는 `aws-sm://<SecretId>` 또는 `aws-sm://<SecretId>#<JSON 키>`다.
 * 키가 있으면 SecretString을 JSON 객체로 읽어 그 키의 문자열 값만 돌려준다.
 *
 * Mailo 코드를 import하지 않고 계약(`apps/mailo/src/secrets/source.ts`)의 구조만 맞춘다.
 * 오류는 닫힌 코드 5개(`not-found`, `access-denied`, `throttled`, `unavailable`, `invalid-value`)만 `code`로 싣고,
 * 메시지는 코드마다 고정 문구다. SDK 오류의 메시지·요청 ID·SecretId·값은 옮기지 않는다(RQ-027).
 */

const SCHEME = "aws-sm";
const SCHEME_PREFIX = `${SCHEME}://`;
const VERSION_STAGE = "AWSCURRENT";

// SecretId와 ARN에는 `#`이 들어갈 수 없어 첫 `#`이 구분자로 모호하지 않다. 키 안의 `#`은 허용하지 않는다.
const KEY_PATTERN = /^[A-Za-z0-9_.-]+$/;

/** @typedef {"not-found" | "access-denied" | "throttled" | "unavailable" | "invalid-value"} ErrorCode */

/** 코드별 고정 메시지. 이 밖의 문구는 오류에 싣지 않는다. */
const MESSAGES = Object.freeze({
  "not-found": "aws-sm: 비밀을 찾지 못했다",
  "access-denied": "aws-sm: 접근이 거부됐다",
  throttled: "aws-sm: 요청이 제한됐다",
  unavailable: "aws-sm: 저장소에 닿지 못했거나 저장소 오류다",
  "invalid-value": "aws-sm: 참조나 값을 받을 수 없다",
});
const UNCLASSIFIED_MESSAGE = "aws-sm: 해석에 실패했다";

/** 코어가 `code`만 읽는 오류. SDK 오류를 `cause`로 달지 않는다(요청 정보가 따라온다). */
class AwsSecretSourceError extends Error {
  /** @param {ErrorCode | undefined} code */
  constructor(code) {
    super(code === undefined ? UNCLASSIFIED_MESSAGE : MESSAGES[code]);
    this.name = "AwsSecretSourceError";
    if (code !== undefined) this.code = code;
  }
}

/** @type {Readonly<Record<string, ErrorCode>>} */
const NAME_TO_CODE = Object.freeze({
  ResourceNotFoundException: "not-found",

  AccessDeniedException: "access-denied",
  UnrecognizedClientException: "access-denied",
  InvalidSignatureException: "access-denied",
  ExpiredTokenException: "access-denied",
  InvalidClientTokenId: "access-denied",
  SignatureDoesNotMatch: "access-denied",
  IncompleteSignature: "access-denied",
  MissingAuthenticationToken: "access-denied",
  // 자격 증명 체인에서 자격 증명을 얻지 못했다.
  CredentialsProviderError: "access-denied",
  // 비밀의 KMS 키를 쓸 권한이 없거나 키를 쓸 수 없다.
  DecryptionFailure: "access-denied",

  ThrottlingException: "throttled",
  TooManyRequestsException: "throttled",
  RequestLimitExceeded: "throttled",
  LimitExceededException: "throttled",

  InternalServiceError: "unavailable",
  ServiceUnavailable: "unavailable",
  ServiceUnavailableException: "unavailable",
  RequestTimeout: "unavailable",
  RequestTimeoutException: "unavailable",
  TimeoutError: "unavailable",
  AbortError: "unavailable",

  InvalidRequestException: "invalid-value",
  InvalidParameterException: "invalid-value",
  ValidationException: "invalid-value",
});

const NETWORK_ERROR_CODE =
  /^(?:ECONNREFUSED|ECONNRESET|ECONNABORTED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|UND_ERR_\w+)$/;

/**
 * SDK가 던진 값을 닫힌 코드로 바꾼다. 이름·상태·`code`·재시도 분류만 읽고 메시지는 읽지 않는다.
 * 속성 접근이 던져도(getter, Proxy) 분류하지 못한 것으로 본다.
 * @param {unknown} error
 * @returns {ErrorCode | undefined}
 */
function classify(error) {
  try {
    if (typeof error !== "object" || error === null) return undefined;
    const { name, code, $metadata, $retryable } = /** @type {any} */ (error);
    if (typeof name === "string" && Object.hasOwn(NAME_TO_CODE, name))
      return NAME_TO_CODE[name];
    if ($retryable?.throttling === true) return "throttled";
    const status = $metadata?.httpStatusCode;
    if (typeof status === "number") {
      if (status === 429) return "throttled";
      if (status === 401 || status === 403) return "access-denied";
      if (status >= 500) return "unavailable";
    }
    if (typeof code === "string" && NETWORK_ERROR_CODE.test(code))
      return "unavailable";
  } catch {
    // 분류하지 못한 오류로 처리한다.
  }
  return undefined;
}

/**
 * 참조에서 SecretId와 JSON 키를 나눈다.
 * @param {string} ref
 * @returns {{ secretId: string, key: string | undefined }}
 */
function parseRef(ref) {
  if (typeof ref !== "string" || !ref.startsWith(SCHEME_PREFIX))
    throw new AwsSecretSourceError("invalid-value");
  const rest = ref.slice(SCHEME_PREFIX.length);
  const hash = rest.indexOf("#");
  const secretId = hash < 0 ? rest : rest.slice(0, hash);
  const key = hash < 0 ? undefined : rest.slice(hash + 1);
  if (secretId === "" || (key !== undefined && !KEY_PATTERN.test(key)))
    throw new AwsSecretSourceError("invalid-value");
  return { secretId, key };
}

/**
 * SecretString에서 키의 문자열 값을 고른다. 파싱 오류에는 본문 일부가 실리므로 버린다.
 * @param {string} secretString
 * @param {string} key
 * @returns {string}
 */
function selectKey(secretString, key) {
  let parsed;
  try {
    parsed = JSON.parse(secretString);
  } catch {
    throw new AwsSecretSourceError("invalid-value");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new AwsSecretSourceError("invalid-value");
  // 상속 속성(constructor 등)은 키로 인정하지 않는다. JSON에 적힌 키는 own 속성이다.
  if (!Object.hasOwn(parsed, key))
    throw new AwsSecretSourceError("invalid-value");
  const value = parsed[key];
  if (typeof value !== "string")
    throw new AwsSecretSourceError("invalid-value");
  return value;
}

/**
 * @typedef {object} ClientLike
 * @property {(command: unknown, options: { abortSignal: AbortSignal }) => Promise<{ SecretString?: string }>} send
 * @property {() => void} destroy
 */

/**
 * @param {{ createClient?: (config: { region: string }) => ClientLike, env?: Record<string, string | undefined> }} [dependencies]
 *   테스트가 SDK 클라이언트와 환경을 바꿔 끼운다. 기본은 실제 SDK와 `process.env`다.
 *   엔드포인트는 SDK가 표준 환경 변수(`AWS_ENDPOINT_URL_SECRETS_MANAGER`, `AWS_ENDPOINT_URL`)로 읽는다.
 */
export function createAwsSecretSource({
  createClient = (config) => new SecretsManagerClient(config),
  env = process.env,
} = {}) {
  return Object.freeze({
    scheme: SCHEME,

    /**
     * @param {string} ref `X_REF` 값 전체
     * @param {{ signal: AbortSignal }} options
     * @returns {Promise<string>}
     */
    async resolve(ref, { signal }) {
      const { secretId, key } = parseRef(ref);
      const region = env.AWS_REGION;
      if (typeof region !== "string" || region === "")
        throw new AwsSecretSourceError("invalid-value");
      // 이미 중단됐으면 클라이언트를 만들지 않는다.
      if (signal.aborted) throw new AwsSecretSourceError("unavailable");

      const client = createClient({ region });
      try {
        const result = await client.send(
          new GetSecretValueCommand({
            SecretId: secretId,
            VersionStage: VERSION_STAGE,
          }),
          { abortSignal: signal },
        );
        // SecretBinary는 지원하지 않는다.
        if (typeof result?.SecretString !== "string")
          throw new AwsSecretSourceError("invalid-value");
        return key === undefined
          ? result.SecretString
          : selectKey(result.SecretString, key);
      } catch (error) {
        throw error instanceof AwsSecretSourceError
          ? error
          : new AwsSecretSourceError(classify(error));
      } finally {
        // 연 연결을 닫는다. 어댑터가 남긴 핸들은 앱 프로세스(main.ts)에 그대로 붙는다.
        try {
          client.destroy();
        } catch {
          // 정리 실패가 해석 결과를 바꾸지 않는다.
        }
      }
    },
  });
}

/** Mailo 로더가 불러올 기본 어댑터. 모듈 로드 중에는 비동기 작업을 하지 않는다. */
export default createAwsSecretSource();
