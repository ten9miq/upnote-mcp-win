---
description: Use Bun instead of Node.js, npm, pnpm, or vite.
globs: "*.ts, *.tsx, *.html, *.css, *.js, *.jsx, package.json"
alwaysApply: false
---

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Default to using Bun instead of Node.js.

- Use `bun <file>` instead of `node <file>` or `ts-node <file>`
- Use `bun test` instead of `jest` or `vitest`
- Use `bun build <file.html|file.ts|file.css>` instead of `webpack` or `esbuild`
- Use `bun install` instead of `npm install` or `yarn install` or `pnpm install`
- Use `bun run <script>` instead of `npm run <script>` or `yarn run <script>` or `pnpm run <script>`
- Use `bunx <package> <command>` instead of `npx <package> <command>`
- Bun automatically loads .env, so don't use dotenv.

## APIs

- `Bun.serve()` supports WebSockets, HTTPS, and routes. Don't use `express`.
- `bun:sqlite` for SQLite. Don't use `better-sqlite3`.
- `Bun.redis` for Redis. Don't use `ioredis`.
- `Bun.sql` for Postgres. Don't use `pg` or `postgres.js`.
- `WebSocket` is built-in. Don't use `ws`.
- Prefer `Bun.file` over `node:fs`'s readFile/writeFile
- Bun.$`ls` instead of execa.

## Testing

Use `bun test` to run tests.

```ts#index.test.ts
import { test, expect } from "bun:test";

test("hello world", () => {
  expect(1).toBe(1);
});
```

## Frontend

Use HTML imports with `Bun.serve()`. Don't use `vite`. HTML imports fully support React, CSS, Tailwind.

Server:

```ts#index.ts
import index from "./index.html"

Bun.serve({
  routes: {
    "/": index,
    "/api/users/:id": {
      GET: (req) => {
        return new Response(JSON.stringify({ id: req.params.id }));
      },
    },
  },
  // optional websocket support
  websocket: {
    open: (ws) => {
      ws.send("Hello, world!");
    },
    message: (ws, message) => {
      ws.send(message);
    },
    close: (ws) => {
      // handle close
    }
  },
  development: {
    hmr: true,
    console: true,
  }
})
```

HTML files can import .tsx, .jsx or .js files directly and Bun's bundler will transpile & bundle automatically. `<link>` tags can point to stylesheets and Bun's CSS bundler will bundle.

```html#index.html
<html>
  <body>
    <h1>Hello, world!</h1>
    <script type="module" src="./frontend.tsx"></script>
  </body>
</html>
```

With the following `frontend.tsx`:

```tsx#frontend.tsx
import React from "react";
import { createRoot } from "react-dom/client";

// import .css files directly and it works
import './index.css';

const root = createRoot(document.body);

export default function Frontend() {
  return <h1>Hello, world!</h1>;
}

root.render(<Frontend />);
```

Then, run index.ts

```sh
bun --hot ./index.ts
```

For more information, read the Bun API docs in `node_modules/bun-types/docs/**.mdx`.

---

# Project-Specific Guidance (upnote-mcp)

## Overview

This project reads the local SQLite database used by UpNote and exposes MCP tools over `stdio`. Reads use `readonly: true, create: false`. This Windows fork explicitly supports `update_note`: the only direct-write path, using a separate short-lived connection, a verified full database snapshot before each edit, version checking and a transaction. Do not add unguarded writes or weaken backup/version checks. Live editing is an explicit experimental per-call option, never a claim of confirmed UI or cloud sync.

For MCP-only live editing use the opt-in `update_note_in_app` CDP bridge to call UpNote's native `coreStore.updateNotes` action. Preserve the version/profile/lock/unsaved-input/backup guards. Never expose arbitrary JS/SQL as an MCP tool. The app owns persistence, revision and sync flags. The launcher must refuse existing processes and never force-restart the user's app. Authenticated cloud verification is distinct from unsigned-in isolated tests; do not claim it from those tests.

`UPNOTE_AUTO_START=1` opts into background app preparation and bounded connection/readiness recovery. Never retry an edit request after disconnection or unknown results. The default launcher may reuse an already-connected app, but cannot force-restart a running app without CDP. Keep startup single-flight within MCP and mutex-protected across launcher processes. MCP tool advertisement must survive missing DB/startup failures; initialized repository instances can still use eager DB opening by default, while the MCP entry point uses deferred opening.

Gate native editing on required API/state capabilities, SQLite column affinities/unique note identity, and actual note value types. Do not reintroduce an app-version or schema-version allowlist; those numbers are diagnostic only. Recheck the schema on each call and before backup, and recheck app write guards after awaited navigation actions. Future labels passing simulated tests do not prove future app builds' semantics; preserve post-save content/DOM/sync verification and the no-auto-retry policy.

The fallback is `prepare_app_note_edit` plus a computer-use client's verified editor paste, then `complete_app_note_edit`. App-editor clipboard HTML must be explicit UTF-8 CF_HTML bytes, not a .NET ANSI string. Never manually set sync flags or claim independent other-device verification in either workflow.

