// rename 원자성과 폴링 가시성 검증(RQ-002, ADR-0004 결정 3·4). 두 역할로 쓴다.
//   writer <dir> <건수> <MiB>  호출처 역할: 임시 이름(.<n>.tmp)에 청크로 쓰고 fsync, close, rename한다.
//   poller <dir> <MiB>         Mailo 역할: readdir을 촘촘히 반복해 *.json만 읽고 삭제한다. DONE 파일이 보이면 끝낸다.
// poller는 점으로 시작하는 이름을 읽지 않는다(Mailo 폴러와 같은 규칙). 읽을 때 끝 표지(END)가 없으면 부분 파일로 센다.
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

const [role, dir, countArg, mibArg] = process.argv.slice(2);
const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (role === "writer") {
  const count = Number(countArg);
  const total = Number(mibArg) * 1024 * 1024;
  const chunk = Buffer.alloc(64 * 1024, 0x61);
  const sameInode = [];
  for (let i = 0; i < count; i += 1) {
    const tmp = path.join(dir, `.${i}.tmp`);
    const fin = path.join(dir, `req-${i}.json`);
    const fd = openSync(tmp, "wx", 0o666);
    let written = 0;
    while (written < total - 3) {
      written += writeSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, total - 3 - written),
      );
    }
    writeSync(fd, "END");
    fsyncSync(fd);
    const inoBefore = fstatSync(fd).ino;
    closeSync(fd);
    renameSync(tmp, fin);
    // rename은 같은 inode를 유지한다(복사가 아니다). Mailo가 먼저 지웠으면 비교하지 않고 건너뛴다.
    try {
      sameInode.push(statSync(fin).ino === inoBefore);
    } catch {
      // 이미 수집·삭제됨
    }
  }
  writeFileSync(path.join(dir, "DONE"), "");
  console.log(
    JSON.stringify({
      role,
      written: count,
      bytesEach: total,
      inodeChecked: sameInode.length,
      inodeKept: sameInode.length > 0 && sameInode.every(Boolean),
    }),
  );
} else if (role === "poller") {
  let complete = 0;
  let partial = 0;
  let tmpSeen = 0;
  let tmpSmallerThanFull = 0;
  let done = false;
  let rounds = 0;
  while (!done || rounds < 2) {
    if (done) rounds += 1;
    for (const name of readdirSync(dir)) {
      if (name === "DONE") {
        done = true;
        continue;
      }
      if (name.startsWith(".")) {
        tmpSeen += 1;
        try {
          if (
            statSync(path.join(dir, name)).size <
            Number(countArg) * 1024 * 1024
          )
            tmpSmallerThanFull += 1;
        } catch {
          // 그 사이 rename됐다.
        }
        continue;
      }
      if (!name.endsWith(".json")) continue;
      const full = path.join(dir, name);
      const fd = openSync(
        full,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const { size } = fstatSync(fd);
      const tail = Buffer.alloc(3);
      readSync(fd, tail, 0, 3, Math.max(0, size - 3));
      closeSync(fd);
      if (tail.toString() === "END") complete += 1;
      else partial += 1;
      unlinkSync(full);
    }
    sleep(1);
  }
  console.log(
    JSON.stringify({ role, complete, partial, tmpSeen, tmpSmallerThanFull }),
  );
} else {
  console.error("사용법: writer <dir> <건수> <MiB> | poller <dir> <MiB>");
  process.exit(2);
}
