# NAS/NFS 운영 가이드 (파일 채널)

파일 채널(ADR-0004)을 NAS/NFS 폴더에서 운영할 때의 mount 옵션, 폴더 권한, 검증 결과와 한계를 적는다.
모든 실측은 같은 호스트의 NFS loopback에서 얻었다. 실제 NAS에서는 확인하지 않았다.
표기: "실측"은 `pnpm test:nfs`(31건)나 기록한 수동 실험으로 확인한 값이고, "추정"은 확인하지 않은 일반 지식이다.
호출처 등록·쓰기 규약은 [caller-onboarding.md](./caller-onboarding.md), 다른 운영 문서는 [README.md](./README.md)다. 이 문서의 `apps/mailo/scripts/nfs/`는 저장소 루트 기준 경로다.

## 결론

- Mailo 쪽 mount 옵션은 `vers=4.2,sec=sys,hard,lookupcache=pos`를 권장한다. 나머지는 기본값을 쓴다.
- `lookupcache=pos`는 새로 만든 호출처 폴더를 Mailo가 보는 지연을 31초에서 9 ms로 줄였다(실측).
- 호출처가 파일을 만드는 호스트의 클라이언트도 `vers=4.2`여야 한다. NFSv4.1 클라이언트가 만든 파일은 호출처 umask가 077이면 default ACL을 받아도 Mailo가 읽지 못했다(실측).
- 기존 폴더에 rename한 파일은 mount 옵션과 무관하게 다음 폴링에서 보였다(실측, 6개 옵션). 폴링 간격이 지연의 상한이다.
- `close` 전에 `rename`해도 Linux NFSv4 클라이언트에서는 Mailo가 전체 내용을 읽었다(실측). ADR-0004 결정 3의 추정(비어 보일 수 있다)은 이 환경에서 재현되지 않았다. 호출처 규약(쓰기, `fsync`, `close`, `rename`)은 유지한다.
- 폴러가 `ESTALE`을 오류로 세던 결함을 찾아 고쳤다(`src/file-channel/errno.ts`). 이전에는 Node가 `ESTALE`을 `code === "ESTALE"`로 주지 않아 어떤 분기에도 걸리지 않았다.

## 검증 환경과 한계

| 항목            | 값                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| 호스트          | WSL2, 커널 `6.6.114.1-microsoft-standard-WSL2`, Ubuntu 22.04                                              |
| 서버            | 커널 nfsd(`nfs-kernel-server` 2.6.1), `rw,sync,root_squash,no_subtree_check`, 백업 파일시스템 ext4(POSIX ACL) |
| 클라이언트      | 같은 커널의 NFS 클라이언트 3개: `w`(호출처), `m1`·`m2`(Mailo 인스턴스). 주소(127.0.0.1~3)와 호스트 이름을 다르게 mount해 별개 클라이언트로 동작한다 |
| 계정            | 호출처 UID 2001·2002, Mailo는 테스트를 돌리는 사용자(UID 1000), 그룹 방식 대안용 공용 GID 2100             |
| 프로토콜        | 클라이언트 NFSv4.1(ADR-0004 결정)과 4.2. 31건 전체를 4.1 기본값과 4.2 기본값(`MAILO_NFS_VERS=4.2`)으로 각각 실행해 통과했고 측정값은 같았다 |

한계(모두 미검증):

- 네트워크 지연·패킷 손실·서버 재시작·failover가 없다. loopback이라 호출처와 Mailo 사이의 시간차가 마이크로초 단위다.
- 실제 NAS 제품(Synology, NetApp, EFS 등)의 캐시·delegation·ACL 구현은 다르다.
- NFSv3, NFSv4.0, Kerberos(`sec=krb5`), `all_squash`, ID 매핑 불일치(호스트마다 UID가 다른 경우)는 확인하지 않았다.
- 호출처가 Windows·macOS 클라이언트인 경우, 서로 다른 커널 버전 조합은 확인하지 않았다.
- 시계 어긋남(임시 파일 정리가 mtime과 Mailo 시계의 차이로 판정한다, ADR-0004 구현 중 확정 9)은 확인하지 않았다.
- 폴더당 수천 개 파일에서의 `readdir` 성능은 확인하지 않았다.
- CI 러너에서 `apps/mailo/scripts/nfs/run.sh`가 동작하는지 확인하지 않았다.

## 권장 mount 옵션

Mailo 컨테이너·호스트의 mount(`<root>`는 `MAILO_FILE_CHANNEL_ROOT`):

