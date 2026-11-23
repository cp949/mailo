/**
 * 발신 주소(From) 허용 정책(RQ-028·RQ-030, ADR-0008 구현 중 확정 12). 호출처 하나의 허용 집합은
 * `{호출처 계정의 from} ∪ callers.json의 allowedFrom`이다(ADR-0013 결정 6). 비교는 addr-spec 전체를 대소문자 무시로 한다.
 * `from`을 생략한 요청(null)은 항상 허용한다. Worker가 작업 계정의 `from`으로 채운다.
 * `defaultFrom` 인자는 호출처 계정의 `from`이다. 호출하는 쪽(`IntakeService`·파일 채널 `ingest`)이 계정을 찾아 넘긴다.
 * `replyTo`에는 적용하지 않는다(형식 검증만).
 */
export function isSenderAllowed(
  from: string | null,
  defaultFrom: string,
  allowedFrom: readonly string[],
): boolean {
  if (from === null) return true;
  const wanted = from.toLowerCase();
  return (
    defaultFrom.toLowerCase() === wanted ||
    allowedFrom.some((address) => address.toLowerCase() === wanted)
  );
}
