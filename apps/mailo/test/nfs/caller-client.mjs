// 호출처 클라이언트 흉내(ADR-0004 결정 3, 8). 테스트가 `sudo setpriv`로 호출처 UID로 띄운다.
// 표준 입력의 JSON 한 줄 명령을 실행하고 표준 출력에 JSON 한 줄로 답한다. 파일 핸들은 이름으로 들고 있다.
// 명령: {op:"open",id,path,flags?,mode?} {op:"write",id,data} {op:"fsync",id} {op:"close",id}
//       {op:"rename",from,to} {op:"unlink",path} {op:"readdir",path} {op:"read",path} {op:"stat",path}
//       {op:"mkdir",path} {op:"chmod",path,mode} {op:"symlink",target,path} {op:"link",from,to} {op:"mkfifo",path} {op:"umask",mask}
//       {op:"id"} {op:"exit"}
import fs from "node:fs";
import readline from "node:readline";
import { execFileSync } from "node:child_process";

const handles = new Map();
const rl = readline.createInterface({ input: process.stdin });

function run(cmd) {
  switch (cmd.op) {
    case "open": {
      const fd = fs.openSync(cmd.path, cmd.flags ?? "wx", cmd.mode ?? 0o666);
      handles.set(cmd.id, fd);
      return {};
    }
    case "write":
      fs.writeSync(handles.get(cmd.id), cmd.data);
      return {};
    case "fsync":
      fs.fsyncSync(handles.get(cmd.id));
      return {};
    case "close":
      fs.closeSync(handles.get(cmd.id));
      handles.delete(cmd.id);
      return {};
    case "rename":
      fs.renameSync(cmd.from, cmd.to);
      return {};
    case "unlink":
      fs.unlinkSync(cmd.path);
      return {};
    case "readdir":
      return { names: fs.readdirSync(cmd.path).sort() };
    case "read":
      return { data: fs.readFileSync(cmd.path, "utf8") };
    case "stat": {
      const s = fs.statSync(cmd.path);
      return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777, size: s.size };
    }
    case "mkdir":
      fs.mkdirSync(cmd.path);
      return {};
    case "symlink":
      fs.symlinkSync(cmd.target, cmd.path);
      return {};
    case "link":
      fs.linkSync(cmd.from, cmd.to);
      return {};
    case "mkfifo":
      execFileSync("mkfifo", [cmd.path]);
      return {};
    case "chmod":
      fs.chmodSync(cmd.path, cmd.mode);
      return {};
    case "umask":
      process.umask(cmd.mask);
      return {};
    case "id":
      return {
        uid: process.getuid(),
        gid: process.getgid(),
        groups: process.getgroups(),
      };
    case "exit":
      for (const fd of handles.values()) fs.closeSync(fd);
      process.exit(0);
    default:
      throw new Error(`unknown op ${cmd.op}`);
  }
}

rl.on("line", (line) => {
  let reply;
  try {
    reply = { ok: true, ...run(JSON.parse(line)) };
  } catch (error) {
    reply = {
      ok: false,
      code: error.code ?? "UNKNOWN",
      message: String(error.message),
    };
  }
  process.stdout.write(`${JSON.stringify(reply)}\n`);
});
