// 메시지함 플러그인 — 프로젝트별 메시지함. CLI/MCP/API 로 송신, 푸시(알림+소리+딥링크)로 수신.
// 데이터는 코어 app.data(SQLite, CJK 검색), 실시간은 app.data.watch(크로스윈도우, 폴링 0).
// '스스로 구독'하면 turn.ended(셸/유휴/ACP) 구독 → 턴 종료 시 기계적으로 메시지 생성.
// 코어/다른 플러그인에 종속 0 — 오픈 capability(data/notify/events)와 오픈 토픽(turn.ended)만 소비.
//
// [스코프] = 프로젝트 root(폴더 경로). projectId 는 창마다 달라(같은 폴더라도) 멀티창 일관성을
// 깨므로 스코프 키로 부적합 — root 가 창 무관 안정 식별자다. 같은 프로젝트를 여러 창에 열어도
// 같은 메일함(같은 scope)을 본다.

const COLL = "messages";
const ID = "soksak-plugin-mailbox";
const DEFAULT_SOUND = "default";

// 푸시 타입(카테고리) — 기본 표현. 우선순위: 메시지 override > 카테고리 > 전역 기본.
const PUSH_TYPES = {
  "agent-turn": { sound: "chime", icon: "🤖" },
  alert: { sound: "alert", icon: "⚠️" },
  reminder: { sound: "ping", icon: "⏰" },
  mention: { sound: "chime", icon: "💬" },
  info: { sound: "default", icon: "ℹ️" },
};

const CSS = [
  ".skmb-root{display:flex;flex-direction:column;height:100%;font-size:12px;color:var(--fg);}",
  ".skmb-head{height:var(--header-h,33px);box-sizing:border-box;display:flex;align-items:center;padding:0 8px;border-bottom:1px solid var(--bd-soft);}",
  ".skmb-search{width:100%;box-sizing:border-box;padding:4px 8px;border-radius:6px;border:1px solid var(--bd-soft);background:var(--inset);color:var(--fg);font-size:12px;}",
  ".skmb-list{flex:1;overflow-y:auto;padding:4px;}",
  ".skmb-empty{color:var(--fg2);padding:10px;text-align:center;}",
  ".skmb-row{display:flex;gap:6px;align-items:flex-start;padding:6px;border-radius:6px;cursor:pointer;}",
  ".skmb-row:hover{background:var(--inset);}",
  ".skmb-row.focus{outline:1px solid var(--acc);}",
  ".skmb-dot{flex:none;width:7px;height:7px;border-radius:999px;margin-top:5px;background:transparent;}",
  ".skmb-row.unread .skmb-dot{background:var(--acc);}",
  ".skmb-row.unread .skmb-title{font-weight:600;}",
  ".skmb-main{flex:1;min-width:0;}",
  ".skmb-title{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
  ".skmb-meta{font-size:10.5px;color:var(--fg3);margin-top:1px;}",
  ".skmb-body{font-size:11px;color:var(--fg2);margin-top:2px;white-space:pre-wrap;word-break:break-word;}",
  ".skmb-x{flex:none;border:0;background:none;padding:2px 5px;border-radius:4px;color:var(--fg3);cursor:pointer;}",
  ".skmb-x:hover{color:var(--fg);background:var(--bd);}",
].join("");

