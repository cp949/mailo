# 호출처 등록과 사용처 연동

호출처(사용처)를 Mailo에 등록하는 운영 절차와, 사용처가 따라야 하는 연동 규칙을 적는다.
계약의 기준은 `docs/api/openapi.yaml`과 `docs/api/README.md`이고, 이 문서의 예시는 그 계약과 2026-11-23 코드에 맞춰 썼다.
표기: "추정"은 확인하지 않은 값이다. 이 문서의 인라인 Java 코드와 SQL 조각은 그대로 컴파일하지 않았다. 컴파일하고 이 저장소의 Mailo와 실행한 구현은 [`samples/spring-boot-relay/`](../../samples/spring-boot-relay/README.md)다(2026-11-23, JDK 21, nimbus-jose-jwt 10.10). 필드 이름, 헤더, 상태 코드, 파일 형식은 코드·계약과 대조했고 샘플 실행으로도 확인했다.

## 결론

- 호출처 하나는 `caller_id` 하나다. REST 인증, 파일 폴더 이름, 서명 키, 할당이 모두 이 값에 묶인다.
- 등록은 `callers.json` 수정과 Mailo 재시작이다. 레지스트리는 기동 때 한 번 읽는다(핫 리로드 없음).
- 사용처는 outbox + relay로 요청을 보낸다. `Idempotency-Key`는 outbox 행 ID를 쓰고, 재시도할 때 내용을 바꾸지 않는다.
- 파일 채널의 쓰기 순서는 임시 이름(점으로 시작)에 쓰기, `fsync`, `close`, 권한 `0660`, 같은 폴더에서 `rename`이다.
- 파일 채널만 쓰는 호출처도 REST API 키가 필요하다. 결과는 Key 조회와 이벤트 피드로만 확인한다.
- 우선순위(`priority`)는 선택이다. 생략하면 `NORMAL`이다. `URGENT`는 즉시 전송을 뜻하지 않는다("우선순위").
- 만료 시간(`ttlSeconds`)은 선택이다. 생략하면 Mailo 기본 TTL(기본 24시간)이다. 긴 TTL은 한도 지연을 없애지 않는다("요청별 만료 시간").
- 나가기 전의 작업은 취소할 수 있다(`POST /jobs/{jobId}/cancel`, 파일 채널 호출처는 `POST /jobs/cancel?idempotencyKey=`). 취소 API를 쓰기 전에 사용처가 `CANCELED`·`JOB_CANCELED`와 모르는 값을 처리하는지 확인한다("작업 취소").

## 1. 등록 전에 정할 것

| 항목 | 선택지 | 권장 |
| ---- | ------ | ---- |
| 입력 채널 | REST, 파일, 둘 다 | REST. 파일은 DB 트랜잭션과의 원자성이 없다(RQ-002 제한). 사용처 outbox가 파일을 쓰면 유실 없음 |
| 서명 `signature.mode` | `required`, `none` | 신규 호출처는 `required`를 기본으로 권장한다. `none`은 사유를 적고 고르는 선택지다(아래 "`none`의 한계"). 파일 채널 + NAS/NFS는 `required`(ADR-0004 결정 9). REST만 쓰는 호출처는 REST가 서명을 쓰지 않으므로 서명 설정이 발송 경로에 영향을 주지 않는다 |
| 본문 암호화(JWE) | 사용, 미사용 | 선택. 파일이 NAS·백업에 평문으로 남는 것이 문제일 때 사용한다. Mailo에 `MAILO_ENVELOPE_KEYS_FILE`이 있어야 한다 |
| 발송 할당 `sendQuota24h` | 정수, 생략(무제한) | 계정 일일 한도를 공유하므로 대량 발송 호출처에 둔다(RQ-032) |

`signature.mode`의 코드 기본값은 없다. 적지 않으면 Mailo가 기동하지 않는다(`callers/registry.ts`). 위 권장은 문서의 선택 기준이고 코드는 바꾸지 않았다.

### `none`의 한계(ADR-0008 구현 중 확정 9)

- `signature.mode=none` 호출처는 inbox 쓰기 권한자의 수신자 바꿔치기를 막지 못한다. JWE 본문 유출을 막아야 하면 `signature.mode=required`를 사용한다.
- `none`에서 inbox 쓰기 권한자는 본문을 새로 만들어 보낼 수도 있다. 이 변조로 새로 생기는 위험은 기밀성뿐이다. 탈취한 JWE 본문을 다른 수신자로 바꿔 보내면 Mailo가 복호화해 그 수신자에게 발송한다.
- `none`을 고를 때는 호출처 등록 기록(변경 설명, 티켓)에 사유와 inbox 쓰기 권한자 범위를 적는다. 예: REST만 쓰고 파일 채널이 꺼져 있다, inbox 폴더의 쓰기 권한이 호출처 계정 하나뿐이다.

## 2. 레지스트리 항목

`callers.json`(저장소 루트, `/callers.json`은 추적하지 않는다)의 `callers[]`에 항목을 추가한다. 예:

```json
{
  "callers": [
    {
      "id": "billing",
      "apiKeyHashes": ["<SHA-256 hex 64자>"],
      "fileChannel": true,
      "signature": {
        "mode": "required",
        "keys": [
          { "kid": "billing-2026-11", "secretVar": "MAILO_JWS_SECRET_BILLING_2026_11" }
        ]
      },
      "sendQuota24h": 500,
      "allowedFrom": ["billing@example.com"],
      "allowedRecipientDomains": ["example.com", "mail.example.com"]
    },
    {
      "id": "reports",
      "apiKeyHashes": ["<SHA-256 hex 64자>"],
      "fileChannel": false,
      "signature": { "mode": "none" }
    }
  ]
}
```

| 필드 | 필수 | 규칙 |
| ---- | ---- | ---- |
| `id` | 예 | `[A-Za-z0-9][A-Za-z0-9_-]{0,63}`, 항목 사이 중복 불가. REST의 `caller_id`이고 파일 폴더 이름이다 |
| `apiKeyHashes` | 예 | 소문자 hex SHA-256(64자) 1~2개. 호출처 사이에도 같은 해시가 겹치면 안 된다 |
| `fileChannel` | 아니오(기본 `false`) | `true`인 호출처의 `<root>/inbox/<id>/`만 수집한다. `MAILO_FILE_CHANNEL_ROOT`가 없으면 폴러가 꺼져 있고 `file_channel_disabled` 경고가 나온다 |
| `signature.mode` | 예(기본값 없음) | `required` 또는 `none`. 빠지면 기동하지 않는다 |
| `signature.keys` | `required`이면 1~2개, `none`이면 둘 수 없음 | 각 항목 `kid`(`[A-Za-z0-9][A-Za-z0-9._:-]{0,63}`)와 `secretVar`(`MAILO_JWS_SECRET_`로 시작하는 대문자·숫자·`_`). 값은 변수로 받는다 |
| `sendQuota24h` | 아니오 | 1~10000000의 정수, 생략하면 무제한. 0은 허용하지 않는다(중지는 호출처를 빼서 표현) |
| `accountId` | 아니오 | 이 호출처가 쓰는 SMTP 계정 ID(`MAILO_SMTP_ACCOUNTS_FILE`의 `id` 또는 환경 변수가 정의한 `default`). 생략하면 `default`다. 구성에 없는 ID이거나 `default` 계정이 없는데 생략하면 기동하지 않는다. 호출처에는 노출되지 않는다(아래) |
| `allowedFrom` | 아니오 | 요청의 `from`으로 쓸 수 있는 발신 주소(addr-spec) 배열, 최대 20개, 생략하면 빈 목록. 형식이 틀리면 기동하지 않는다 |
| `allowedRecipientDomains` | 아니오 | 호출처가 `to`·`cc`·`bcc`로 보낼 수 있는 수신 도메인 배열, 1~50개, 생략하면 제한 없음. 소문자 ASCII 도메인만 받는다(아래). 빈 배열·`null`은 기동하지 않는다 |
| `jwe` | 아니오 | 코드가 읽기만 하고 쓰지 않는다. JWE는 호출처 항목이 아니라 Mailo 키 목록(`key-management.md`)으로 정한다 |

