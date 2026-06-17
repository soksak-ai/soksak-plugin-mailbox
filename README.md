# soksak-plugin-mailbox

A per-project message inbox. Send messages via CLI/MCP/API and receive them as push notifications. The unread count is shown on the left sidebar tab and stays in sync across multiple windows of the same project in real time (no polling).

## Features

- **Per-project inbox** — messages are stored separately by project (scope).
- **Real-time** — driven by core data change broadcast (`app.data.watch`). No polling. Consistent across multiple windows.
- **CJK search** — full-text search on title and body (core FTS5 trigram).
- **Message types** — `info` (general) / `push` (OS and in-app notification + sound + deep link) / `event` (machine).
- **Push** — default sound and icon per `pushType` (agent-turn/alert/reminder/mention/info), overridable per message. Click navigates to that message (deep link).
- **Self-subscribe** — when enabled, automatically creates a message on turn end (`turn.ended`: shell/idle/ACP).

## Commands (all exposed via CLI/MCP/API — `plugin.soksak-plugin-mailbox.<name>`)

| Command | Description |
|---|---|
| `send` | Send a message (`type`, `pushType`, `to`, `sound`, `image`, `deepLink`, …) |
| `list` | List messages (newest first, `unread`) |
| `search` | CJK full-text search |
| `get` | Retrieve a single message |
| `open` | Deep link target — switch project, open inbox, scroll, mark as read |
| `mark-read` | Mark as read (`id` or `all`) |
| `delete` / `clear` | Delete / clear entire project inbox |
| `subscribe` / `unsubscribe` / `subscriptions` | Toggle and list auto-subscribe (turn end) |
| `export` / `import` | JSONL backup and restore (this namespace) |

### Examples

```bash
sok plugin.soksak-plugin-mailbox.send '{"title":"Build complete","type":"push","pushType":"alert"}'
sok plugin.soksak-plugin-mailbox.list
sok plugin.soksak-plugin-mailbox.search '{"query":"build failed"}'
sok plugin.soksak-plugin-mailbox.subscribe '{"source":"shell"}'
```

## Permissions

`ui`, `commands`, `commands:destructive`, `data`, `notify`, `terminal:read`.

## Required Core Capabilities

`app.data` (embedded DB) · `app.notify`/`app.sound` (notifications and sound) · `turn.ended` open topic · view badge. No dependency on any specific plugin.

## DOM Exposure (Structural Addresses)

The host accesses the DOM via structural path addresses instead of arbitrary CSS selectors. Elements exposed from the inbox view to the outside (address clicks/measurements, E2E) are declared in `contributes.nodes` and have a `data-node` attribute on the actual element (undeclared or unattributed elements are not accessible). Absolute address: `…/view/soksak-plugin-mailbox.inbox/node/<data-node>`.

| Node | data-node | Description |
|---|---|---|
| `search` | `search` | Search input field |
| `msg` | `msg/<message-id>` | Message row (click marks as read) — stable key = message id |
| `del` | `del/<message-id>` | Message delete button — stable key = message id |

The stable key for dynamic list items (message rows, delete buttons) is the message id (not a counter index — the same message always has the same address). If the id does not conform to the path format (lowercase alphanumeric, `.`, `-`) it is deterministically normalised.
