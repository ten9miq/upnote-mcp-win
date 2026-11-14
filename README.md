# upnote-mcp

`upnote-mcp` is an MCP server for reading local UpNote data from SQLite over stdio. This Windows fork also supports backed-up, in-place note edits.

This is an unofficial project and is not affiliated with, endorsed by, or maintained by UpNote.

## Features

- `search_notes`: search notes by title, body text, or summary
- `list_recent_notes`: list the most recently updated notes
- `list_notes_this_week`: list notes updated during the current week
- `list_notes_this_month`: list notes updated during the current month
- `find_notes`: combine period, keyword, and tag filters in one call
- `find_and_open_note`: find matching notes and open the most recent match in UpNote
- `open_note`: open a note in the UpNote app by note ID
- `get_note`: fetch the full contents of a note by note ID
- `open_notebook`: open a notebook in the UpNote app by notebook ID
- `list_notebooks`: list notebooks with note counts
- `create_note`: create a new note through UpNote's official URL scheme
- `update_note`: edit or append to an existing note without changing its ID, with an automatic database backup
- `prepare_app_note_edit`: back up and stage an app-native live edit on the Windows clipboard for a computer-use client
- `complete_app_note_edit`: verify the app saved the expected title/text under the original ID and acknowledged syncing it
- `update_note_in_app`: one MCP call to edit through UpNote's internal `coreStore.updateNotes` action, refresh its editor and await sync acknowledgement through opt-in local CDP (no Computer Use or clipboard)
- `get_upnote_bridge_status`: inspect the CDP bridge, target editor and sync metadata
- `ensure_upnote_connection`: prepare an available native connection, automatically starting a closed UpNote when enabled
- `get_note_edit_context`: compact version/size/sync metadata, paginated headings and targeted text/section excerpts
- `patch_note_in_app`: literal text replacement, section replacement/append and heading rename while preserving untouched source HTML
- `list_tags`: list tags
- `search_by_tag`: list notes for a tag