## Commands

```bash
bun install          # Install dependencies
bun run start        # Start the MCP server over stdio
bun run dev          # Start with --watch
bun run check        # Run tsc --noEmit; this is the main verification gate
bun run smoke        # Execute repository methods via scripts/smoke.ts
```

- Run `bun run check` and `bun run test`. The full suite uses separate OS processes per file to avoid observed Bun 1.4.0/Windows shared-VM/native crashes. Do not skip/retry failed tests. Individual files may use `bun test ./src/name.test.ts`. Editing tests use temporary databases and must never mutate the user's real library. MCP integration testing needs process-list and loopback access.
- `bun run smoke` requires the user's real database and performs read-only inspection. Keep live-library editing tests separate and explicitly authorized.

## Architecture

Keep a strict two-layer boundary.

- [src/upnote.ts](src/upnote.ts) — `UpNoteRepository`. This is the only place that may touch SQL or `bun:sqlite`. Database path resolution, soft-delete filtering, and timestamp conversion also belong here.
- [src/index.ts](src/index.ts) — MCP server wiring (`registerTool`) and user-facing formatting helpers only. Do not write SQL here.
- [src/editing.ts](src/editing.ts) — pure edit preparation/version helpers and fail-closed process detection; no SQL. Use append mode to preserve existing attachment HTML. Do not automatically retry or restore a committed edit after a conflict.
- [src/clipboard.ts](src/clipboard.ts), [src/note-clipboard.ps1](src/note-clipboard.ps1) — clipboard data staging only, with no window/input automation. The computer-use client owns verified focus, selection, paste and visual checks.
- [src/native-bridge.ts](src/native-bridge.ts) — loopback-only CDP transport and fixed native app actions. Validate app identity/capabilities/database/locks, refuse unsaved input and pop-outs, never read credentials or patch the installed app. No SQL belongs here; calls go through the app's own `sqlPreload` read API and native store action.
- [src/compatibility.ts](src/compatibility.ts) — pure SQLite affinity/schema and shared note-value validation. Keep the note validator self-contained because it is serialized into the renderer alongside the fixed native action.
- [src/connection.ts](src/connection.ts) — connection-only recovery and opt-in background app startup. Retry only discovery/readiness, preserve profile/lock/API errors, dispose failed/probe sockets, and never wrap a mutation in retry logic.
- [src/partial-edit.ts](src/partial-edit.ts) — source-offset HTML edits, compact context and heading boundaries; no SQL. Resolve every operation against the same original snapshot, reject overlaps/ambiguous matches/protected-object deletion, and do not serialize untouched HTML. Partial MCP results must never echo the whole old/new note. Native saves verify exact planned HTML in addition to the usual text/UI/sync checks.

Reject final HTML over the conservative 1000000-byte UTF-8 ceiling before backup/write; UpNote's documented HTML cloud-sync limit is about 1 MB. Oversized notes may still be inspected or shrunk. Keep native save-request timeouts bounded and never retry a timed-out mutation.

When adding a feature, always follow this sequence: add a method to `UpNoteRepository`, then register a tool in `src/index.ts`.

## UpNote Database Facts

These are observed facts about the UpNote database and cannot be derived from files in this repository. They are required context when writing SQL.

- Tables in use: `notes`, `notebooks`, `tags`, `organizers`
- Always apply soft-delete filters. Use `deleted = 0 AND trashed = 0` for `notes`, and `deleted = 0 AND inactive = 0` for `notebooks` and `tags`
- `notes.tagLinks` is a JSON array containing tag **titles**, not tag IDs. Expand it with `json_each(tagLinks)` when matching. This is why `searchByTag` strips a leading `#` before matching the title
- Notebook-to-note relationships are resolved via `organizers.notebookId` and `organizers.noteId`
- Timestamps are millisecond epoch integers and must be converted to ISO strings through `formatTimestamp`

## Implementation Rules

- Search uses a simple `LIKE %query%` strategy across `title`, `text`, and `summary`. FTS is not used
- Clamp `limit` to `1..50` in both zod schemas and repository methods; do not rely on only one side
- Every tool should return `structuredContent` and include `dbPath`
- This project is intended for a global audience, so user-facing strings, tool descriptions, errors, and the main README should be written in English
- Commit messages should also be written in English
- Use `UPNOTE_DB` when provided; Windows defaults to `%APPDATA%/UpNote/upnote.sqlite3`, macOS to its existing container path

## Repository Notes

- `.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc` is a **symbolic link to this file (`CLAUDE.md`)**. Cursor reads the same content through that path. Do not remove or replace the Bun section at the top, or the Cursor rule will break
- The YAML frontmatter at the top of this file (`description`, `globs`, `alwaysApply`) is used by Cursor MDC and must remain at the very beginning of the file
- `.cursor/rules/` contains only that symlink. There are no separate Cursor rules in this repository, and there is no `.github/copilot-instructions.md`
