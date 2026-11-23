/**
 * NFS 검증 환경 도우미(RQ-002·024, ADR-0004 결정 10). 환경은 `scripts/nfs/setup.sh`가 만든다.
 * 서로 다른 주소·호스트 이름으로 mount한 클라이언트 3개(w=호출처, m1·m2=Mailo 인스턴스)를 쓴다.
 * 모두 같은 커널의 loopback이므로 서로 다른 호스트를 흉내 낸 것이며, 실제 NAS와 같다고 단정하지 않는다.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

export const BASE = process.env.MAILO_NFS_BASE ?? "/srv/mailo-nfs-test";
export const EXPORT_DIR = path.join(BASE, "export");
export const UID_A = Number(process.env.MAILO_NFS_CALLER_A_UID ?? 2001);
export const UID_B = Number(process.env.MAILO_NFS_CALLER_B_UID ?? 2002);
export const SHARE_GID = Number(process.env.MAILO_NFS_SHARE_GID ?? 2100);

/** 클라이언트 기본 NFS 버전. `MAILO_NFS_VERS=4.2 scripts/nfs/run.sh`처럼 바꿔 같은 테스트를 다시 돌릴 수 있다. */
export const DEFAULT_VERS = process.env.MAILO_NFS_VERS ?? "4.1";

export type Client = "w" | "m1" | "m2";
export const mountPoint = (client: Client): string =>
  path.join(BASE, "mnt", client);

const SCRIPTS = path.join(process.cwd(), "scripts", "nfs");
const CLIENT_SCRIPT = path.join(
  process.cwd(),
  "test",
  "nfs",
  "caller-client.mjs",
);

/** 세 mount가 모두 있는가. 없으면 NFS 테스트는 건너뛴다(`MAILO_NFS_REQUIRED=1`이면 실패시킨다). */
export function nfsAvailable(): boolean {
  try {
    const mounts = readFileSync("/proc/mounts", "utf8");
    return (["w", "m1", "m2"] as const).every((c) =>
      mounts.includes(` ${mountPoint(c)} nfs4 `),
    );
  } catch {
    return false;
  }
}

export function sudo(args: string[], input?: string): string {
  return execFileSync("sudo", ["-n", ...args], {
    encoding: "utf8",
    ...(input !== undefined && { input }),
  });
}

/** 클라이언트 mount를 옵션을 바꿔 다시 만든다. `vers=`를 주면 기본 4.1을 대체한다. */
export function remount(client: Client, options = ""): void {
  const withVersion = /(^|,)(nfs)?vers=/.test(options)
    ? options
    : [`vers=${DEFAULT_VERS}`, options].filter(Boolean).join(",");
  sudo([path.join(SCRIPTS, "mount.sh"), client, withVersion]);
}

export function currentMountOptions(client: Client): string {
  const line = readFileSync("/proc/mounts", "utf8")
    .split("\n")
    .find((l) => l.includes(` ${mountPoint(client)} nfs4 `));
  return line?.split(" ")[3] ?? "";
}

export function inboxScript(args: string[]): void {
  sudo([path.join(SCRIPTS, "inbox.sh"), ...args]);
}

/** 서버 백업 경로의 파일(NFS를 거치지 않는다). 다른 호스트·NAS 관리자가 만든 변경을 흉내 낸다. */
export const serverPath = (...parts: string[]): string =>
  path.join(EXPORT_DIR, ...parts);

export function serverRm(file: string): void {
  sudo(["rm", "-f", file]);
}

/** 서버 쪽에서 UID로 파일을 만든다. 폴더의 default ACL·setgid를 그대로 받는다. */
export function serverWriteAs(uid: number, file: string, content: string) {
  sudo(
    [
      "setpriv",
      `--reuid=${uid}`,
      `--regid=${uid}`,
      "--clear-groups",
      "sh",
      "-c",
      'umask 022; cat > "$1"',
      "sh",
      file,
    ],
    content,
  );
}

/** 모든 호출처 폴더의 일반 파일·링크·FIFO를 지운다(폴더는 둔다). */
export function clearInboxes(): void {
  sudo([
    "find",
    path.join(EXPORT_DIR, "inbox"),
    "-mindepth",
    "2",
    "-not",
    "-type",
    "d",
    "-delete",
  ]);
}

export interface Reply {
  ok: boolean;
  code?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * 지정한 UID로 `caller-client.mjs`를 띄워 호출처(또는 다른 계정)가 w mount에서 하는 일을 흉내 낸다.
 * `sudo setpriv`로 UID를 바꾸므로 비밀번호 없는 sudo가 필요하다.
 */
export class CallerClient {
  private readonly queue: Array<(reply: Reply) => void> = [];

  private constructor(private readonly child: ChildProcess) {
    const rl = readline.createInterface({ input: child.stdout! });
    rl.on("line", (line) => this.queue.shift()?.(JSON.parse(line) as Reply));
  }

  static start(
    uid: number,
    options: { gid?: number; groups?: number[]; umask?: number } = {},
  ): Promise<CallerClient> {
    const gid = options.gid ?? uid;
    const groups = options.groups?.length
      ? `--groups=${options.groups.join(",")}`
      : "--clear-groups";
    const child = spawn(
      "sudo",
      [
        "-n",
        "setpriv",
        `--reuid=${uid}`,
        `--regid=${gid}`,
        groups,
        process.execPath,
        CLIENT_SCRIPT,
      ],
      { stdio: ["pipe", "pipe", "inherit"] },
    );
    const client = new CallerClient(child);
    return client
      .call({ op: "umask", mask: options.umask ?? 0o022 })
      .then(() => client);
  }

  call(command: Record<string, unknown>): Promise<Reply> {
    return new Promise((resolve) => {
      this.queue.push(resolve);
      this.child.stdin!.write(`${JSON.stringify(command)}\n`);
    });
  }

  /** 성공해야 하는 명령. 실패하면 오류 코드를 던진다. */
  async must(command: Record<string, unknown>): Promise<Reply> {
    const reply = await this.call(command);
    if (!reply.ok)
      throw new Error(`${String(command.op)} 실패: ${reply.code ?? "?"}`);
    return reply;
  }

  async close(): Promise<void> {
    if (this.child.exitCode !== null) return;
    const exited = new Promise<void>((resolve) =>
      this.child.once("exit", () => resolve()),
    );
    this.child.stdin!.write('{"op":"exit"}\n');
    await exited;
  }
}

/** 호출처 규약(ADR-0004 결정 3): 점(.) 임시 이름에 쓰고 fsync·close한 뒤 같은 폴더에서 rename한다. */
export async function dropFile(
  client: CallerClient,
  callerId: string,
  name: string,
  content: string,
  options: { fsync?: boolean; close?: boolean } = {},
): Promise<void> {
  const dir = path.join(mountPoint("w"), "inbox", callerId);
  const tmp = path.join(dir, `.${name}.tmp`);
  await client.must({ op: "open", id: name, path: tmp });
  await client.must({ op: "write", id: name, data: content });
  if (options.fsync ?? true) await client.must({ op: "fsync", id: name });
  if (options.close ?? true) await client.must({ op: "close", id: name });
  await client.must({ op: "rename", from: tmp, to: path.join(dir, name) });
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
