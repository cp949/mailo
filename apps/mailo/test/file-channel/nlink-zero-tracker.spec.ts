import { describe, expect, it } from "@jest/globals";
import {
  NLINK_ZERO_MAX_TRACKED,
  NlinkZeroTracker,
} from "../../src/file-channel/nlink-zero-tracker.js";

describe("nlink 0 연속 추적(N5, ADR-0004 구현 중 확정 36)", () => {
  it("같은 경로가 연속 3회 nlink 0이면 세 번째 호출에서만 경고 신호를 낸다", () => {
    const tracker = new NlinkZeroTracker(3);

    expect(tracker.record("/r/inbox/a/x.json")).toBe(false);
    expect(tracker.record("/r/inbox/a/x.json")).toBe(false);
    expect(tracker.record("/r/inbox/a/x.json")).toBe(true);
    // 경로당 한 번이다. 넘은 뒤에는 다시 신호를 내지 않는다.
    expect(tracker.record("/r/inbox/a/x.json")).toBe(false);
  });

  it("다른 결과로 끝나면(clear) 연속이 끊기고 경로마다 따로 센다", () => {
    const tracker = new NlinkZeroTracker(3);
    tracker.record("/r/inbox/a/x.json");
    tracker.record("/r/inbox/a/x.json");
    tracker.clear("/r/inbox/a/x.json");

    expect(tracker.record("/r/inbox/a/x.json")).toBe(false);
    expect(tracker.record("/r/inbox/a/y.json")).toBe(false);
    expect(tracker.size).toBe(2);
  });

  it("목록에서 사라진 경로는 prune이 버리고, 다른 호출처 폴더는 건드리지 않는다", () => {
    const tracker = new NlinkZeroTracker(3);
    tracker.record("/r/inbox/a/gone.json");
    tracker.record("/r/inbox/a/stay.json");
    tracker.record("/r/inbox/b/other.json");

    tracker.prune("/r/inbox/a", new Set(["/r/inbox/a/stay.json"]));

    expect(tracker.size).toBe(2);
    // gone.json은 다시 1회부터 센다.
    tracker.record("/r/inbox/a/gone.json");
    tracker.record("/r/inbox/a/gone.json");
    expect(tracker.record("/r/inbox/a/gone.json")).toBe(true);
  });

  it("경로 1만 개를 거쳐도 파일이 사라지면 prune으로 항목 수가 0으로 돌아온다", () => {
    const tracker = new NlinkZeroTracker(3);
    for (let i = 0; i < 10_000; i += 1) tracker.record(`/r/inbox/a/${i}.json`);
    expect(tracker.size).toBe(10_000);

    tracker.prune("/r/inbox/a", new Set());

    expect(tracker.size).toBe(0);
  });

  it("정리가 막혀도 추적 경로는 상한을 넘지 않고 가장 오래된 경로부터 버린다", () => {
    const tracker = new NlinkZeroTracker(3);
    for (let i = 0; i <= NLINK_ZERO_MAX_TRACKED; i += 1)
      tracker.record(`/r/inbox/a/${i}.json`);

    expect(tracker.size).toBe(NLINK_ZERO_MAX_TRACKED);
    // 0번이 버려졌으므로 처음부터 다시 센다.
    tracker.record("/r/inbox/a/0.json");
    tracker.record("/r/inbox/a/0.json");
    expect(tracker.record("/r/inbox/a/0.json")).toBe(true);
  });
});