Search and retrieval use a read-only connection. Creation and open actions use UpNote's official URL scheme.
`update_note` is the explicit exception: it uses a separate, short-lived write connection, a full SQLite backup, and a transaction. See [Editing existing notes](#editing-existing-notes).

## Package Name

This package is prepared to be published as `@bellx2/upnote-mcp`.

## Requirements

- `macOS` or `Windows 10/11`
- `bun >= 1.3.0` installed on the machine that runs the server
- Markdown editing requires `bun >= 1.4.0`; plain-text editing can use the existing runtime requirement
- UpNote desktop app installed
- Default UpNote database paths:

```text
# macOS
~/Library/Containers/com.getupnote.desktop/Data/Library/Application Support/UpNote/upnote.sqlite3

# Windows
%APPDATA%\UpNote\upnote.sqlite3
```

If your database lives somewhere else, set `UPNOTE_DB`.

## Install

```bash
bun install
```

## Run

```bash
bun run start
```

For normal use, prefer the published package:

```bash
bunx @bellx2/upnote-mcp
```

or:

```bash
npx @bellx2/upnote-mcp
```

`npx` support still depends on `bun` being installed, because this package uses Bun-specific APIs such as `bun:sqlite`.

For development with file watching:

```bash
bun run dev
```

## Install via MCP Bundle (`.mcpb`)

For Claude Desktop on macOS, you can also install a prebuilt MCP Bundle instead of running `bunx`.

An `.mcpb` file is a zip archive containing a standalone MCP server and a `manifest.json`. Claude Desktop can install it with a double click, similar to a browser extension.

### Download

Tagged releases include an `.mcpb` asset on [GitHub Releases](https://github.com/bellx2/upnote-mcp/releases).

Example file name:

```text
upnote-mcp-0.2.7.mcpb
```

### Install in Claude Desktop

1. Download the `.mcpb` file from GitHub Releases
2. Double-click the file
3. Follow the Claude Desktop installation dialog
4. Optionally set the UpNote database path during setup. The default path works for the standard UpNote desktop app location

The bundle includes a compiled macOS binary, so Bun is not required for this install path.

### Build locally

To rebuild the bundle from source:

```bash
bun run build:mcpb
```

This creates `dist/upnote-mcp.mcpb`.

Release builds run on GitHub Actions (`macos-latest`) and are attached automatically when a `v*` tag is pushed.

## Environment Variables

- `UPNOTE_DB`: absolute path to `upnote.sqlite3`
- `UPNOTE_BACKUPS_DIR`: optional backup directory for edits; defaults to `MCP Backups` beside the database. Backups are retained until you remove them
- `UPNOTE_CDP_URL`: opt-in local origin for internal app editing, for example `http://127.0.0.1:19330`; only literal loopback HTTP origins are accepted
- `UPNOTE_AUTO_START`: `1` enables background preparation on MCP startup and connection recovery before native operations; default off
- `UPNOTE_AUTO_START_LAUNCHER`: optional absolute path to the installed Windows `launch.ps1`; defaults to `%LOCALAPPDATA%\UpNoteMcp\launch.ps1`

Example:

```bash
export UPNOTE_DB="$HOME/Library/Containers/com.getupnote.desktop/Data/Library/Application Support/UpNote/upnote.sqlite3"
```

Windows PowerShell:

```powershell
$env:UPNOTE_DB = "$env:APPDATA\UpNote\upnote.sqlite3"
```

## Permissions

On first run, your MCP client may show permission prompts for command execution and local file access.

This is expected because the server:

- launches through `bun`
- reads your local UpNote SQLite database
- may open the UpNote app for `open_note`, `open_notebook`, or `create_note`

If you deny these permissions, note search and retrieval will not work. After granting access, you may need to restart the MCP server in Cursor or Claude Desktop.

## MCP Config Example

### Recommended: published package

#### Cursor

```json
{
  "mcpServers": {
    "upnote": {
      "command": "bunx",
      "args": ["@bellx2/upnote-mcp"]
    }
  }
}
```

#### Claude Desktop

##### Option 1: MCP Bundle (recommended)

Download and install the `.mcpb` file from [GitHub Releases](https://github.com/bellx2/upnote-mcp/releases). No manual JSON editing is required.

##### Option 2: published package

```json
{
  "mcpServers": {
    "upnote": {
      "command": "bunx",
      "args": ["@bellx2/upnote-mcp"]
    }
  }
}
```

### Local development checkout

#### Cursor

```json
{
  "mcpServers": {
    "upnote": {
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/upnote-mcp/src/index.ts"]
    }
  }
}
```

#### Claude Desktop

```json
{
  "mcpServers": {
    "upnote": {
      "command": "/absolute/path/to/bun",
      "args": ["run", "/absolute/path/to/upnote-mcp/src/index.ts"]
    }
  }
}
```

#### Codex on Windows

Register the local checkout after running `bun install`. Use the absolute path to the installed Bun executable when Codex does not inherit the interactive shell `PATH`.

```powershell
codex mcp add upnote-local --env "UPNOTE_DB=$env:APPDATA\UpNote\upnote.sqlite3" -- "C:\Users\you\.bun\bin\bun.exe" run "C:\absolute\path\to\upnote-mcp\src\index.ts"
```

Verify the registration:

```powershell
codex mcp list
codex mcp get upnote-local
```

This starts the local source checkout; it does not use `bunx @bellx2/upnote-mcp`. The published upstream package does not include this fork's editing feature. Reads remain read-only; `update_note` uses the guarded write path described below. Reconnect/restart the MCP server after updating the checkout so the new tool is advertised.

## Editing existing notes

The design is informed by [bug-breeder/upnote-mcp](https://github.com/bug-breeder/upnote-mcp). UpNote's [documented URL endpoints](https://help.getupnote.com/resources/x-callback-url-endpoints) do not expose in-place editing, so edits write directly to SQLite.

1. Call `get_note` and review the current contents. It returns a `version` token covering the full database row.
2. Call `update_note` with that token as `expectedVersion`. Use `dryRun: true` to inspect the proposed title, HTML and plain text without creating a backup or changing the database.
3. Quit UpNote for normal editing, then call with `dryRun: false`. Quitting or syncing may change the version; if so, read and review the note again before editing.
4. Reopen UpNote and verify the edit and other-device sync. A successful tool result proves only a matching local database read, not UI refresh or cloud sync.

Example (the version must come from a fresh `get_note` call):

```json
{
  "id": "existing-note-id",
  "expectedVersion": "<64-character version from get_note>",
  "content": "## Summary\n\nUpdated body.",
  "contentFormat": "markdown",
  "mode": "replace",
  "dryRun": true
}
```

`content` is the body **without the title**. `title` is optional; a title-only edit preserves body markup when the existing title heading is recognized. `contentFormat` accepts `markdown` (default) or `text`. Raw HTML is treated as text. `mode: "append"` appends while preserving existing HTML and attachment references. Replacing a body containing images/attachments is refused, and importing new images is unsupported. An empty body is allowed only in replace mode. Notebook membership, tags, link indexes, attachment metadata, sharing, pins and bookmarks are not recalculated or changed by this tool; manage those features in UpNote. Replacing Markdown can change unsupported rich-text formatting.

Before mutation the server obtains `BEGIN IMMEDIATE`, rechecks the version, and creates a standalone `VACUUM INTO` snapshot on another read-only source connection. The snapshot includes committed WAL data, passes `quick_check`, and is flushed before updating the note. No edit is committed if backup creation or verification fails. This temporarily reserves the SQLite writer for the duration of the backup; other writers may wait. The edit increments `revision`/`updatedAt` and sets `synced=0`. The note ID and creation date stay unchanged. There is no automatic retry or database restoration.

The result includes `committed`, `backupPath`, `databaseVerification`, `cloudSync: "unverified"`, and warnings. Backups contain the whole database (including private notes) but do not copy external image/attachment files. To recover, quit UpNote and inspect the backup before restoring anything; replacing the whole DB can undo unrelated changes and is not a cloud-sync rollback. Each real edit retains a separate full backup, so monitor disk usage.

### Experimental editing while UpNote is running

Set **`allowWhileRunning: true` on the individual call**. The default refuses writes while UpNote runs. Live edits additionally require the note to have `synced=1`; pending local edits/sync must finish before a fresh read. Process-detection failure also refuses writing.

This is **best-effort, not safe live editing**. The SQLite transaction prevents concurrent SQL writes during the edit, but cannot invalidate UpNote's cached note or stop its later writes. Avoid editing the target in UpNote at the same time, including separate note windows. The server checks the database for two seconds after a live edit and reports an observed overwrite as `databaseVerification: "conflict"` with an MCP error **even though `committed` is true**. A later overwrite remains possible. A failed read-back is likewise reported without retrying the edit. No successful result claims that the UI reloaded or cloud sync completed. The server does not kill, suspend, restart or focus UpNote.

For direct SQLite edits, quit UpNote during the write and reopen it afterward. For live editing use the internal-API workflow below, or the Computer Use fallback. Bypassing the process check alone cannot invalidate the app's cache or enqueue a cloud upload.

### MCP-only internal API editing on Windows

`update_note_in_app` calls the running app's own **`coreStore.updateNotes()`** action over Chromium's local DevTools Protocol (CDP). This updates the in-memory note, normal save/sync pipeline, and current editor. It does not simulate input, use the clipboard, or write note rows/sync flags from MCP. A verified pre-edit DB backup remains mandatory.

Initial setup requires one normal exit and relaunch of UpNote: the ordinary running process has no CDP listener and cannot be attached after launch on this Windows build. The launcher never kills or restarts an existing app, copies a signed-in profile, modifies app binaries, or persists OS startup settings.

```powershell
# First exit UpNote normally (save any unsaved edits).
powershell.exe -NoProfile -File .\scripts\start-upnote-bridge.ps1
```

Then add `UPNOTE_CDP_URL=http://127.0.0.1:19330` to the environment of the existing local MCP registration and reconnect MCP. Keep `UPNOTE_DB` pointing at the same database that the app uses. `-Port` can select a different port; use the same origin in the MCP environment. For a non-Store installation, supply `-ExePath` to the launcher. Subsequent editing calls do not restart UpNote.

CDP has the app's privileges and is not an authenticated application API: other local processes able to connect can also control the signed-in app. The launcher requests loopback binding, checks any OS-visible listener addresses, and verifies the browser PID using CDP `SystemInfo.getProcessInfo`. Some Windows environments omit this listener from the OS table; the launcher reports that limitation while still requiring a matching browser PID. Do not expose or forward this port. It remains enabled until UpNote exits normally; ordinary launching afterward leaves it disabled. Use the bridge launcher again for later app sessions.

#### Everyday shortcuts and Windows startup

For an explicitly configured per-user default launch path, `scripts/start-upnote-default.ps1` and `scripts/upnote-default.vbs` can be deployed as `%LOCALAPPDATA%\UpNoteMcp\launch.ps1` and `launch.vbs`. The VBS host starts PowerShell without a console window. The PowerShell launcher resolves the current Store package on every launch, so versioned `WindowsApps` paths are not baked into the shortcut. It starts UpNote with the local CDP flags; `--background` on the VBS host adds UpNote's `--auto-start-in-background` flag. If UpNote is already running with CDP, normal shortcuts show its existing window and startup shortcuts do nothing. A running app without CDP is never force-restarted; it is reported in `launch.jsonl`.

The verified Windows configuration on 2026-11-14 uses:

- Desktop `UpNote.lnk` and Start Menu `UpNote (MCP).lnk` → `wscript.exe "%LOCALAPPDATA%\UpNoteMcp\launch.vbs"`.
- The existing Startup-folder `UpNote - ショートカット.lnk` → the same command with `--background`.
- UpNote's built-in auto-start disabled and the obsolete `electron.app.UpNote` Run value removed, so the Startup shortcut owns automatic launch.

The Store-generated Start Menu app entry is unchanged; use the new **UpNote (MCP)** entry or the desktop shortcut. No UpNote taskbar pin was present to replace. Original shortcut files and the prior Run value are retained under `%LOCALAPPDATA%\UpNoteMcp\backups`, with `before.json` describing the changes and the original app auto-start flag. `installation.json` records installed shortcut targets and verification results. The exact startup shortcut was tested after a normal app exit: the new main process had both CDP flags plus background startup, and CDP ownership was verified. The desktop/Start Menu shortcut reused the running app successfully. A Windows sign-out/sign-in itself was not performed.

1. Call `get_upnote_bridge_status` and `get_note`.
2. Call `update_note_in_app` with the same `id`, `expectedVersion` from `get_note`, and proposed `title` and/or `content`. `contentFormat`, `mode`, and `dryRun` follow `update_note`; `waitMs` defaults to 20000 and is capped at 30000.
3. Only `state: "synced"` means the expected content, editor DOM reflection, and fresh app sync acknowledgement were all observed. `cloudSync: "app_acknowledged"` does not independently verify receipt on another device. On incomplete/unknown outcomes, query `get_upnote_bridge_status` with the note ID; do not repeat the mutation automatically. `get_note` now includes `sync.synced`, `sync.syncedAt`, and `sync.revision`.

The bridge uses **capability and schema checks, not an app-version allowlist**. The app version and SQLite schema version are diagnostic information only. Each native call checks the methods it actually uses (`updateNotes`, navigation/selection and the read-only SQL bridge), their required state/lock/navigation types, the locked-note ID collection, and the exact database path. Missing or malformed state fails closed rather than being treated as false. The target note's actual values are checked on both sides of the bridge, including numeric timestamps/revision, boolean flags and attachment ID collections. Compatible synchronous or Promise-returning app actions are supported; navigation and write guards are rechecked before the save.

The DB must retain the required `notes` columns with compatible SQLite TEXT/numeric affinities and a unique note ID (single-column primary key or non-partial unique index). Additional columns, column order changes, equivalent declarations such as `VARCHAR`/`TEXT` or `INTEGER`/`DOUBLE`, and changed schema-version numbers are accepted. Missing columns, incompatible affinities, required generated columns, non-unique IDs, and unsupported stored value types are refused before backup or app mutation. The schema is read on every status/edit call and again under the pre-backup writer reservation; a prior successful check is not cached indefinitely. `get_upnote_bridge_status` and native edit results report the database/runtime `compatibility` checks.

The existing profile/workspace, locked-note, stale-snapshot and in-memory metadata guards remain. Unsaved editor changes and open pop-out note windows are refused. A native call that loses its response returns `applied: null` with the backup path instead of claiming the edit was not applied. Body replacement still refuses attachments/images; append preserves the existing body. Read-only structural checks cannot prove that a future internal method with the same name/types still has identical semantics: every edit therefore still requires a verified backup and post-save content, editor and fresh sync-acknowledgement checks, with no automatic retry or restoration.

#### Verification scope

On 2026-11-14, the actual new MCP tool was exercised first against an unsigned-in disposable profile: backup integrity, identical note ID/creation time, Japanese rich text, and immediate editor DOM update passed, with sync correctly remaining unverified.

It was then tested against the user's signed-in normal UpNote 9.22.9 profile after a normal exit and CDP-enabled relaunch. One `update_note_in_app` MCP call edited the dedicated test note, immediately updated the editor and list preview, preserved the ID/creation time, and returned `state: "synced"` / `cloudSync: "app_acknowledged"`. The app recorded the edit at 19:29:06.918 JST and sync acknowledgement at 19:29:10.544 JST (3.626 seconds later). The full pre-edit backup matched the original note row and passed `integrity_check`. Japanese heading/bold/list rendering was checked through the editor DOM. No Computer Use, input simulation, clipboard, direct note-row write or manual sync flag change was used. Other-device receipt was not independently checked.

The capability-based replacement was verified against the same installed app and dedicated note: backup/identity/DOM checks passed and a fresh app sync acknowledgement followed in 4.420 seconds. Future version labels (including 9.22.10 and 10.0.0) were accepted in simulated runtimes with the same API contract; actual future UpNote builds were not installed or tested. Tests also cover missing methods/state, incompatible DB changes, changed runtime value types, asynchronous actions and schema changes during preflight.

`scripts/test-native-bridge.ts` is an opted-in integration probe for the disposable `.cache/upnote-cdp-probe` profile only. It refuses a signed-in profile. It is not part of `bun test`. `scripts/inspect-native-bridge.ts` provides a read-only capability inventory through an explicitly supplied CDP endpoint.

`scripts/live-native-edit-check.ts TEST_NOTE_ID OUTPUT_JSON --edit-test-note` is a separate, explicitly opted-in real-library test. It only accepts a dedicated `MCP実機テスト ` note and checks the complete MCP-native edit, backup, DOM and app sync acknowledgement flow. Never run it against ordinary notes. `scripts/verify-upnote-cdp-owner.ts` checks the current browser PID without reading note contents.

### Partial edits for long notes

Use `get_note_edit_context` followed by `patch_note_in_app` to send only the intended changes. Neither tool returns the complete old/new body by default. The server reads the current note, maps changes to original HTML source ranges, and passes the complete reconstructed HTML to the existing native save pipeline. It never round-trips unchanged content through Markdown or an HTML serializer. Backups, full-row version conflicts, API/schema checks, app-cache/unsaved guards, UI verification and fresh sync acknowledgements are shared with `update_note_in_app`.

`get_note_edit_context` returns `version`, character/UTF-8 byte sizes, sync metadata and a paginated body outline. Optional `find` returns occurrence numbers and short before/after snippets; optional `section` returns only that section (`sectionFormat: "text"` or `"html"`, default 8000 characters, maximum 64000). `limit` defaults to 20 and is capped at 100; `offset` paginates outline/search results. Section excerpts report `truncated`: do not treat an incomplete excerpt as the full original section. Very long heading labels are abbreviated in the outline; use their `index` instead of a truncated label.

Example change request (use the actual ID and version returned by the context tool):

```json
{
  "id": "existing-note-id",
  "expectedVersion": "<version from get_note_edit_context>",
  "dryRun": true,
  "operations": [
    { "type": "replace_text", "find": "Old wording", "replacement": "New wording", "expectedMatches": 1 },
    { "type": "replace_section", "section": { "heading": "Next steps", "level": 2 }, "content": "- Review the draft\n- Send the result", "contentFormat": "markdown" }
  ]
}
```

All 1..100 operations resolve against the **same original snapshot**, not against the result of earlier operations. Overlapping source changes are refused before backup/save. This prevents an earlier section deletion from silently shifting a later heading index. A disjoint heading rename and section-body replacement can both refer to the original heading name. Once previewed, submit the same request with `dryRun: false` while the version is still current. One batch uses one backup and one app save; responses contain compact change counts/sizes, the new version/sync status and backup path, not the whole note.

| Operation | Behavior |
| --- | --- |
| `replace_text` | Literal visible-text matching within a block, including across inline tags. Replacement is escaped text; it inherits the first matched text node's formatting. Newlines become `<br>`. Tags, attributes, link destinations, comments and protected object content are not searched/replaced. It cannot span paragraph/break/protected-object boundaries. |
| `replace_section` | Replace the body after the selected heading through the next same/higher-level heading, including subsections. Preserve the selected heading's own markup. New content is Markdown or plain text. |
| `append_section` | Append at that section's end, preserving its existing HTML. |
| `rename_heading` | Rename a body heading while retaining its tags/attributes and surrounding content. The note title is excluded. |

Text matching must be unique unless `occurrence` is explicit. `all: true` requires the exact `expectedMatches` (maximum 10000 replacements per operation). A heading can be selected by exact text plus optional `level`/`occurrence`, or its one-based outline `index`; ambiguous headings are refused. The standard leading title heading must be recognized. Section operations refuse unsupported parent/boundary layouts. Images/attachments elsewhere in the note remain untouched; replacing a section containing a protected image/attachment/object is refused. Literal edits outside protected objects and section appends remain possible. Unicode/HTML-entity boundaries are checked instead of slicing encoded text blindly.

For partial edits, `htmlPreserved: true` means the saved DB HTML exactly matches the source-spliced plan. Unexpected app rewriting is reported as `state: "conflict"`, even if the app already applied/synced the change. Only `state: "synced"` with `htmlPreserved: true` confirms expected saved HTML, editor reflection and the app's sync acknowledgement. On an incomplete/unknown outcome, inspect the compact context/sync status; do not automatically repeat the patch or restore the DB. Other-device receipt is not independently checked.

#### Size limit and long-note verification

UpNote itself documents an approximately **1 MB underlying HTML limit**, beyond which Firebase cannot store a note ([official Premium FAQ](https://help.getupnote.com/resources/upnote-premium/premium-faqs)). The server conservatively rejects a final HTML payload above **1000000 UTF-8 bytes** before backup or mutation, including previews; the limit applies to final HTML, not JavaScript character count. Oversized existing notes can still be inspected and shrunk below the ceiling. MCP's default 10 MiB receive buffer remains unchanged; smaller patch/context messages do not remove the app's own size limit. Native save requests allow 30 seconds, with independent bounded sync verification afterward.

The installed UpNote 9.22.9 was tested with a dedicated **154407-character** note (177050 HTML characters / 465514 UTF-8 bytes). A 389-byte MCP patch performed a text replacement and section replacement together; the response was 3883 bytes. The unchanged prefix/tail source, highlight class, bold text, table, ID/creation time, pre-edit backup and stale-version rejection passed. The fresh app sync acknowledgement arrived after 15.177 seconds. An initial 1088312-byte test note exceeded the app limit and did not sync; the same note was shrunk by section editing, with backup, and synced successfully. No ordinary user note was changed.

Automated tests include multi-megabyte HTML, 8000 inline replacements, entities/emoji/CRLF, ambiguity, overlapping edits, heading-index stability, protected attachments, backup failures and unexpected app HTML rewriting. A 6 MiB temporary note was readable through compact MCP context and correctly rejected for saving; an 800 kB temporary note's preview stayed compact. That protocol test uses a fake app endpoint and is not evidence of cloud sync above UpNote's limit. `scripts/live-partial-edit-check.ts OUTPUT_JSON --create-long-test-note` is a separate explicitly opted-in real-app fixture; it creates a dedicated note and preserves it and its backup for inspection.

### Automatic Codex connection preparation

With the per-user launcher installed, set `UPNOTE_AUTO_START=1` in the existing MCP registration (alongside `UPNOTE_CDP_URL` and `UPNOTE_DB`). The server advertises its tools immediately and prepares UpNote in the background. If UpNote is closed, it starts the installed Store app with CDP in the background and waits for the renderer and data to load. `ensure_upnote_connection` explicitly checks readiness; native status/edit operations also recover their connection before sending any edit. Each operation discovers a fresh CDP target, so later app restarts do not reuse an obsolete WebSocket.

Connection/readiness retries are bounded. The server shares startup work within one MCP process, and the installed PowerShell launcher uses a per-user named mutex across separate Codex/MCP processes. App-start failures do not terminate stdio. Database opening is deferred in the MCP server, so a temporarily missing database causes a tool error rather than killing the server; a later request can open the database after it becomes available. Local SQLite search/read tools remain separate from native app readiness.

No note mutation is retried automatically. Incompatible APIs/profiles, app locks, pop-out windows and unsaved input still block the relevant operation. An app already running without CDP must be saved and exited normally first; the helper never kills it or discards user input. Automatic startup does not log in, unlock the app or guarantee network/cloud availability.

The configured Codex registration on 2026-11-14 enables auto-start and uses a 30-second MCP startup timeout and 90-second tool timeout. A one-time MCP reconnect is needed when updating an already-running Codex client. Afterward no repeated launcher or connection setup is needed for ordinary closed-app use. The live verification used the actual saved registration: after a normal app exit, two concurrent MCP clients both became ready, one new CDP-enabled UpNote main process was created, a third reconnected client became ready, and the existing test note remained readable without any note edits. MCP handshakes completed in roughly 0.14–0.20 seconds while app preparation continued asynchronously.

`scripts/verify-codex-connection.ts OUTPUT_JSON` exercises the saved registration and performs no note mutations. Unit tests cover a subsequent app exit, startup contention, initialization waits, persistent MCP availability after a missing DB, and refusal to retry a lost mutation response.

### App-native live editing on Windows

This is a fallback for clients using Computer Use instead of the opt-in CDP bridge. **It requires a computer-use client in addition to MCP.** These tools prepare and verify the edit; they do not click or type into the app by themselves.

1. Read `get_note` and call `prepare_app_note_edit` with `id`, `expectedVersion`, and the proposed `title` and/or `content` (`contentFormat` and `mode` follow `update_note`). UpNote must be running and the target initially synced. The tool creates a verified full backup, stages HTML/Unicode text on the Windows clipboard, and returns a ten-minute `ticket` and instructions. It does **not** update UpNote's database rows.
2. The computer-use client opens the returned note URL, verifies its ID/title, clicks inside the editor, inspects focus/selection, then selects the note content and pastes with Ctrl+V. The staged content includes the title. UpNote immediately renders it and performs its own normal save and sync. Do not create a replacement note or paste into an unverified field.
3. Inspect the rendered content and call `complete_app_note_edit` with the ticket. `waitMs` defaults to 15000, capped at 30000 per call. `awaiting_edit` and `awaiting_sync` are incomplete; poll verification without repeating the paste. A conflicting save stops verification.

`state: "synced"` requires the same note ID and creation time, matching normalized title/plain text, `synced=1`, and a fresh `syncedAt` at least as recent as both preparation and the current `updatedAt`. It returns `cloudSync: "app_acknowledged"` and `otherDeviceVerified: false`. This is UpNote's local acknowledgement of server sync; independent retrieval on another device was not performed. Formatting must also be inspected in the UI. The MCP server never sets the sync flags for this workflow.

Keep the MCP server alive until completion; the ticket is held in that server process. The workflow replaces the shared Windows clipboard and needs a visible, unlocked desktop. Do not concurrently edit the target in another app window: a DB version token cannot detect unsaved UI changes. Full-note paste currently refuses images/attachments, including append requests. App updates may change how pasted HTML is normalized. A failed paste/verification is not automatically retried or rolled back.

#### App-editor live verification (2026-11-14)

On UpNote 9.22.9, manual sync and Ctrl+S did not upload a direct SQLite edit. Editing through the app's editor did. The new MCP preparation/verification workflow was then tested with Computer Use on the dedicated test note: the editor rendered the Japanese heading, bold text and list immediately; the list preview refreshed; the ID and creation time stayed unchanged. The pre-edit backup matched the entire original row and passed `integrity_check`. UpNote saved the edit at 18:43:21.094 JST and recorded sync acknowledgement at 18:43:25.301 JST (about 4.2 seconds later); the UI displayed its updated sync time.

An initial CF_HTML encoding failure was detected as a content conflict and corrected: HTML is now staged as an explicit UTF-8 byte stream with tested byte offsets rather than a .NET ANSI string. The test note was repaired through the app, with a new backup retained before repair.

`scripts/live-app-edit-check.ts TEST_NOTE_ID OUTPUT_JSON --prepare-test-note` exercises these MCP tools, but still waits for the computer-use client to perform the verified paste. It only accepts a dedicated `MCP実機テスト ` note. Repair mode additionally requires evidence matching a failed test. Neither script is part of the automated suite or runs against a real library without explicit opt-in.

#### Windows live verification (2026-11-14)

On UpNote 9.22.9, a newly created test note was edited through a fresh MCP server process while UpNote stayed running. Its ID and creation time were unchanged; the automatic backup matched the entire pre-edit note row and passed `integrity_check`. The database retained the new body through the final check, about 170 seconds after commit.

The already-open editor did not refresh immediately. After changing the view and reopening the note, the main editor displayed the new heading and body without quitting UpNote. A newly opened secondary window initially showed the old body, and the list preview also stayed stale. The final local `synced` flag was still `0`; cloud/other-device sync was not confirmed. This verifies conditional local UI reflection, not reliable immediate refresh or completed sync.

`scripts/live-edit-check.ts` is a manually opted-in real-library check, separate from the automated test suite. It refuses notes without the `MCP実機テスト ` title prefix and `BEFORE-LIVE-EDIT` marker, and requires UpNote running with the note initially synced. It writes the target test note only and retains the automatic backup. Run only against a newly created dedicated test note:

```text
bun run scripts/live-edit-check.ts TEST_NOTE_ID OUTPUT_JSON --edit-test-note
```

## Example Workflows

Try prompts like:

- `Search UpNote for "travel" and show me the first result`
- `Show me my 10 most recent UpNote notes`
- `Show me this week's notes`
- `Show me this month's notes`
- `Find this week's AI notes`
- `Open this week's AI note`
- `Find this month's notes tagged meeting`
- `Open the latest note tagged meeting`
- `List my UpNote tags and open the note that matches the tag "meeting"`
- `Find notes about "launch", summarize them, and create a new UpNote note with the summary`
- `List notebooks and open the one named "Research"`

## Tool Reference

### `search_notes`

Input:

```json
{
  "query": "travel",
  "limit": 5
}
```

### `list_recent_notes`

Input:

```json
{
  "limit": 10
}
```

### `list_notes_this_week`

Input:

```json
{
  "limit": 20
}
```

### `list_notes_this_month`

Input:

```json
{
  "limit": 20
}
```

### `find_notes`

Input:

```json
{
  "period": "this_week",
  "query": "AI",
  "limit": 10
}
```

Or:

```json
{
  "period": "this_month",
  "tag": "meeting",
  "limit": 10
}
```

### `find_and_open_note`

Input:

```json
{
  "period": "this_week",
  "query": "AI",
  "limit": 10
}
```

Or:

```json
{
  "period": "recent",
  "tag": "meeting",
  "limit": 10
}
```

### `get_note`

Input:

```json
{
  "id": "019fd239-a98a-742b-b75b-cee66e7aa830"
}
```

### `open_note`

Input:

```json
{
  "id": "019fd239-a98a-742b-b75b-cee66e7aa830"
}
```

### `open_notebook`

Input:

```json
{
  "id": "3f03c742-1270-4d35-a5bc-c7d98580d6fc"
}
```

### `list_notebooks`

Input:

```json
{}
```

### `list_tags`

Input:

```json
{}
```

### `search_by_tag`

Input:

```json
{
  "tag": "meeting",
  "limit": 5
}
```

### `create_note`

Input:

```json
{
  "title": "Meeting Notes",
  "text": "# Summary\n\nDraft created by MCP.",
  "markdown": true,
  "newWindow": false
}
```

## Verification

```bash
bun run check
bun run test
bun run smoke
bun run build:mcpb
```

The full suite uses `scripts/run-tests.ts` to run every test file once in a fresh OS process. On the installed Bun 1.4.0/Windows runtime, shared-process VM/large-HTML tests triggered native crashes; per-file process isolation passes without skipping or retrying tests. Individual files can still be run with `bun test ./src/example.test.ts`.

## Japanese README

The previous Japanese README is available at `README_ja.md`.
