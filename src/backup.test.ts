import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { backupNote } from "./backup";
import { noteVersion } from "./editing";

const directories: string[] = [];
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "upnote-note-backup-"));
  directories.push(directory);
  return { root: join(directory, "backups"), source: join(directory, "source.sqlite3") };
}

test("single-note archive preserves all row values, blobs and quoted/additive columns", () => {
  const f = fixture();
  const row = { id: "note-a", title: "日本語", html: "<h2>日本語</h2>", text: "本文", nullable: null,
    integer: 42, real: 0.25, numericText: "00123", blob: new Uint8Array([0, 255, 1]), 'quoted"column': "kept" };
  const path = backupNote(row, f.root, f.source);
  expect(path.endsWith("note.sqlite3")).toBe(true);
  const db = new Database(path, { readonly: true, create: false });
  try {
    expect(db.query("SELECT * FROM notes").all()).toEqual([row]);
    expect(db.query("SELECT typeof(numericText) AS kind FROM notes").get()).toEqual({ kind: "text" });
    expect(db.query("SELECT * FROM mcp_backup_metadata").get()).toMatchObject({
      format_version: 1, kind: "upnote-note", note_id: "note-a", note_version: noteVersion(row), source_database: f.source,
    });
    expect(db.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
  } finally { db.close(); }
});

test("successive edits retain independent note backups instead of overwriting an earlier revision", () => {
  const f = fixture();
  const before = backupNote({ id: "note-a", text: "before" }, f.root, f.source);
  const after = backupNote({ id: "note-a", text: "after" }, f.root, f.source);
  expect(before).not.toBe(after);
  for (const [path, text] of [[before, "before"], [after, "after"]]) {
    const db = new Database(path!, { readonly: true, create: false });
    try { expect(db.query("SELECT text FROM notes").get()).toEqual({ text }); }
    finally { db.close(); }
  }
});

test("missing identity or unsupported SQLite values cannot produce a successful backup", () => {
  const f = fixture();
  expect(() => backupNote({ id: "" }, f.root, f.source)).toThrow("note ID");
  expect(() => backupNote({ id: "note-a", unknown: { nested: true } }, f.root, f.source)).toThrow("Unsupported SQLite value");
  expect(existsSync(f.root)).toBe(false);
});