- 서명 키(`signature.keys`)의 값은 호출처 사이·`kid` 사이·DB 본문 키·지문 키와 달라야 한다. 같은 바이트이면 기동하지 않는다(표기가 base64와 hex로 달라도 같다). `NODE_ENV`가 `development`·`test`가 아니면 같은 바이트가 반복된 키와 공개 샘플 키(적합성 벡터의 JWS 비밀키 포함)도 거부한다(ADR-0008 구현 중 확정 13, ADR-0014 결정 3). 오류에는 위치만 나오고 값은 나오지 않는다.
- 알 수 없는 필드가 있으면 기동하지 않는다. 오류 메시지는 위치(`callers[0]`)와 고정 사유만 담는다.
- SMTP 계정(`accountId`, RQ-054, ADR-0013 결정 2·6): 호출처 하나는 계정 하나를 쓴다. 호출처는 계정을 고르지도 알지도 못한다. 요청에 계정 필드를 보내면 `UNKNOWN_FIELD`로 거부되고, `Job`·`Event`·거부 기록·검증 오류에는 계정 필드와 계정 주소가 없다.
  - 작업은 등록 때 계정을 고정한다. 이후 `accountId`를 바꿔도 이미 등록한 작업은 처음 계정으로 나간다. 계정 전환은 새 요청에만 적용된다. 같은 Key의 재전송은 기존 작업의 계정을 그대로 두고 200이나 409를 돌려받는다(계정은 지문에 들어가지 않는다).
  - 계정이 열려 있거나 한도가 남아 있어도 다른 계정으로 자동 전환하지 않는다. 계정이 구성에서 빠지면 그 계정의 대기 작업은 점유되지 않고 만료 시각에 `EXPIRED`가 된다(`deployment.md` "SMTP 계정 도입 배포 순서").
  - 배포 순서: 계정 파일과 비밀 변수가 모든 인스턴스에 배포된 뒤에 `accountId`를 넣고 재시작한다. 구버전은 이 필드를 몰라 기동하지 못한다("코드 먼저, 레지스트리 나중"). 구현 묶음 B 전에는 `default`가 아닌 계정을 구성할 수 없다(계정 파일에 있으면 앱이 기동을 거부한다). 그래서 `accountId`는 `default`만 가리킬 수 있다.
- 발신 주소(`allowedFrom`, ADR-0008 구현 중 확정 12, ADR-0013 결정 6): 호출처가 쓸 수 있는 `from`은 호출처 계정의 `from`(`default`는 `MAILO_SMTP_FROM`, 없으면 `MAILO_SMTP_USER`)과 이 목록이다. 다른 계정의 `from`은 허용되지 않는다. 비교는 대소문자를 무시한다. `from`을 생략하면 작업 계정의 `from`으로 나간다. `allowedFrom`이 다른 계정의 `from`과 같으면 기동 때 `allowed_from_other_account`(warn, `callerId`)가 남는다(별칭을 계정이 공유할 수 있어 거부하지 않는다). 집합 밖이면 REST는 400(`errors`의 `pointer: /from`, `code: FROM_NOT_ALLOWED`), 파일은 `VALIDATION_FAILED` 거부다. 새 호출처가 다른 발신 주소를 써야 하면 여기에 넣고 재시작한다.
  - 배포 순서: 이미 계정 `from` 외의 `from`을 보내는 호출처가 있으면 Mailo를 올리기 전에 그 주소를 `allowedFrom`에 넣는다. 이미 큐에 등록된 작업은 검사하지 않고 그대로 나간다. 이미 등록된 `Idempotency-Key`의 재전송은 허용 여부와 무관하게 기존 작업을 돌려받는다.
  - `replyTo`는 제한하지 않는다. 위험은 회신을 다른 주소로 유도하는 피싱이다. SPF·DMARC는 `From`만 정렬 대상이라 `Reply-To`가 발신 사칭을 늘리지는 않는다.
  - Gmail 인증 모드: `allowedFrom` 주소를 Gmail "다른 주소에서 메일 보내기"(send-as) 별칭으로 등록해야 From이 유지된다. 등록하지 않으면 Gmail이 From을 계정 주소로 바꾼다. 이 동작은 확인하지 않았다(미검증). IP 허용 relay(인증 없음)에서는 relay 정책이 허용하는 주소여야 한다(미검증).
- 수신 도메인(`allowedRecipientDomains`, RQ-046, ADR-0011 결정 8): API 키가 유출되거나 스테이징이 잘못 설정돼도 임의 수신자로 대량 발송되지 않게 하는 호출처별 제한이다. 수신자 주소의 `@` 뒤를 소문자로 바꿔 목록과 **정확히** 비교한다.
  - 하위 도메인은 따로 적는다(`example.com`은 `mail.example.com`을 허용하지 않는다). 와일드카드는 없다. 국제화 도메인은 A-label(`xn--...`)로 적는다.
  - 기동을 거부하는 값: 대문자, 비ASCII(U-label), 끝 점(`example.com.`), `*`, 선행 점(`.example.com`), 목록 안의 중복, 도메인 형식 오류(라벨 1개, 숫자뿐인 마지막 라벨 등), 빈 배열, `null`, 51개 이상. 오류 메시지에는 항목 위치(`callers[i].allowedRecipientDomains[j]`)와 사유만 나오고 값은 나오지 않는다. 호출처를 막으려면 이 필드가 아니라 정지(`deployment.md` "발송 정지와 운영 REST")나 키 폐기를 쓴다.
  - 하나라도 어기면 요청 전체를 거부한다. REST는 400(`errors`에 어긴 주소마다 `pointer: /to/0`·`/cc/1`·`/bcc/0`, `code: RECIPIENT_DOMAIN_NOT_ALLOWED`), 파일은 `VALIDATION_FAILED` 거부다. 응답·로그·거부 기록에 주소와 도메인 값은 없다. 일부 수신자만 빼고 등록하지 않는다. SMTP 서버가 수신자를 거부하는 부분 거부(ADR-0007 결정 7)와 다른 단계다.
  - `replyTo`는 수신자가 아니라 제한하지 않는다. 이미 등록된 `Idempotency-Key`의 재전송은 목록과 무관하게 기존 작업(200)이나 409를 돌려받는다. 목록을 바꾸기 전에 큐에 등록된 작업은 그대로 나간다.
  - 한계: 허용 도메인 안의 대량 발송은 막지 못한다. 도메인의 MX 같은 실제 수신 가능 여부는 보지 않는다.
  - 배포 순서: 모든 인스턴스가 새 버전이 된 뒤에 레지스트리에 넣고 재시작한다. 이전 버전은 이 필드를 몰라 기동하지 못한다(`deployment.md` "수신 도메인 제한·이벤트 공백 감지 도입 배포 순서"). 이미 이 호출처가 보내는 수신 도메인을 먼저 조사해 목록에 모두 넣는다. 빠진 도메인으로 가는 요청은 400이다.
- 발송 할당: 24시간 rolling이고 단위는 메시지 시도 수다(수신자 수로 가중하지 않는다). 초과하면 그 호출처의 작업은 점유되지 않고 대기하며 시도 횟수는 늘지 않는다. 대기 중 만료 시각에 이르면 `EXPIRED`다. 등록 응답에는 영향이 없다(429 없음). 로그 이벤트는 `caller_quota_exceeded`·`caller_quota_recovered`다(`troubleshooting.md`). 값을 바꾸면 재시작이 필요하다.

## 3. API 키 발급·교체·폐기

키는 256비트 난수다. Mailo에는 SHA-256 해시만 둔다. 평문은 호출처에게만 준다.

```sh
KEY=$(openssl rand -base64 32)            # 호출처에 전달할 평문. 이 터미널 밖에 남기지 않는다
printf '%s' "$KEY" | sha256sum | cut -d' ' -f1   # callers.json의 apiKeyHashes에 넣을 값
```

- 해시는 키 문자열을 UTF-8 그대로 해시한 값이다. `printf '%s'`는 끝 개행을 붙이지 않는다. `echo`를 쓰면 개행이 포함돼 해시가 달라진다.
- 키는 `Authorization: Bearer <키>`로 보낸다. 512자를 넘거나 공백이 있으면 401이다.

발급:

1. 위 명령으로 키와 해시를 만든다. `apiKeyHashes`에 해시를 넣는다.
2. Mailo를 재시작한다.
3. 호출처에 평문을 안전한 경로로 전달한다.
4. 확인: `curl -s -H "Authorization: Bearer $KEY" http://<host>:3000/health/ready`가 200이고 `eventFeed` 필드가 있으면 키가 유효하다. 틀린 키는 401이다.

교체(키 2개 동시 허용):

1. 새 해시를 `apiKeyHashes`에 추가한다(총 2개). 재시작한다.
2. 호출처가 새 키로 바꾼 것을 확인한다(요청 로그의 `caller=<id>` 또는 호출처 확인).
3. 이전 해시를 지우고 재시작한다.

