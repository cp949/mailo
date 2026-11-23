# 도메인 문서

에이전트가 Mailo의 도메인 문서를 찾고 출력에 적용하는 규칙이다.

## 구조

single-context다. 앱은 `apps/mailo` 하나다. 루트 `CONTEXT-MAP.md`가 문서 위치와 모듈별 근거 문서를 정리한다. 이 파일이 있어도 multi-context가 아니다.

```text
/
├── CONTEXT-MAP.md                      ← 문서 위치, 모듈↔근거 표
├── docs/requirements/mail-sending.md   ← 용어("용어와 진행 상태" 절), RQ-001~032
├── docs/adr/                           ← ADR-0001~0008
├── docs/api/                           ← API 계약(OpenAPI)
├── docs/operations/                    ← 배포·키·호출처·장애 문서
└── apps/mailo/src/
```

`CONTEXT.md`는 없다. 용어 기준은 `docs/requirements/mail-sending.md`의 "용어와 진행 상태" 절이다. 그 절로 부족해지면 `apps/mailo/CONTEXT.md`를 추가하고 `CONTEXT-MAP.md` 표를 갱신한다.

## 작업 전에 읽을 문서

- `CONTEXT-MAP.md`: 작업할 모듈의 근거 RQ·ADR
- `docs/requirements/mail-sending.md`: 해당 RQ의 수용 조건과 진행 상태, 용어 절
- 관련 `docs/adr/`: 결정 번호까지 읽는다. 코드·테스트 주석은 `ADR-0007 결정 5`처럼 결정 번호로 참조한다.

문서가 없거나 비어 있어도 조용히 작업을 계속한다. 없는 파일을 만들자고 먼저 제안하지 않는다.

## 용어 사용

이슈 제목, 리팩터링 제안, 가설, 테스트 제목에서 도메인 개념을 쓸 때 용어 절의 표현을 쓴다. 예: 발송을 요청하는 서버는 "사용처", 요청 한 건은 "발송 작업", 요청 경로는 "입력 채널". 레지스트리와 설정 필드에서는 코드 식별자(`caller_id`, `fileChannel`)를 그대로 쓴다.

필요한 개념이 용어 절에 없으면 둘 중 하나다. 프로젝트가 쓰지 않는 표현을 새로 만든 것이면 다시 생각한다. 실제 의미 공백이면 사용자와 정의를 정한 뒤 용어 절에 추가한다.

## ADR 충돌 처리

제안이 기존 ADR과 충돌하면 조용히 덮어쓰지 않는다. 충돌하는 ADR 번호와 결정 번호, 다시 검토할 이유, 영향 범위를 밝힌다. 결정을 바꾸는 절차는 `AGENTS.md`의 "문서와 요구사항 갱신"을 따른다.

> _ADR-0007 결정 5와 충돌한다. 다시 검토할 이유는…_
