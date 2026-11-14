# Architecture and advanced configuration

See [English setup](../README.md) / [日本語の導入手順](../README_ja.md) first. The public identity is `@ten9miq/upnote-mcp-win`; tool names and `UPNOTE_*` variables retain compatibility with existing registrations.

## CDP save sequence

1. Discover the UpNote main renderer at a literal loopback HTTP origin. Validate the UpNote identity, returned WebSocket destination and expected renderer path; refuse open pop-out note windows.
2. Check the profile/database path, app/workspace/note locks, loaded state, navigation/selection capabilities, unsaved-input state and target note values. SQLite checks require the stored `notes` columns with compatible affinities and unique note IDs; extra columns and equivalent declarations are accepted.
3. Match the caller's full-row `expectedVersion`, prepare the candidate HTML, enforce the UTF-8 size ceiling and perform native preflight. Partial batches resolve all ranges against the same original snapshot and reject overlapping ranges.
4. Acquire a short SQLite writer reservation, recheck schema/version and archive the complete target row read in that transaction. Write it to a separate `note.sqlite3`, reopen it to check integrity/exact row equality, and flush it. Roll back the source reservation; no UpNote note row or sync flag was changed.
5. Call the app's internal `coreStore.updateNotes` action and navigation/selection actions over CDP. Recheck guards after awaited navigation. The app owns persistence, revisions, UI state and cloud sync.
6. Read back the saved data, compare the editor and wait for a fresh sync acknowledgement. Partial editing additionally compares the complete saved HTML with the exact source-spliced plan.

The server exposes fixed editing/status operations, not arbitrary JavaScript or SQL execution. Nevertheless, CDP itself is a powerful local debugger and must stay on a trusted machine's loopback interface.

## Environment variables

| Variable | Meaning / default |
| --- | --- |
| `UPNOTE_DB` | Absolute SQLite path. Default `%APPDATA%\UpNote\upnote.sqlite3` on Windows. |
| `UPNOTE_BACKUPS_DIR` | Per-note archive folder; default `MCP Backups` beside the database. No automatic retention cleanup. |
| `UPNOTE_CDP_URL` | Opt-in local origin, e.g. `http://127.0.0.1:19330`. Omit for local search / URL creation. |
| `UPNOTE_AUTO_START` | `1` enables background app preparation and bounded discovery/readiness recovery; default off. |
| `UPNOTE_AUTO_START_LAUNCHER` | Installed Store launcher; default `%LOCALAPPDATA%\UpNoteMcp\launch.ps1`. Install templates as described in the README first. |

Changing the port requires matching launcher and MCP settings. The VBS everyday-shortcut example uses the default port; use the PowerShell launcher's `-Port` argument for a custom port. Automatic startup requires IPv4 loopback and a non-privileged port. The launcher is a separate installed copy: refresh it from the checkout when its code changes.

## Codex configuration

Example MCP TOML entry; replace every example path. This describes a local source checkout and installed launcher, not a registry package. Install the launcher before enabling `UPNOTE_AUTO_START`.

```toml
[mcp_servers.upnote-mcp-win]
command = 'C:\Users\YOUR_NAME\.bun\bin\bun.exe'
args = ['run', 'C:\path\to\upnote-mcp-win\src\index.ts']
startup_timeout_sec = 30
tool_timeout_sec = 90

[mcp_servers.upnote-mcp-win.env]
UPNOTE_DB = 'C:\Users\YOUR_NAME\AppData\Roaming\UpNote\upnote.sqlite3'
UPNOTE_CDP_URL = 'http://127.0.0.1:19330'
UPNOTE_AUTO_START = '1'
UPNOTE_AUTO_START_LAUNCHER = 'C:\Users\YOUR_NAME\AppData\Local\UpNoteMcp\launch.ps1'
```

Existing registrations such as `upnote-local` may keep their server key. Do not duplicate two registrations unintentionally. The server advertises tools before optional app preparation and opens the DB lazily. A startup failure does not remove search tools; later operations recheck availability. Concurrent requests share startup work within MCP; installed launchers use a per-user Windows mutex across processes. The app is never force-restarted to recover a connection.

## Results and recovery

| Result | Interpretation |
| --- | --- |
| `state: synced` | Saved content, editor and fresh app sync acknowledgement verified. Partial edits also require `htmlPreserved: true`. |
| `awaiting_sync` / `awaiting_ui` | App accepted the edit, but completion is not fully verified. Query status/context instead of resubmitting. |
| `applied: null` / `unavailable` | Transport/result uncertainty. The edit may already have applied. Inspect the current note and backup. |
| `conflict` | Saved content/state differs. Partial HTML rewriting also produces conflict even if the app saved/synced it. |

`cloudSync: app_acknowledged` comes from a new app-recorded `syncedAt` after the edit, not from an independent read of the remote service. `otherDeviceVerified` remains false. Full-body native verification checks normalized text/title and identity; partial verification additionally requires byte-for-byte planned HTML equality.

Backups now contain only the target note's complete row, rather than copying the full library on every edit. `MCP Backups/edit-…/note.sqlite3` contains a `notes` table with exactly one pre-edit row and a `mcp_backup_metadata` table (`format_version: 1`, `kind: upnote-note`, note ID/version, UTC time and source DB path). All stored note columns, including additive columns, HTML and attachment/tag references, are retained. Table constraints, triggers, indexes, other notes, notebook/tag definitions or membership lists in other tables, external attachment blobs and cloud state are not copied. The source writer reservation ensures the captured row/version stays unchanged until backup finishes; committed WAL data is visible through the source query as usual.

This is a recovery archive, **not a complete UpNote database**: never replace `upnote.sqlite3` with it. Inspect the saved row and apply a reviewed note-level recovery through the app; there is no automatic restore or mutation retry. Existing full-library backups are left in place, and new per-note archives are also retained until manually removed. Dry runs and no-op edits create no backup.

## Fallback workflows

### Direct SQLite editing (`update_note`)

Read `get_note`, then pass `id`, `expectedVersion`, `title` and/or `content`. `contentFormat` is `markdown` or `text`; `mode` is `replace` or `append`. Use `dryRun: true` to preview without backup/write. Normal writes require UpNote to be quit. They use a separate short-lived write connection, target-note row archive, transaction and post-write readback, preserving ID and creation time. See [per-note backups](note-backups.md) for the format and verification results.

`allowWhileRunning: true` is an explicit **experimental** override for a synced note. The app's memory cache may subsequently overwrite the DB change; a SQL lock does not prevent this. Direct writes do not run the app's save/sync action. Their results always leave cloud sync unverified. Prefer the CDP tools for live editing.

Body replacement refuses images/attachments; append keeps existing HTML. This path does not recalculate every UpNote index/metadata relationship and cannot guarantee complete round-tripping of custom decorations.

### Clipboard/editor fallback (Windows)

`prepare_app_note_edit` checks the version, creates the backup and stages UTF-8 CF_HTML plus text on the Windows clipboard. A separate computer-use client must open and verify the target, focus/select the editor and paste. `complete_app_note_edit` verifies matching title/text, identity and a new app sync timestamp. Preparation alone does not edit the note.

Tickets live for ten minutes in the same MCP process. This workflow overwrites the clipboard, requires an interactive app window and refuses attachment/image notes even for append. Do not repeat the paste automatically after a failure. This fallback is distinct from CDP editing, which needs no computer use, typing or clipboard.