폐기: 해시를 지우고 재시작한다. 호출처 항목 전체를 지우면 그 호출처의 REST 요청은 401이고, 파일 폴더는 읽지 않는다.

## 4. 파일 채널 폴더와 권한

코드는 폴더를 만들거나 `chmod`하지 않는다(ADR-0004 결정 8). 운영자가 만든다.

**권장은 default ACL이다.** 같은 호스트 Docker 볼륨(2026-11-23, `scripts/volume/`)과 NFS loopback에서 확인한 결과다(ADR-0004 구현 중 확정 13~19, 20~27, 28).

| 방식 | 쓰는 때 | Mailo가 읽는 범위 | 제약 |
| ---- | ------- | ----------------- | ---- |
| default ACL(권장) | 파일시스템이 POSIX ACL을 지원할 때 | 호출처 umask 022·027·077·000 모두 읽음 | 호출처가 파일 생성 mode를 `0600`으로 만들면 읽지 못한다 |
| 공용 그룹 + setgid(대안) | ACL을 쓸 수 없는 파일시스템 | umask 027까지 읽고 077은 못 읽음 | 호출처 umask를 `027` 이하로 고정해야 한다. 호출처가 자기 폴더 권한을 바꿀 수 있다 |

- Mailo는 폴링마다 `<root>`, `inbox`, `inbox/<caller_id>`가 링크가 아닌 디렉터리인지 확인한다. 링크이면 그 폴링에서 읽지 않고 `file_dir_unsafe`를 남긴다. 경로를 통과할 권한이 없어 확인하지 못해도(`EACCES`) 같은 경고(`why: ACCESS`)를 남기고 그 폴링에서 읽지 않는다(`MAILO_FILE_CHANNEL_ROOT`에는 링크가 아닌 실제 경로를 준다). `o+w`가 있는 폴더(`<root>`·`inbox`는 `g+w`도)는 `file_channel_dir_permissive` 경고를 한 번 남기고 수집은 계속한다. 호출처 폴더의 `g+w`는 default ACL 마스크 때문에 정상이라 경고하지 않는다(ADR-0004 구현 중 확정 32).
- 호출처가 `0600`으로 만든 파일은 두 방식 모두 수집되지 않는다. 파일은 삭제되지 않고 남으며 `file_poll` 로그의 `unreadable`로 드러난다. 호출처가 `rename` 전에 `0660`으로 `chmod`해야 수집된다(`troubleshooting.md`).
- 계정은 Mailo 1개와 호출처마다 1개이고 모두 non-root, UID가 서로 달라야 한다. root나 Mailo와 같은 UID의 호출처는 다른 호출처 폴더를 읽고 쓴다(검증됨, `verify-root-model.sh`).

폴더 상태(default ACL, ADR-0004 구현 중 확정 14):

| 경로 | 소유 | 모드·ACL |
| ---- | ---- | -------- |
| `<root>`, `<root>/inbox` | root | `0755`, `0711`(호출처 이름 목록을 숨긴다) |
| `<root>/inbox/<caller_id>/` | Mailo UID | `0700` + `user:<호출처 UID>:-wx` + default ACL `user::rw-, user:<Mailo UID>:rw-, group::---, mask::rw-, other::---` |

같은 호스트 볼륨에서는 `scripts/volume/init-volume.sh`가 이 상태를 만든다(root로 실행, 멱등, `setfacl` 필요).

```sh
MAILO_UID=1000 MAILO_GID=1000 CALLERS="billing:10002 reports:10003" \
  sh scripts/volume/init-volume.sh acl <루트 경로>
# 공용 그룹 방식: 첫 인자를 group으로 바꾸고 SHARED_GID=<공용 GID>를 추가한다
```

- 호출처 컨테이너에는 `volume.subpath: inbox/<caller_id>`로 자기 폴더만 마운트한다(`docker-compose.volume-example.yml`, Docker Engine 26 이상). 이중 방어이고 권한 모델의 일부는 아니다.
- NAS/NFS는 `docs/operations/nfs.md`를 따른다. 호출처 호스트도 `vers=4.2`로 mount해야 default ACL 폴더에서 umask 077 파일이 읽힌다.
- 호출처는 자기 폴더의 목록을 볼 수 없다. 이름을 알면 자기 파일의 읽기·삭제는 가능하다(소유자라 막을 수 없다).

## 5. 파일 쓰기 규약

### 순서와 이름

1. 같은 폴더 안에서 점(`.`)으로 시작하는 임시 이름에 쓴다. 예: `.<uuid>.json.tmp`.
2. `fsync`한다.
3. `close`한다.
4. `0660`으로 `chmod`한다. 파일 생성 mode가 `0600`이면 필수이고, 아니어도 해가 없다.
5. 같은 폴더 안에서 최종 이름 `<고유 이름>.json`으로 `rename`한다.

- 최종 이름은 확장자 `.json`(소문자)이다. 점으로 시작하는 이름과 `.json`이 아닌 이름은 무시된다.
- 최종 이름은 요청마다 고유해야 한다. outbox 행 ID(UUID)를 쓰면 이벤트의 `fileName`으로 요청을 찾을 수 있다. 같은 이름으로 `rename`하면 아직 수집되지 않은 파일을 경고 없이 덮어쓴다.
- 다른 폴더나 다른 파일시스템에서 `rename`하지 않는다(`EXDEV`, 비원자적).
- `rename` 뒤에 파일을 열어 두고 덧쓰지 않는다. 부분 내용이 노출될 수 있다.
- 심볼릭 링크, 하드링크, 하위 디렉터리를 만들지 않는다. 읽지 않고 거부한다. `link`로 최종 이름을 만든 뒤 임시 이름을 `unlink`하는 게시 방식도 쓰지 않는다. `link` 직후 `unlink` 전에 폴링되면 `nlink`가 2라서 `MALFORMED`로 거부되고 파일이 삭제된다(ADR-0004 구현 중 확정 30). 게시는 `rename`만 쓴다.
- 파일 크기 상한은 기본 2 MiB(`MAILO_FILE_MAX_BYTES`)이다. JWS·JWE는 base64 때문에 평문의 약 1.8배가 된다. 상한을 넘으면 `SIZE_EXCEEDED`다.
- 쓰기를 1시간(`MAILO_FILE_TEMP_MAX_AGE_SECONDS`) 넘게 멈춘 임시 파일은 Mailo가 지울 수 있다.
- 호출처가 Linux가 아닌 환경(Windows, macOS 클라이언트)은 확인하지 않았다.
- `mkstemp`류와 Java의 `Files.createTempFile`은 mode `0600`으로 만든다. `chmod 0660` 없이 `rename`하면 Mailo가 읽지 못한다.

### 파일 내용

REST 본문과 같은 필드에 `version`(정수 1)과 `idempotencyKey`가 더해진다. REST에서는 이 두 필드가 정의되지 않은 필드(400)다. `attachments`는 거부한다. 선택 필드 `priority`·`ttlSeconds`도 REST와 같다("우선순위", "요청별 만료 시간").

서명 `none`, 평문:

```json
{
  "version": 1,
  "idempotencyKey": "7c9e6679-7425-40de-944b-e07fc1f90ae7",
  "to": ["kim@example.com"],
  "from": "no-reply@example.com",
  "subject": "주문 접수 안내",
  "text": "주문이 접수되었습니다."
}
```

서명 `required`는 최상위가 flattened JWS이고 위 JSON이 `payload` 안에 들어간다. `payload`·`protected`·`signature`는 base64url 문자열이다.

```json
{ "protected": "<b64url>", "payload": "<b64url>", "signature": "<b64url>" }
```

- `protected`(JSON)는 `alg`(`HS256`), `kid`, `caller`(호출처 `id`), `iat`(초 단위 숫자) 네 필드뿐이다. 다른 필드는 거부한다. 최상위에 unprotected `header`나 `signatures`를 두지 않는다(서명 범위 밖이라 받지 않는다).
- `payload`는 요청 JSON의 UTF-8 바이트를 base64url(패딩 없음)로 인코딩한 값이고, 서명 입력은 `protected + "." + payload`다(RFC 7515).
- `iat`가 서명 허용 기간(기본 7일)보다 오래됐거나 허용 오차(기본 5분)를 넘어 미래이면 `IAT_OUT_OF_RANGE`다. 호출처 호스트 시계를 NTP로 맞춘다.
- 재시도 때는 같은 요청이라도 서명을 다시 만들어 새 `iat`를 쓴다.
- 서명·암호화 구현은 서버 없이 `docs/api/conformance/vectors.json`의 골든 벡터로 확인한다. 읽는 방법은 `docs/api/conformance/README.md`다. 벡터의 키는 공개 가짜 키이고 운영에 쓰지 않는다.

