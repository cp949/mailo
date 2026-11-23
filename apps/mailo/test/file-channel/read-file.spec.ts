import { afterAll, beforeAll, describe, expect, it } from "@jest/globals";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  linkSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EMPTY_SHA256 } from "../../src/file-channel/index.js";
import { readInboxFile } from "../../src/file-channel/read-file.js";
import { mkfifo } from "../support/file-channel.js";

// ADR-0004 결정 5의 1~2단계(open 플래그, fstat, 상한 + 1바이트 읽기)와 "구현 중 확정"의 sha256 정책. RQ-002.

const sha = (data: Buffer) => createHash("sha256").update(data).digest("hex");
const LIMIT = 4096;

describe("입력 파일 읽기 (ADR-0004 결정 5, RQ-002)", () => {
  let dir: string;
  let n = 0;
  const file = (name = `f${n++}.json`) => path.join(dir, name);

  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), "mailo-read-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("상한 이하 일반 파일은 전체 바이트와 전체 sha256을 돌려준다", async () => {
    const data = Buffer.from('{"a":1}');
    const target = file();
    writeFileSync(target, data);

    const result = await readInboxFile(target, LIMIT);

    expect(result).toMatchObject({
      kind: "read",
      sizeBytes: data.length,
      sha256: sha(data),
    });
    expect((result as { bytes: Buffer }).bytes.equals(data)).toBe(true);
  });

  it("정확히 상한 크기인 파일은 읽고, 1바이트 넘으면 크기 초과다", async () => {
    const exact = file();
    const over = file();
    writeFileSync(exact, Buffer.alloc(LIMIT, 0x61));
    writeFileSync(over, Buffer.alloc(LIMIT + 1, 0x61));

    expect((await readInboxFile(exact, LIMIT)).kind).toBe("read");
    expect(await readInboxFile(over, LIMIT)).toMatchObject({
      kind: "oversize",
      sizeBytes: LIMIT + 1,
      sha256: sha(Buffer.alloc(LIMIT + 1, 0x61)),
    });
  });

  it("크기 초과 파일은 처음 상한 + 1바이트의 sha256을 쓰고 그 뒤는 읽지 않는다", async () => {
    // 앞 상한 + 1바이트가 같고 뒤만 다른 두 파일은 같은 sha256이다. 읽기가 정확히 상한 + 1에서 멈춘다는 증거다.
    const head = Buffer.alloc(LIMIT + 1, 0x62);
    const a = file();
    const b = file();
    writeFileSync(a, Buffer.concat([head, Buffer.alloc(50_000, 0x01)]));
    writeFileSync(b, Buffer.concat([head, Buffer.alloc(80_000, 0x02)]));

    const [ra, rb] = await Promise.all([
      readInboxFile(a, LIMIT),
      readInboxFile(b, LIMIT),
    ]);

    expect(ra).toMatchObject({ kind: "oversize", sha256: sha(head) });
    expect(rb).toMatchObject({ kind: "oversize", sha256: sha(head) });
    expect(ra).toMatchObject({ sizeBytes: head.length + 50_000 });
    expect(rb).toMatchObject({ sizeBytes: head.length + 80_000 });
  });

  it("rename 뒤 덧써서 커진 파일은 열 때 크기와 무관하게 상한 + 1바이트까지 읽어 크기 초과로 판정한다", async () => {
    // fstat 크기가 작을 때 열었더라도 읽는 양은 상한 + 1바이트까지로 정한다.
    const target = file();
    writeFileSync(target, "{}");
    appendFileSync(target, Buffer.alloc(LIMIT * 3, 0x63));

    const result = await readInboxFile(target, LIMIT);

    expect(result.kind).toBe("oversize");
  });

  it("심볼릭 링크는 따라가지 않고 내용을 읽지 않는다", async () => {
    const real = file("real.json");
    writeFileSync(real, '{"secret":"CANARY-SYMLINK"}');
    const link = file("link.json");
    symlinkSync(real, link);

    const result = await readInboxFile(link, LIMIT);

    expect(result).toMatchObject({ kind: "not_read", why: "SYMLINK" });
    expect(
      JSON.stringify(result, (_k, v) => (typeof v === "bigint" ? "0" : v)),
    ).not.toContain("CANARY-SYMLINK");
  });

  it("FIFO는 열기에서 멈추지 않고 일반 파일이 아니라고 판정한다", async () => {
    const fifo = file("pipe.json");
    mkfifo(fifo);

    let timer: NodeJS.Timeout | undefined;
    const result = await Promise.race([
      readInboxFile(fifo, LIMIT),
      new Promise<string>((resolve) => {
        timer = setTimeout(() => resolve("HANG"), 3000);
      }),
    ]).finally(() => clearTimeout(timer));

    expect(result).toMatchObject({ kind: "not_read", why: "NOT_REGULAR" });
  });

  it("디렉터리와 하드링크(nlink > 1)는 읽지 않는다", async () => {
    const original = file("orig.json");
    writeFileSync(original, '{"x":1}');
    const hard = file("hard.json");
    linkSync(original, hard);

    expect(await readInboxFile(hard, LIMIT)).toMatchObject({
      kind: "not_read",
      why: "HARDLINK",
    });
    expect(await readInboxFile(dir, LIMIT)).toMatchObject({
      kind: "not_read",
      why: "NOT_REGULAR",
    });
  });

  it("연 뒤 fstat 전에 다른 인스턴스가 이름을 지우면(nlink 0) 하드링크로 거부하지 않고 gone이다", async () => {
    // 폴러 둘이 같은 폴더를 읽을 때 한쪽이 처리를 끝내고 unlink하는 틈에 다른 쪽이 열었던 경우다(ADR-0004 결정 6).
    const target = file("unlinked-after-open.json");
    writeFileSync(target, '{"x":1}');

    const result = await readInboxFile(target, LIMIT, () => unlinkSync(target));

    expect(result).toEqual({ kind: "gone" });
  });

  it("없는 파일은 gone이다", async () => {
    expect(await readInboxFile(file("nothing.json"), LIMIT)).toEqual({
      kind: "gone",
    });
  });

  it("내용을 읽지 않는 경우의 sha256 상수는 빈 입력의 해시다", () => {
    expect(EMPTY_SHA256).toBe(sha(Buffer.alloc(0)));
  });
});
