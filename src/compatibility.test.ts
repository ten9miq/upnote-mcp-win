import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertNativeSchema, assertNativeNoteData, sqliteAffinity, type NativeColumn } from "./compatibility";

function columns() {
  const db = new Database(":memory:");
  try {
    db.exec(`CREATE TABLE notes (
      id TEXT PRIMARY KEY, title VARCHAR(500), html CLOB, text TEXT, summary TEXT, fileIds TEXT, space TEXT,
      createdAt INTEGER, updatedAt REAL, syncedAt DOUBLE, revision BIGINT,
      synced BOOLEAN, deleted INTEGER, trashed INTEGER, hasTodo INTEGER, filesCount INTEGER,
      futureColumn BLOB
    )`);
    return db.query<NativeColumn, []>("PRAGMA table_xinfo(notes)").all();
  } finally { db.close(); }
}

test("native DB compatibility accepts equivalent affinities, extra columns and changed schema versions", () => {
  const schema = columns();
  expect(assertNativeSchema("table", schema, true, 999).compatible).toBe(true);
  expect(assertNativeSchema("table", schema.reverse(), true, 1000).extraColumnsAllowed).toBe(true);
  expect(sqliteAffinity("VARCHAR(500)")).toBe("text");
  expect(sqliteAffinity("DOUBLE PRECISION")).toBe("numeric");
  expect(sqliteAffinity("BOOLEAN")).toBe("numeric");
});

test("native DB compatibility rejects missing, generated and incompatible columns and lost identity", () => {
  const schema = columns();
  expect(() => assertNativeSchema("table", schema.filter(c => c.name !== "syncedAt"), true, 1)).toThrow("missing notes.syncedAt");
  expect(() => assertNativeSchema("table", schema.map(c => c.name === "revision" ? { ...c, type: "TEXT" } : c), true, 1)).toThrow("notes.revision requires numeric");
  expect(() => assertNativeSchema("table", schema.map(c => c.name === "html" ? { ...c, hidden: 3 } : c), true, 1)).toThrow("non-generated");
  expect(() => assertNativeSchema("table", schema, false, 1)).toThrow("unique index");
  expect(() => assertNativeSchema("view", schema, true, 1)).toThrow("must be a table");
});

test("note value checks reject dynamic SQLite type drift even under a compatible declared schema", () => {
  const row = { id: "id", title: null, html: "<p>x</p>", text: "x", summary: null, space: null,
    createdAt: 1, updatedAt: 2, syncedAt: -1, revision: 0, synced: 0, deleted: 0, trashed: 0, hasTodo: null, filesCount: 0, fileIds: "[]" };
  expect(() => assertNativeNoteData(row, "sqlite")).not.toThrow();
  expect(() => assertNativeNoteData({ ...row, synced: "false" }, "sqlite")).toThrow("synced");
  expect(() => assertNativeNoteData({ ...row, revision: NaN }, "sqlite")).toThrow("revision");
  expect(() => assertNativeNoteData({ ...row, updatedAt: "2026-11-14" }, "sqlite")).toThrow("updatedAt");
  expect(() => assertNativeNoteData({ ...row, fileIds: "{}" }, "sqlite")).toThrow("fileIds");
  expect(() => assertNativeNoteData({ ...row, fileIds: ["id"] }, "sqlite")).toThrow("JSON string");
  expect(() => assertNativeNoteData({ ...row, synced: false, fileIds: new Set(["image-id"]) }, "app")).not.toThrow();
});
