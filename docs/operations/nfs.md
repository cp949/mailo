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
- 컨테이너에서는 호스트 mount를 bind하지 않고 Docker `local` 드라이버의 NFS named volume을 쓰는 구성(`docker-compose.nfs-example.yml`)을 예시로 둔다. 이 구성은 같은 호스트 loopback NFS에서 `verify-docker-volume.sh`로 확인했다(2026-11-23, 13개 통과). 실제 NAS 제품과 `hard` mount에서 서버를 멈췄을 때의 동작은 미검증이다("컨테이너에서 쓰는 방법").
- 파일 채널이 켜져 있고 `<root>/inbox`가 없거나 통과(X)할 수 없으면 앱이 기동을 거부한다. mount 전의 빈 디렉터리를 읽는 상황을 막는다. `inbox`의 읽기(R) 권한은 요구하지 않는다(운영 모델의 `0711`). 호출처 폴더 하나가 없는 것은 경고(`file_inbox_missing`)다.
- 폴러가 `ESTALE`을 오류로 세던 결함을 찾아 고쳤다(`src/file-channel/errno.ts`). 이전에는 Node가 `ESTALE`을 `code === "ESTALE"`로 주지 않아 어떤 분기에도 걸리지 않았다.

## 검증 환경과 한계

| 항목            | 값                                                                                                         |
| --------------- | ---------------------------------------------------------------------------------------------------------- |
| 호스트          | WSL2, 커널 `6.6.114.1-microsoft-standard-WSL2`, Ubuntu 22.04                                              |
| 서버            | 커널 nfsd(`nfs-kernel-server` 2.6.1), `rw,sync,root_squash,no_subtree_check`, 백업 파일시스템 ext4(POSIX ACL) |
| 클라이언트      | 같은 커널의 NFS 클라이언트 3개: `w`(호출처), `m1`·`m2`(Mailo 인스턴스). 주소(127.0.0.1~3)와 호스트 이름을 다르게 mount해 별개 클라이언트로 동작한다 |
| 계정            | 호출처 UID 2001·2002, Mailo는 테스트를 돌리는 사용자(UID 1000), 그룹 방식 대안용 공용 GID 2100             |
| 프로토콜        | 클라이언트 NFSv4.1(ADR-0004 결정)과 4.2. 31건 전체를 4.1 기본값과 4.2 기본값(`MAILO_NFS_VERS=4.2`)으로 각각 실행해 통과했고 측정값은 같았다. 같은 날 `CallerClient` 수정(`ci.md` "NFS 잡") 뒤 `run.sh`를 기본값(4.1) 1회 다시 실행해 31건이 통과했다(4.2 기본값 전체 재실행은 하지 않았다. (e)의 일부 테스트는 `w` 클라이언트를 4.2·4.1로 다시 mount해 쓴다) |

한계(모두 미검증):

- 네트워크 지연·패킷 손실·서버 재시작·failover가 없다. loopback이라 호출처와 Mailo 사이의 시간차가 마이크로초 단위다.
- 실제 NAS 제품(Synology, NetApp, EFS 등)의 캐시·delegation·ACL 구현은 다르다.
- NFSv3, NFSv4.0, Kerberos(`sec=krb5`), `all_squash`, ID 매핑 불일치(호스트마다 UID가 다른 경우)는 확인하지 않았다.
- 호출처가 Windows·macOS 클라이언트인 경우, 서로 다른 커널 버전 조합은 확인하지 않았다.
- 시계 어긋남(임시 파일 정리가 mtime과 Mailo 시계의 차이로 판정한다, ADR-0004 구현 중 확정 9)은 확인하지 않았다.
- 폴더당 수천 개 파일에서의 `readdir` 성능은 확인하지 않았다.
- GitHub 호스티드 러너에서 `apps/mailo/scripts/nfs/run.sh`가 통과하는지 확인하지 못했다. 첫 실행(2026-11-23)에서 NFS 서버 설치·export·mount 3개 준비는 성공했지만, 테스트가 호출처 UID로 띄우는 `caller-client.mjs`를 그 UID가 찾지 못해(러너의 저장소 경로 통과 불가, `MODULE_NOT_FOUND`) 실패했고 잡이 30분 timeout까지 끝나지 않았다. 사본 경로 실행과 timeout을 추가했으나 재실행 전이라 러너 통과는 확인하지 못했다(`ci.md` "NFS 잡").
- 호출처 UID가 실행하는 파일의 경로(테스트의 `caller-client.mjs` 사본)와 그 위 폴더가 호출처 UID에게 열려 있어야 한다. 저장소가 `0750` 홈 아래에 있어도 테스트는 `/tmp` 사본을 쓰므로 통과한다. 호출처 UID가 접근할 수 없는 `TMPDIR`는 쓰지 않는다.

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

## 컨테이너에서 쓰는 방법

