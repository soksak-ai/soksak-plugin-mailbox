# soksak-plugin-mailbox

프로젝트별 메시지함. CLI/MCP/API 로 메시지를 보내고 푸시 알림으로 받는다. 좌측 사이드바 탭에 읽지않음 수가 표시되고, 같은 프로젝트가 여러 창에 열려 있어도 실시간으로 동기화된다(폴링 없음).

## 기능

- **프로젝트 단위 메시지함** — 메시지는 프로젝트(scope) 별로 분리 저장.
- **실시간** — 코어 데이터 변경 브로드캐스트(`app.data.watch`) 기반. 폴링 없음. 멀티 창 일관.
- **CJK 검색** — 제목/본문 전문검색(코어 FTS5 trigram).
- **메시지 타입** — `info`(일반) / `push`(OS·인앱 알림+소리+딥링크) / `event`(기계).
- **푸시** — `pushType`(agent-turn/alert/reminder/mention/info) 별 기본 소리·아이콘, 메시지별 override. 클릭 시 그 메시지로 이동(딥링크).
- **스스로 구독** — 켜면 턴 종료(`turn.ended`: 셸/유휴/ACP) 시 메시지를 자동 생성.

## 커맨드 (모두 CLI/MCP/API 노출 — `plugin.soksak-plugin-mailbox.<name>`)

| 커맨드 | 설명 |
|---|---|
| `send` | 메시지 전송(`type`, `pushType`, `to`, `sound`, `image`, `deepLink`, …) |
| `list` | 목록(최신순, `unread`) |
| `search` | CJK 전문검색 |
| `get` | 1개 조회 |
| `open` | 딥링크 타깃 — 프로젝트 전환·인박스 열기·스크롤·읽음 |
| `mark-read` | 읽음(`id` 또는 `all`) |
| `delete` / `clear` | 삭제 / 프로젝트 전체 비우기 |
| `subscribe` / `unsubscribe` / `subscriptions` | 자동 구독(턴 종료) 토글·목록 |
| `export` / `import` | JSONL 백업·복원(이 네임스페이스) |

### 예시

```bash
sok plugin.soksak-plugin-mailbox.send '{"title":"빌드 완료","type":"push","pushType":"alert"}'
sok plugin.soksak-plugin-mailbox.list
sok plugin.soksak-plugin-mailbox.search '{"query":"빌드 실패"}'
sok plugin.soksak-plugin-mailbox.subscribe '{"source":"shell"}'
```

## 권한

`ui`, `commands`, `commands:destructive`, `data`, `notify`, `terminal:read`.

## 요구 코어 capability

`app.data`(임베디드 DB) · `app.notify`/`app.sound`(알림·소리) · `turn.ended` 오픈 토픽 · 뷰 배지. 특정 플러그인에는 종속되지 않는다.

## DOM 노출 (구조적 주소)

호스트가 임의 CSS selector 대신 구조적 path 주소로 DOM 에 접근한다. 인박스 뷰에서 외부(주소 클릭/측정·E2E)에 노출하는 요소는 `contributes.nodes` 에 종류를 선언하고 실제 요소에 `data-node` 속성을 부여한다(미선언·미부여 요소는 접근 불가). 절대 주소는 `…/view/soksak-plugin-mailbox.inbox/node/<data-node>`.

| 노드 | data-node | 설명 |
|---|---|---|
| `search` | `search` | 검색 입력 필드 |
| `msg` | `msg/<메시지id>` | 메시지 행(클릭 시 읽음 표시) — 안정키 = 메시지 id |
| `del` | `del/<메시지id>` | 메시지 삭제 버튼 — 안정키 = 메시지 id |

동적 목록(메시지 행·삭제 버튼)의 안정키는 메시지 id 다(카운터 인덱스 아님 — 같은 메시지는 항상 같은 주소). id 가 path 형식(소문자·영숫자·`.`·`-`)에 안 맞으면 결정적으로 정제한다.
