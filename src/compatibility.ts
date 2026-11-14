export type NativeColumn = { name: string; type: string; pk: number; hidden: number };
export const nativeNoteColumns = {
  id: "text", title: "text", html: "text", text: "text", summary: "text", fileIds: "text", space: "text",
  createdAt: "numeric", updatedAt: "numeric", syncedAt: "numeric", revision: "numeric",
  synced: "numeric", deleted: "numeric", trashed: "numeric", hasTodo: "numeric", filesCount: "numeric",
} as const;

/** SQLite affinity rules, rather than an exact declared-type or schema-version pin. */
export function sqliteAffinity(type: string): "text" | "numeric" | "blob" {
  const name = type.toUpperCase();
  if (name.includes("INT")) return "numeric";
  if (/CHAR|CLOB|TEXT/.test(name)) return "text";
  if (!name || name.includes("BLOB")) return "blob";
  return "numeric";
}

export function assertNativeSchema(tableType: string | undefined, columns: NativeColumn[], uniqueId: boolean, schemaVersion: number) {
  const fail = (reason: string): never => { throw new Error(`Incompatible UpNote DB: ${reason}`); };
  if (tableType !== "table") fail("notes must be a table.");
  const byName = new Map(columns.map(column => [column.name, column]));
  for (const [name, affinity] of Object.entries(nativeNoteColumns)) {
    const column = byName.get(name);
    if (!column) fail(`missing notes.${name}.`);
    if (column!.hidden !== 0) fail(`notes.${name} must be a stored, non-generated column.`);
    if (sqliteAffinity(column!.type) !== affinity) fail(`notes.${name} requires ${affinity} affinity; found ${column!.type || "untyped/BLOB"}.`);
  }
  if (!uniqueId) fail("notes.id must have a single-column primary key or non-partial unique index.");
  return { compatible: true as const, check: "columns-affinities-unique-id" as const, schemaVersion, checkedColumns: Object.keys(nativeNoteColumns), extraColumnsAllowed: true as const };
}

/** Self-contained so the same value checks can run inside the app's renderer. */
export function assertNativeNoteData(value: unknown, source: "sqlite" | "app"): asserts value is Record<string, unknown> {
  const fail = (field: string, expected: string): never => { throw new Error(`Incompatible UpNote ${source} note data: ${field} must be ${expected}.`); };
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("row", "an object");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id) fail("id", "a non-empty string");
  for (const field of ["title", "html", "text", "summary", "space"]) {
    if (!(field in row) || (row[field] !== null && typeof row[field] !== "string")) fail(field, "a string or null");
  }
  for (const field of ["createdAt", "updatedAt", "revision"]) {
    if (!Number.isSafeInteger(row[field]) || Number(row[field]) < 0) fail(field, "a non-negative safe integer");
  }
  if (!("syncedAt" in row) || (row.syncedAt !== null && (!Number.isSafeInteger(row.syncedAt) || Number(row.syncedAt) < -1))) fail("syncedAt", "a millisecond integer, -1, or null");
  for (const field of ["synced", "deleted", "trashed"]) {
    const flag = row[field];
    if (flag !== 0 && flag !== 1 && !(source === "app" && typeof flag === "boolean")) fail(field, source === "app" ? "a boolean or 0/1" : "0 or 1");
  }
  if (!("hasTodo" in row) || (row.hasTodo !== null && row.hasTodo !== 0 && row.hasTodo !== 1 && !(source === "app" && typeof row.hasTodo === "boolean"))) fail("hasTodo", "a compatible boolean flag or null");
  if (!("filesCount" in row) || (row.filesCount !== null && (!Number.isSafeInteger(row.filesCount) || Number(row.filesCount) < 0))) fail("filesCount", "a non-negative safe integer or null");
  if (!("fileIds" in row)) fail("fileIds", "an attachment ID collection");
  let ids: unknown = row.fileIds;
  if (ids === null || ids === "") return;
  if (typeof ids === "string") {
    try { ids = JSON.parse(ids); } catch { fail("fileIds", "a JSON array of strings"); }
  } else if (source === "app" && ids instanceof Set) ids = [...ids];
  else if (source === "sqlite") fail("fileIds", "a JSON string or null");
  if (!Array.isArray(ids) || ids.some(id => typeof id !== "string" || !id)) fail("fileIds", "an array/Set of non-empty strings");
}
