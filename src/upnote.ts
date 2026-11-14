import { existsSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { isUpNoteRunning, noteVersion, prepareNoteUpdate, htmlUpdateFields, assertNoteHtmlSize, MAX_NOTE_HTML_BYTES, type UpdateNoteParams } from "./editing";
import { noteEditContext, planPartialEdit, type PartialOperation, type ContextOptions } from "./partial-edit";
import { stageNoteClipboard } from "./clipboard";
import { NativeConnection, nativeExpression, type NativeChannel } from "./native-bridge";
import { assertNativeSchema, assertNativeNoteData, type NativeColumn } from "./compatibility";
import { connectWithRecovery, launchInstalledUpNote } from "./connection";
import { backupNote } from "./backup";

export type { UpdateNoteParams } from "./editing";

type RepositoryOptions = {
  isUpNoteRunning?: () => boolean;
  backupsDir?: string;
  observeLiveMs?: number;
  stageClipboard?: (payloadPath: string) => Promise<void>;
  nativeEndpoint?: string;
  connectNative?: (endpoint: string) => Promise<NativeChannel>;
  autoStart?: boolean;
  startNativeApp?: (endpoint: string) => Promise<void>;
  lazyOpen?: boolean;
};

export type NativeEditResult = {
  id: string;
  applied: boolean | null;
  state: "unchanged" | "synced" | "awaiting_sync" | "awaiting_ui" | "conflict" | "unavailable";
  uiUpdated: boolean;
  cloudSync: "app_acknowledged" | "unverified";
  otherDeviceVerified: false;
  backupPath: string | null;
  note: NoteDetail | null;
  message: string;
  preview: { title: string; content: string; html: string } | null;
  compatibility: { database: ReturnType<typeof assertNativeSchema>; runtime?: unknown };
};

type AppEditSession = {
  id: string;
  before: Record<string, unknown>;
  desiredTitle: string;
  desiredText: string;
  preparedAt: number;
  backupPath: string;
};

export type AppEditVerification = {
  id: string;
  state: "awaiting_edit" | "awaiting_sync" | "synced" | "conflict" | "unavailable";
  applied: boolean;
  cloudSync: "app_acknowledged" | "unverified";
  otherDeviceVerified: false;
  backupPath: string;
  syncedAt: string | null;
  note: NoteDetail | null;
  message: string;
};

export type UpdateNoteResult = {
  id: string;
  dryRun: boolean;
  committed: boolean;
  changedFields: string[];
  backupPath: string | null;
  appRunning: boolean;
  databaseVerification: "preview" | "unchanged" | "matches" | "conflict" | "unavailable";
  cloudSync: "unverified";
  warnings: string[];
  note: NoteDetail | null;
  preview: { title: string; content: string; html: string } | null;
};

export type DbPathResolutionOptions = {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  homeDir?: string;
};

export type SearchNotesParams = {
  query: string;
  limit?: number;
};

export type SearchNoteResult = {
  id: string;
  title: string;
  preview: string;
  updatedAt: string | null;
  createdAt: string | null;
  url: string;
};

export type NoteDetail = {
  id: string;
  title: string;
  content: string;
  html: string;
  summary: string;
  updatedAt: string | null;
  createdAt: string | null;
  url: string;
  version: string;
  sync: { synced: boolean; syncedAt: string | null; revision: number | null };
};

export type NotebookResult = {
  id: string;
  title: string;
  noteCount: number;
  parent: string | null;
  updatedAt: string | null;
  url: string;
};

export type TagResult = {
  id: string;
  title: string;
  updatedAt: string | null;
  url: string;
};

export type CreateNoteParams = {
  title?: string;
  text?: string;
  notebook?: string;
  markdown?: boolean;
  newWindow?: boolean;
};

export type FindNotesParams = {
  period?: "recent" | "this_week" | "this_month";
  query?: string;
  tag?: string;
  limit?: number;
};

type SearchNoteRow = {
  id: string;
  title: string | null;
  preview: string | null;
  updatedAt: number | null;
  createdAt: number | null;
};

type NotebookRow = {
  id: string;
  title: string | null;
  noteCount: number;
  parent: string | null;
  updatedAt: number | null;
};

type TagRow = {
  id: string;
  title: string | null;
  updatedAt: number | null;
};

type NoteDetailRow = {
  id: string;
  title: string | null;
  text: string | null;
  html: string | null;
  summary: string | null;
  updatedAt: number | null;
  createdAt: number | null;
};

export function resolveUpnoteDbPath(options: DbPathResolutionOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? homedir();
  const configured = env.UPNOTE_DB?.trim();

  if (configured) {
    return configured.replaceAll("${HOME}", homeDir);
  }

  if (platform === "win32") {
    const appData = env.APPDATA?.trim();
    if (!appData) {
      throw new Error("APPDATA is not set, so the default Windows UpNote database path cannot be resolved. Set UPNOTE_DB explicitly.");
    }
    return join(appData, "UpNote", "upnote.sqlite3");
  }

  // Keep the existing default for macOS and Linux-compatible environments.
  return join(
    homeDir,
    "Library",
    "Containers",
    "com.getupnote.desktop",
    "Data",
    "Library",
    "Application Support",
    "UpNote",
    "upnote.sqlite3",
  );
}

function createOpenDbMessage(dbPath: string, error: unknown): string {
  return [
    "Failed to open the UpNote database.",
    `Checked path: ${dbPath}`,
    "Confirm that UpNote Desktop has initialized the database, then set UPNOTE_DB if the database is stored elsewhere.",
    "On macOS, Claude Desktop may also need Full Disk Access in System Settings > Privacy & Security.",
    "On Windows, the standard path is %APPDATA%\\UpNote\\upnote.sqlite3.",
    `Details: ${String(error)}`,
  ].join("\n");
}

function formatTimestamp(value: number | null): string | null {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function normalizeMultilineText(value: string | null): string {
  return value?.trim() ?? "";
}

function startOfCurrentWeek(): number {
  const now = new Date();
  const start = new Date(now);
  const day = start.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  start.setDate(start.getDate() + diff);
  start.setHours(0, 0, 0, 0);
  return start.getTime();
}

function startOfCurrentMonth(): number {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

export function noteUrl(noteId: string): string {
  return `upnote://x-callback-url/openNote?noteId=${encodeURIComponent(noteId)}`;
}

export function notebookUrl(notebookId: string): string {
  return `upnote://x-callback-url/openNotebook?notebookId=${encodeURIComponent(notebookId)}`;
}

export function tagUrl(tagTitle: string): string {
  const tag = tagTitle.replace(/^#/, "");
  return `upnote://x-callback-url/tag/view?tag=${encodeURIComponent(tag)}`;
}

export function createNoteUrl(params: CreateNoteParams): string {
  const searchParams = new URLSearchParams();

  if (params.title) {
    searchParams.set("title", params.title);
  }
  if (params.text) {
    searchParams.set("text", params.text);
  }
  if (params.notebook) {
    searchParams.set("notebook", params.notebook);
  }
  if (params.markdown !== undefined) {
    searchParams.set("markdown", String(params.markdown));
  }
  if (params.newWindow !== undefined) {
    searchParams.set("new_window", String(params.newWindow));
  }

  const query = searchParams.toString();
  return query
    ? `upnote://x-callback-url/note/new?${query}`
    : "upnote://x-callback-url/note/new";
}

function createMissingDbMessage(dbPath: string): string {
  return [
    "UpNote database file was not found.",
    `Checked path: ${dbPath}`,
    "Set the UPNOTE_DB environment variable if your upnote.sqlite3 is stored in a different location.",
  ].join("\n");
}

export class UpNoteRepository {
  private readonly dbPath: string;
  private dbCache: Database | null = null;
  private closed = false;
  private readonly appEdits = new Map<string, AppEditSession>();

  constructor(dbPath = resolveUpnoteDbPath(), private readonly options: RepositoryOptions = {}) {
    this.dbPath = dbPath;
    if (!options.lazyOpen) void this.db;
  }

  private get db(): Database {
    if (this.closed) throw new Error("The UpNote repository is closed.");
    if (this.dbCache) return this.dbCache;
    if (!existsSync(this.dbPath)) {
      throw new Error(createMissingDbMessage(this.dbPath));
    }

    try {
      this.dbCache = new Database(this.dbPath, {
        readonly: true,
        create: false,
        strict: true,
      });
    } catch (error) {
      throw new Error(createOpenDbMessage(this.dbPath, error));
    }
    return this.dbCache;
  }

  getResolvedDbPath(): string {
    return this.dbPath;
  }

  close(): void {
    this.dbCache?.close();
    this.dbCache = null;
    this.closed = true;
  }

  /** Back up the exact target row read under a source DB writer reservation. */
  private backupBeforeEdit(row: Record<string, unknown>): string {
    const root = resolve(this.options.backupsDir ?? process.env.UPNOTE_BACKUPS_DIR ?? join(dirname(this.dbPath), "MCP Backups"));
    return backupNote(row, root, this.dbPath);
  }

  private async nativeConnection(): Promise<NativeChannel> {
    const endpoint = this.options.nativeEndpoint ?? process.env.UPNOTE_CDP_URL;
    if (!endpoint) throw new Error("UPNOTE_CDP_URL is not configured. Exit UpNote normally and start it with scripts/start-upnote-bridge.ps1, then configure the MCP environment. The server never force-restarts UpNote.");
    return connectWithRecovery({
      endpoint, key: `${endpoint}|${this.dbPath}`,
      autoStart: this.options.autoStart ?? process.env.UPNOTE_AUTO_START === "1",
      connect: this.options.connectNative ?? NativeConnection.connect,
      ready: channel => channel.evaluate(nativeExpression({ action: "status", databasePath: this.dbPath })),
      launch: this.options.startNativeApp ?? launchInstalledUpNote,
    });
  }

  private nativeSchemaCompatibility(db = this.db) {
    const table = db.query<{ type: string }, []>("SELECT type FROM sqlite_schema WHERE name='notes'").get();
    const columns = db.query<NativeColumn, []>("PRAGMA table_xinfo(notes)").all();
    const primary = columns.filter(column => column.pk > 0);
    let uniqueId = primary.length === 1 && primary[0]!.name === "id";
    if (!uniqueId && table?.type === "table") {
      for (const index of db.query<{ name: string; unique: number; partial: number }, []>("PRAGMA index_list(notes)").all()) {
        if (index.unique !== 1 || index.partial !== 0) continue;
        const keys = db.query<{ name: string | null }, [string]>("SELECT name FROM pragma_index_info(?) ORDER BY seqno").all(index.name);
        if (keys.length === 1 && keys[0]!.name === "id") { uniqueId = true; break; }
      }
    }
    const version = db.query<{ schema_version: number }, []>("PRAGMA schema_version").get();
    return assertNativeSchema(table?.type, columns, uniqueId, version?.schema_version ?? 0);
  }

  async getNativeBridgeStatus(id?: string) {
    const connection = await this.nativeConnection();
    try {
      const database = this.nativeSchemaCompatibility();
      const runtime = await connection.evaluate<Record<string, unknown>>(nativeExpression({ action: "status", databasePath: this.dbPath }));
      const compatibility = { database, runtime: runtime.compatibility };
      if (!id) return { ready: true, ...runtime, compatibility };
      const expected = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=? AND deleted=0 AND trashed=0").get(id);
      if (!expected) throw new Error("Active note not found.");
      assertNativeNoteData(expected, "sqlite");
      const ui = await connection.evaluate<{ editorMatches: boolean; compatibility?: unknown }>(nativeExpression({ action: "verify", databasePath: this.dbPath, expected }));
      return { ready: true, ...runtime, compatibility: { database, runtime: ui.compatibility ?? runtime.compatibility }, id, uiUpdated: ui.editorMatches, note: this.getNote(id) };
    } finally { connection.close(); }
  }

  async updateNoteInApp(params: UpdateNoteParams, waitMs = 20_000): Promise<NativeEditResult> {
    const id = params.id.trim();
    if (!id || !/^[a-f\d]{64}$/.test(params.expectedVersion)) throw new Error("Provide id and expectedVersion from get_note.");
    if (params.title === undefined && params.content === undefined) throw new Error("Provide title or content.");
    if (params.title !== undefined && (!params.title.trim() || /[\r\n]/.test(params.title))) throw new Error("title must be a non-empty single line.");
    if (params.mode === "append" && !params.content?.trim()) throw new Error("Append requires non-empty content.");
    const database = this.nativeSchemaCompatibility();
    const before = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=? AND deleted=0 AND trashed=0").get(id);
    if (!before || noteVersion(before) !== params.expectedVersion) throw new Error("The note changed or is unavailable. Read get_note again.");
    assertNativeNoteData(before, "sqlite");
    const patch = prepareNoteUpdate(before, params);
    return this.applyNativeFields(id, before, patch, database, !!params.dryRun, waitMs);
  }

  private async applyNativeFields(id: string, before: Record<string, unknown>, patch: Record<string, string | number>, database: ReturnType<typeof assertNativeSchema>, dryRun: boolean, waitMs: number): Promise<NativeEditResult> {
    assertNoteHtmlSize(String(patch.html ?? before.html ?? ""));
    const expectedVersion = noteVersion(before);
    const connection = await this.nativeConnection();
    const result: NativeEditResult = { id, applied: false, state: "unchanged", uiUpdated: false, cloudSync: "unverified", otherDeviceVerified: false, backupPath: null, note: this.getNote(id), message: "Nothing to change.", preview: dryRun ? { title: String(patch.title ?? before.title ?? ""), content: String(patch.text ?? before.text ?? ""), html: String(patch.html ?? before.html ?? "") } : null, compatibility: { database } };
    try {
      const preflight = await connection.evaluate<{ compatibility?: unknown }>(nativeExpression({ action: "check", databasePath: this.dbPath, expected: before }));
      result.compatibility.runtime = preflight.compatibility;
      if (!Object.keys(patch).length || dryRun) {
        result.message = dryRun ? "Native preflight passed; dry run made no changes." : "Nothing to change.";
        return result;
      }
      const writer = new Database(this.dbPath, { readwrite: true, create: false, strict: true });
      try {
        writer.exec("PRAGMA busy_timeout=2000; BEGIN IMMEDIATE");
        this.nativeSchemaCompatibility(writer);
        const current = writer.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(id);
        if (!current || noteVersion(current) !== expectedVersion) throw new Error("The note changed before backup. Read get_note again.");
        result.backupPath = this.backupBeforeEdit(current);
      } finally {
        if (writer.inTransaction) writer.exec("ROLLBACK");
        writer.close();
      }
      // No UpNote row was written above. The app owns all persistence and sync.
      const startedAt = Date.now();
      try {
        await connection.evaluate(nativeExpression({ action: "apply", databasePath: this.dbPath, expected: before, patch }), 30_000);
        result.applied = true;
      } catch (error) {
        result.applied = null;
        result.note = null;
        result.state = "unavailable";
        result.message = `Native request failed or its outcome is unknown: ${String(error)}. Inspect the current note and backup; do not retry automatically.`;
        return result;
      }
      const normalize = (value: unknown) => String(value ?? "").replace(/\s+/gu, " ").trim();
      const wantedTitle = patch.title ?? before.title;
      const wantedText = patch.text ?? before.text;
      const deadline = Date.now() + Math.min(30_000, Math.max(0, waitMs));
      do {
        const actual = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(id);
        if (actual) assertNativeNoteData(actual, "sqlite");
        if (!actual || actual.deleted !== 0 || actual.trashed !== 0 || actual.createdAt !== before.createdAt || actual.title !== wantedTitle || normalize(actual.text) !== normalize(wantedText)) {
          result.state = "conflict"; result.message = "The saved note differs from the native edit. Inspect it and the backup; do not retry automatically."; return result;
        }
        const ui = await connection.evaluate<{ editorMatches: boolean }>(nativeExpression({ action: "verify", databasePath: this.dbPath, expected: before, patch }));
        result.uiUpdated = ui.editorMatches;
        result.note = this.getNote(id);
        const synced = actual.synced === 1 && Number(actual.syncedAt) >= Number(actual.updatedAt) && Number(actual.syncedAt) >= startedAt;
        if (synced) result.cloudSync = "app_acknowledged";
        result.state = synced ? result.uiUpdated ? "synced" : "awaiting_ui" : "awaiting_sync";
        if (result.state === "synced") { result.message = "UpNote's internal updateNotes action saved the same note, refreshed the editor, and recorded a fresh sync acknowledgement. Other-device receipt was not independently checked."; return result; }
        if (Date.now() >= deadline) { result.message = "The native edit was applied, but UI/sync verification is incomplete. Query get_upnote_bridge_status; do not repeat the edit automatically."; return result; }
        await Bun.sleep(250);
      } while (true);
    } catch (error) {
      if (!result.applied) throw error;
      result.state = "unavailable"; result.note = null; result.message = `The app accepted the edit but verification failed: ${String(error)}. Do not retry automatically.`; return result;
    } finally { connection.close(); }
  }

  getNoteEditContext(id: string, options: ContextOptions = {}) {
    const row = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=? AND deleted=0 AND trashed=0").get(id.trim());
    if (!row) throw new Error("Active note not found.");
    assertNativeNoteData(row, "sqlite");
    return { id: row.id, title: String(row.title ?? "").slice(0, 1000), titleTruncated: String(row.title ?? "").length > 1000, version: noteVersion(row), htmlChars: String(row.html ?? "").length,
      htmlBytes: Buffer.byteLength(String(row.html ?? "")), maxHtmlBytes: MAX_NOTE_HTML_BYTES,
      textChars: String(row.text ?? "").length,
      sync: { synced: row.synced === 1, syncedAt: Number(row.syncedAt) > 0 ? formatTimestamp(Number(row.syncedAt)) : null, revision: row.revision },
      ...noteEditContext(String(row.html ?? ""), String(row.title ?? ""), options) };
  }

  async patchNoteInApp(params: { id: string; expectedVersion: string; operations: PartialOperation[]; dryRun?: boolean; waitMs?: number }) {
    if (!params.id.trim() || !/^[a-f\d]{64}$/.test(params.expectedVersion)) throw new Error("Provide id and expectedVersion from get_note_edit_context.");
    const database = this.nativeSchemaCompatibility();
    const before = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=? AND deleted=0 AND trashed=0").get(params.id.trim());
    if (!before || noteVersion(before) !== params.expectedVersion) throw new Error("The note changed; inspect get_note_edit_context again before patching.");
    assertNativeNoteData(before, "sqlite");
    const plan = planPartialEdit(String(before.html ?? ""), String(before.title ?? ""), params.operations);
    const patch = htmlUpdateFields(before, plan.html);
    const result = await this.applyNativeFields(params.id.trim(), before, patch, database, !!params.dryRun, params.waitMs ?? 20_000);
    const htmlPreserved = result.applied && result.note ? result.note.html === plan.html : result.state === "unchanged" && !params.dryRun ? true : null;
    if (htmlPreserved === false) {
      result.state = "conflict";
      result.message = "UpNote saved HTML that differs from the source-preserving patch. Inspect the note and backup; do not retry or restore automatically.";
    }
    // Never serialize the entire old/new note or a full HTML preview to MCP.
    return { id: result.id, applied: result.applied, state: result.state, uiUpdated: result.uiUpdated,
      cloudSync: result.cloudSync, otherDeviceVerified: false, backupPath: result.backupPath,
      version: result.note?.version ?? null, sync: result.note?.sync ?? null, dryRun: !!params.dryRun,
      htmlPreserved, changes: plan.changes, htmlCharsBefore: plan.htmlCharsBefore, htmlCharsAfter: plan.htmlCharsAfter,
      compatibility: result.compatibility, message: result.message };
  }

  async prepareAppNoteEdit(params: UpdateNoteParams) {
    if (!params.id.trim() || !/^[a-f\d]{64}$/.test(params.expectedVersion)) throw new Error("Provide id and expectedVersion from get_note.");
    if (params.title === undefined && params.content === undefined) throw new Error("Provide title or content.");
    if (params.title !== undefined && (!params.title.trim() || /[\r\n]/.test(params.title))) throw new Error("title must be a non-empty single line.");
    if (params.mode === "append" && !params.content?.trim()) throw new Error("Append requires non-empty content.");
    const running = this.options.isUpNoteRunning ?? isUpNoteRunning;
    if (!running()) throw new Error("Start UpNote before preparing an app-editor edit.");
    const before = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=? AND deleted=0 AND trashed=0").get(params.id);
    if (!before || noteVersion(before) !== params.expectedVersion) throw new Error("The note changed or is unavailable. Read get_note again.");
    if (before.synced !== 1) throw new Error("Wait until the note has synced before preparing an app-editor edit.");
    // Full-note paste cannot safely round-trip external attachment objects.
    if (Number(before.filesCount ?? 0) > 0 || /<img\b|<attachment\b/i.test(String(before.html ?? "")) || (before.fileIds && String(before.fileIds) !== "[]")) {
      throw new Error("App-editor full-note paste currently refuses notes with images/attachments.");
    }
    const patch = prepareNoteUpdate(before, params);
    if (!Object.keys(patch).length) throw new Error("Nothing to change.");
    const desiredTitle = String(patch.title ?? before.title ?? "");
    const desiredText = String(patch.text ?? before.text ?? "");
    const html = String(patch.html ?? before.html ?? "");
    assertNoteHtmlSize(html);
    // Snapshot under a writer reservation, but do not update any UpNote rows.
    const writer = new Database(this.dbPath, { readwrite: true, create: false, strict: true });
    let backupPath: string;
    try {
      writer.exec("PRAGMA busy_timeout=2000; BEGIN IMMEDIATE");
      const current = writer.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(params.id);
      if (!current || noteVersion(current) !== params.expectedVersion) throw new Error("The note changed before backup. Read get_note again.");
      backupPath = this.backupBeforeEdit(current);
    } finally {
      if (writer.inTransaction) writer.exec("ROLLBACK");
      writer.close();
    }
    const ticket = randomUUID();
    const payloadPath = join(dirname(backupPath), "app-edit-clipboard.json");
    writeFileSync(payloadPath, JSON.stringify({ kind: "upnote-app-edit-v1", id: params.id, title: desiredTitle, html, text: desiredText }, null, 2));
    await (this.options.stageClipboard ?? stageNoteClipboard)(payloadPath);
    // Fail rather than encouraging a stale clipboard paste if staging took time.
    const current = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(params.id);
    if (!current || noteVersion(current) !== params.expectedVersion) throw new Error(`The note changed during preparation. Do not paste. Backup: ${backupPath}`);
    for (const [key, value] of this.appEdits) if (Date.now() - value.preparedAt > 10 * 60_000) this.appEdits.delete(key);
    this.appEdits.set(ticket, { id: params.id, before, desiredTitle, desiredText, backupPath, preparedAt: Date.now() });
    return {
      ticket, id: params.id, currentTitle: String(before.title ?? ""), title: desiredTitle, url: noteUrl(params.id), backupPath, clipboardStaged: true,
      proposed: { title: desiredTitle, text: desiredText, html },
      instructions: [
        "Use the computer-use client to open the note URL and verify the target note ID and currentTitle (the proposed title may differ). Do not paste into any other app or field.",
        "Ensure nobody is editing this note in another window. Click inside its editor, inspect focus, then select all note content and paste with Ctrl+V (rich HTML is staged).",
        "Inspect the editor to verify the proposed contents are visible. The note title is included in the staged content; do not create a replacement note.",
        "Call complete_app_note_edit with this ticket. Only state=synced acknowledges app-reported server sync. Never set synced/syncedAt manually or retry the paste automatically.",
      ],
      warnings: ["The Windows clipboard has been replaced. Concurrent unsaved edits cannot be guarded by a database version token. Images/attachments are unsupported in this full-note-paste workflow."],
    };
  }

  async completeAppNoteEdit(ticket: string, waitMs = 15_000): Promise<AppEditVerification> {
    const session = this.appEdits.get(ticket);
    if (!session || Date.now() - session.preparedAt > 10 * 60_000) throw new Error("Unknown or expired app-edit ticket. Do not paste again automatically.");
    const normalize = (text: unknown) => String(text ?? "").replace(/\s+/gu, " ").trim();
    const result: AppEditVerification = {
      id: session.id, state: "awaiting_edit", applied: false, cloudSync: "unverified", otherDeviceVerified: false,
      backupPath: session.backupPath, syncedAt: null, note: null, message: "The staged edit has not been saved by UpNote yet.",
    };
    const deadline = Date.now() + Math.min(30_000, Math.max(0, waitMs));
    do {
      try {
        const row = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(session.id);
        if (!row || row.deleted !== 0 || row.trashed !== 0 || row.createdAt !== session.before.createdAt) {
          result.state = "conflict"; result.message = "The target note is unavailable or its identity changed. Inspect it; do not retry the paste."; return result;
        }
        result.note = this.getNote(session.id);
        const matches = row.title === session.desiredTitle && normalize(row.text) === normalize(session.desiredText);
        if (matches) {
          result.applied = true;
          result.syncedAt = formatTimestamp(Number(row.syncedAt) || null);
          if (row.synced === 1 && Number(row.syncedAt) >= Number(row.updatedAt) && Number(row.syncedAt) >= session.preparedAt) {
            result.state = "synced"; result.cloudSync = "app_acknowledged";
            result.message = "UpNote saved the expected content under the same ID and recorded a fresh sync acknowledgement. Other-device receipt was not independently checked.";
            return result;
          }
          result.state = "awaiting_sync"; result.message = "The expected edit is saved locally, but UpNote has not acknowledged syncing it yet.";
        } else if (noteVersion(row) !== noteVersion(session.before)) {
          result.state = "conflict"; result.message = "The saved content differs from the staged edit. Inspect the editor and backup; do not paste again automatically."; return result;
        }
      } catch (error) {
        result.state = "unavailable"; result.message = `Cannot verify the saved edit: ${String(error)}. Do not paste again automatically.`; return result;
      }
      if (Date.now() >= deadline) return result;
      await Bun.sleep(250);
    } while (true);
  }

  async updateNote(params: UpdateNoteParams): Promise<UpdateNoteResult> {
    const id = params.id.trim();
    if (!id || !/^[a-f\d]{64}$/.test(params.expectedVersion)) {
      throw new Error("Provide id and expectedVersion from a fresh get_note result.");
    }
    if (params.title === undefined && params.content === undefined) throw new Error("Provide title or content to update.");
    if (params.title !== undefined && (!params.title.trim() || /[\r\n]/.test(params.title))) throw new Error("title must be a non-empty single line.");
    if (params.mode !== undefined && params.mode !== "replace" && params.mode !== "append") throw new Error("Invalid edit mode.");
    if (params.contentFormat !== undefined && params.contentFormat !== "markdown" && params.contentFormat !== "text") throw new Error("Invalid content format.");
    if (params.mode === "append" && !params.content?.trim()) throw new Error("Append requires non-empty content.");

    const detectRunning = this.options.isUpNoteRunning ?? isUpNoteRunning;
    let appRunning = detectRunning();
    const warnings = ["Cloud sync and the UpNote UI cache are unverified. Tags, link indexes and attachment metadata are not recalculated."];
    const assertAppState = (row: Record<string, unknown>) => {
      // Recheck immediately before mutation; SQLite cannot prevent UpNote starting later.
      appRunning = detectRunning();
      if (appRunning && !params.allowWhileRunning) throw new Error("UpNote is running. Quit it, or explicitly use experimental allowWhileRunning=true.");
      if (appRunning && row.synced !== 1) throw new Error("The note has pending sync changes. Wait for sync and fetch get_note again before a live edit.");
    };
    const readRow = (db: Database) => {
      const row = db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id = ? AND deleted = 0 AND trashed = 0").get(id);
      if (!row) throw new Error(`Active note not found: ${id}`);
      if (noteVersion(row) !== params.expectedVersion) throw new Error("The note changed since get_note. Fetch it again and review the changes; do not retry blindly.");
      return row;
    };
    const initial = readRow(this.db);
    const patch = prepareNoteUpdate(initial, params);
    assertNoteHtmlSize(String(patch.html ?? initial.html ?? ""));
    const changedFields = Object.keys(patch);
    const result: UpdateNoteResult = {
      id, dryRun: params.dryRun ?? false, committed: false, changedFields, backupPath: null, appRunning,
      databaseVerification: params.dryRun ? "preview" : "unchanged", cloudSync: "unverified", warnings,
      note: this.getNote(id),
      preview: params.dryRun ? {
        title: String(patch.title ?? initial.title ?? ""),
        content: String(patch.text ?? initial.text ?? ""),
        html: String(patch.html ?? initial.html ?? ""),
      } : null,
    };
    if (params.dryRun || !changedFields.length) return result;
    assertAppState(initial);

    const writer = new Database(this.dbPath, { readwrite: true, create: false, strict: true });
    try {
      writer.exec("PRAGMA busy_timeout = 2000");
      const columns = new Set(writer.query<{ name: string }, []>("PRAGMA table_info(notes)").all().map((column) => column.name));
      for (const column of ["synced", "revision", "updatedAt", ...changedFields]) {
        if (!columns.has(column)) throw new Error(`Unsupported UpNote schema: missing notes.${column}`);
      }
      writer.exec("BEGIN IMMEDIATE");
      try {
        const current = readRow(writer);
        assertAppState(current);
        // Holding the writer reservation prevents another SQL writer from changing
        // the snapshot between the backup and this edit. Readers remain available.
        result.backupPath = this.backupBeforeEdit(current);
        assertAppState(current);
        const updatedAt = Math.max(Date.now(), Number(current.updatedAt ?? 0) + 1);
        writer.query(`UPDATE notes SET ${changedFields.map((key) => `"${key}" = ?`).join(", ")}, synced = 0, revision = COALESCE(revision, 0) + 1, updatedAt = ? WHERE id = ? AND deleted = 0 AND trashed = 0`)
          .run(...Object.values(patch), updatedAt, id);
        writer.exec("COMMIT");
        result.committed = true;
      } catch (error) {
        if (writer.inTransaction) writer.exec("ROLLBACK");
        throw new Error(`Edit not committed. ${String(error)}${result.backupPath ? ` Backup: ${result.backupPath}` : ""}`);
      }
    } finally {
      writer.close();
    }

    result.appRunning = appRunning;
    if (appRunning) warnings.push("Experimental live edit: UpNote may overwrite this change later from its in-memory cache. A matching DB read does not prove UI reload or cloud sync. Do not automatically retry or restore the database.");
    const deadline = Date.now() + (appRunning ? this.options.observeLiveMs ?? 2_000 : 0);
    try {
      do {
        const actual = this.db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id = ?").get(id);
        if (!actual || actual.deleted !== 0 || actual.trashed !== 0 || changedFields.some((key) => actual[key] !== patch[key])) {
          result.databaseVerification = "conflict";
          warnings.push("The database changed after commit. Inspect the backup and current note before taking further action.");
          break;
        }
        result.databaseVerification = "matches";
        if (Date.now() >= deadline) break;
        await Bun.sleep(200);
      } while (true);
      result.note = this.getNote(id);
    } catch (error) {
      if (result.databaseVerification !== "conflict") result.databaseVerification = "unavailable";
      result.note = null;
      warnings.push(`Edit committed, but read-back failed: ${String(error)}. Do not retry blindly.`);
    }
    return result;
  }

  listNotebooks(): NotebookResult[] {
    try {
      const rows = this.db
        .query<NotebookRow, []>(
          `
            SELECT
              nb.id,
              nb.title,
              nb.parent,
              nb.updatedAt,
              CASE
                WHEN EXISTS (
                  SELECT 1
                  FROM lists l
                  WHERE l.id = 'notebooks_' || nb.id AND l.deleted = 0
                ) THEN (
                  SELECT COUNT(*)
                  FROM lists l,
                    json_each(
                      CASE
                        WHEN json_valid(l.content) THEN l.content
                        ELSE '[]'
                      END
                    ) noteIds
                  WHERE l.id = 'notebooks_' || nb.id AND l.deleted = 0
                )
                ELSE (
                  SELECT COUNT(*)
                  FROM organizers o
                  WHERE o.notebookId = nb.id AND o.deleted = 0
                )
              END AS noteCount
            FROM notebooks nb
            WHERE nb.deleted = 0 AND nb.inactive = 0
            ORDER BY nb.title ASC
          `,
        )
        .all();

      return rows.map((row) => ({
        id: row.id,
        title: row.title?.trim() || "Untitled",
        noteCount: row.noteCount,
        parent: row.parent?.trim() || null,
        updatedAt: formatTimestamp(row.updatedAt),
        url: notebookUrl(row.id),
      }));
    } catch (error) {
      throw new Error(`Failed to list notebooks: ${String(error)}`);
    }
  }

  listTags(): TagResult[] {
    try {
      const rows = this.db
        .query<TagRow, []>(
          `
            SELECT id, title, updatedAt
            FROM tags
            WHERE deleted = 0 AND inactive = 0
            ORDER BY title ASC
          `,
        )
        .all();

      return rows.map((row) => ({
        id: row.id,
        title: row.title?.trim() || "",
        updatedAt: formatTimestamp(row.updatedAt),
        url: tagUrl(row.title?.trim() || ""),
      }));
    } catch (error) {
      throw new Error(`Failed to list tags: ${String(error)}`);
    }
  }

  listRecentNotes(limit = 10): SearchNoteResult[] {
    const clamped = Math.min(Math.max(limit, 1), 50);

    try {
      const rows = this.db
        .query<SearchNoteRow, [number]>(
          `
            SELECT
              id,
              title,
              substr(COALESCE(text, summary, ''), 1, 240) AS preview,
              updatedAt,
              createdAt
            FROM notes
            WHERE deleted = 0
              AND trashed = 0
            ORDER BY updatedAt DESC
            LIMIT ?
          `,
        )
        .all(clamped);

      return rows.map((row) => ({
        id: row.id,
        title: row.title?.trim() || "Untitled",
        preview: normalizeMultilineText(row.preview),
        updatedAt: formatTimestamp(row.updatedAt),
        createdAt: formatTimestamp(row.createdAt),
        url: noteUrl(row.id),
      }));
    } catch (error) {
      throw new Error(`Failed to list recent notes: ${String(error)}`);
    }
  }

  listNotesThisWeek(limit = 50): SearchNoteResult[] {
    return this.listNotesUpdatedSince(startOfCurrentWeek(), limit, "this week");
  }

  listNotesThisMonth(limit = 50): SearchNoteResult[] {
    return this.listNotesUpdatedSince(startOfCurrentMonth(), limit, "this month");
  }

  findNotes(params: FindNotesParams): SearchNoteResult[] {
    const period = params.period ?? "recent";
    const limit = Math.min(Math.max(params.limit ?? 10, 1), 100);
    const clauses = ["deleted = 0", "trashed = 0"];
    const values: Array<string | number> = [];

    if (period === "this_week") {
      clauses.push("updatedAt >= ?");
      values.push(startOfCurrentWeek());
    } else if (period === "this_month") {
      clauses.push("updatedAt >= ?");
      values.push(startOfCurrentMonth());
    }

    if (params.query?.trim()) {
      const likeQuery = `%${params.query.trim()}%`;
      clauses.push("(COALESCE(title, '') LIKE ? OR COALESCE(text, '') LIKE ? OR COALESCE(summary, '') LIKE ?)");
      values.push(likeQuery, likeQuery, likeQuery);
    }

    if (params.tag?.trim()) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(tagLinks) WHERE json_each.value = ?)");
      values.push(params.tag.trim().replace(/^#/, ""));
    }

    values.push(limit);

    try {
      const rows = this.db
        .query<SearchNoteRow, Array<string | number>>(
          `
            SELECT
              id,
              title,
              substr(COALESCE(text, summary, ''), 1, 240) AS preview,
              updatedAt,
              createdAt
            FROM notes
            WHERE ${clauses.join("\n              AND ")}
            ORDER BY updatedAt DESC
            LIMIT ?
          `,
        )
        .all(...values);

      return rows.map((row) => ({
        id: row.id,
        title: row.title?.trim() || "Untitled",
        preview: normalizeMultilineText(row.preview),
        updatedAt: formatTimestamp(row.updatedAt),
        createdAt: formatTimestamp(row.createdAt),
        url: noteUrl(row.id),
      }));
    } catch (error) {
      throw new Error(`Failed to find notes: ${String(error)}`);
    }
  }

  private listNotesUpdatedSince(startMs: number, limit: number, label: string): SearchNoteResult[] {
    const clamped = Math.min(Math.max(limit, 1), 100);

    try {
      const rows = this.db
        .query<SearchNoteRow, [number, number]>(
          `
            SELECT
              id,
              title,
              substr(COALESCE(text, summary, ''), 1, 240) AS preview,
              updatedAt,
              createdAt
            FROM notes
            WHERE deleted = 0
              AND trashed = 0
              AND updatedAt >= ?
            ORDER BY updatedAt DESC
            LIMIT ?
          `,
        )
        .all(startMs, clamped);

      return rows.map((row) => ({
        id: row.id,
        title: row.title?.trim() || "Untitled",
        preview: normalizeMultilineText(row.preview),
        updatedAt: formatTimestamp(row.updatedAt),
        createdAt: formatTimestamp(row.createdAt),
        url: noteUrl(row.id),
      }));
    } catch (error) {
      throw new Error(`Failed to list notes updated ${label}: ${String(error)}`);
    }
  }

  searchByTag(tagTitle: string, limit = 10): SearchNoteResult[] {
    const tag = tagTitle.trim().replace(/^#/, "");
    if (!tag) {
      throw new Error("tagTitle cannot be empty.");
    }

    const clamped = Math.min(Math.max(limit, 1), 50);

    try {
      const rows = this.db
        .query<SearchNoteRow, [string, number]>(
          `
            SELECT
              id,
              title,
              substr(COALESCE(text, summary, ''), 1, 240) AS preview,
              updatedAt,
              createdAt
            FROM notes
            WHERE deleted = 0
              AND trashed = 0
              AND EXISTS (
                SELECT 1
                FROM json_each(tagLinks)
                WHERE json_each.value = ?
              )
            ORDER BY updatedAt DESC
            LIMIT ?
          `,
        )
        .all(tag, clamped);

      return rows.map((row) => ({
        id: row.id,
        title: row.title?.trim() || "Untitled",
        preview: normalizeMultilineText(row.preview),
        updatedAt: formatTimestamp(row.updatedAt),
        createdAt: formatTimestamp(row.createdAt),
        url: noteUrl(row.id),
      }));
    } catch (error) {
      throw new Error(`Failed to search notes by tag: ${String(error)}`);
    }
  }

  searchNotes(params: SearchNotesParams): SearchNoteResult[] {
    const query = params.query.trim();
    if (!query) {
      throw new Error("query cannot be empty.");
    }

    const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
    const likeQuery = `%${query}%`;

    try {
      const rows = this.db
        .query<SearchNoteRow, [string, string, string, number]>(
          `
            SELECT
              id,
              title,
              substr(COALESCE(text, summary, ''), 1, 240) AS preview,
              updatedAt,
              createdAt
            FROM notes
            WHERE deleted = 0
              AND trashed = 0
              AND (
                COALESCE(title, '') LIKE ?
                OR COALESCE(text, '') LIKE ?
                OR COALESCE(summary, '') LIKE ?
              )
            ORDER BY updatedAt DESC
            LIMIT ?
          `,
        )
        .all(likeQuery, likeQuery, likeQuery, limit);

      return rows.map((row) => ({
        id: row.id,
        title: row.title?.trim() || "Untitled",
        preview: normalizeMultilineText(row.preview),
        updatedAt: formatTimestamp(row.updatedAt),
        createdAt: formatTimestamp(row.createdAt),
        url: noteUrl(row.id),
      }));
    } catch (error) {
      throw new Error(`Failed to search UpNote notes: ${String(error)}`);
    }
  }

  getNote(id: string): NoteDetail {
    const noteId = id.trim();
    if (!noteId) {
      throw new Error("id cannot be empty.");
    }

    try {
      const row = this.db
        .query<NoteDetailRow & Record<string, unknown>, [string]>(
          `
            SELECT *
            FROM notes
            WHERE id = ?
              AND deleted = 0
              AND trashed = 0
            LIMIT 1
          `,
        )
        .get(noteId);

      if (!row) {
        throw new Error(`Note not found: ${noteId}`);
      }

      return {
        id: row.id,
        title: row.title?.trim() || "Untitled",
        content: normalizeMultilineText(row.text),
        html: row.html ?? "",
        summary: row.summary ?? "",
        updatedAt: formatTimestamp(row.updatedAt),
        createdAt: formatTimestamp(row.createdAt),
        url: noteUrl(row.id),
        version: noteVersion(row),
        sync: { synced: row.synced === 1, syncedAt: Number(row.syncedAt) > 0 ? formatTimestamp(Number(row.syncedAt)) : null, revision: typeof row.revision === "number" ? row.revision : null },
      };
    } catch (error) {
      throw new Error(`Failed to get UpNote note: ${String(error)}`);
    }
  }
}
