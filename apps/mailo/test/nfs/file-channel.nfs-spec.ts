import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "@jest/globals";
import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { open as openFile } from "node:fs/promises";
import path from "node:path";
import type pg from "pg";
import type { PollSummary } from "../../src/file-channel/index.js";
import { readInboxFile } from "../../src/file-channel/read-file.js";
import { createTestDatabase, type TestDatabase } from "../support/database.js";
import {
  createFileHarness,
  fileRequest,
  type FileHarness,
} from "../support/file-channel.js";
import { migrate } from "../support/queue-fixtures.js";
import {
  CallerClient,
  SHARE_GID,
  UID_A,
  UID_B,
  clearInboxes,
  currentMountOptions,
  dropFile,
  inboxScript,
  mountPoint,
  nfsAvailable,
  remount,
  serverPath,
  serverRm,
  serverWriteAs,
  sleep,
  sudo,
} from "./support.js";

/**
 * NFS(NFSv4.x, 같은 호스트 loopback, root_squash, non-root UID 3개)에서의 파일 채널 검증.
 * 근거: RQ-002·024, ADR-0004 결정 3·5·6·8·10. 환경은 `scripts/nfs/setup.sh`(또는 `scripts/nfs/run.sh`)가 만든다.
 * 클라이언트 w=호출처, m1·m2=Mailo 인스턴스 두 개. 같은 커널의 loopback이라 실제 NAS와 같다고 단정하지 않는다.
 */

const available = nfsAvailable();
if (!available && process.env.MAILO_NFS_REQUIRED === "1")
  throw new Error(
    "NFS 환경이 없다(MAILO_NFS_REQUIRED=1). scripts/nfs/setup.sh를 먼저 실행한다.",
  );
const suite = available ? describe : describe.skip;

const json = (value: unknown) => JSON.stringify(value);
const request = (key: string) => json(fileRequest({ idempotencyKey: key }));
const sha = (data: string | Buffer) =>
  createHash("sha256").update(data).digest("hex");

type CountKey =
  | "registered"
  | "duplicates"
  | "rejected"
  | "errors"
  | "unreadable"
  | "deleteFailed"
  | "gone";
function total(summary: PollSummary, key: CountKey): number {
  return summary.callers.reduce((sum, c) => sum + c[key], 0);
}

interface JobRow {
  caller_id: string;
  idempotency_key: string;
}

