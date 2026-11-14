# upnote-mcp-win

Windows MCP server for searching UpNote and **editing a running UpNote app through local Chrome DevTools Protocol (CDP)**. It keeps the note ID, backs up before saving, checks the editor update and waits for a fresh app sync acknowledgement. Partial edits preserve unchanged HTML without sending the whole note through the AI client.

[日本語](README_ja.md) · [Architecture and fallback workflows](docs/architecture.md) · [Verification](docs/verification.md) · [Release preparation](docs/releasing.md)

An independent Windows fork of [bellx2/upnote-mcp](https://github.com/bellx2/upnote-mcp), maintained at [ten9miq/upnote-mcp-win](https://github.com/ten9miq/upnote-mcp-win). Unofficial; not affiliated with or supported by UpNote. CDP editing uses undocumented app internals, not an official UpNote API.

## Identity and distribution

| Item | This fork |
| --- | --- |
| Repository / issues | [ten9miq/upnote-mcp-win](https://github.com/ten9miq/upnote-mcp-win) / [Issues](https://github.com/ten9miq/upnote-mcp-win/issues) |
| npm package identity | @ten9miq/upnote-mcp-win |
| Executable / bundle name | upnote-mcp-win |
| Version line | 0.1.0, independent of upstream's 0.2.x |

**The documented installation path is a source checkout.** A package name and build configuration do not mean an npm package or downloadable bundle has been released. Do not install @bellx2/upnote-mcp expecting this fork's CDP features. Verify an actual release in this repository before using registry/bundle installation instructions.

## How CDP editing differs

The comparison describes the linked READMEs checked on 2026-11-14; it is not a claim about every similarly named server.

| Implementation | Read / create | Existing-note editing | Running app / sync |
| --- | --- | --- | --- |
| [bellx2/upnote-mcp](https://github.com/bellx2/upnote-mcp#readme), upstream | Read-only SQLite / official URL scheme | No editing tool documented | No live-edit workflow documented |
| [bug-breeder/upnote-mcp](https://github.com/bug-breeder/upnote-mcp#readme), design reference | SQLite / URL scheme | Python; direct SQLite edits, moves, tags, deletes and merges | README requires quitting the app for reliable edits; running-app override available |
| **This fork** | Read-only SQLite / URL scheme | Bun/TypeScript; CDP calls the app's internal save action; partial text/section changes | App stays running; checks saved content, editor and fresh sync acknowledgement; guarded direct-write fallback also retained |

This fork focuses on live content editing. It does not implement bug-breeder's move/delete/merge/tag-management tools.

~~~mermaid
flowchart LR
  AI["MCP client"] -->|stdio| MCP["upnote-mcp-win"]
  MCP -->|read-only search| DB[("Local SQLite")]
  MCP -->|verified pre-edit note archive| Backup[("Backup")]
  MCP -->|local CDP: internal save action| App["Running UpNote"]
  App -->|save| DB
  App -->|its own sync process| Cloud["UpNote cloud"]
  MCP -->|verify saved HTML / editor / sync metadata| App
~~~

For the CDP workflow, MCP never updates note rows or sync flags itself. It obtains a short SQLite writer reservation to check the snapshot and create a consistent backup, then releases it before asking the app to save. This updates the app's own state and sync path. Creation still uses UpNote's official URL scheme.

## Requirements

- Windows 10/11 and a locally installed UpNote desktop app. The measured environment was **Windows / UpNote 9.22.9 / Bun 1.4.0**; see [verification scope](docs/verification.md).
- [Bun](https://bun.sh) **1.4.0 or newer** for the source package, including Markdown conversion. Node.js alone is insufficient.
- Git and Windows PowerShell for these setup instructions.
- The default everyday/automatic launcher requires the **Microsoft Store edition**. A manually specified UpNote.exe can use the one-time launcher; automatic startup for that installation is not provided.
- A signed-in, unlocked UpNote app with network access for cloud sync checks. Local search does not require CDP or an online account.

Inherited macOS database/URL support remains in source, but this fork's CDP workflow and Windows bundle are not claimed to be tested on macOS/Linux.

## Install from source

Run in PowerShell:

~~~powershell
git clone https://github.com/ten9miq/upnote-mcp-win.git
Set-Location upnote-mcp-win
bun install --frozen-lockfile
bun run check
(Get-Command bun.exe).Source
~~~

Keep the checkout in a stable directory. Use its absolute path and the printed bun.exe path in the MCP configuration. The default database is %APPDATA%\UpNote\upnote.sqlite3; override UPNOTE_DB for another profile/path. Search-only setup can omit the CDP environment variables and the next step.

### 1. Start UpNote with CDP

Save any current work and **exit UpNote normally**, including its tray process. From the checkout:

~~~powershell
powershell.exe -NoProfile -File .\scripts\start-upnote-bridge.ps1
# For a non-Store installation, provide the actual installed executable:
# powershell.exe -NoProfile -File .\scripts\start-upnote-bridge.ps1 -ExePath 'C:\path\to\UpNote.exe'
~~~

The launcher uses --remote-debugging-address=127.0.0.1 and --remote-debugging-port=19330, checks the app/CDP owner and prints the endpoint. It refuses a running app and never force-restarts it. Administrator rights are not part of normal setup. If a local execution policy blocks a script, review that script and follow your organization's policy; the setup does not change machine-wide policy.

CDP is a powerful local debugging interface. It remains available until UpNote exits. The server accepts literal loopback HTTP origins only; do not expose the port through a network bind, proxy or tunnel. Other local programs with access to the port may control the app. Use this on a trusted local machine.

### 2. Register with an MCP client

For a JSON-based stdio MCP client (for example Cursor/Claude Desktop), replace the paths with your own:

~~~json
{
  "mcpServers": {
    "upnote-mcp-win": {
      "command": "C:\\Users\\YOUR_NAME\\.bun\\bin\\bun.exe",
      "args": ["run", "C:\\path\\to\\upnote-mcp-win\\src\\index.ts"],
      "env": {
        "UPNOTE_DB": "C:\\Users\\YOUR_NAME\\AppData\\Roaming\\UpNote\\upnote.sqlite3",
        "UPNOTE_CDP_URL": "http://127.0.0.1:19330"
      }
    }
  }
}
~~~

Codex uses the same command/arguments/environment in its MCP TOML configuration. See the [Codex example](docs/architecture.md#codex-configuration). A 30-second startup timeout and 90-second tool timeout leave room for startup, note backup and sync checks. Reconnect the MCP client after changing its configuration or updating this checkout. Existing registrations with another server key can keep that key; tool names are unchanged.

Call ensure_upnote_connection or get_upnote_bridge_status first. The bridge checks the database path, runtime capabilities and schema. It will not unlock the app or bypass login.

### 3. Optional: everyday shortcuts and automatic preparation

For the Store edition, copy the stable launcher templates once:

~~~powershell
$helperDir = Join-Path $env:LOCALAPPDATA 'UpNoteMcp'
New-Item -ItemType Directory -Path $helperDir -Force | Out-Null
Copy-Item -LiteralPath .\scripts\start-upnote-default.ps1 -Destination (Join-Path $helperDir 'launch.ps1')
Copy-Item -LiteralPath .\scripts\upnote-default.vbs -Destination (Join-Path $helperDir 'launch.vbs')
~~~

Create a Windows shortcut targeting wscript.exe with arguments "C:\Users\YOUR_NAME\AppData\Local\UpNoteMcp\launch.vbs". For Windows login startup, put a shortcut in the folder opened by shell:startup and append --background to those arguments. These examples use port 19330.

Switch your usual launch shortcut to this helper and disable UpNote's own automatic startup if it would launch without CDP. Original Store shortcuts/taskbar pins are not modified automatically. The helper resolves the current Store package on every launch instead of storing a version-specific executable path; it reuses an already connected app and refuses a running app without CDP.

Add UPNOTE_AUTO_START=1 to the MCP environment after installing the helper. UPNOTE_AUTO_START_LAUNCHER can override its default path, %LOCALAPPDATA%\UpNoteMcp\launch.ps1. A closed app will then be prepared in the background when MCP starts or a native operation needs it. Parallel clients share startup work. Only connection/readiness checks are retried; note mutations are never replayed automatically.

To turn this off, remove the startup shortcut, restore your usual UpNote shortcut and remove UPNOTE_AUTO_START / UPNOTE_CDP_URL from the MCP configuration. Exit UpNote normally and launch it normally to close the debugging port. No app binary patch is involved.

## Edit without resending a long note

1. Read get_note_edit_context with the note ID and optional find/section filters. It returns a version token, size/sync metadata and bounded excerpts.
2. Pass that version and only the changes to patch_note_in_app. All operations target the **same original snapshot**; overlapping or ambiguous changes are refused.
3. Use dryRun=true to validate first. A preview does not write or create a backup. Apply against the same version only if it is still current.

~~~json
{
  "id": "NOTE_ID",
  "expectedVersion": "VERSION_FROM_GET_NOTE_EDIT_CONTEXT",
  "operations": [
    { "type": "replace_text", "find": "old phrase", "replacement": "new phrase" },
    { "type": "replace_section", "section": { "heading": "Next steps", "level": 2 },
      "content": "- **Revised task**", "contentFormat": "markdown" }
  ]
}
~~~

| Operation | Behavior |
| --- | --- |
| replace_text | Literal visible-text replacement within a block, across inline tags. Replacement is escaped text; inherits the first matched text node's style. |
| replace_section | Replace the body after a heading through the next equal/higher-level heading. Keeps the selected heading. |
| append_section | Append to that section while keeping existing HTML. |
| rename_heading | Rename a body heading while keeping its tags/attributes. Excludes the note title. |

Use occurrence for duplicate text, or all=true together with the exact expectedMatches (up to 10000). Headings accept heading with optional level/occurrence, or a one-based outline index. Unchanged HTML is spliced directly from its original source; it is not regenerated from Markdown. The app still receives a full HTML save internally, so small MCP requests do not remove UpNote's note-size limit.

For full body/title replacement or append, use get_note then update_note_in_app with its version. Whole-body replacement cannot preserve every UpNote-specific decoration; partial editing is preferable for local changes.

## Backups, completion and constraints

- **Backup:** every actual edit saves only the target note's complete SQLite row to a checked, flushed `note.sqlite3` archive. Other notes/tables and external attachment blobs are excluded. Default: `MCP Backups/edit-…/note.sqlite3` beside the DB; override `UPNOTE_BACKUPS_DIR`. After verifying the new backup, older managed archives are automatically pruned: default **10 generations per note/profile and 512 MiB total**, configurable with `UPNOTE_BACKUP_MAX_GENERATIONS` / `UPNOTE_BACKUP_MAX_TOTAL_BYTES`. Each note's latest valid archive is always preserved; active clipboard preparations are temporarily protected. If that prevents meeting the ceiling or a deletion fails, `backupRetention.limitsExceeded` and warnings report it. Legacy full-DB backups and unrecognized files remain untouched and outside the managed-byte total. The reservation can briefly block another writer. This archive is not a replacement UpNote database; see [retention and recovery details](docs/note-backups.md).
- **Conflicts:** expectedVersion covers the full note row. Changes in DB/app state, unsaved editor input, locked notes/workspaces, a mismatched profile or open pop-out note windows stop native edits. Capabilities, required columns/affinities, unique IDs and note value types are checked each time; app-version numbers are diagnostic. Equivalent future versions can work, but matching names/types cannot guarantee future API semantics.
- **Completion:** only state=synced confirms the expected saved content, editor reflection and fresh app sync acknowledgement. Partial edits additionally require htmlPreserved=true. cloudSync=app_acknowledged is **not independent verification on another device**. Offline/timeout/unknown results are incomplete; inspect context/status and the backup instead of automatically repeating the edit or restoring the DB.
- **Size:** [UpNote documents an approximately 1 MB underlying HTML limit](https://help.getupnote.com/resources/upnote-premium/premium-faqs). This server conservatively refuses final HTML above **1000000 UTF-8 bytes**, including previews. Oversized existing notes can be read and shortened. Native save requests allow 30 seconds; sync verification is separately bounded. MCP's default receive limit is unchanged.
- **Formatting/attachments:** partial text edits cannot cross block/break/protected-object boundaries. Title and unsafe section layouts are protected. Replacing a section containing images/attachments/protected objects is refused; edits elsewhere and append can preserve them. New attachment insertion is unsupported. New Markdown/text content is converted to HTML; it is not stored as Markdown source.
- **Other limits:** no move/delete/merge/tag-management API, no official public cloud API integration, no guaranteed sync latency and no guaranteed compatibility with future undocumented internals. URL creation is fire-and-forget and does not return a confirmed new note ID. Search is substring-based, not ranked full-text search.

The server also exposes advanced direct-SQLite update_note and clipboard prepare_app_note_edit / complete_app_note_edit fallbacks. Their guarantees differ from CDP editing; read [the fallback workflows](docs/architecture.md#fallback-workflows) before using them. In particular, a matching direct DB write does not prove UI refresh or cloud sync.

## Tools

| Group | Tools |
| --- | --- |
| Search/read | search_notes, list_recent_notes, list_notes_this_week, list_notes_this_month, find_notes, get_note, list_notebooks, list_tags, search_by_tag |
| Open/create via URL | find_and_open_note, open_note, open_notebook, create_note |
| CDP connection | ensure_upnote_connection, get_upnote_bridge_status |
| CDP editing | update_note_in_app, get_note_edit_context, patch_note_in_app |
| Advanced fallbacks | update_note, prepare_app_note_edit, complete_app_note_edit |

## Development and verification

~~~powershell
bun install --frozen-lockfile
bun run check
bun run test
bun run pack
# Windows-only compiled bundle (requires downloading the MCPB packer):
bun run build:mcpb
~~~

Tests use temporary DBs; the full suite isolates test files into separate OS processes because of observed Bun 1.4.0/Windows VM/native crashes. Process-list and loopback access are required for integration tests. Live-profile scripts are opt-in and restricted to dedicated test notes; they are not run by the automatic suite. [Measured verification and remaining gaps](docs/verification.md) distinguish real app sync acknowledgements from simulated tests.

See [release preparation](docs/releasing.md) for package/bundle contents and manual publication. Opening an MCPB bundle in Claude Desktop is a separate integration check; a local bundle build alone does not establish it.

On 2026-11-15 JST, the reconnected chat MCP edited a dedicated real note 12 times: backups reached ten at edit 10, then the oldest file was automatically removed on each of edits 11 and 12. The newest pre-edit archive was retained, all ten final archives passed integrity checks (120 KiB total), and every edit received editor/sync acknowledgement. The 512 MiB capacity ceiling and other-device receipt were not exercised by this small-note run. See [live retention results](docs/note-backups.md#live-retention-check-2026-11-15-jst).

## License and attribution

MIT. The original bellx2 copyright notice is retained in [LICENSE](LICENSE). This fork builds on bellx2/upnote-mcp; bug-breeder/upnote-mcp informed the guarded direct-edit design. Neither upstream project maintains or supports this fork. Report fork issues in [this repository](https://github.com/ten9miq/upnote-mcp-win/issues).