JWE 사용 시 `subject`·`text`·`html` 대신 `content`(JWE compact, 점으로 구분한 5부분)를 넣는다. 평문과 암호문을 한 요청에 섞으면 `CONFLICTING_FIELDS`(REST) 또는 `VALIDATION_FAILED`(파일)다. 복호화 평문은 UTF-8 JSON `{"subject","text","html"}`뿐이다. `alg`는 `RSA-OAEP-256`, `enc`는 `A256GCM`, protected header에 `kid`(Mailo가 알려 준 값)와 `caller`(호출처 `id`)를 넣는다. 수신자와 `Idempotency-Key`는 평문이다.

### Java 예시(조각은 컴파일하지 않았다. 같은 API 호출을 쓰는 `samples/spring-boot-relay/`의 `FileChannelWriter`·`RequestSigner`·`EnvelopeEncryptor`는 컴파일·실행했다)

최종 파일 쓰기(JDK만 사용):

```java
static void writeRequestFile(Path inbox, UUID requestId, String json) throws IOException {
    String finalName = requestId + ".json";
    Path tmp = inbox.resolve("." + finalName + ".tmp");          // 점으로 시작: Mailo가 무시한다
    byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
    try (FileChannel ch = FileChannel.open(tmp, StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE)) {
        ByteBuffer buf = ByteBuffer.wrap(bytes);
        while (buf.hasRemaining()) ch.write(buf);
        ch.force(true);                                            // fsync
    }                                                              // close
    Files.setPosixFilePermissions(tmp, PosixFilePermissions.fromString("rw-rw----")); // 0660
    Files.move(tmp, inbox.resolve(finalName), StandardCopyOption.ATOMIC_MOVE);       // 같은 폴더 rename
}
```

서명(nimbus-jose-jwt. 10.10에서 `kid`·`caller`·`iat`를 `customParam`으로 넣은 HS256 flattened JWS를 Mailo가 `signature.mode=required`로 받는 것을 확인했다. 다른 버전은 확인하지 않았다):

```java
JWSHeader header = new JWSHeader.Builder(JWSAlgorithm.HS256)
    .keyID("billing-2026-11")
    .customParam("caller", "billing")
    .customParam("iat", Instant.now().getEpochSecond())
    .build();
JWSObject jws = new JWSObject(header, new Payload(requestJson));   // requestJson: 요청 JSON 문자열
jws.sign(new MACSigner(secretBytes));                               // 32바이트 비밀키
String[] p = jws.serialize().split("\\.");                          // protected . payload . signature
String fileJson = objectMapper.writeValueAsString(
    Map.of("protected", p[0], "payload", p[1], "signature", p[2]));
```

JWE(`content` 생성):

```java
JWEHeader header = new JWEHeader.Builder(JWEAlgorithm.RSA_OAEP_256, EncryptionMethod.A256GCM)
    .keyID("mailo-2026-12")                                         // Mailo가 알려 준 kid
    .customParam("caller", "billing")
    .build();
JWEObject jwe = new JWEObject(header, new Payload(plaintextJson));  // {"subject":...,"text":...}
jwe.encrypt(new RSAEncrypter(mailoPublicKey));                      // RSA 3072 공개키
String content = jwe.serialize();
```

## 6. REST 연동 요약

```txt
POST /jobs
Authorization: Bearer <API 키>
Idempotency-Key: 7c9e6679-7425-40de-944b-e07fc1f90ae7
Content-Type: application/json

{"to":["kim@example.com"],"subject":"주문 접수 안내","text":"주문이 접수되었습니다."}
```

- `Content-Type`이 `application/json`이 아니면 415다.
- 202는 새 작업, 200은 같은 Key·같은 내용의 기존 작업이다. 둘 다 등록 완료이며 발송 완료가 아니다. 응답은 `Location: /jobs/{jobId}`와 `Job` 본문이다.
- 상태 확인은 `GET /jobs/{jobId}` 또는 `GET /jobs?idempotencyKey=<Key>`다. 최종 결과는 이벤트 피드로 받는다.
- 오류는 `application/problem+json`이다. `type`으로 분기한다.

| 응답 | 의미 | relay 동작 |
| ---- | ---- | ---------- |
| 202, 200 | 등록 완료 | outbox 행을 전달 완료로 표시 |
| 네트워크 오류, 타임아웃, 5xx(503 포함) | 등록 여부 불명 또는 일시 장애 | 같은 Key·같은 내용으로 재시도 |
| 400, 413, 415 | 요청 오류 | 재시도하지 않는다. 실패로 기록하고 알린다 |
| 401 | 자격 오류 | 재시도하지 않는다. 알린다 |
| 409 `idempotency-conflict` | 같은 Key에 다른 내용 | 재시도하지 않는다. 영구 실패로 기록하고 운영 알림. Key를 재사용하는 호출처 버그를 의심한다 |
| 409 `job-not-cancelable` | 취소 요청에만 온다. 작업이 `SENDING`이거나 종결 상태다 | 재시도하지 않는다. 응답의 `jobStatus`와 이후 이벤트로 결과를 확인한다 |
| 429 | 쓰지 않는다 | 등록 단계에 쿼터가 없다 |

## 7. Spring Boot 사용처: outbox + relay

실행 가능한 구현은 [`samples/spring-boot-relay/`](../../samples/spring-boot-relay/README.md)다(Gradle, Spring Boot 3.5.16, JDK 21). 아래 규칙과의 차이는 두 가지다. 샘플은 상태에 `REJECTED`(400·401·413·415 등 재시도 불가, 파일 수집 거부)와 `QUARANTINED`(409, 같은 Key에 다른 내용)를 두어 Mailo의 최종 실패 `FAILED`와 구분하고, `NEEDS_CHECK`(모르는 이벤트 종류·Job 상태를 만나 `GET /jobs`로 확인 중)를 둔다. 401은 행 하나를 `REJECTED`로 표시한 뒤 relay를 프로세스 재시작까지 멈춘다. 이 규칙 표(6절) 중 Mailo 응답으로 실행 확인한 것은 202, 200, 400, 401, 409와 네트워크 오류(연결 거부)다. 5xx, 413, 415, 429는 샘플의 `SendDecision` 단위 테스트로 판정만 확인했고 Mailo 응답으로는 재현하지 않았다.

### 구조(RQ-004, RQ-021, ADR-0001 결정 4)

비즈니스 트랜잭션이 발송 요청을 자기 DB의 outbox 행으로 같은 트랜잭션에 쓴다. 커밋 뒤 별도 relay가 outbox를 읽어 Mailo로 보낸다. Mailo가 내려가 있어도 비즈니스 트랜잭션은 영향받지 않는다. relay는 outbox 행이 남아 있는 한 재시도한다.

| 방식 | 요청 유실 | 롤백된 건의 메일 발송 | 비고 |
| ---- | --------- | ---------------------- | ---- |
| outbox + relay(권장) | 없음 | 없음 | 중복 전달은 `Idempotency-Key`가 흡수한다 |
| 커밋 후 직접 전송(REST·파일) | 전송 전에 프로세스가 죽으면 유실 | 없음 | 파일 채널의 유실 가능 구간이 여기다 |
| 커밋 전 전송 | 없음 | 롤백되면 존재하지 않는 건의 메일이 발송될 수 있다 | 권하지 않는다 |

Mailo는 사용처 DB를 알지 못하고 접속하지 않는다(RQ-003). 사용처도 Mailo DB에 접속하지 않는다.

### outbox 테이블(PostgreSQL 문법 예시)

```sql
CREATE TABLE mail_outbox (
  id              uuid PRIMARY KEY,                  -- Idempotency-Key로 쓴다. 요청 단위로 고유하다
  request_json    text NOT NULL,                     -- 등록 시점에 확정한 요청. 재시도에서 필드를 바꾸지 않는다(바꾸면 409)
  status          text NOT NULL DEFAULT 'PENDING',   -- PENDING, DELIVERED, SENT, FAILED, EXPIRED, DEAD (샘플은 REJECTED, QUARANTINED, NEEDS_CHECK 추가)
  attempt_count   integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now(),
  last_http_status integer
);
CREATE INDEX mail_outbox_due_idx ON mail_outbox (next_attempt_at) WHERE status = 'PENDING';
```

