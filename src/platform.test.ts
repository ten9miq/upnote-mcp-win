import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { getUpNoteUrlOpenerCommand } from "./url";
import { resolveUpnoteDbPath, UpNoteRepository } from "./upnote";

test("UPNOTE_DB overrides every platform default", () => {
  expect(resolveUpnoteDbPath({
    platform: "win32",
    homeDir: "C:\\Users\\test",
    env: { UPNOTE_DB: "D:\\custom\\upnote.sqlite3", APPDATA: "C:\\ignored" },
  })).toBe("D:\\custom\\upnote.sqlite3");
});

test("Windows defaults to APPDATA\\UpNote\\upnote.sqlite3", () => {
  expect(resolveUpnoteDbPath({
    platform: "win32",
    env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming" },
  })).toBe("C:\\Users\\test\\AppData\\Roaming\\UpNote\\upnote.sqlite3");
});

test("macOS keeps the existing container path", () => {
  expect(resolveUpnoteDbPath({
    platform: "darwin",
    homeDir: "C:\\Users\\test",
    env: {},
  })).toContain("Library\\Containers\\com.getupnote.desktop");
});

test("Windows URL opening passes the URL as an argument", () => {
  const url = "upnote://x-callback-url/note/new?title=one%26two&text=a%3Db";
  expect(getUpNoteUrlOpenerCommand(url, "win32")).toEqual([
    "rundll32.exe",
    "url.dll,FileProtocolHandler",
    url,
  ]);
});

test("a missing database error includes the checked path", () => {
  const missingPath = join(import.meta.dir, "does-not-exist.sqlite3");
  expect(() => new UpNoteRepository(missingPath)).toThrow(`Checked path: ${missingPath}`);
});

test("notebook counts use current lists metadata and retain organizers fallback", () => {
  const directory = mkdtempSync(join(tmpdir(), "upnote-mcp-test-"));
  const dbPath = join(directory, "upnote.sqlite3");
  const fixture = new Database(dbPath);

  try {
    fixture.exec(`
      CREATE TABLE notebooks (
        id TEXT PRIMARY KEY,
        title TEXT,
        parent TEXT,
        updatedAt DOUBLE,
        deleted INTEGER,
        inactive INTEGER
      );
      CREATE TABLE organizers (
        id TEXT PRIMARY KEY,
        noteId TEXT,
        notebookId TEXT,
        deleted INTEGER
      );
      CREATE TABLE lists (
        id TEXT PRIMARY KEY,
        content TEXT,
        deleted INTEGER
      );
      INSERT INTO notebooks VALUES ('modern', 'Modern', '', 0, 0, 0);
      INSERT INTO notebooks VALUES ('legacy', 'Legacy', '', 0, 0, 0);
      INSERT INTO organizers VALUES ('old-modern', 'outdated-note', 'modern', 0);
      INSERT INTO organizers VALUES ('old-legacy', 'legacy-note', 'legacy', 0);
      INSERT INTO lists VALUES ('notebooks_modern', '["note-a","note-b"]', 0);
    `);
  } finally {
    fixture.close();
  }

  const repository = new UpNoteRepository(dbPath);
  try {
    const notebooks = repository.listNotebooks();
    expect(notebooks.find((notebook) => notebook.id === "modern")?.noteCount).toBe(2);
    expect(notebooks.find((notebook) => notebook.id === "legacy")?.noteCount).toBe(1);
  } finally {
    repository.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
