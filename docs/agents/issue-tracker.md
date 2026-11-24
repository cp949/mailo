# 이슈 트래커: GitHub

이 저장소(`cp949/mailo`)의 이슈는 GitHub Issues에서 관리한다. 모든 작업에 `gh` CLI를 쓴다.

요구사항은 `docs/requirements/mail-sending.md`, 결정은 `docs/adr/`가 소유한다. 이슈는 요구사항·ADR을 대체하지 않는다. 설계 문서와 구현 계획을 이슈로 등록하지 않는다.

## 등록 기준

이슈는 미해결 항목을 추적하는 수단이다. 작업 이력은 커밋 메시지와 `docs/`가 남긴다.

등록한다:

- 지금 구현하지 않고 보류하는 항목
- 사용자나 다른 에이전트가 따로 추적해야 하는 항목
- 재현 조건·원시 로그를 보존해야 하는 간헐 실패
- 별도 논의·승인 기록이 필요한 결함(높음·중간 심각도)
- RQ·ADR과 구현이 어긋나 문서 변경안에 사용자 결정이 필요한 항목

등록하지 않는다:

- 같은 세션에서 구현해 `dev`에 반영할 낮은 심각도 결함. 열자마자 닫게 되어 추적 기능이 없다.
- 버려도 되는 사소한 후속 작업
- 설계·구현 계획

등록하지 않은 수정의 결정 근거와 검증 범위는 커밋 본문에 요약한다.

## 게시 승인

- 읽기(`gh issue view`, `gh issue list`, `gh api` 조회)는 언제든 실행한다.
- 쓰기는 사용자가 지시했을 때만 한다. 쓰기는 이슈 생성, 댓글, 수정, 종료, 라벨·assignee 변경이다.
- 예외: 사용자가 특정 이슈의 작업을 지시했고 아래 "작업 완료와 자동 종료" 조건을 모두 충족하면 완료 댓글과 종료는 별도 확인 없이 한다.
- 게시 전에 본문에서 SMTP 인증 정보, API 키, 개인키, 메일 본문·제목·수신자 주소를 제거한다(RQ-027). 이슈는 공개 저장소에 남는다.

## 작업 완료와 자동 종료

관련 이슈가 있는 작업은 아래 조건을 모두 충족하면 해당 이슈를 종료한다.

- 이슈 본문·댓글의 수용 조건과 작업의 필수 완료 조건을 모두 충족했다.
- 필요한 검증을 완료했다. 검증 단계는 `docs/agents/verification.md`를 따른다.
- 코드·문서 변경이 있으면 최종 커밋이 로컬 `dev`에 반영돼 있다.
- 조사·결정 작업이면 이슈가 요구한 결과와 결정 기록이 남아 있다.

종료 절차:

1. `gh issue view <번호> --comments`로 최신 요구와 상태를 확인한다. 이미 닫힌 이슈는 다시 종료하지 않는다.
2. 완료 댓글에 구현·조사 결과, 최종 커밋, 검증 범위·통과/실패 수, 미실행 항목과 남은 한계를 적는다. 이전 검증 기록을 인용하면 이번 작업에서 실행한 결과와 구분한다.
3. 댓글 본문을 임시 파일에 쓰고 `gh issue comment <번호> --body-file <파일>`로 게시한다.
4. `gh issue close <번호> --reason completed`로 종료한다.
5. `gh issue view <번호> --json state,stateReason,url`로 `CLOSED`·`COMPLETED`를 확인하고 링크를 보고한다.

종료하지 않는 경우:

- 로컬 `dev` 반영만으로 수용 조건이 충족되면 push 전에도 종료한다. 종료를 위해 push하지 않는다.
- 수용 조건이 push·배포·외부 검증을 요구하면 충족될 때까지 열어 둔다.
- 일부만 완료했거나 필수 검증이 실패·미실행이면 종료하지 않고 미충족 조건을 보고한다.
- 미완료 항목을 후속 이슈로 옮겨 수용 조건을 줄이는 판단은 자동으로 하지 않는다.
- 이번 작업과 무관한 이슈는 종료하지 않는다.
- 댓글·종료·확인이 실패하면 완료한 작업과 실패한 GitHub 처리를 나눠 보고한다.

## Conventions

- **Create an issue**: `gh issue create --title "..." --body-file <파일>`. 여러 줄 본문은 파일로 넘긴다.
- **Read an issue**: `gh issue view <number> --comments`
- **List issues**: `gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`. `--label`, `--state`로 거른다.
- **Comment on an issue**: `gh issue comment <number> --body-file <파일>`
- **Apply / remove labels**: `gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --reason completed`

저장소는 `git remote -v`에서 추론한다. clone 안에서 실행하는 `gh`는 현재 remote를 쓴다.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(외부 PR을 기능 요청으로 다루면 `yes`로 바꾼다. `/triage`가 이 값을 읽는다.)_

`yes`일 때 PR은 이슈와 같은 라벨·상태로 처리한다. `gh pr` 명령을 쓴다.

- **Read a PR**: `gh pr view <number> --comments`, 변경은 `gh pr diff <number>`
- **List external PRs for triage**: `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments` 결과에서 `authorAssociation`이 `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, `NONE`인 것만 남긴다.
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`

이슈와 PR은 번호 공간을 공유한다. `#42`가 무엇인지 모르면 `gh pr view 42`로 확인하고, 없으면 `gh issue view 42`를 쓴다.

## When a skill says "publish to the issue tracker"

GitHub 이슈를 만든다. 위 "게시 승인"의 지시 조건을 따른다.

## When a skill says "fetch the relevant ticket"

`gh issue view <number> --comments`를 실행한다.