- Key는 요청 단위의 고유 값이다. outbox 행 ID가 적합하다. 사용자 ID처럼 여러 요청이 공유하는 값은 409를 만든다(ADR-0005 결정 8). 형식은 1~128자, `[A-Za-z0-9._:-]`다. UUID 문자열은 맞는다.
- 요청 본문은 `request_json`에 확정해 두고 relay가 그대로 보낸다. 재시도 때 수신자·제목·본문·`from`·`replyTo` 중 하나라도 달라지면 409다. 평문 모드와 JWE 모드는 평문이 같으면 같은 내용이다.
- 상태 `DELIVERED`는 Mailo가 등록(202·200)했다는 뜻이다. `SENT`는 이벤트 피드로 확인한 SMTP 수락이다.
- Mailo의 `PENDING`·`SENDING`·`RETRY_WAIT`는 비종결이다. 등록됨(`DELIVERED`)으로 두고 종결 이벤트를 기다린다. 완료로 처리하지 않는다.
- 모르는 `Job.status`나 이벤트 `type`을 만나면 성공으로 처리하거나 건너뛰지 않는다. 행을 "확인 필요"(샘플은 `NEEDS_CHECK`)로 표시하고 `GET /jobs?idempotencyKey=`로 확인한다. 규칙은 `docs/api/README.md`의 "호출처가 모르는 값을 만났을 때" 절이다.

### relay 규칙

- 대상 행: `status = 'PENDING' AND next_attempt_at <= now()`. 여러 relay 인스턴스가 있으면 `FOR UPDATE SKIP LOCKED`로 잡는다.
- 결과 처리는 위 표(6절)를 따른다.
- 재시도 간격은 exponential backoff에 jitter를 더하고 상한을 둔다. 수치는 사용처가 정한다. 예시 값: 시작 30초, 배수 2, 상한 1시간, jitter ±20%(추정).
- **최대 재시도 기간은 7일 이하다.** `created_at`부터 7일이 지나면 `DEAD`로 기록하고 알린다. Key 보존 기간(종결 후 30일)보다 충분히 짧아야 하기 때문이다(7일은 추정). 서명 파일은 `iat` 허용 기간(기본 7일)도 같은 한도를 만든다.
- 409는 영구 실패다. 행을 영구 실패 상태(`FAILED`, 샘플은 `QUARANTINED`)로 두고 운영 알림을 낸다. 같은 Key로 다른 내용을 보내려는 버그다.
- HTTP 타임아웃은 사용처가 정한다. 예시: 연결 5초, 요청 10초(추정). 타임아웃은 등록 여부를 알 수 없는 경우이므로 같은 Key로 재시도한다.

HTTP 호출과 판정(JDK `java.net.http`. 이 조각은 컴파일하지 않았다. 샘플의 `MailoClient`·`SendDecision`이 같은 호출 방식으로 실행 확인됐다):

```java
enum Decision { DONE, RETRY, FAIL_AND_ALERT }

static Decision classify(int status) {
    if (status == 200 || status == 202) return Decision.DONE;
    if (status >= 500) return Decision.RETRY;       // 503 포함. 같은 Key로 재시도
    return Decision.FAIL_AND_ALERT;                 // 400, 401, 409, 413, 415 등 4xx는 재시도하지 않는다
}

Decision send(HttpClient http, URI base, String apiKey, UUID key, String requestJson) {
    HttpRequest req = HttpRequest.newBuilder(base.resolve("/jobs"))
        .timeout(Duration.ofSeconds(10))
        .header("Authorization", "Bearer " + apiKey)
        .header("Idempotency-Key", key.toString())
        .header("Content-Type", "application/json")
        .POST(HttpRequest.BodyPublishers.ofString(requestJson, StandardCharsets.UTF_8))
        .build();
    try {
        HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
        return classify(res.statusCode());
    } catch (IOException e) {                        // 연결 실패, 타임아웃(HttpTimeoutException 포함)
        return Decision.RETRY;
    } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        return Decision.RETRY;
    }
}
```

- 응답 본문의 `jobId`는 필요하면 저장한다. 파일 채널은 `jobId`를 돌려주지 않으므로 Key로 조회한다.
- 401은 자격 설정 문제다. 같은 요청을 계속 보내지 않도록 relay를 멈추고 알리는 방식을 사용처가 정한다(`docs/api/README.md`).
- 파일 채널로 보내는 relay도 같은 규칙이다. 재시도는 "파일 쓰기"가 대신하고, 등록 확인은 Key 조회와 이벤트 피드로 한다. 파일 이름은 outbox 행 ID로 정하면 이벤트의 `fileName`과 대조할 수 있다.

### 이벤트 피드 소비와 cursor 저장

`GET /events?after=<cursor>&limit=<개수>`를 약 30초(추정) 간격으로 폴링한다.

1. 처음에는 `after` 없이 호출한다.
2. 응답의 `events`를 순서대로 처리한 뒤 `nextCursor`를 저장한다. 처리와 cursor 저장을 같은 트랜잭션에 넣는다.
3. `hasMore`가 `true`이면 바로 이어서 호출하고, `false`이면 간격을 두고 폴링한다.
4. `type` 필터를 쓰면 필터 조합마다 cursor를 따로 저장한다. cursor는 필터와 무관하므로 섞어 쓰면 이벤트를 놓친다. 필터 없이 모든 종류를 받는 구성을 권한다.
5. cursor는 불투명 문자열이다. 해석하거나 만들지 않는다. 이벤트가 없고 `after`도 없으면 `nextCursor`는 `null`이다.
6. 같은 이벤트가 다시 올 수 있다. `eventId`(문자열, 순서 의미 없음)나 outbox 행 상태 전이를 멱등하게 처리한다.

```sql
CREATE TABLE mailo_event_cursor (name text PRIMARY KEY, cursor text);  -- 행 하나. 필터를 쓰면 필터 조합마다 이름을 나눈다
```

| 이벤트 `type` | 사용처 처리 |
| ------------- | ----------- |
| `JOB_SENT` | outbox 행을 `SENT`로 표시한다. `rejectedRecipients`가 있으면 일부 수신자가 거부된 것이므로 기록·알림 여부를 정한다 |
| `JOB_FAILED` | `failureReason`(`PERMANENT_ERROR`, `MAX_ATTEMPTS_EXCEEDED`, `ACCOUNT_ERROR_REPEATED`)과 `lastError`를 기록하고 알린다. `outcomeUncertain`이 `true`이면 메일이 이미 나갔을 수 있다(아래 "결과 불명 실패"). 새 요청으로 다시 보낼지는 사용처가 정한다(새 Key) |
| `JOB_EXPIRED` | `failureReason: EXPIRED`. 기본 만료 TTL은 24시간이다. 차단기 장애가 길면 대량으로 올 수 있다. 이전 시도에 결과 불명이 있었으면 `outcomeUncertain`이 `true`다 |
| `JOB_CANCELED` | 취소 종결이다. 실패가 아니다. outbox 행을 취소 상태로 닫고 재시도하지 않는다. `canceledBy`(`CALLER`·`OPERATOR`)로 운영자가 취소한 것인지 구분한다. 호출처가 직접 취소해도 온다 |
| `INTAKE_REJECTED` | 파일 수집 거부. `reasonCode`로 원인을 고쳐 새 파일로 다시 보낸다(`troubleshooting.md`). `idempotencyKey`가 있으면 outbox 행을 찾고, `null`이면 `fileName`으로 찾는다 |
| 위에 없는 `type` | 건너뛰지 않는다. 이벤트를 기록하고 outbox 행을 "확인 필요"로 표시한 뒤 `GET /jobs`로 상태를 확인한다. cursor는 그 이벤트를 지나가므로 이 표시가 유일한 단서다 |

- 이벤트 모양 예(JOB_SENT): `eventId`, `type`, `occurredAt`, `jobId`, `idempotencyKey`, `attempts`, `recipients{to,cc,bcc}`, `rejectedRecipients[]`. `JOB_FAILED`·`JOB_EXPIRED`는 `failureReason`, `lastError`, `outcomeUncertain`을 더한다. `INTAKE_REJECTED`는 `rejectionId`, `idempotencyKey`(없으면 `null`), `fileName`, `fileSize`, `sha256`, `reasonCode`다.
- 이벤트는 기록 후 30일 보존한다. 30일 넘게 폴링하지 않으면 그 사이 이벤트를 놓친다. 응답 헤더 `Mailo-Cursor-Gap: true`가 이 유실을 알린다(아래 "공백 신호").
- `GET /events`가 200이 아니면 같은 요청을 말없이 반복하지 않는다. 상태 코드를 기록하고 알린다. 401은 키를 고치기 전에 반복하지 않는다.
- 응답의 모르는 필드와 헤더는 무시한다.
- 빈 `events`가 새 이벤트가 없다는 뜻은 아니다. DB에 긴 트랜잭션이 있으면 피드가 지연된다(이벤트는 유실되지 않는다). 지연은 `/health/ready`의 `eventFeed.lagSeconds`로 본다. 새 이벤트가 없어도 값이 커지므로 단독 장애 신호가 아니다.
- 같은 이름·같은 `sha256`의 파일을 다시 넣어도 거부 기록과 이벤트는 새로 생기지 않는다. 고친 파일은 내용이 달라지므로 새 기록이 생긴다.

