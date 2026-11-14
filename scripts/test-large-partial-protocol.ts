import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const directory = mkdtempSync(join(tmpdir(), "upnote-large-patch-"));
const path = join(directory, "fixture.sqlite3");
const db = new Database(path);
const title = "Long test"; const body = "x".repeat(6 * 1024 * 1024);
const html = `<h2>${title}</h2><h2>Section</h2><p>TARGET ${body}</p>`;
db.exec(`CREATE TABLE notes(id TEXT PRIMARY KEY,title TEXT,html TEXT,text TEXT,summary TEXT,space TEXT,fileIds TEXT,filesCount INTEGER,hasTodo INTEGER,
  createdAt DOUBLE,updatedAt DOUBLE,syncedAt DOUBLE,revision INTEGER,synced INTEGER,deleted INTEGER,trashed INTEGER)`);
db.query("INSERT INTO notes VALUES(?,?,?,?,?,NULL,'[]',0,0,1,1,1,1,1,0,0)").run("long-id", title, html, title + "\nSection\nTARGET " + body, "Long test");
const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
  fetch(request, server) {
    const p = new URL(request.url).pathname;
    if (p === "/json/version") return Response.json({ "User-Agent": "UpNote/any-compatible-version" });
    if (p === "/json/list") return Response.json([{ id: "main", type: "page", url: "file:///C:/UpNote/app/resources/app.asar/dist/electron/index.html", webSocketDebuggerUrl: `ws://127.0.0.1:${server.port}/devtools/page/main` }]);
    if (p === "/devtools/page/main" && server.upgrade(request)) return;
    return new Response("Not found", { status: 404 });
  },
  websocket: { maxPayloadLength: 32 * 1024 * 1024, message(socket, input) {
    const request = JSON.parse(String(input));
    socket.send(JSON.stringify({ id: request.id, result: { result: { value: { compatibility: { compatible: true }, editorMatches: true } } } }));
  } },
});
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const client = new Client({ name: "large-partial-test", version: "1.0.0" });
try {
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["run", resolve(import.meta.dir, "../src/index.ts")],
    env: { ...env, UPNOTE_DB: path, UPNOTE_CDP_URL: `http://127.0.0.1:${server.port}`, UPNOTE_AUTO_START: "0" }, stderr: "pipe" }));
  const context = await client.callTool({ name: "get_note_edit_context", arguments: { id: "long-id", find: "TARGET", limit: 1 } });
  assert.notEqual(context.isError, true);
  const contextChars = JSON.stringify(context).length; assert.ok(contextChars < 5000);
  const data = context.structuredContent as any;
  assert.ok(data.htmlChars > 6 * 1024 * 1024); assert.equal(data.search.total, 1);
  const request = { id: "long-id", expectedVersion: data.version, dryRun: true, operations: [{ type: "replace_text", find: "TARGET", replacement: "CHANGED" }] };
  assert.ok(JSON.stringify(request).length < 300);
  const oversized = await client.callTool({ name: "patch_note_in_app", arguments: request });
  assert.equal(oversized.isError, true); assert.ok(JSON.stringify(oversized.content).includes("cloud-sync safety ceiling"));
  assert.equal(db.query<{ html: string }, []>("SELECT html FROM notes").get()!.html.length, html.length);
  const smaller = "<h2>Long test</h2><h2>Section</h2><p>TARGET " + "x".repeat(800_000) + "</p>";
  db.query("UPDATE notes SET html=?,text=?").run(smaller, "Long test\nSection\nTARGET " + "x".repeat(800_000));
  const refreshed = await client.callTool({ name: "get_note_edit_context", arguments: { id: "long-id" } });
  request.expectedVersion = (refreshed.structuredContent as any).version;
  const preview = await client.callTool({ name: "patch_note_in_app", arguments: request });
  assert.notEqual(preview.isError, true);
  const result = preview.structuredContent as any;
  assert.equal(result.applied, false); assert.equal(result.dryRun, true); assert.equal(result.backupPath, null);
  const previewChars = JSON.stringify(preview).length; assert.ok(previewChars < 10_000);
  assert.equal(db.query<{ html: string }, []>("SELECT html FROM notes").get()!.html.length, smaller.length);
  console.log(JSON.stringify({ oversizedRejected: true, contextChars, previewChars, noteUnchanged: true }));
} finally {
  await client.close(); server.stop(true); db.close();
  assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
  rmSync(directory, { recursive: true, force: true });
}