```txt
mount -t nfs4 -o vers=4.2,sec=sys,hard,lookupcache=pos <서버>:<export> <root>
```

| 옵션               | 권장                                         | 근거                                                                                                                      |
| ------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `vers=4.2`         | 사용. 호출처 호스트도 같다                   | 실측: 호출처 umask 077, default ACL 폴더에서 4.1은 Mailo가 읽지 못하고(`unreadable`) 4.2는 읽었다. 추정: 4.2의 `umask` 속성을 클라이언트가 보내 서버가 default ACL이 있으면 umask를 적용하지 않는다. 커널 6.6에서 확인 |
| `lookupcache=pos`  | 사용                                         | 실측: 폴러의 첫 폴링 뒤 폴더를 만들었을 때 보이기까지 기본값 31.3초, `acdirmin=acdirmax=3` 3.0초, `lookupcache=pos` 9 ms. "없음" 결과를 캐시하지 않기 때문이다(추정) |
| `hard`(기본)       | 유지                                         | 추정: `soft`는 서버 응답이 늦으면 `EIO`로 실패해 읽기·삭제 중간에 오류가 난다. 확인하지 않았다                                 |
| `actimeo`·`ac*`    | 기본값 유지                                  | 실측: `actimeo=60`, `noac`, 기본값에서 기존 폴더에 rename한 파일이 모두 7~13 ms에 수집됐다. 줄이거나 늘려도 이 경로에는 영향이 없다 |
| `nocto`            | 쓰지 않는다                                  | 실측: 이 환경에서는 `nocto,actimeo=60`에서도 7 ms에 보였다. 그러나 close-to-open이 호출처 쓰기 순서(ADR-0004 결정 3)의 기반이다. 끄면 다른 환경에서 어떤 결과가 나올지 확인하지 않았다. 추정으로 금지한다 |
| `sec=sys`          | 이 환경의 값                                 | Kerberos는 확인하지 않았다                                                                                                |
| `nosharecache`     | 운영에서는 필요 없다                         | 테스트가 같은 호스트에서 클라이언트를 분리하려고 쓴 옵션이다                                                                |

호출처 호스트의 mount는 `vers=4.2,sec=sys,hard`를 권장한다. 호출처 쪽 캐시 옵션은 바꿔 비교하지 않았다(테스트의 호출처 클라이언트는 기본 캐시 옵션).

## 폴더와 계정 구성

코드는 폴더를 만들거나 chmod하지 않는다(ADR-0004 결정 8). 운영자가 만든다. 같은 호스트 볼륨 검증(ADR-0004 구현 중 확정 14)과 같은 default ACL 모델을 쓴다. `apps/mailo/scripts/nfs/lib.sh`의 `nfs_make_inbox`가 아래 구성을 만든다.

서버 쪽 경로:

| 경로                      | 소유   | 모드·ACL                                                                                                  |
| ------------------------- | ------ | --------------------------------------------------------------------------------------------------------- |
| `<export>/inbox`          | root   | `0711`(통과만 허용, 호출처 이름 목록을 숨긴다)                                                            |
| `<export>/inbox/<caller>` | Mailo UID | `0700` + `user:<호출처 UID>:-wx` + default ACL `user::rw-, user:<Mailo UID>:rw-, group::---, mask::rw-, other::---` |

```sh
chmod 0711 inbox
chown <MailoUID> inbox/<caller_id>
chmod 0700 inbox/<caller_id>
setfacl -m  u:<호출처UID>:-wx inbox/<caller_id>
setfacl -d -m u::rw-,u:<MailoUID>:rw-,g::---,m::rw-,o::--- inbox/<caller_id>
```

실측 결과(NFS, root_squash):

- 호출처 UID는 자기 폴더에 파일을 만든다. 폴더 목록 조회와 `inbox` 목록 조회는 `EACCES`다. 폴더 소유자가 Mailo이므로 호출처는 폴더 `chmod`를 할 수 없다.
- 호출처 UID는 다른 호출처 폴더에 만들기·목록·읽기·삭제가 모두 `EACCES`다.
- 호출처는 자기가 만든 파일을 읽고 지울 수 있다. 막을 수 없다(RQ-024).
- root는 `root_squash`로 nobody가 되어 호출처 폴더에 쓰지도 읽지도 못한다.
- Mailo UID는 호출처 umask 022, 077 모두 읽었다. 단 파일을 만든 클라이언트가 NFSv4.2일 때만이다. NFSv4.1 클라이언트에서 umask 077이면 서버가 ACL mask를 `---`로 만들어 Mailo가 읽지 못했고, 폴러는 이 파일을 거부하지 않고 `unreadable`로 세며 남겼다. umask 022는 4.1에서도 읽혔다.
- 호출처가 파일 생성 mode를 `0600`으로 명시하는 경우는 NFS에서 확인하지 않았다. 같은 호스트 볼륨에서는 default ACL 방식도 읽지 못했다(ADR-0004 구현 중 확정 15).
- Mailo가 호출처 파일을 지우려면 폴더 쓰기 권한이 필요하다. 폴더 소유자가 Mailo이므로 만족한다.