검증 상태: 이 절의 구성은 2026-11-23에 같은 호스트 loopback NFS(WSL2, `nfs-kernel-server` 2.6.1, 사용자 승인으로 설치)에서 `apps/mailo/scripts/nfs/verify-docker-volume.sh`로 실행해 확인했다(종료 코드 0, 통과 13, 실패 0). 확인한 것: named volume(`vers=4.2,hard,lookupcache=pos`)으로 컨테이너 기동, `/var/mailo/files`가 `nfs4` mount, non-root UID 1000, `inbox/alpha` 읽기, `file_channel_started`, 이미지 읽기 전용(`/repo` 쓰기 실패), `/tmp` tmpfs 쓰기, `CapEff` 0, 호출처 UID 2001(umask 077)이 `w` mount에 넣은 파일을 컨테이너가 등록하고 삭제, 로그에 본문 없음, `<root>/inbox`가 없는 경로를 volume으로 주면 종료 코드 1로 끝나고 로그가 inbox 문제를 알림. 확인하지 않은 것: 실제 NAS 제품, NFSv3·4.0, `hard` mount에서 서버를 멈췄을 때의 동작, 서버 재시작·failover. 아래 "근거" 중 "추정"·"코드 읽기 결과"로 적은 항목은 이 스크립트가 확인하지 않았다.

구성: `docker-compose.nfs-example.yml`을 `docker-compose.yml` 위에 덮어 쓴다.

```sh
# .env: MAILO_FILE_CHANNEL_ROOT=/var/mailo/files, MAILO_NFS_ADDR=<서버 주소>, MAILO_NFS_EXPORT=<서버의 export 경로>
docker compose -f docker-compose.yml -f docker-compose.nfs-example.yml up -d --build
```

- 예시 파일은 named volume `mailo-files`를 `driver: local`, `type: nfs`, `o: addr=<서버>,vers=4.2,sec=sys,hard,lookupcache=pos`, `device: :<export 경로>`로 정의하고 `/var/mailo/files`에 마운트한다. mount 옵션은 위 "권장 mount 옵션"과 같다.
- 근거(추정): non-root(`node`, UID 1000) 컨테이너는 직접 `mount`할 수 없다. Docker 데몬이 컨테이너 시작 때 mount하므로 이 제약이 없다. 호스트에는 NFS 클라이언트(`nfs-common` 등)가 필요하다.
- 호스트 mount를 bind하는 방식은 검증하지 않았다. mount가 끝나기 전에 컨테이너가 뜨면 bind가 빈 디렉터리를 잡을 수 있다. 앱이 `<root>/inbox`가 없으면 기동을 거부하므로(`checkRoot`, 통합 테스트와 로컬 Docker 볼륨 e2e로 확인) 호출처 폴더가 없는 상태로 조용히 도는 것은 막는다. `inbox`가 있는 빈 디렉터리를 bind하는 경우까지 막지는 못한다.
- NFS 서버에 닿지 않으면 named volume mount가 실패해 컨테이너가 시작하지 않는다(fail closed, 추정, 실행하지 않았다).
- 서버 쪽 전제: `root_squash`(기본)와 컨테이너 `node` UID 1000이 서버에서도 같은 UID로 보여야 한다. `all_squash`나 ID 매핑이 있으면 Mailo UID가 달라져 폴더 소유·ACL이 맞지 않는다(확인하지 않았다). 폴더와 권한은 서버에서 운영자가 만든다(다음 절). 앱은 만들지 않는다.
- `hard` mount에서 NAS가 멈추면 폴러의 `opendir`·`stat` 같은 파일 호출이 응답이 올 때까지 끝나지 않는다. 그 폴링은 끝나지 않으므로 `filePoller.lastPollAt`(폴링이 끝난 시각, `poller.ts`가 폴링 끝에 기록한다)이 갱신되지 않는다. 운영자 토큰으로 `/health/ready`를 읽으면 `lastPollAt`이 폴링 간격보다 오래되는 것으로 알 수 있다(코드 읽기 결과, 서버를 멈춰 실행하지 않았다). `/health/ready`는 메모리 값만 읽어 계속 응답한다. 막힌 호출이 Node의 libuv 스레드 풀(기본 4개)을 점유하면 다른 파일 작업도 늦어질 수 있다(추정). DB와 SMTP는 파일 시스템을 쓰지 않아 영향이 없다.
- 재현 스크립트: `apps/mailo/scripts/nfs/verify-docker-volume.sh`. 같은 호스트 loopback NFS를 만들고(`setup.sh`) 컨테이너가 named volume으로 파일을 읽어 등록·삭제하는지, `inbox`가 없으면 기동을 거부하는지, 읽기 전용 루트·capability 제거 상태에서 동작하는지 확인한다. 비밀번호 없는 `sudo`, Docker, `openssl`, `nfs-kernel-server`가 필요하다. 2026-11-23 첫 실행에서 통과 13, 실패 0이었다. 호출처 쪽 mount는 `vers=4.2`만 실행했다.

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

- Docker local 드라이버 NFS named volume(`docker-compose.nfs-example.yml`)을 실제 NAS 제품에서 확인한다(같은 호스트 loopback은 2026-11-23에 확인했다). NFSv3·4.0 서버와 호출처 UID 매핑 불일치도 같다.
- NAS가 멈췄을 때(`hard` mount) 폴러 정지가 `filePoller.lastPollAt`으로 감지되는지와 다른 파일 작업에 미치는 영향.
- 실제 NAS(대상 제품과 mount 옵션)에서 `apps/mailo/scripts/nfs/run.sh`를 대신할 검증. 최소한 (a) 새 폴더 가시성, (b) `close` 전 `rename`, (e) umask 077 읽기를 다시 확인한다.
- `nfs` 잡을 GitHub에서 실행해 `run.sh` 동작 확인(워크플로는 작성함, 미실행). 성공을 확인한 뒤에도 필수 체크 지정 여부를 따로 정한다.
- 서버 재시작·failover 뒤 폴러의 동작(ESTALE, 재연결 지연).
- 시계 어긋남이 있는 서버와의 임시 파일 정리.