### 공백 신호 `Mailo-Cursor-Gap`

근거: RQ-045, ADR-0011 결정 9. 보존 삭제(30일)가 저장해 둔 `after` 뒤의 이벤트를 지웠으면 응답이 헤더 `Mailo-Cursor-Gap: true`를 가진다. 상태는 200이고 본문은 같다.

1. 응답의 이벤트는 평소처럼 처리하고 `nextCursor`를 저장한다.
2. 헤더가 있으면 종결되지 않은 outbox 행(`DELIVERED` 등)마다 `GET /jobs?idempotencyKey=`로 상태를 확인한다. 30일이 지나 404인 Key는 사용처가 정한다(새 Key로 다시 보낼지는 중복 발송 위험과 함께 판단한다).
3. `nextCursor`로 이어 읽어 cursor가 삭제 지점을 넘으면 헤더가 사라진다. 헤더가 붙는 응답마다 같은 outbox 행을 다시 확인하지 않도록 확인한 행을 표시한다.

- `onGap=error`를 보내면 헤더 대신 410(`cursor-expired`)이다. 410을 처리하지 못하는 사용처는 보내지 않는다. 410을 받으면 `after` 없이 다시 읽어 남은 이벤트부터 받고 2를 한다. 같은 `after`로 `onGap` 없이 다시 읽어도 된다. 410을 모르는 클라이언트가 200이 아닌 응답을 같은 요청으로 반복하면 피드가 멈추므로 기본값은 410이 아니다(ADR-0011 결정 9).
- 판정은 `type`별이다. `type` 필터로 읽는 사용처는 요청한 종류의 삭제만 신호로 받는다.
- 복구 읽기를 `after` 없이 하면 그 사이 삭제가 신호 없이 진행될 수 있다. 같은 `after`로 이어 읽으면 신호가 난다. 복구 뒤에 `GET /jobs`로 한 번 더 확인한다.
- 신호가 없는 경우: 공백 감지 도입 전에 삭제된 이벤트, cursor가 `null`인 호출처, 롤링 중 구버전 인스턴스가 지운 이벤트. 헤더를 모르는 사용처는 지금처럼 알지 못한다.

### Key 조회 404 처리

`GET /jobs?idempotencyKey=<Key>`는 등록된 작업만 반환한다. 404는 다음 중 하나다. 다른 호출처의 Key와 없는 Key는 구분하지 않는다.

1. 아직 수집되지 않았다(파일 채널). 폴링 간격(기본 30초)과 NFS 새 폴더 가시성 지연이 지나기 전이다.
2. 수집이 거부됐다. 이벤트 피드에서 같은 Key의 `INTAKE_REJECTED`를 찾는다. Key를 파싱하지 못한 거부는 `idempotencyKey`가 `null`이다.
3. 파일이 유실됐다(파일 쓰기 전 장애, 권한 오류로 `unreadable` 상태 등).
4. 종결 후 30일(보존 기간)이 지나 삭제된 Key다.

처리(파일 채널 호출처):

1. 거부 이벤트가 있으면 사유 코드대로 고쳐 다시 보낸다.
2. 거부 이벤트가 없고 쓴 지 충분히 지났으면(폴링 간격보다 훨씬 긴 시간, 예 5분, 추정) 같은 Key·같은 내용으로 파일을 다시 쓴다. 이미 등록된 Key면 중복으로 걸러지므로 안전하다.
3. 4번(30일 경과)은 사용처가 이미 종결 이벤트를 받았어야 하는 시점이다. 이벤트를 놓쳤다면 사용처 쪽 결정이 필요하다.

### 우선순위

근거: RQ-033·035·036, ADR-0009.

요청 최상위에 `priority`를 넣으면 Worker가 높은 등급을 먼저 점유한다. REST와 파일이 같은 규칙이다.

| 값 | 용도 기준(예) |
| -- | ------------- |
| `URGENT` | 인증 코드, 보안 알림. 늦으면 사용자가 다음 단계로 못 가는 메일 |
| `HIGH` | 주문·결제 확인처럼 사용자가 곧 확인하는 거래 메일 |
| `NORMAL` | 기본값(생략과 같다). 일반 알림 |
| `LOW` | 뉴스레터, 대량 안내처럼 늦어도 되는 메일 |

- 값은 위 네 문자열만 받는다. 대소문자를 구분한다. `null`, 숫자, 빈 문자열, `urgent` 같은 소문자는 REST 400(`/priority` `INVALID_FORMAT`), 파일은 `VALIDATION_FAILED` 거부다.
- `priority`는 수신자처럼 평문 최상위 필드다. JWE 복호화 평문(`content`) 안에 넣으면 `UNKNOWN_FIELD`(파일은 `VALIDATION_FAILED`)다. 파일 JWS는 요청 JSON 전체를 서명하므로 `priority`도 서명 대상이다.
- `priority`는 `Idempotency-Key` 내용 비교에 들어간다. 생략과 `NORMAL`은 같은 내용이다. 같은 Key로 등급만 바꿔 보내면 409(파일은 `FINGERPRINT_MISMATCH`)다. 재시도할 때 등급을 바꾸지 않는다. 등록 뒤 등급을 바꾸는 API는 없다.
- 작업 조회·등록 응답의 `priority`가 등록한 등급이다. 이 기능 도입 전에 등록한 작업은 `NORMAL`이다. 이벤트 피드에는 `priority`가 없다.
- 모든 호출처가 모든 등급을 쓸 수 있다. 모든 메일을 `URGENT`로 보내면 등급 효과가 없어지고 다른 호출처의 급한 메일도 늦어진다. 위 용도 기준을 지킨다.

```json
{"to":["kim@example.com"],"subject":"인증 코드","text":"인증 코드는 123456입니다.","priority":"URGENT"}
```

파일(서명 `none`)과 JWE 요청에서도 같은 위치다. JWS는 이 JSON 전체가 `payload`다.

```json
{
  "version": 1,
  "idempotencyKey": "0b7e5f4c-2a1d-4e8b-9c3f-6d2a1b0e9f88",
  "to": ["kim@example.com"],
  "from": "no-reply@example.com",
  "priority": "LOW",
  "content": "<JWE compact>"
}
```

점유 순서와 한계:

- claim 호출마다 약 10%(`MAILO_CLAIM_FIFO_RATIO`, 추정 기본값)는 등급을 무시하고 가장 오래 기다린 작업을 고른다. 나머지는 `URGENT` → `HIGH` → `NORMAL` → `LOW`, 같은 등급은 오래 기다린 순서다.
- `URGENT`는 즉시 전송을 뜻하지 않는다. 점유 시점은 빈 슬롯과 다음 점유 실행에 따라 달라진다. 슬롯이 비면 Worker가 polling 대기에서 일찍 깨어날 수 있다. 폴링 간격은 고정 지연 하한이 아니다. Worker가 빈 슬롯은 있으나 할 일이 없어 대기 중이면 새 `URGENT`는 다음 polling까지 기다린다. 이 대기는 `MAILO_WORKER_POLL_MS`(기본 1000ms)에 ±10% jitter를 더한 값이다(`worker/worker.ts` `pollDelay`). claim이 연속 실패하면 대기가 `pollMs × 2^n`(n 최대 10)으로 늘어난다. 진행 중 전송을 끊지 않는다.
- 재시도 대기(`next_attempt_at`), 호출처 할당(모든 등급 합산), 차단기 `open`은 `URGENT`에도 같게 적용된다. 고정 점유 지연이나 수신함 도착, 정확히 한 번 발송은 보장하지 않는다.
- 굶음의 한계: 오래된 작업에 주는 몫은 처리량의 일부다. 유입이 처리량보다 많은 상태가 이어지면 `LOW` 작업은 만료 시각(기본 24시간)을 넘겨 `EXPIRED`가 될 수 있다. `LOW`도 언젠가 보내야 하는 메일이면 만료 이벤트(`JOB_EXPIRED`)를 처리한다.
- 배포 순서: Mailo의 모든 인스턴스가 이 기능을 지원하는 버전이 된 뒤에 `priority`를 보내기 시작한다. 이전 버전은 `priority`를 정의되지 않은 필드로 거부한다(REST 400, 파일 거부).
- 롤백 전에 relay·파일 게시를 멈추고 미확인 Key의 등록 여부를 조회한다. 비기본 등급으로 이미 등록된 요청에서 `priority`만 제거하면 지문이 달라진다. 상세 절차는 `deployment.md` "우선순위 도입 배포 순서"를 따른다.

