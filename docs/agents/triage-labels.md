# Triage 라벨

스킬은 다섯 가지 표준 triage 역할을 쓴다. 이 문서는 각 역할을 이 저장소의 실제 라벨 문자열에 매핑한다.

| mattpocock/skills의 라벨 | 이 저장소의 라벨  | 의미                                          |
| ------------------------ | ----------------- | --------------------------------------------- |
| `needs-triage`           | `needs-triage`    | 관리자가 이슈를 검토해야 함                   |
| `needs-info`             | `needs-info`      | 제보자의 추가 정보를 기다리는 중              |
| `ready-for-agent`        | `ready-for-agent` | 명세가 완료되어 AFK 에이전트가 처리할 수 있음 |
| `ready-for-human`        | `ready-for-human` | 사람의 구현이 필요함                          |
| `wontfix`                | `wontfix`         | 처리하지 않기로 결정함                        |

스킬이 역할을 언급하면(예: "AFK 처리 가능 triage 라벨을 적용") 이 표에서 대응하는 라벨 문자열을 쓴다.

## 등록 상태

다섯 라벨 모두 `cp949/mailo`에 있다(2026-11-23 `gh label list` 확인). `wontfix`는 GitHub 기본 라벨이고 나머지 넷은 이 날 만들었다. 라벨이 지워졌거나 다른 저장소에 같은 세트를 만들 때는 아래 명령을 쓴다.

```bash
gh label create needs-triage    -c fbca04 -d "관리자가 이슈를 검토해야 함"
gh label create needs-info      -c d4c5f9 -d "제보자의 추가 정보를 기다리는 중"
gh label create ready-for-agent -c 0e8a16 -d "명세가 완료되어 AFK 에이전트가 처리할 수 있음"
gh label create ready-for-human -c 1d76db -d "사람의 구현이 필요함"
```

현재 상태는 `gh label list`로 확인한다. 라벨 이름이나 색을 바꾸면 위 표와 명령을 함께 고친다.
