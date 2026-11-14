import { closeSync, existsSync, fsyncSync, mkdirSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { isUpNoteRunning, noteVersion, prepareNoteUpdate, type UpdateNoteParams } from "./editing";

export type { UpdateNoteParams } from "./editing";

type RepositoryOptions = {
  isUpNoteRunning?: () => boolean;
  backupsDir?: string;
  observeLiveMs?: number;
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
  private readonly db: Database;

  constructor(dbPath = resolveUpnoteDbPath(), private readonly options: RepositoryOptions = {}) {
    this.dbPath = dbPath;

    if (!existsSync(this.dbPath)) {
      throw new Error(createMissingDbMessage(this.dbPath));
    }

    try {
      this.db = new Database(this.dbPath, {
        readonly: true,
        create: false,
        strict: true,
      });
    } catch (error) {
      throw new Error(createOpenDbMessage(this.dbPath, error));
    }
  }

  getResolvedDbPath(): string {
    return this.dbPath;
  }

  close(): void {
    this.db.close();
  }

  /** Consistent SQLite snapshot, including committed WAL pages; never copy a live DB file. */
  private backupBeforeEdit(): string {
    const root = resolve(this.options.backupsDir ?? process.env.UPNOTE_BACKUPS_DIR ?? join(dirname(this.dbPath), "MCP Backups"));
    mkdirSync(root, { recursive: true });
    const directory = mkdtempSync(join(root, `edit-${new Date().toISOString().replace(/[:.]/g, "-")}-`));
    const backupPath = join(directory, "upnote.sqlite3");
    const reader = new Database(this.dbPath, { readonly: true, create: false, strict: true });
    try {
      reader.query("VACUUM main INTO ?").run(backupPath);
    } finally {
      reader.close();
    }
    const backup = new Database(backupPath, { readonly: true, create: false });
    try {
      const checks = backup.query<Record<string, string>, []>("PRAGMA quick_check").all();
      if (checks.length !== 1 || Object.values(checks[0]!)[0] !== "ok") {
        throw new Error(`Backup integrity check failed: ${backupPath}`);
      }
    } finally {
      backup.close();
    }
    const fd = openSync(backupPath, "r+");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return backupPath;
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
        result.backupPath = this.backupBeforeEdit();
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