대안(공용 그룹 + setgid, 폴더 소유자 호출처, 그룹 공용 GID, 모드 `2370`, ACL 없음)도 NFS에서 확인했다. 이 방식은 파일시스템이 ACL을 쓸 수 없을 때의 대안이고 호출처 umask를 `027` 이하로 고정해야 한다(ADR-0004 구현 중 확정 28). `nfs_make_inbox <이름> <UID> no`가 만든다.

- 새 파일의 그룹이 공용 그룹이 되지만 읽기 비트는 호출처 umask가 정한다. umask 027은 그룹 구성원이 읽었고 077은 읽지 못했다.
- 호출처가 폴더 소유자라 폴더 권한을 바꿔 목록 조회 금지를 풀 수 있다.
- 그룹 구성원 판정은 서버 기준이다. 기본 gid가 공용 그룹인 계정은 읽고 지울 수 있었다. 보조 그룹으로만 속한 계정은 거부됐다. Ubuntu 기본값의 `rpc.mountd --manage-gids`가 클라이언트가 보낸 보조 그룹을 무시하고 서버의 passwd·group을 조회하기 때문이다(추정). 시험 계정(UID 3000)이 서버에 없어서 생긴 결과일 수도 있다.

## 호출처 규약(NFS)

- 임시 이름(`.`로 시작)에 쓰고 `fsync`, `close`, 같은 폴더에서 `rename`한다. 이 순서를 유지한다.
- `rename` 뒤에 파일을 열어 두고 덧쓰지 않는다. 실측: 절반을 쓰고 `rename`한 뒤 나머지를 쓰면 `close` 전에 Mailo는 앞 절반(524293 / 1048586 바이트)만 읽었다. 폴러는 부분 JSON을 형식 오류로 거부하고 삭제한다.
- 완성 파일 이름은 호출처가 고유하게 만든다. 같은 이름으로 `rename`하면 미수집 파일을 덮어쓴다(ADR-0004 구현 중 확정 10).
- 서버 쪽 관리자가 호출처 폴더를 삭제하고 다시 만들 때는 호출처 호스트의 클라이언트 캐시도 영향을 받는다. 호출처 쪽 `ESTALE`은 확인하지 않았다.

## 항목별 결과

| 항목                                          | 결과     | 실측 내용                                                                                                                                       |
| --------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| (a) rename 뒤 폴링 가시성                     | 성공     | 기존 폴더: 기본값·`actimeo=60`·`lookupcache=none`·`lookupcache=pos`·`noac`·`nocto,actimeo=60` 모두 7~13 ms. 새 폴더: 기본값 31.3초, `acdirmin=acdirmax=3` 3.0초, `lookupcache=pos` 9 ms |
| (b) close 전 rename                           | 성공(추정과 다름) | 쓰기만, `fsync`만, `close` 후 세 경우 모두 1 MiB 전체를 읽었다. 3 MiB에서도 수동 실험으로 같았다. 서버의 `fs.leases-enable=0`(delegation 없음)에서도 수동 실험 결과가 같았다. rename 뒤 덧쓰기는 부분 노출 |
| (c) rename 원자성                             | 성공     | 2 MiB 파일 16개를 쓰는 동안 Mailo 쪽에서 반복 읽기: 부분 내용 0건                                                                                |
| (d) O_NOFOLLOW·FIFO·nlink                     | 성공     | 심볼릭 링크·FIFO는 내용을 읽지 않고 `MALFORMED`로 거부·삭제, 정상 파일 수집. 하드링크 쌍은 한쪽 거부 뒤 나머지가 nlink 1이 되어 수집(registered=1, rejected=1). 로컬 통합 테스트와 같은 결과 |
| (e) root_squash·UID별 권한                    | 성공(조건 있음) | 위 "폴더와 계정 구성". NFSv4.1 + umask 077은 실패(`unreadable`)                                                                          |
| (f) ESTALE                                    | 결함을 고침 | 수정 전: 다른 클라이언트가 지운 직후 열면 40회 중 8회 `readInboxFile`이 errno -116을 던졌다. 수정 후 40회 모두 `gone`. 폴더를 다시 만든 뒤 폴링은 오류 0 |
| (g) 두 인스턴스 동시 수집                     | 성공     | 별개 NFS 클라이언트 2개, 3라운드 × 20건: 작업 60건, Key 중복 0, 오류 0, 파일 잔존 0. 수정 전 한 번 오류 1건이 났다(원인 로그는 확인하지 않았고 ESTALE로 추정) |