suite("파일 채널 NFS 검증 (RQ-002·024, ADR-0004 결정 10)", () => {
  let db: TestDatabase;
  let pool: pg.Pool;
  let h: FileHarness;
  const clients: CallerClient[] = [];

  async function caller(
    uid: number,
    options: { umask?: number; gid?: number; groups?: number[] } = {},
  ): Promise<CallerClient> {
    const client = await CallerClient.start(uid, options);
    clients.push(client);
    return client;
  }
  const jobs = async (): Promise<JobRow[]> =>
    (
      await pool.query<JobRow>(
        "SELECT caller_id, idempotency_key FROM mail_jobs ORDER BY caller_id, idempotency_key",
      )
    ).rows;
  const reasons = async (): Promise<string[]> =>
    (
      await pool.query<{ reason_code: string }>(
        "SELECT reason_code FROM mail_intake_rejections ORDER BY id",
      )
    ).rows.map((r) => r.reason_code);
  const inboxListing = (client: "w" | "m1" | "m2", callerId: string) =>
    readdirSync(path.join(mountPoint(client), "inbox", callerId)).sort();

  beforeAll(async () => {
    db = await createTestDatabase();
    pool = db.pool;
    await migrate(pool);
  });

  afterAll(async () => {
    await db.close();
  });

  beforeEach(async () => {
    // 각 테스트가 같은 캐시 상태에서 시작하도록 mount를 기본 옵션으로 다시 만든다.
    for (const c of ["w", "m1", "m2"] as const) remount(c);
    clearInboxes();
    await pool.query("DELETE FROM mail_events");
    await pool.query("DELETE FROM mail_intake_rejections");
    await pool.query("DELETE FROM mail_jobs");
    h = createFileHarness(pool, { config: { root: mountPoint("m1") } });
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.close()));
    h.cleanup();
  });

  describe("기본 수집", () => {
    it("호출처 UID가 w mount에 rename한 파일을 Mailo가 m1 mount에서 수집하고 삭제한다", async () => {
      const a = await caller(UID_A);
      await dropFile(a, "alpha", "a1.json", request("nfs-1"));

      const summary = await h.makePoller().pollOnce();

      expect(total(summary, "registered")).toBe(1);
      expect(total(summary, "errors")).toBe(0);
      expect(await jobs()).toEqual([
        { caller_id: "alpha", idempotency_key: "nfs-1" },
      ]);
      expect(inboxListing("m1", "alpha")).toEqual([]);
      expect(existsSync(serverPath("inbox", "alpha", "a1.json"))).toBe(false);
    });
  });

  describe("(a) rename 직후 폴링 가시성 지연(mount 옵션별)", () => {
    // 폴러가 한 번 돈 뒤(캐시가 찬 상태)에 호출처가 rename하고, 폴링이 파일을 수집할 때까지의 시간을 잰다.
    const FILE_OPTIONS = [
      "",
      "actimeo=60",
      "lookupcache=none",
      "lookupcache=pos",
      "noac",
      "nocto,actimeo=60",
    ];
    it.each(FILE_OPTIONS)(
      "기존 폴더에 rename한 파일은 mount 옵션 '%s'에서 5초 안에 보인다",
      async (options) => {
        // Key 형식은 영숫자·`-`·`_` 등으로 제한되므로 옵션 문자열을 Key에 쓰지 않는다.
        const key = `vis-${randomBytes(4).toString("hex")}`;
        remount("m1", options);
        const a = await caller(UID_A);
        const poller = h.makePoller();
        await poller.pollOnce();
        await dropFile(a, "alpha", "v.json", request(key));
        const t0 = Date.now();

        let visibleMs = Infinity;
        while (Date.now() - t0 < 60000) {
          if (total(await poller.pollOnce(), "registered") > 0) {
            visibleMs = Date.now() - t0;
            break;
          }
          await sleep(100);
        }

        console.info(
          `[nfs-measure] 파일 가시성 옵션='${options}' visibleMs=${visibleMs}`,
        );
        expect(visibleMs).toBeLessThan(5000);
      },
    );

    // 호출처 폴더가 Mailo의 첫 폴링보다 늦게 만들어지는 경우. 음의 dentry(없음 결과) 캐시가 지연을 만든다.
    const DIR_OPTIONS: Array<{ options: string; maxMs: number }> = [
      { options: "", maxMs: 90000 },
      { options: "acdirmin=3,acdirmax=3", maxMs: 12000 },
      { options: "lookupcache=pos", maxMs: 3000 },
    ];
    it.each(DIR_OPTIONS)(
      "나중에 만든 호출처 폴더는 mount 옵션 '$options'에서 $maxMs ms 안에 보인다",
      async ({ options, maxMs }) => {
        remount("m1", options);
        inboxScript(["remove", "beta"]);
        const poller = h.makePoller();
        const first = await poller.pollOnce();
        expect(
          first.callers.find((c) => c.callerId === "beta")?.inboxMissing,
        ).toBe(true);

        inboxScript(["create", "beta", "B"]);
        serverWriteAs(
          UID_B,
          serverPath("inbox", "beta", "late.json"),
          request("late-dir"),
        );
        const t0 = Date.now();
        let visibleMs = Infinity;
        while (Date.now() - t0 < maxMs + 5000) {
          if (total(await poller.pollOnce(), "registered") > 0) {
            visibleMs = Date.now() - t0;
            break;
          }
          await sleep(250);
        }

        console.info(
          `[nfs-measure] 새 폴더 가시성 옵션='${options}' visibleMs=${visibleMs}`,
        );
        expect(visibleMs).toBeLessThan(maxMs);
      },
    );
  });

  describe("(b) close 전 rename (close-to-open 추정 검증)", () => {
    const BODY = json({ pad: "y".repeat(1024 * 1024) });
    const readAtMailo = (name: string): string =>
      readFileSync(path.join(mountPoint("m1"), "inbox", "alpha", name), "utf8");

    it.each([
      ["쓰기, fsync 없음, close 없음, rename", { fsync: false, close: false }],
      ["쓰기, fsync, close 없음, rename", { fsync: true, close: false }],
      ["쓰기, close, rename", { fsync: false, close: true }],
    ])(
      "%s: Mailo가 전체 내용을 읽는다(비어 보이지 않는다)",
      async (_label, options) => {
        const a = await caller(UID_A);
        await dropFile(a, "alpha", "b.json", BODY, options);

        const seen = readAtMailo("b.json");

        expect(seen.length).toBe(BODY.length);
        expect(sha(seen)).toBe(sha(BODY));
      },
    );

    it("rename 뒤에 호출처가 덧쓴 부분은 close 전에는 Mailo에게 보이지 않는다(프로토콜 위반의 결과)", async () => {
      const a = await caller(UID_A);
      const half = BODY.length / 2;
      const dir = path.join(mountPoint("w"), "inbox", "alpha");
      await a.must({ op: "open", id: "f", path: `${dir}/.late.tmp` });
      await a.must({ op: "write", id: "f", data: BODY.slice(0, half) });
      await a.must({
        op: "rename",
        from: `${dir}/.late.tmp`,
        to: `${dir}/late.json`,
      });
      await a.must({ op: "write", id: "f", data: BODY.slice(half) });

      const beforeClose = readAtMailo("late.json").length;
      await a.must({ op: "close", id: "f" });
      const afterClose = readAtMailo("late.json").length;

      console.info(
        `[nfs-measure] rename 뒤 덧쓰기: close 전 ${beforeClose} / close 후 ${afterClose} / 전체 ${BODY.length}`,
      );
      expect(beforeClose).toBeLessThan(BODY.length);
      expect(afterClose).toBe(BODY.length);
    });
  });

  describe("(c) rename 원자성", () => {
    it("rename으로 나타난 *.json은 항상 완성된 내용이다(부분 파일이 보이지 않는다)", async () => {
      const a = await caller(UID_A);
      const COUNT = 16;
      const expected = new Map<string, string>();
      const contents = new Map<string, string>();
      for (let i = 0; i < COUNT; i++) {
        const body = randomBytes(2 * 1024 * 1024).toString("base64");
        contents.set(`c${i}.json`, body);
        expected.set(`c${i}.json`, sha(body));
      }

      const dir = path.join(mountPoint("m1"), "inbox", "alpha");
      const bad: string[] = [];
      const seen = new Set<string>();
      let writing = true;
      const reader = (async () => {
        while (writing || seen.size < COUNT) {
          for (const name of readdirSync(dir)) {
            if (!name.endsWith(".json") || name.startsWith(".")) continue;
            let body: string;
            try {
              body = readFileSync(path.join(dir, name), "utf8");
            } catch {
              continue;
            }
            seen.add(name);
            if (sha(body) !== expected.get(name)) bad.push(name);
          }
          await sleep(5);
          if (!writing && seen.size >= COUNT) break;
        }
      })();

      for (const [name, body] of contents) {
        await dropFile(a, "alpha", name, body, { fsync: false, close: false });
      }
      writing = false;
      await reader;

      expect(seen.size).toBe(COUNT);
      expect(bad).toEqual([]);
    });
  });

  describe("(d) O_NOFOLLOW·FIFO·nlink 검사", () => {
    it("심볼릭 링크와 FIFO는 내용을 읽지 않고 거부 기록 뒤 삭제하며, 정상 파일은 수집된다", async () => {
      const a = await caller(UID_A);
      const dir = path.join(mountPoint("w"), "inbox", "alpha");
      await dropFile(a, "alpha", "ok.json", request("d-ok"));
      await a.must({
        op: "symlink",
        target: "/etc/passwd",
        path: `${dir}/sym.json`,
      });
      await a.must({ op: "mkfifo", path: `${dir}/fifo.json` });

      const summary = await h.makePoller().pollOnce();

      expect(total(summary, "errors")).toBe(0);
      expect(total(summary, "registered")).toBe(1);
      expect(total(summary, "rejected")).toBe(2);
      expect(await reasons()).toEqual(["MALFORMED", "MALFORMED"]);
      expect(inboxListing("m1", "alpha")).toEqual([]);
    });

    it("하드링크로 nlink가 2인 파일은 거부하고, 한쪽이 지워져 nlink가 1이 된 나머지는 일반 파일로 읽는다", async () => {
      const a = await caller(UID_A);
      const dir = path.join(mountPoint("w"), "inbox", "alpha");
      await dropFile(a, "alpha", "own.json", request("d-hard"));
      await a.must({
        op: "link",
        from: `${dir}/own.json`,
        to: `${dir}/own-link.json`,
      });

      const summary = await h.makePoller().pollOnce();

      console.info(
        `[nfs-measure] 하드링크 쌍: registered=${total(summary, "registered")} rejected=${total(summary, "rejected")}`,
      );
      expect(total(summary, "errors")).toBe(0);
      expect(total(summary, "rejected")).toBeGreaterThanOrEqual(1);
      expect(total(summary, "rejected") + total(summary, "registered")).toBe(2);
      expect(inboxListing("m1", "alpha")).toEqual([]);
    });
  });

  describe("(e) root_squash와 서로 다른 non-root UID의 권한 모델", () => {
    it("호출처는 자기 폴더에 파일을 만들 수 있지만 목록은 볼 수 없고 폴더 권한도 바꿀 수 없다", async () => {
      const a = await caller(UID_A);
      const dir = path.join(mountPoint("w"), "inbox", "alpha");

      expect(
        (await a.call({ op: "open", id: "x", path: `${dir}/.p.tmp` })).ok,
      ).toBe(true);
      await a.must({ op: "close", id: "x" });
      const list = await a.call({ op: "readdir", path: dir });
      const root = await a.call({
        op: "readdir",
        path: path.join(mountPoint("w"), "inbox"),
      });
      const chmod = await a.call({ op: "chmod", path: dir, mode: 0o777 });

      expect(list).toMatchObject({ ok: false, code: "EACCES" });
      expect(root).toMatchObject({ ok: false, code: "EACCES" });
      expect(chmod.ok).toBe(false);
    });

    it("호출처는 다른 호출처 폴더에 만들기·목록·읽기가 모두 거부된다", async () => {
      const a = await caller(UID_A);
      const b = await caller(UID_B);
      await dropFile(b, "beta", "b1.json", request("e-beta"));
      const betaDir = path.join(mountPoint("w"), "inbox", "beta");

      const create = await a.call({
        op: "open",
        id: "x",
        path: `${betaDir}/evil.json`,
      });
      const list = await a.call({ op: "readdir", path: betaDir });
      const read = await a.call({ op: "read", path: `${betaDir}/b1.json` });
      const unlink = await a.call({ op: "unlink", path: `${betaDir}/b1.json` });

      expect(create).toMatchObject({ ok: false, code: "EACCES" });
      expect(list).toMatchObject({ ok: false, code: "EACCES" });
      expect(read).toMatchObject({ ok: false, code: "EACCES" });
      expect(unlink).toMatchObject({ ok: false, code: "EACCES" });
    });

    it("호출처는 자기가 만든 파일의 소유자라 읽고 지울 수 있다(막을 수 없는 항목)", async () => {
      const a = await caller(UID_A);
      await dropFile(a, "alpha", "own.json", request("e-own"));
      const file = path.join(mountPoint("w"), "inbox", "alpha", "own.json");

      const read = await a.call({ op: "read", path: file });
      const unlink = await a.call({ op: "unlink", path: file });

      expect(read.ok).toBe(true);
      expect(unlink.ok).toBe(true);
    });

    it("root는 root_squash로 nobody가 되어 호출처 폴더에 쓰지도 읽지도 못한다", async () => {
      const a = await caller(UID_A);
      await dropFile(a, "alpha", "rs.json", request("e-root"));
      const dir = path.join(mountPoint("w"), "inbox", "alpha");

      expect(() => sudo(["sh", "-c", `echo x > ${dir}/rootfile`])).toThrow();
      expect(() => sudo(["cat", `${dir}/rs.json`])).toThrow();
    });

    it("default ACL 폴더에서 Mailo UID는 호출처 umask 022·077과 무관하게 읽는다: NFSv4.2", async () => {
      remount("w", "vers=4.2");
      expect(currentMountOptions("w")).toContain("vers=4.2");
      const a = await caller(UID_A, { umask: 0o077 });
      await dropFile(a, "alpha", "u077.json", request("e-acl-42"));

      const summary = await h.makePoller().pollOnce();

      expect(total(summary, "unreadable")).toBe(0);
      expect(total(summary, "registered")).toBe(1);
    });

    it("default ACL 폴더에서 호출처 umask 077이면 NFSv4.1 클라이언트가 만든 파일은 Mailo가 읽지 못한다(unreadable로 남는다)", async () => {
      remount("w", "vers=4.1");
      expect(currentMountOptions("w")).toContain("vers=4.1");
      const a = await caller(UID_A, { umask: 0o077 });
      await dropFile(a, "alpha", "u077.json", request("e-acl-41"));

      const summary = await h.makePoller().pollOnce();

      expect(total(summary, "unreadable")).toBe(1);
      expect(total(summary, "registered")).toBe(0);
      expect(inboxListing("m1", "alpha")).toEqual(["u077.json"]);
    });

    it("호출처 umask 022이면 NFSv4.1에서도 default ACL로 Mailo가 읽는다", async () => {
      const a = await caller(UID_A, { umask: 0o022 });
      await dropFile(a, "alpha", "u022.json", request("e-acl-022"));

      const summary = await h.makePoller().pollOnce();

      expect(total(summary, "registered")).toBe(1);
    });

    // 공용 그룹 + setgid 모델(ACL 없음). 호출처 umask가 그룹 읽기 비트를 정한다.
    // Mailo 역할 계정은 기본 그룹(gid)이 공용 그룹이다. 보조 그룹만으로는 서버가 인정하지 않는 구성이 있다(아래 마지막 테스트).
    it.each([
      ["027", 0o027, true],
      ["077", 0o077, false],
    ])(
      "공용 그룹·setgid 폴더에서 호출처 umask %s이면 공용 그룹 기본 gid 계정의 읽기 가능 여부는 %s이다",
      async (_label, umask, readable) => {
        const a = await caller(UID_A, { umask });
        const mailoLike = await caller(3000, { gid: SHARE_GID });
        const outsider = await caller(3001);
        await dropFile(a, "grp", "g.json", request("e-grp"));
        const file = path.join(mountPoint("w"), "inbox", "grp", "g.json");

        const stat = await a.must({ op: "stat", path: file });
        const member = await mailoLike.call({ op: "read", path: file });
        const other = await outsider.call({ op: "read", path: file });

        expect(stat.gid).toBe(SHARE_GID);
        expect(member.ok).toBe(readable);
        expect(other.ok).toBe(false);
      },
    );

    it("공용 그룹 기본 gid 계정은 호출처 파일을 지울 수 있다(폴더 그룹 쓰기)", async () => {
      const a = await caller(UID_A, { umask: 0o027 });
      const mailoLike = await caller(3000, { gid: SHARE_GID });
      await dropFile(a, "grp", "g.json", request("e-grp-del"));

      const unlink = await mailoLike.call({
        op: "unlink",
        path: path.join(mountPoint("w"), "inbox", "grp", "g.json"),
      });

      expect(unlink.ok).toBe(true);
    });

    it("보조 그룹으로만 공용 그룹에 속한 계정의 접근 여부는 서버의 그룹 조회 설정(--manage-gids)에 달렸다", async () => {
      const a = await caller(UID_A, { umask: 0o027 });
      const supplemental = await caller(3000, { groups: [SHARE_GID] });
      await dropFile(a, "grp", "g.json", request("e-grp-supp"));

      const read = await supplemental.call({
        op: "read",
        path: path.join(mountPoint("w"), "inbox", "grp", "g.json"),
      });

      // Ubuntu 기본값(`--manage-gids`)은 클라이언트가 보낸 보조 그룹을 무시하고 서버의 NSS(passwd·group)로 조회한다.
      // 계정이 서버에 없으면 거부된다. 값은 환경에 따라 달라 기록만 남긴다.
      console.info(
        `[nfs-measure] 보조 그룹만 있는 계정의 읽기 허용=${read.ok}`,
      );
      expect(typeof read.ok).toBe("boolean");
    });
  });

  describe("(f) 삭제된 파일의 stale handle(ESTALE)", () => {
    it("다른 클라이언트가 지운 파일에서 ESTALE이 나도 readInboxFile은 던지지 않고 gone으로 돌려준다", async () => {
      const a = await caller(UID_A);
      const dir = path.join(mountPoint("m1"), "inbox", "alpha");
      const ATTEMPTS = 40;

      // 목록을 읽어 Mailo 클라이언트의 dentry·속성 캐시를 채우고(폴러가 readdir 뒤 open하는 순서), 서버에서 지운 직후 접근한다.
      // ESTALE 창은 지운 뒤 수십 ms 안이라 지운 즉시 접근해야 재현된다.
      async function afterRemote<T>(
        i: number,
        label: string,
        use: (file: string) => Promise<T>,
      ): Promise<T> {
        const name = `${label}-${i}.json`;
        await dropFile(a, "alpha", name, request(`f-${label}-${i}`));
        readdirSync(dir);
        serverRm(serverPath("inbox", "alpha", name));
        return use(path.join(dir, name));
      }

      // 환경이 ESTALE을 실제로 만드는지 확인하는 표본이다. libuv에는 ESTALE 이름이 없어 errno(-116)로 판별한다.
      let probeStale = 0;
      for (let i = 0; i < ATTEMPTS; i++) {
        await afterRemote(i, "probe", async (file) => {
          try {
            const fh = await openFile(
              file,
              constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
            );
            try {
              await fh.stat();
              await fh.read(Buffer.alloc(8), 0, 8, null);
            } catch (error) {
              if ((error as NodeJS.ErrnoException).errno === -116) probeStale++;
            } finally {
              await fh.close().catch(() => undefined);
            }
          } catch {
            // ENOENT는 정상 경로다.
          }
        });
      }

      const kinds: Record<string, number> = {};
      const thrown: string[] = [];
      for (let i = 0; i < ATTEMPTS; i++) {
        await afterRemote(i, "target", async (file) => {
          try {
            const outcome = await readInboxFile(file, 2 * 1024 * 1024);
            kinds[outcome.kind] = (kinds[outcome.kind] ?? 0) + 1;
          } catch (error) {
            thrown.push(String((error as NodeJS.ErrnoException).errno));
          }
        });
      }

      console.info(
        `[nfs-measure] ESTALE 표본 ${probeStale}/${ATTEMPTS}, readInboxFile 결과 ${JSON.stringify(kinds)}, 던진 오류 errno ${JSON.stringify(thrown)}`,
      );
      expect(probeStale).toBeGreaterThan(0);
      expect(thrown).toEqual([]);
      expect(
        Object.keys(kinds).every((k) => k === "gone" || k === "read"),
      ).toBe(true);
    });

    it("호출처 폴더가 다른 곳에서 다시 만들어져도 다음 폴링이 오류 없이 새 파일을 수집한다", async () => {
      const poller = h.makePoller();
      await poller.pollOnce();
      inboxScript(["remove", "alpha"]);
      inboxScript(["create", "alpha", "A"]);
      serverWriteAs(
        UID_A,
        serverPath("inbox", "alpha", "new.json"),
        request("f-dir"),
      );

      const summaries: PollSummary[] = [];
      for (let i = 0; i < 5 && (await jobs()).length === 0; i++) {
        summaries.push(await poller.pollOnce());
        await sleep(200);
      }

      const errors = summaries.reduce((n, s) => n + total(s, "errors"), 0);
      console.info(
        `[nfs-measure] 폴더 교체 뒤 폴링 ${summaries.length}회, errors=${errors}, lastPollOk=${poller.status().lastPollOk}`,
      );
      expect(await jobs()).toEqual([
        { caller_id: "alpha", idempotency_key: "f-dir" },
      ]);
      expect(errors).toBe(0);
      expect(h.logs.filter((l) => l.includes("file_poll_failed"))).toEqual([]);
    });
  });

  describe("(g) 두 Mailo 인스턴스의 동시 수집", () => {
    it("서로 다른 NFS 클라이언트의 두 폴러가 같은 폴더를 동시에 읽어도 Key마다 작업이 하나다", async () => {
      const a = await caller(UID_A);
      const ROUNDS = 3;
      const PER_ROUND = 20;
      const fileChannel = { ...h.config.fileChannel, root: mountPoint("m2") };
      const p1 = h.makePoller();
      const p2 = h.makePoller({ config: fileChannel });
      let registered = 0;
      let errors = 0;
      let gone = 0;

      for (let round = 0; round < ROUNDS; round++) {
        for (let i = 0; i < PER_ROUND; i++)
          await dropFile(
            a,
            "alpha",
            `g${round}-${i}.json`,
            request(`g-${round}-${i}`),
          );
        const [s1, s2] = await Promise.all([p1.pollOnce(), p2.pollOnce()]);
        registered += total(s1, "registered") + total(s2, "registered");
        errors += total(s1, "errors") + total(s2, "errors");
        gone += total(s1, "gone") + total(s2, "gone");
      }

      console.info(
        `[nfs-measure] 동시 수집: registered=${registered} gone=${gone} errors=${errors}`,
      );
      const rows = await jobs();
      expect(rows).toHaveLength(ROUNDS * PER_ROUND);
      expect(new Set(rows.map((r) => r.idempotency_key)).size).toBe(
        ROUNDS * PER_ROUND,
      );
      expect(registered).toBe(ROUNDS * PER_ROUND);
      expect(errors).toBe(0);
      expect(inboxListing("m1", "alpha")).toEqual([]);
      expect(await reasons()).toEqual([]);
    });
  });
});