### 요청별 만료 시간

근거: RQ-039, ADR-0010.

요청 최상위에 정수 `ttlSeconds`를 넣으면 그 작업의 만료 시각을 정한다. REST와 파일이 같은 규칙이다.

- 만료 시각은 Mailo가 등록 때 DB 시각 + `ttlSeconds`로 정한다. 응답·조회의 `expiresAt`이 그 값이다. 호출처 시계는 쓰지 않는다. 절대 시각 필드는 받지 않는다.
- 생략하면 Mailo 기본 TTL(`MAILO_JOB_EXPIRY_SECONDS`, 기본 86400)이다.
- 범위는 60 이상 Mailo 상한(`MAILO_JOB_EXPIRY_MAX_SECONDS`) 이하다. 운영자가 상한을 따로 정하지 않았으면 상한은 기본 TTL과 같다. 기본 TTL보다 긴 값이 필요하면 운영자에게 상한을 확인한다.
- 정수가 아닌 값(소수, 문자열 `"600"`, `null`)은 REST 400 `/ttlSeconds` `INVALID_FORMAT`, 범위 밖 정수는 REST 400 `/ttlSeconds` `OUT_OF_RANGE`다. 파일은 둘 다 `VALIDATION_FAILED` 거부다. relay는 이 400을 재시도하지 않는다.
- `ttlSeconds`는 평문 최상위 필드다. JWE 복호화 평문(`content`) 안에 넣으면 `UNKNOWN_FIELD`(파일은 `VALIDATION_FAILED`)다. 파일 JWS에서는 서명 대상이다.
- `ttlSeconds`는 `Idempotency-Key` 내용 비교에 들어간다. 생략한 요청과 기본값(예: 86400)을 명시한 요청은 다른 내용이다. 같은 Key로 값을 바꾸거나 빼거나 새로 넣으면 409(파일은 `FINGERPRINT_MISMATCH`)다. 재시도할 때 값을 바꾸지 않는다. outbox에 값을 저장해 같은 값을 다시 보낸다.
- 같은 Key로 다시 보내도 만료 시각은 늘어나지 않는다. 처음 등록한 시각이 기준이다.

만료의 뜻:

- 만료 시각 이후에는 새 시도를 시작하지 않는다. 대기·재시도 대기 중이던 작업은 `EXPIRED`가 되고 이벤트 `JOB_EXPIRED`가 나온다.
- 이미 시작한 전송은 만료 시각을 지나도 끝까지 간다. 성공하면 `SENT`다. 그래서 만료 시각 직후 도착하는 메일은 있을 수 있다.
- 짧은 TTL은 재시도 기회를 줄인다. 기본 재시도 간격은 60초(±20%)다. `ttlSeconds` 60인 메일은 첫 시도가 일시 오류이면 대부분 재시도 없이 `EXPIRED`다. 재시도가 필요하면 TTL을 재시도 간격보다 충분히 길게 잡는다.

사용 예:

- 인증 코드처럼 몇 분 뒤 쓸모없는 메일: `ttlSeconds` 600(10분). 늦게 도착해 혼란을 주는 재시도를 막는다.
- 하루를 넘겨도 보내야 하는 대기 알림: 기본 TTL보다 긴 값(예: 172800, 2일). Mailo 상한이 그 이상이어야 한다.

```json
{"to":["kim@example.com"],"subject":"인증 코드","text":"인증 코드는 123456입니다.","priority":"URGENT","ttlSeconds":600}
```

**긴 TTL은 메일이 결국 나가게 할 뿐, 한도로 생긴 지연을 없애지 않는다.** 일일 한도(`550 5.4.5`)로 차단기가 열리면 TTL과 무관하게 차단이 풀릴 때까지 발송하지 않는다. 한도 차단이 하루를 넘는 것은 발송량과 계정 한도의 문제다. 발송량을 줄이거나 할당(`sendQuota24h`)을 조정하는 것이 해법이다.

배포 순서: Mailo의 모든 인스턴스가 이 기능을 지원하는 버전이 된 뒤에 `ttlSeconds`를 보내기 시작한다. 이전 버전은 `ttlSeconds`를 정의되지 않은 필드로 거부한다(REST 400, 파일 거부). 롤백 절차는 `deployment.md` "요청별 만료 시간 도입 배포 순서"를 따른다.

### 결과 불명 실패

근거: RQ-048, ADR-0011 결정 5, `docs/api/README.md` "결과 불명 실패".

`outcomeUncertain`은 SMTP 서버가 메일을 수락했는지 알 수 없는 시도가 한 건이라도 있었으면 `true`다. `GET /jobs`의 `Job`(모든 상태)과 `JOB_FAILED`·`JOB_EXPIRED` 이벤트에 있다. `FAILED`·`EXPIRED`에서 `true`이면 메일이 이미 나갔을 수 있다.

- 운영자 재시도 API는 없다. 다시 보내는 책임은 사용처에 있다. 새 `Idempotency-Key`(새 outbox 행)로 등록한다. 같은 Key로 보내면 `FAILED` 작업이 돌아올 뿐 다시 발송되지 않는다.
- 같은 내용이 수신자에게 이미 갔을 수 있으므로 중복 수신 위험은 사용처가 판단한다. `Message-ID`가 작업마다 다르므로 새 Key로 보낸 메일은 수신 측이 같은 `Message-ID`로 중복을 걸러내는 완화가 듣지 않는다.
- `true`가 아니어도 메일이 나가지 않았다는 보장은 아니다. 서버가 응답했지만 Mailo가 받지 못한 경우는 이 표시가 잡지 못한다(RQ-013).
- 표시를 모르는 사용처도 안전하다. 모르는 응답 필드는 무시하는 규칙(`docs/api/README.md` "호출처가 모르는 값을 만났을 때")이 이미 있다. 샘플(`samples/spring-boot-relay/`)은 JSON을 `JsonNode`로 읽어 이 필드를 무시하고 이벤트 원본을 `mailo_event_log.payload`에 보관한다.
- 작업은 종결 후 30일(기본)이 지나면 지워지고 그 뒤에는 값을 조회할 수 없다. 이벤트의 값은 이벤트 보존 기간(30일) 안에 읽는다.

### 작업 취소

근거: RQ-040·041, ADR-0011 결정 4·10, `docs/api/README.md` "작업 취소".

나가기 전의 작업(`PENDING`, `RETRY_WAIT`)만 취소한다. 호출처 API 키로 자기 작업을 취소한다. 운영자가 취소하는 경로는 이 문서의 범위가 아니다.

| 요청 | 용도 |
| ---- | ---- |
| `POST /jobs/{jobId}/cancel` | REST로 등록해 `jobId`를 받은 호출처 |
| `POST /jobs/cancel?idempotencyKey=<Key>` | 파일 채널 호출처처럼 `jobId`를 모르는 호출처 |

- 취소하면 200과 `status: CANCELED`인 `Job`이 온다. 이미 취소된 작업에 다시 요청해도 같은 200이다(멱등). relay 재시도로 같은 취소를 여러 번 보내도 된다.
- `SENDING`, `SENT`, `FAILED`, `EXPIRED`이면 409 `job-not-cancelable`이다. `jobStatus`가 현재 상태다. 전송 중인 작업은 중단하지 않으므로 취소 요청이 늦으면 메일이 나갈 수 있다.
- 없는 작업과 다른 호출처의 작업은 구분하지 않고 404다.
- 취소하면 Mailo가 본문을 즉시 지운다. 되돌릴 수 없다. 같은 Key로 같은 내용을 `POST /jobs`로 다시 보내면 200과 `CANCELED` 작업이 오고 메일은 나가지 않는다. 다시 보내려면 새 Key(새 outbox 행)를 쓴다.
- 이벤트 `JOB_CANCELED`가 피드에 한 건 온다. outbox를 이벤트로 닫는 사용처는 이 이벤트를 종결로 처리한다. `JOB_FAILED`로 보지 않는다.
- 조회 응답 `Job`은 `canceledAt`, `canceledBy`를 가진다. `CANCELED`에서 `sentAt`·`failedAt`·`failureReason`은 `null`이다.