ESTALE 관찰:

- 다른 클라이언트가 파일을 지우면 Mailo 클라이언트에서 `open`은 성공하고 `fstat`·`read`가 ESTALE(errno 116)로 실패하는 경우가 있었다. 지운 직후 수십 ms 안에서만 나타났고 시도의 약 5~50%였다(실행마다 다르다).
- Node(libuv)에는 ESTALE 이름이 없어 `error.code`가 `"Unknown system error -116"`이고 `error.errno`가 `-116`이다. `code === "ESTALE"` 비교는 동작하지 않는다.
- 수정: `errno.ts`의 `isStale`이 `errno -116`을 판별한다. `open`·`fstat`·`read`·`lstat`·`unlink`의 ESTALE은 "이미 없음"(`gone`)으로 다룬다. `opendir`·`readdir`의 ESTALE은 한 번 다시 읽고, 두 번째도 실패하면 그 호출처를 건너뛰고 경고 로그(`file_inbox_stale`)를 남긴다.
- 서버를 재시작하거나 export를 바꾼 뒤의 ESTALE은 확인하지 않았다.

## 재현 방법과 위험

```sh
docker compose up -d postgres
apps/mailo/scripts/nfs/run.sh          # 환경 준비, NFS 테스트 실행, 정리
MAILO_NFS_VERS=4.2 apps/mailo/scripts/nfs/run.sh   # 4.2 기준
```

- 전제: 비밀번호 없는 `sudo`, 커널 `nfsd` 모듈, `nfs-kernel-server`(없으면 `MAILO_NFS_INSTALL=1`), `acl` 패키지.
- `sudo -n`이 되지 않으면 스크립트는 종료 코드 20으로 중단한다. 비밀번호를 묻거나 우회하지 않는다.
- 이미 환경이 있으면 `apps/mailo/scripts/nfs/setup.sh`는 종료 코드 24·25로 중단한다.
- NFS 환경이 없을 때 `pnpm test:nfs`는 테스트를 건너뛴다. `MAILO_NFS_REQUIRED=1`이면 실패한다(`run.sh`는 이 값을 준다).
- `pnpm test:integration`에는 포함되지 않는다(`*.nfs-spec.ts`는 별도 설정 `jest.nfs.config.cjs`).

위험도와 롤백:

```txt
위험도: 중간
내용: 호스트에 NFS export(/etc/exports.d/mailo-nfs-test.exports)와 loopback mount 3개를 추가하고 /srv/mailo-nfs-test를 만든다. nfsd 모듈을 적재한다.
롤백: apps/mailo/scripts/nfs/teardown.sh (mount 해제, exports 조각 삭제, exportfs -ra, /srv/mailo-nfs-test 삭제)
남는 것: nfs-kernel-server 패키지, nfsd 모듈. 필요하면 `sudo systemctl disable --now nfs-server`, `sudo apt-get purge nfs-kernel-server`, `sudo modprobe -r nfsd`로 되돌린다.
```

- 기존 `/etc/exports`는 건드리지 않는다. export는 `/etc/exports.d/` 조각 파일 하나로 추가한다.
- export 대상은 `127.0.0.0/8`뿐이다. 외부 주소에는 열리지 않는다.
- `teardown.sh`는 `MAILO_NFS_BASE`가 비었거나 `/`, `/srv`, `/home`, `/tmp`, `/var`이면 삭제하지 않고 중단한다.

## 남은 일

- 실제 NAS(대상 제품과 mount 옵션)에서 `apps/mailo/scripts/nfs/run.sh`를 대신할 검증. 최소한 (a) 새 폴더 가시성, (b) `close` 전 `rename`, (e) umask 077 읽기를 다시 확인한다.
- CI 러너(Linux VM)에서 `run.sh` 동작 확인과 CI 연결.
- 서버 재시작·failover 뒤 폴러의 동작(ESTALE, 재연결 지연).
- 시계 어긋남이 있는 서버와의 임시 파일 정리.
