# `_works` 작업 폴더 규칙

`_works`는 `AGENTS.md`의 "작업 실행"에서 고른 workflow의 실행 문서를 두는 로컬 작업장이다. `qq`는 `docs/agents/qq-workflow.md`, `rubber`는 `docs/agents/rubber-workflow.md`를 따른다. 공통 실행 계약은 `docs/agents/workflow-shared.md`를 따른다. 한 작업 폴더에서 서로 다른 형식을 섞지 않는다.

작업은 파일 단위가 아니라 폴더 단위로 관리한다.

## 추적 범위

- 추적 대상은 이 문서와 `_works/templates/*.md`뿐이다. 예외 규칙은 `.gitignore`에 있다.
- 작업 폴더, `_works/_completed/`와 그 밖의 파일은 Git에서 제외한다. 강제로 stage하지 않는다.
- `_works/`는 oxfmt(`.oxfmtrc.json`)와 Docker 빌드 컨텍스트(`.dockerignore`)에서 빠진다. 표 열 정렬은 손으로 맞춘다.
- 작업 폴더 문서에도 RQ-027을 적용한다. 메일 본문·제목·수신자 주소, SMTP 인증 정보, API 키 평문, 키를 적지 않는다. 로그를 붙일 때도 같다.

## 구조

- 형식: `_works/<yyyyMMdd>-<seq>-<작업명>/`
- `<seq>`는 `01`, `02` 같은 두 자리 일련번호다.
- `<작업명>`은 짧은 영문 slug 또는 한글 작업명이다.

예시:

- `_works/20261123-01-claim-fairness/`
- `_works/20261123-02-qq-workflow-도입/`

## workflow별 구조

`qq-workflow` 작업은 계획서 하나와 DELTA 파일을 사용한다. DELTA는 `DELTA-01.md` 하나로 시작하고 최대 3개다. 리뷰는 DELTA마다 첫 리뷰부터 번호를 붙인다. 필요한 라운드의 파일만 만든다. `verification-log.md`는 검증을 실행하는 작업에서 만든다. 문서만 바꾸는 작업은 만들지 않아도 된다.

```text
_works/<작업폴더>/
  _meta.md
  01-계획.md
  DELTA-01.md
  DELTA-01-REVIEW-01.md
  DELTA-01-REVIEW-02.md
  pending-issues/
  verification-log.md
```

| 문서      | 템플릿                                  |
| --------- | --------------------------------------- |
| 계획서    | `_works/templates/qq-01-계획.md`        |
| DELTA     | `_works/templates/qq-DELTA-NN.md`       |
| 리뷰      | `_works/templates/qq-IMPL-REVIEW-NN.md` |
| 검증 기록 | `_works/templates/verification-log.md`  |

`rubber-workflow` 작업의 구조와 파일 내용은 `docs/agents/rubber-workflow.md`의 "작업 폴더", "LEG", "DELTA 형식"을 따른다. 검증 기록(`verification-log.md`, 템플릿 `_works/templates/verification-log.md`)은 어느 workflow에서든 검증을 실행하는 작업에 둔다. 문서만 바꾸는 작업은 만들지 않아도 된다. 전체 DELTA 목록을 사전에 완성하지 않고 진행 결과로 DELTA를 추가·분할한다.

`pending-issues/`는 사용자 지시 전이라 GitHub에 올리지 않은 이슈 초안이다. 파일 하나에 이슈 하나를 두고 제목, 등록 기준(`docs/agents/issue-tracker.md`의 "등록 기준" 중 해당 항목), 재현 조건, 관련 RQ·ADR을 적는다.

## 작성 규칙

- 파일 내용은 한국어로 쓴다.
- 작업 폴더 내부 문서는 같은 폴더 안의 파일명으로 참조한다.
- 실행 단위 문서는 이전 대화 없이 읽어도 작업을 시작할 수 있게 쓴다. "계획서 참고", "관련 테스트를 적절히 수정한다"처럼 내용을 숨기지 않고 결론·파일 경로·검증 명령을 직접 적는다.
- 참고 문서는 규칙 검산용이다. 그 문서를 읽어야만 알 수 있는 핵심 작업 지시는 실행 단위 문서에 요약한다.
- 리뷰 파일은 리뷰 입력이다. 실행 단위의 필수 읽기 목록에 넣지 않는다.

## 완료와 보관

- 완료하면 `_meta.md`의 상태를 `완료`로 바꾸고 작업 폴더를 `_works/_completed/`로 옮긴다.
- `_works/_completed/`는 영구 보관소가 아니다. 누적되면 삭제될 수 있다.
- 영구로 남길 내용은 `docs/agents/workflow-shared.md`의 "문서와 최종 보고"에 따라 장기 문서나 GitHub 이슈로 옮긴다.
- 작업 폴더 바깥(소스·테스트·`docs`)에서 작업 폴더 내부 파일로 링크하지 않는다. 금지 표기는 `docs/agents/writing-styles.md`의 "참조 표기"를 따른다.
- 작업 폴더 내부의 상대 링크는 폴더 전체가 함께 이동되는 경우에만 보존된다.
