/**
 * 파일 시스템 오류 코드 판별(ADR-0004 구현 중 확정 NFS 항목).
 *
 * NFS에서 다른 클라이언트가 파일·폴더를 지우거나 바꾸면 open·fstat·read·readdir가 `ESTALE`(Linux errno 116)로 실패할 수 있다.
 * libuv에는 `ESTALE` 이름이 없어 Node는 `code`를 "Unknown system error -116"으로 채우고 `errno`만 -116으로 둔다.
 * `code === "ESTALE"` 비교는 항상 거짓이므로 `errno`로 판별한다.
 */
const ESTALE_ERRNO = -116;

/** NFS stale file handle인가. 대상이 다른 클라이언트에서 지워졌거나 바뀐 것이다. */
export function isStale(error: unknown): boolean {
  const e = error as NodeJS.ErrnoException | null | undefined;
  return e?.code === "ESTALE" || e?.errno === ESTALE_ERRNO;
}

/** 로그·기록용 오류 코드. `ESTALE`은 이름으로 바꿔 쓴다. */
export function errnoCode(error: unknown): string {
  if (isStale(error)) return "ESTALE";
  return (error as NodeJS.ErrnoException | null | undefined)?.code ?? "UNKNOWN";
}
