/**
 * 열린 뒤 nlink 0이라 `gone`으로 본 경로를 연속 폴링 횟수로 센다(N5, ADR-0004 구현 중 확정 36).
 * 다른 인스턴스와의 삭제 경쟁이면 다음 폴링에서 이름이 사라져 연속으로 나오지 않는다.
 * 같은 경로가 계속 나오면 파일시스템(일부 FUSE·SMB)이 살아 있는 파일의 `st_nlink`를 0으로 보고하는 것이고,
 * 그 파일은 영구히 건너뛰어진다. 경로는 키로만 쓰고 호출자가 로그에 내보내지 않는다(RQ-027).
 */
/** 추적하는 경로 수의 상한. 폴러가 `prune`으로 정리하지만, 그 경로가 막혀도 메모리가 무한히 늘지 않게 하는 안전장치다. */
export const NLINK_ZERO_MAX_TRACKED = 10_000;

export class NlinkZeroTracker {
  // Map은 삽입 순서를 지킨다. 상한을 넘으면 가장 오래된 경로부터 버린다.
  private readonly streaks = new Map<string, number>();

  constructor(private readonly warnAfter: number) {}

  /** nlink 0을 한 번 더 봤다. 연속 횟수가 처음 `warnAfter`에 닿은 호출에서만 true다(경고는 경로당 한 번). */
  record(path: string): boolean {
    const streak = (this.streaks.get(path) ?? 0) + 1;
    this.streaks.delete(path); // 갱신한 경로를 가장 최근으로 보낸다.
    this.streaks.set(path, streak);
    if (this.streaks.size > NLINK_ZERO_MAX_TRACKED) {
      const oldest = this.streaks.keys().next().value;
      if (oldest !== undefined) this.streaks.delete(oldest);
    }
    return streak === this.warnAfter;
  }

  /** 이 경로가 nlink 0이 아닌 결과로 끝났다. 연속이 끊긴다. */
  clear(path: string): void {
    this.streaks.delete(path);
  }

  /** `dir` 아래에서 이번 목록(`present`)에 없는 경로를 버린다. 사라진 파일의 횟수가 쌓이지 않게 한다. */
  prune(dir: string, present: ReadonlySet<string>): void {
    for (const path of this.streaks.keys())
      if (path.startsWith(`${dir}/`) && !present.has(path))
        this.streaks.delete(path);
  }

  get size(): number {
    return this.streaks.size;
  }
}