**취소 API를 쓰기 전 선행 조건.** 사용처가 `docs/api/README.md` "호출처가 모르는 값을 만났을 때"의 세 규칙을 지켜야 한다. 이 규칙을 지키지 않는 사용처는 `CANCELED`·`JOB_CANCELED`를 모르는 값으로 보고 outbox 행을 종결하지 못하거나 성공으로 처리할 수 있다. 샘플(`samples/spring-boot-relay/`)은 두 값을 종결로 처리한다. 이 저장소 밖의 사용처가 규칙을 지키는지는 확인하지 않았다.

배포 순서와 롤링 중 주의:

1. 사용처가 위 선행 조건을 만족하는 것을 확인한다.
2. 마이그레이션 `0006`·`0007`을 적용하고 모든 Mailo 인스턴스를 새 버전으로 바꾼다(`deployment.md` "작업 취소 도입 배포 순서").
3. 그 뒤에 사용처가 취소 API를 쓰기 시작한다.

롤링 중(구·신 인스턴스 혼용) 구버전 인스턴스는 다음처럼 동작한다(코드를 읽어 확인했다).

- `CANCELED` 작업을 조회하면 `status: "CANCELED"`를 그대로 내보낸다. `sentAt`·`failedAt`·`failureReason`은 `null`이다.
- `GET /events?type=JOB_CANCELED`는 400이다. 필터 없이 읽는 구성(권장)은 영향이 없다.
- 이벤트 피드에서 `JOB_CANCELED`는 `failureReason: CANCELED_BY_CALLER` 같은 저장 값이 붙은 실패형 이벤트로 나갈 수 있다. 사용처는 `type`으로 분기해야 한다. `failureReason`으로 취소를 판정하지 않는다.
- 구버전 인스턴스에 취소 요청이 가면 `POST /jobs/{jobId}/cancel` 경로가 없어 404다. 롤링이 끝나기 전에는 취소 API를 쓰지 않는다.

### 발송 정지

근거: RQ-043, ADR-0011 결정 2·3. 운영자가 장애 중 발송을 멈출 수 있다(`deployment.md` "발송 정지와 운영 REST").

- 정지 중에도 등록은 평소처럼 202다. 작업은 `PENDING`에 쌓이고 만료 시각(`expiresAt`)에 `EXPIRED`가 된다. 사용처 relay는 등록 실패로 처리하지 않는다.
- 정지를 알아보려면 호출처 API 키로 `GET /health/ready`를 호출해 `sendPaused`(`{ paused, scope }`)를 본다. `scope`가 `all`이면 전체 정지, `account`이면 이 호출처가 쓰는 SMTP 계정의 정지, `caller`이면 이 호출처만 정지다. `scope`는 앞으로 값이 더 늘 수 있으므로 모르는 값도 `paused: true`로 보고 정지로 다룬다(`account`는 SMTP 계정 도입 때 더해졌다). 계정 ID는 응답에 없다. 이 값은 이벤트 피드로 오지 않는다.
- 호출처 키로 받는 `circuitBreaker`(`state`·`openUntil`·`lastReason`)는 이 호출처가 쓰는 SMTP 계정의 차단기다(SMTP 계정이 여럿인 배포). 다른 계정이 막혀도 `closed`일 수 있다. 인증 없이 받는 `circuitBreaker.state`는 모든 계정 중 가장 나쁜 상태라 이 호출처의 메일이 막혔는지는 호출처 키로 확인한다. 어느 경우에도 계정 ID와 계정 수는 없다. 계정이 하나인 배포는 계정 정지를 쓰지 않는 한 이전과 같다. 단일 계정 배포에서도 `default` 계정을 정지하면(`PUT /ops/pauses/accounts/default`) 호출처 키가 `sendPaused.scope: account`를 받는다. 어느 값도 200/503을 바꾸지 않으므로 readiness 판정에 쓰지 않는다.
- 정지는 키 폐기와 다르다. 키 폐기는 새 요청을 막고 정지는 발송만 멈춘다. 호출처 키가 유출됐으면 운영자가 호출처 정지와 키 폐기를 함께 한다.
- 운영자가 관리 토큰으로 작업을 취소하면(`POST /ops/jobs/{jobId}/cancel`) `CANCELED`와 `JOB_CANCELED`(`canceledBy: OPERATOR`)가 온다. 사용처는 호출처가 직접 취소한 경우와 같게 종결 처리한다(위 "작업 취소").

### 한계

- 발송은 at-least-once다. SMTP 수락 직후 장애가 나면 같은 메일이 두 번 갈 수 있다(RQ-013). 완화로 `Message-ID`를 작업 ID에서 유도한 고정값으로 쓴다. Gmail이 같은 `Message-ID`를 중복으로 버리는지는 확인하지 못했다(ADR-0007 결정 8).
- `SENT`는 SMTP 서버의 수락이다. 받은편지함 도착이 아니고, 일부 수신자가 거부됐을 수 있다(RQ-016).
- 요청 중복 방지(Key)와 SMTP 중복 방지는 다르다. Key는 등록 중복을, 위 한계는 전송 중복을 말한다.

## 8. 등록 확인 체크리스트

1. 기동 로그에 설정 오류가 없다. 파일 채널을 켰다면 `file_channel_started`(`callers`에 호출처 수)가 나온다.
2. `GET /health/ready`에 새 API 키로 200이 온다.
3. REST: 테스트 요청이 202이고 같은 Key 재요청이 200이다. 같은 Key에 다른 본문은 409다.
4. 파일: 규약대로 파일을 넣는다. 다음 폴링(기본 30초 이내)에 `file_poll` 로그의 `registered`가 1이고 파일이 사라진다. 이어 `GET /jobs?idempotencyKey=`가 200이다.
5. 권한: 호출처 계정으로 자기 폴더 목록 조회와 다른 호출처 폴더 접근이 거부되는지 확인한다.
6. 이벤트: 발송 뒤 `GET /events`에 `JOB_SENT`가 나온다.
7. 취소(취소 API를 쓰는 호출처): 모르는 값 규칙 준수를 확인한 뒤, 차단기가 `open`이거나 `RETRY_WAIT`인 테스트 작업을 `POST /jobs/{jobId}/cancel`로 취소해 200과 `CANCELED`, 이벤트 `JOB_CANCELED`가 오는지 본다.

## 검증하지 않은 것

- 이 문서의 인라인 Java·SQL 조각 자체. 샘플(`samples/spring-boot-relay/`)이 같은 규칙을 구현해 Mailo와 실행됐고, 여러 relay 인스턴스의 동시 실행·전송 도중 강제 종료·7일 `DEAD` 전이의 시각 경과는 재현하지 않았다.
- nimbus-jose-jwt 10.10 외 버전, `RSA-OAEP-256`+`A256GCM`·`HS256` 외 알고리즘, 키 교체 중 이전 `kid`로 암호화한 요청과의 상호 운용. 위 조합은 샘플 실행으로 확인했다.
- 실제 NAS 제품, bind mount, rootless Docker·`userns-remap`, ACL을 지원하지 않는 파일시스템에서의 권한 구성.
- 호출처가 Linux가 아닌 환경에서의 파일 쓰기.
- 실제 Gmail·Workspace SMTP.
- 호출처의 `accountId` 전환(`default`에서 다른 계정으로)을 실제 Gmail 계정 둘로 실행하지 않았다. 계정별 송신은 로컬 SMTP 서버 둘(`test/e2e/multi-account.integration-spec.ts`)로만 확인했다.
- 모르는 이벤트 종류·`Job.status`를 서버가 실제로 보낼 때의 샘플 동작. 서버가 아직 보내지 않아 샘플 단위 테스트의 대역으로만 확인했다(`samples/spring-boot-relay/README.md`).
- 작업 취소 도입의 롤링 배포·롤백 실행. 구버전 인스턴스의 동작은 코드를 읽어 적었다. 이 저장소 밖 사용처가 모르는 값 규칙을 지키는지도 확인하지 않았다.
- 요청별 만료 시간의 롤링 배포·롤백. 만료 동작은 통합 테스트(`test/e2e/job-ttl.integration-spec.ts`)로 확인했다.
- 우선순위의 효과를 실제 부하(여러 인스턴스, 장시간 적체)에서 측정하지 않았다. 점유 순서는 통합 테스트(`test/queue/claim-priority.integration-spec.ts`, `test/worker/worker-priority.integration-spec.ts`)로 확인했다.