export default {
  activate(ctx) {
    const app = ctx.app;
    const sub = (d) => ctx.subscriptions.push(d);

    const mounts = new Set(); // 프로젝트(root)별 마운트된 인박스 뷰 — data 변경/딥링크 focus 라우팅
    const subs = new Map(); // root → { enabled, source, type } (자동 구독, kv 영속 + 캐시)
    const lastAuto = new Map(); // root → ts(자동 메시지 디바운스)

    const err = (code, message) => ({ ok: false, code, message });

    // ── i18n ─────────────────────────────────────────────────────────────────
    const I18N = {
      "search.placeholder": { en: "Search…",              ko: "검색…" },
      "empty.search":       { en: "No results",           ko: "검색 결과가 없습니다" },
      "empty.default":      { en: "No messages",          ko: "메시지가 없습니다" },
      "delete.title":       { en: "Delete",               ko: "삭제" },
    };
    const t = (k) => { const s = I18N[k]; const l = app.locale ? app.locale() : "ko"; return s ? (s[l] ?? s.en ?? s.ko) : k; };

    // 스코프(root) 해석 — 명시 인자(to/scope/root) 우선, 없으면 현재 프로젝트 root.
    // root 없는 프로젝트(P1상 드묾)는 id 폴백.
    const scopeArg = (p) =>
      (typeof p.to === "string" && p.to) ||
      (typeof p.scope === "string" && p.scope) ||
      (typeof p.root === "string" && p.root) ||
      app.project.current()?.root ||
      app.project.current()?.id ||
      null;

    const deepLinkFor = (id, scope) =>
      `soksak://cmd/plugin.${ID}.open?` +
      new URLSearchParams({ id, root: scope }).toString();

    // 메시지 생성(send + self-subscribe 공용). push 면 송신측 1회 알림+소리(재알림 금지).
    async function createMessage(p) {
      const scope = scopeArg(p);
      if (!scope) return err("INVALID_PARAMS", "프로젝트 없음 — to 지정 또는 프로젝트에서 실행");
      if (!p.title) return err("INVALID_PARAMS", "title 필요");
      const type = p.type === "push" || p.type === "event" ? p.type : "info";
      const cat = (p.pushType && PUSH_TYPES[p.pushType]) || {};
      const sound = p.sound ?? cat.sound ?? DEFAULT_SOUND;
      const icon = p.icon ?? cat.icon;
      const rec = {
        from: typeof p.from === "string" ? p.from : "api",
        type,
        pushType: typeof p.pushType === "string" ? p.pushType : undefined,
        title: String(p.title),
        body: p.body != null ? String(p.body) : undefined,
        sound,
        icon,
        image: typeof p.image === "string" ? p.image : undefined,
        deepLink: typeof p.deepLink === "string" ? p.deepLink : undefined,
        data: p.data,
        read: false,
        createdAt: Date.now(),
        source: typeof p.source === "string" ? p.source : "command",
      };
      const id = await app.data.put(COLL, rec, { scope });
      // 발행: 외부 구독자(다른 플러그인/코어)용 이벤트 채널(창-로컬 bus). 자기 UI 는 data.watch 사용.
      app.bus.emit("mailbox.message", { id, scope, type, from: rec.from, title: rec.title, pushType: rec.pushType });
      if (type === "push" && app.notify) {
        await app.notify.push({
          title: rec.title,
          body: rec.body,
          icon,
          image: rec.image,
          sound,
          deepLink: rec.deepLink || deepLinkFor(id, scope),
          tag: `mailbox-${id}`,
        });
      }
      // 반환 키는 messageId — top-level "id" 는 JSON-RPC 응답 봉투의 요청 id 와 충돌(코어 컨벤션:
      // 커맨드는 bare "id" 를 반환하지 않는다 — groupId/viewId/label 식).
      return { ok: true, messageId: id, scope };
    }

    async function markRead(scope, id) {
      const rec = await app.data.get(COLL, id, { scope: scope ?? undefined });
      if (rec && !rec.read) {
        await app.data.put(COLL, { ...rec, read: true }, { scope: scope ?? undefined, id });
        app.bus.emit("mailbox.read", { id, scope });
      }
    }

    // ── 커맨드(전부 CLI/MCP/API 노출) ──
    sub(
      app.commands.register("send", {
        description:
          "Send a message to a mailbox (type: info|push|event). push triggers OS/in-app notification with sound and deep link. to=target project root (default: current).",
        triggers: { ko: "메시지 보내기 쪽지 보내기 알림 전송 메일 발송" },
        params: {
          title: { type: "string", required: true, description: "제목" },
          body: { type: "string", description: "본문" },
          type: { type: "string", description: "info|push|event(기본 info)" },
          pushType: { type: "string", description: "agent-turn|alert|reminder|mention|info" },
          to: { type: "string", description: "대상 프로젝트 root(기본 현재)" },
          sound: { type: "string", description: "내장 default/ping/chime/success/alert 또는 경로" },
          image: { type: "string", description: "이미지 URL/경로" },
          deepLink: { type: "string", description: "클릭 시 딥링크(기본 이 메시지 열기)" },
          from: { type: "string", description: "발신자 표시" },
          data: { type: "json", description: "임의 페이로드" },
        },
        returns: "{ messageId, scope }",
        message: (d) => "메시지를 보냈습니다",
        examples: [
          'sok plugin.soksak-plugin-mailbox.send \'{"title":"빌드 완료","type":"push","pushType":"alert"}\'',
        ],
        handler: (p) => createMessage(p),
      }),
    );

    sub(
      app.commands.register("list", {
        description: "List messages in a mailbox (newest first). scope=project root (default: current). Set unread=true to return only unread messages.",
        triggers: { ko: "메시지 목록 읽지 않은 메시지 메일함 조회 받은 편지함" },
        params: {
          scope: { type: "string", description: "프로젝트 root(기본 현재)" },
          unread: { type: "boolean", description: "안 읽은 것만" },
          limit: { type: "number", description: "최대 건수(기본 100)" },
          offset: { type: "number", description: "페이지네이션" },
        },
        returns: "{ messages }",
        message: (d) => `${(d.messages ?? []).length}개`,
        examples: ["sok plugin.soksak-plugin-mailbox.list"],
        handler: async (p) => {
          const scope = scopeArg(p);
          if (!scope) return err("INVALID_PARAMS", "프로젝트 없음");
          const messages = await app.data.query(COLL, {
            scope,
            where: p.unread ? { read: false } : undefined,
            order: "createdAt",
            desc: true,
            limit: typeof p.limit === "number" ? p.limit : 100,
            offset: typeof p.offset === "number" ? p.offset : undefined,
          });
          return { messages };
        },
      }),
    );

    sub(
      app.commands.register("search", {
        description: "Full-text search messages (title and body, CJK-aware). scope=project root (default: current).",
        triggers: { ko: "메시지 검색 쪽지 찾기 메일 검색" },
        params: {
          query: { type: "string", required: true, description: "검색어" },
          scope: { type: "string", description: "프로젝트 root(기본 현재)" },
          limit: { type: "number", description: "최대 건수(기본 50)" },
        },
        returns: "{ messages }",
        message: (d) => `${(d.messages ?? []).length}개`,
        examples: ['sok plugin.soksak-plugin-mailbox.search \'{"query":"빌드 실패"}\''],
        handler: async (p) => {
          const scope = scopeArg(p);
          if (!scope) return err("INVALID_PARAMS", "프로젝트 없음");
          if (typeof p.query !== "string") return err("INVALID_PARAMS", "query 필요");
          const messages = await app.data.search(COLL, p.query, {
            scope,
            limit: typeof p.limit === "number" ? p.limit : undefined,
          });
          return { messages };
        },
      }),
    );

    sub(
      app.commands.register("get", {
        description: "Fetch a single message by id.",
        triggers: { ko: "메시지 조회 쪽지 읽기 메일 가져오기" },
        params: {
          id: { type: "string", required: true, description: "메시지 id" },
          scope: { type: "string", description: "프로젝트 root" },
        },
        returns: "{ message }",
        message: (d) => d.message?.title ? `메시지를 가져왔습니다: ${d.message.title}` : "메시지를 가져왔습니다",
        handler: async (p) => {
          if (typeof p.id !== "string") return err("INVALID_PARAMS", "id 필요");
          const message = await app.data.get(COLL, p.id, {
            scope: scopeArg(p) ?? undefined,
          });
          if (!message) return err("TARGET_NOT_FOUND", "메시지 없음");
          return { message };
        },
      }),
    );

    sub(
      app.commands.register("open", {
        description: "Deep-link target — switch to the project, open the inbox view, scroll to the message, and mark it as read.",
        triggers: { ko: "메시지 열기 딥링크 인박스 열기 메일 보기" },
        params: {
          id: { type: "string", required: true, description: "메시지 id" },
          root: { type: "string", description: "프로젝트 root(스코프)" },
        },
        returns: "{ ok }",
        message: (d) => "메시지를 열었습니다",
        handler: async (p) => {
          if (typeof p.id !== "string") return err("INVALID_PARAMS", "id 필요");
          const scope = (typeof p.root === "string" && p.root) || app.project.current()?.root || null;
          // 이 창에서 그 root 의 프로젝트 탭을 찾아 전환(projectId 는 창-로컬).
          if (scope) {
            try {
              const r = await app.commands.execute("project.list");
              if (r.ok) {
                const proj = (r.projects || []).find((x) => x.root === scope);
                if (proj) await app.commands.execute("project.activate", { project: proj.id });
              }
            } catch (e) {
              console.warn("[mailbox] 프로젝트 전환 실패:", e);
            }
          }
          try {
            await app.ui.openView("inbox", "sidebar-left");
          } catch (e) {
            console.warn("[mailbox] openView 실패:", e);
          }
          await markRead(scope, p.id);
          for (const m of mounts) if (m.scope === scope) m.focus(p.id);
          return { ok: true };
        },
      }),
    );

    sub(
      app.commands.register("mark-read", {
        description: "Mark a message as read. Provide id for a single message or all=true to mark all messages in the scope.",
        triggers: { ko: "읽음 표시 전체 읽음 메시지 확인 안 읽은 메시지 처리" },
        params: {
          id: { type: "string", description: "메시지 id" },
          all: { type: "boolean", description: "scope 전체 읽음" },
          scope: { type: "string", description: "프로젝트 root(기본 현재)" },
        },
        returns: "{ marked }",
        message: (d) => `${d.marked}개를 읽음 표시했습니다`,
        handler: async (p) => {
          const scope = scopeArg(p);
          if (p.all) {
            const unread = await app.data.query(COLL, {
              scope,
              where: { read: false },
              limit: 5000,
            });
            for (const m of unread)
              await app.data.put(COLL, { ...m, read: true }, { scope, id: m.id });
            return { marked: unread.length };
          }
          if (typeof p.id !== "string") return err("INVALID_PARAMS", "id 또는 all 필요");
          await markRead(scope, p.id);
          return { marked: 1 };
        },
      }),
    );

    sub(
      app.commands.register("delete", {
        description: "Delete a message by id.",
        triggers: { ko: "메시지 삭제 쪽지 지우기 메일 삭제" },
        danger: "destructive",
        params: {
          id: { type: "string", required: true, description: "메시지 id" },
          scope: { type: "string", description: "프로젝트 root" },
        },
        returns: "{ deleted }",
        message: (d) => "메시지를 삭제했습니다",
        handler: async (p) => {
          if (typeof p.id !== "string") return err("INVALID_PARAMS", "id 필요");
          const deleted = await app.data.delete(COLL, p.id, {
            scope: scopeArg(p) ?? undefined,
          });
          return { deleted };
        },
      }),
    );

    sub(
      app.commands.register("clear", {
        description: "Delete all messages in the project mailbox. Use with caution — this is irreversible.",
        triggers: { ko: "메시지 전체 삭제 메일함 비우기 받은 편지함 초기화" },
        danger: "destructive",
        params: { scope: { type: "string", description: "프로젝트 root(기본 현재)" } },
        returns: "{ deleted }",
        message: (d) => `${d.deleted}개를 삭제했습니다`,
        handler: async (p) => {
          const scope = scopeArg(p);
          if (!scope) return err("INVALID_PARAMS", "프로젝트 없음");
          const all = await app.data.query(COLL, { scope, limit: 100000 });
          for (const m of all) await app.data.delete(COLL, m.id, { scope });
          return { deleted: all.length };
        },
      }),
    );

    // ── 자동 구독(turn.ended → 자동 메시지) ──
    const subKey = (scope) => `subscribe:${scope}`;

    sub(
      app.commands.register("subscribe", {
        description:
          "Enable auto-subscription — creates a message automatically when a turn ends. source=shell|idle|acp|all (default shell), type=push|info.",
        triggers: { ko: "자동 구독 켜기 턴 종료 알림 설정 자동 메시지 활성화" },
        params: {
          scope: { type: "string", description: "프로젝트 root(기본 현재)" },
          source: { type: "string", description: "shell|idle|acp|all(기본 shell)" },
          type: { type: "string", description: "생성 메시지 타입 push|info(기본 push)" },
        },
        returns: "{ scope, source }",
        message: (d) => `자동 구독을 켰습니다 (${d.source})`,
        handler: async (p) => {
          const scope = scopeArg(p);
          if (!scope) return err("INVALID_PARAMS", "프로젝트 없음");
          const source = ["shell", "idle", "acp", "all"].includes(p.source) ? p.source : "shell";
          const cfg = { enabled: true, source, type: p.type === "info" ? "info" : "push" };
          await app.data.kv.set(subKey(scope), cfg);
          subs.set(scope, cfg);
          if (source === "idle" || source === "all") {
            try {
              await app.commands.execute("turn.idleDetection", { enabled: true });
            } catch (e) {
              console.warn("[mailbox] idle 감지 켜기 실패:", e);
            }
          }
          return { scope, source };
        },
      }),
    );

    sub(
      app.commands.register("unsubscribe", {
        description: "Disable auto-subscription for the project mailbox.",
        triggers: { ko: "자동 구독 끄기 턴 종료 알림 해제 자동 메시지 비활성화" },
        params: { scope: { type: "string", description: "프로젝트 root(기본 현재)" } },
        returns: "{ scope }",
        message: (d) => "자동 구독을 껐습니다",
        handler: async (p) => {
          const scope = scopeArg(p);
          if (!scope) return err("INVALID_PARAMS", "프로젝트 없음");
          await app.data.kv.delete(subKey(scope));
          subs.delete(scope);
          return { scope };
        },
      }),
    );

    sub(
      app.commands.register("subscriptions", {
        description: "List all active auto-subscriptions.",
        triggers: { ko: "구독 목록 자동 구독 현황 메시지 구독 조회" },
        params: {},
        returns: "{ subscriptions }",
        message: (d) => `${(d.subscriptions ?? []).length}개`,
        handler: () => ({
          subscriptions: [...subs.entries()].map(([scope, cfg]) => ({ scope, ...cfg })),
        }),
      }),
    );

    // turn.ended → 구독 프로젝트(root)에 자동 메시지(디바운스로 중복 억제). terminal:read 권한 게이트.
    sub(
      app.events.on("turn.ended", (ev) => {
        const scope = ev.root;
        if (!scope) return;
        const cfg = subs.get(scope);
        if (!cfg || !cfg.enabled) return;
        if (cfg.source !== "all" && ev.source !== cfg.source) return;
        const now = Date.now();
        if (now - (lastAuto.get(scope) || 0) < 1500) return;
        lastAuto.set(scope, now);
        // 본문 = 끝난 명령(+cwd) 우선 — 사람이 읽을 수 있게. 없으면 생략(pane id 같은 내부값 미노출).
        let body;
        if (ev.command) body = ev.cwd ? `${ev.command}  ·  ${ev.cwd}` : ev.command;
        else if (ev.cwd) body = ev.cwd;
        void createMessage({
          to: scope,
          type: cfg.type || "push",
          pushType: "agent-turn",
          from: `turn:${ev.source}`,
          title: `턴 종료 (${ev.source})`,
          body,
          source: "turn",
        });
      }),
    );

    // ── 백업/이식(코어 data.* 위임, 이 네임스페이스 한정) ──
    sub(
      app.commands.register("export", {
        description: "Export all mailbox data as JSONL for backup.",
        triggers: { ko: "메일함 내보내기 데이터 백업 메시지 추출" },
        params: {},
        returns: "{ jsonl }",
        message: (d) => "메일함을 내보냈습니다",
        handler: async () => {
          const r = await app.commands.execute("data.export", { ns: ID });
          if (!r.ok) return err("INTERNAL", r.message || "export 실패");
          return { jsonl: r.jsonl };
        },
      }),
    );

    sub(
      app.commands.register("import", {
        description: "Import mailbox data from JSONL (output of export). Existing records are overwritten by id.",
        triggers: { ko: "메일함 가져오기 데이터 복원 메시지 임포트" },
        danger: "destructive",
        params: { jsonl: { type: "string", required: true, description: "data.export 출력" } },
        returns: "{ applied }",
        message: (d) => `${d.applied}개를 가져왔습니다`,
        handler: async (p) => {
          if (typeof p.jsonl !== "string") return err("INVALID_PARAMS", "jsonl 필요");
          const r = await app.commands.execute("data.import", { jsonl: p.jsonl });
          if (!r.ok) return err("INTERNAL", r.message || "import 실패");
          return { applied: r.applied };
        },
      }),
    );

    // ── 인박스 뷰(좌측 사이드바, 프로젝트별). 실시간 = app.data.watch(크로스윈도우). ──
    sub(
      app.ui.registerView("inbox", {
        mount(el, vctx) {
          // 스코프 = root(창 무관). root 없으면 projectId 폴백.
          const scope = vctx.root || vctx.projectId;
          el.textContent = "";
          const style = document.createElement("style");
          style.textContent = CSS;
          const root = document.createElement("div");
          root.className = "skmb-root";
          const head = document.createElement("div");
          head.className = "skmb-head";
          const searchInput = document.createElement("input");
          searchInput.className = "skmb-search";
          searchInput.type = "text";
          searchInput.placeholder = t("search.placeholder");
          searchInput.dataset.node = "search"; // 단일 요소 — 구조적 주소 노출(검색 입력)
          head.append(searchInput);
          const listEl = document.createElement("div");
          listEl.className = "skmb-list";
          root.append(head, listEl);
          el.append(style, root);

          let searchTerm = "";
          let focusId = null;
          let searchTimer = null;

          const fmtTime = (ts) => {
            try {
              return new Date(ts).toLocaleString();
            } catch {
              return "";
            }
          };

          // node path 안정키 정제 — 세그먼트 형식(^[a-z0-9][a-z0-9.-]*$)에 맞춤. 코어 자동 id
          // (013자리-pid-nanos)는 이미 부합하지만, import 로 들어온 임의 id(대문자/기호)도
          // 결정적으로 매핑(인덱스 대체 아님 — 멱등)되도록 소문자화·비허용문자 '-' 치환.
          const nodeKey = (id) => {
            const s = String(id).toLowerCase().replace(/[^a-z0-9.-]/g, "-");
            return /^[a-z0-9]/.test(s) ? s : "k-" + s;
          };

          const renderRows = (msgs) => {
            listEl.textContent = "";
            if (!msgs.length) {
              const empty = document.createElement("div");
              empty.className = "skmb-empty";
              empty.textContent = searchTerm ? t("empty.search") : t("empty.default");
              listEl.append(empty);
              return;
            }
            for (const m of msgs) {
              const key = nodeKey(m.id);
              const row = document.createElement("div");
              row.className =
                "skmb-row" + (m.read ? "" : " unread") + (m.id === focusId ? " focus" : "");
              row.dataset.node = "msg/" + key; // 동적 목록 — 안정키=메시지 id(읽음 클릭 대상)
              const dot = document.createElement("span");
              dot.className = "skmb-dot";
              const main = document.createElement("div");
              main.className = "skmb-main";
              const title = document.createElement("div");
              title.className = "skmb-title";
              title.textContent = (m.icon ? m.icon + " " : "") + (m.title || "");
              const meta = document.createElement("div");
              meta.className = "skmb-meta";
              meta.textContent = `${m.from || ""} · ${fmtTime(m.createdAt)}`;
              main.append(title, meta);
              if (m.body) {
                const body = document.createElement("div");
                body.className = "skmb-body";
                body.textContent = m.body;
                main.append(body);
              }
              const x = document.createElement("button");
              x.className = "skmb-x";
              x.textContent = "✕";
              x.title = t("delete.title");
              x.dataset.node = "del/" + key; // 동적 목록 — 안정키=메시지 id(삭제 클릭 대상)
              row.append(dot, main, x);
              row.addEventListener("click", () => {
                void markRead(scope, m.id);
              });
              x.addEventListener("click", (ev) => {
                ev.stopPropagation();
                void app.data.delete(COLL, m.id, { scope });
              });
              listEl.append(row);
            }
          };

          const refresh = async () => {
            try {
              const msgs = searchTerm
                ? await app.data.search(COLL, searchTerm, { scope, limit: 100 })
                : await app.data.query(COLL, {
                    scope,
                    order: "createdAt",
                    desc: true,
                    limit: 200,
                  });
              renderRows(msgs);
              if (focusId) {
                const idx = msgs.findIndex((m) => m.id === focusId);
                if (idx >= 0 && listEl.children[idx])
                  listEl.children[idx].scrollIntoView({ block: "nearest" });
              }
              const unread = await app.data.count(COLL, { scope, where: { read: false } });
              vctx.setBadge(unread);
            } catch (e) {
              console.warn("[mailbox] refresh 실패:", e);
            }
          };

          searchInput.addEventListener("input", () => {
            searchTerm = searchInput.value.trim();
            if (searchTimer) clearTimeout(searchTimer);
            searchTimer = setTimeout(() => void refresh(), 180);
          });

          const entry = {
            scope,
            refresh,
            focus: (id) => {
              focusId = id;
              void refresh();
            },
          };
          mounts.add(entry);
          el.__skmbEntry = entry;
          void refresh();
        },
        unmount(el) {
          if (el.__skmbEntry) {
            mounts.delete(el.__skmbEntry);
            el.__skmbEntry = null;
          }
          el.textContent = "";
        },
      }),
    );

    // 데이터 변경 → 해당 프로젝트(root) 뷰만 재질의(전 창 — 같은 프로젝트 다중 창 일관, 폴링 0).
    sub(
      app.data.watch(COLL, undefined, (e) => {
        for (const m of mounts) if (m.scope === e.scope) void m.refresh();
      }),
    );
    // 로케일 변경 → 마운트된 모든 인박스 뷰 재렌더(라벨·placeholder·빈상태 문자열 갱신).
    sub(app.events.on("locale.changed", () => { for (const m of mounts) { try { m && m.refresh && m.refresh(); } catch {} } }));

    // 컬렉션 정의(멱등) 후 저장된 자동 구독 로드.
    void (async () => {
      try {
        await app.data.define(COLL, {
          indexes: ["read", "type", "createdAt", "from"],
          fts: ["title", "body"],
        });
        const keys = await app.data.kv.keys("subscribe:");
        let needIdle = false;
        for (const k of keys) {
          const cfg = await app.data.kv.get(k);
          if (cfg && cfg.enabled) {
            const scope = k.slice("subscribe:".length);
            subs.set(scope, cfg);
            if (cfg.source === "idle" || cfg.source === "all") needIdle = true;
          }
        }
        if (needIdle) {
          try {
            await app.commands.execute("turn.idleDetection", { enabled: true });
          } catch {
            /* idle 감지 켜기 실패는 무시 — shell/acp 구독은 영향 없음 */
          }
        }
        for (const m of mounts) void m.refresh();
      } catch (e) {
        console.error("[mailbox] 초기화 실패:", e);
      }
    })();
  },

  deactivate() {
    // 등록물·구독은 ctx.subscriptions/호스트 tracker 가 자동 해제.
  },
};
