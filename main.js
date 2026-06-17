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
  ".skmb-head{padding:6px 8px;border-bottom:1px solid var(--bd-soft);}",
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
          "메시지 전송(type: info|push|event). push 면 OS/인앱 알림+소리+딥링크. to=대상 프로젝트 root(기본 현재)",
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
        examples: [
          'sok plugin.soksak-plugin-mailbox.send \'{"title":"빌드 완료","type":"push","pushType":"alert"}\'',
        ],
        handler: (p) => createMessage(p),
      }),
    );

    sub(
      app.commands.register("list", {
        description: "메시지 목록(최신순). scope=프로젝트 root(기본 현재), unread=true 면 안 읽은 것만",
        params: {
          scope: { type: "string", description: "프로젝트 root(기본 현재)" },
          unread: { type: "boolean", description: "안 읽은 것만" },
          limit: { type: "number", description: "최대 건수(기본 100)" },
          offset: { type: "number", description: "페이지네이션" },
        },
        returns: "{ messages }",
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
        description: "메시지 CJK 전문검색(제목/본문). scope=프로젝트 root(기본 현재)",
        params: {
          query: { type: "string", required: true, description: "검색어" },
          scope: { type: "string", description: "프로젝트 root(기본 현재)" },
          limit: { type: "number", description: "최대 건수(기본 50)" },
        },
        returns: "{ messages }",
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
        description: "메시지 1개 조회",
        params: {
          id: { type: "string", required: true, description: "메시지 id" },
          scope: { type: "string", description: "프로젝트 root" },
        },
        returns: "{ message }",
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
        description: "딥링크 타깃 — 해당 프로젝트로 전환·인박스 열기·메시지로 스크롤·읽음 표시",
        params: {
          id: { type: "string", required: true, description: "메시지 id" },
          root: { type: "string", description: "프로젝트 root(스코프)" },
        },
        returns: "{ ok }",
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
        description: "읽음 표시. id 지정 또는 all=true(scope 전체)",
        params: {
          id: { type: "string", description: "메시지 id" },
          all: { type: "boolean", description: "scope 전체 읽음" },
          scope: { type: "string", description: "프로젝트 root(기본 현재)" },
        },
        returns: "{ marked }",
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
        description: "메시지 삭제",
        danger: "destructive",
        params: {
          id: { type: "string", required: true, description: "메시지 id" },
          scope: { type: "string", description: "프로젝트 root" },
        },
        returns: "{ deleted }",
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
        description: "프로젝트 메시지 전부 삭제",
        danger: "destructive",
        params: { scope: { type: "string", description: "프로젝트 root(기본 현재)" } },
        returns: "{ deleted }",
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
          "자동 구독 켜기 — 턴 종료 시 메시지 자동 생성. source=shell|idle|acp|all(기본 shell), type=push|info",
        params: {
          scope: { type: "string", description: "프로젝트 root(기본 현재)" },
          source: { type: "string", description: "shell|idle|acp|all(기본 shell)" },
          type: { type: "string", description: "생성 메시지 타입 push|info(기본 push)" },
        },
        returns: "{ scope, source }",
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
        description: "자동 구독 끄기",
        params: { scope: { type: "string", description: "프로젝트 root(기본 현재)" } },
        returns: "{ scope }",
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
        description: "자동 구독 목록",
        params: {},
        returns: "{ subscriptions }",
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
        description: "이 메일함 데이터 JSONL 내보내기(백업)",
        params: {},
        returns: "{ jsonl }",
        handler: async () => {
          const r = await app.commands.execute("data.export", { ns: ID });
          if (!r.ok) return err("INTERNAL", r.message || "export 실패");
          return { jsonl: r.jsonl };
        },
      }),
    );

    sub(
      app.commands.register("import", {
        description: "JSONL 메일함 데이터 가져오기",
        danger: "destructive",
        params: { jsonl: { type: "string", required: true, description: "data.export 출력" } },
        returns: "{ applied }",
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
          searchInput.placeholder = "검색…";
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

          const renderRows = (msgs) => {
            listEl.textContent = "";
            if (!msgs.length) {
              const empty = document.createElement("div");
              empty.className = "skmb-empty";
              empty.textContent = searchTerm ? "검색 결과 없음" : "메시지 없음";
              listEl.append(empty);
              return;
            }
            for (const m of msgs) {
              const row = document.createElement("div");
              row.className =
                "skmb-row" + (m.read ? "" : " unread") + (m.id === focusId ? " focus" : "");
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
              x.title = "삭제";
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
