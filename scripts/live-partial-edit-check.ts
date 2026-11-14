import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NativeConnection } from "../src/native-bridge";
import { htmlToPlainText, assertNoteHtmlSize } from "../src/editing";

const [outputPath, optIn, existingId] = process.argv.slice(2);
if (!outputPath || !["--create-long-test-note", "--existing-test-note"].includes(optIn ?? "") || (optIn === "--existing-test-note" && !existingId)) throw new Error("Usage: bun run scripts/live-partial-edit-check.ts OUTPUT_JSON --create-long-test-note (or --existing-test-note ID)");
const registration: any = (Bun.TOML.parse(readFileSync(join(process.env.USERPROFILE!, ".codex/config.toml"), "utf8")) as any).mcp_servers["upnote-local"];
const endpoint = registration.env.UPNOTE_CDP_URL;
const dbPath = registration.env.UPNOTE_DB;
const id = existingId ?? Bun.randomUUIDv7();
const title = `MCP実機テスト 長文部分編集 ${new Date().toISOString()}`;
const tail = Array.from({ length: 1400 }, (_, index) => `<div class="unchanged-paragraph">段落${index}: ${"長文の書式を保持します。".repeat(8)} <i>固定の書式</i></div>`).join("\n");
const sectionHeading = "<h2>対象節</h2>"; const tailHeading = "<h2>保持する節</h2>";
const html = `<h2>${Bun.escapeHTML(title)}</h2><h2>導入</h2><div data-preserve="source"><span class="shine-highlight-yellow" style="color:rgb(200,0,0)">KEEP_HIGHLIGHT</span> <b>OLD_LITERAL</b> <i>KEEP_ITALIC</i></div><table style="width:300px"><tbody><tr><td><b>KEEP_TABLE</b></td><td>固定セル</td></tr></tbody></table>${sectionHeading}<div>変更前の節本文</div>${tailHeading}${tail}`;
const text = htmlToPlainText(html);
const hash = (value: unknown) => createHash("sha256").update(String(value)).digest("hex");
const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
const client = new Client({ name: "live-partial-note-check", version: "1.0.0" });
const transport = new StdioClientTransport({ command: registration.command, args: registration.args, env: { ...env, ...registration.env }, stderr: "pipe" });
const db = new Database(dbPath, { readonly: true, create: false });
const row = () => db.query<Record<string, unknown>, [string]>("SELECT * FROM notes WHERE id=?").get(id)!;
try {
  await client.connect(transport);
  const ready = await client.callTool({ name: "ensure_upnote_connection", arguments: {} });
  assert.notEqual(ready.isError, true);
  if (optIn === "--create-long-test-note") {
    assertNoteHtmlSize(html);
    const seed = { id, title, html, text };
    const connection = await NativeConnection.connect(endpoint);
    try {
    await connection.evaluate(`(async note => {
      const p=document.querySelector('#app').__vue_app__.config.globalProperties.$pinia;
      const s=p._s.get('coreStore'), lock=p._s.get('lockStore');
      if(s.isCurrentNoteModified || lock.shouldShowAppLock || lock.shouldShowPartialLock || s.currentWorkspaceLocked)throw new Error('Unsaved/locked state; refusing test creation');
      if(s.spaceId)throw new Error('Use the default workspace for this test');
      if(!s.user && !s.cachedUser)throw new Error('Signed-in profile required');
      if(s.notes.has(note.id))throw new Error('Test ID already exists');
      const now=Date.now(); await s.updateNotes([{...note,createdAt:now,updatedAt:now,space:s.spaceId}]);
      await s.setNavigationState({...s.current,mode:'notes-all',noteId:note.id});p._s.get('uiStore').setSelectedNoteId(note.id);
    })(${JSON.stringify(seed)})`, 30_000);
    } finally { connection.close(); }
  } else assert.ok(String(row()?.title).startsWith("MCP実機テスト 長文部分編集 "), "Only an existing dedicated test note can be used");
  const deadline = Date.now() + 40_000;
  while (!row()?.synced || Number(row().syncedAt) < Number(row().updatedAt)) {
    if (Date.now() >= deadline) throw new Error(`Test seed did not sync; inspect test note ${id}`);
    await Bun.sleep(300);
  }
  const before = row(); assert.ok(String(before.title).startsWith("MCP実機テスト 長文部分編集 "));
  console.log(JSON.stringify({ phase: "long-note-created", id, htmlChars: String(before.html).length, textChars: String(before.text).length, htmlBytes: Buffer.byteLength(String(before.html)) }));
  const context = await client.callTool({ name: "get_note_edit_context", arguments: { id, find: "OLD_LITERAL", limit: 5 } });
  assert.notEqual(context.isError, true);
  const data = context.structuredContent as any;
  assert.equal(data.search.total, 1); assert.equal(data.outline.total, 3);
  const args = { id, expectedVersion: data.version, operations: [
    { type: "replace_text", find: "OLD_LITERAL", replacement: "NEW_LITERAL", expectedMatches: 1 },
    { type: "replace_section", section: { heading: "対象節", level: 2 }, content: "**更新後の節本文**", contentFormat: "markdown" },
  ], waitMs: 30_000 };
  const preview = await client.callTool({ name: "patch_note_in_app", arguments: { ...args, dryRun: true } });
  assert.notEqual(preview.isError, true); assert.equal((preview.structuredContent as any).applied, false);
  assert.equal(hash(row().html), hash(before.html));
  const response = await client.callTool({ name: "patch_note_in_app", arguments: args });
  const result = response.structuredContent as any;
  assert.notEqual(response.isError, true); assert.equal(result.state, "synced"); assert.equal(result.htmlPreserved, true);
  const after = row(); assert.equal(after.id, before.id); assert.equal(after.createdAt, before.createdAt);
  const oldHtml = String(before.html); const newHtml = String(after.html);
  const oldSectionStart = oldHtml.indexOf(sectionHeading) + sectionHeading.length;
  const newSectionStart = newHtml.indexOf(sectionHeading) + sectionHeading.length;
  const oldTail = oldHtml.indexOf(tailHeading); const newTail = newHtml.indexOf(tailHeading);
  assert.ok(oldSectionStart >= sectionHeading.length && newSectionStart >= sectionHeading.length && oldTail > oldSectionStart && newTail > newSectionStart);
  assert.equal(newHtml.slice(0, newSectionStart), oldHtml.slice(0, oldSectionStart).replace("OLD_LITERAL", "NEW_LITERAL"));
  assert.equal(hash(newHtml.slice(newTail)), hash(oldHtml.slice(oldTail)));
  assert.ok(newHtml.slice(newSectionStart, newTail).includes("更新後の節本文"));
  const stale = await client.callTool({ name: "patch_note_in_app", arguments: args }); assert.equal(stale.isError, true);
  assert.equal(hash(row().html), hash(after.html));
  const backup = new Database(result.backupPath, { readonly: true, create: false });
  let backupMatches; let integrity;
  try { backupMatches = JSON.stringify(backup.query("SELECT * FROM notes WHERE id=?").get(id)) === JSON.stringify(before); integrity = backup.query("PRAGMA integrity_check").all(); }
  finally { backup.close(); }
  assert.equal(backupMatches, true); assert.deepEqual(integrity, [{ integrity_check: "ok" }]);
  const channel = await NativeConnection.connect(endpoint);
  let ui: any;
  try {
    ui = await channel.evaluate(`(() => { const e=document.querySelector('.shine-editor'); const span=[...e.querySelectorAll('span')].find(x=>x.textContent==='KEEP_HIGHLIGHT');return{highlightClass:span?.className,highlightStyle:span?.getAttribute('style'),boldNewLiteral:[...e.querySelectorAll('b,strong')].some(x=>x.textContent==='NEW_LITERAL'),keptTable:[...e.querySelectorAll('td')].some(x=>x.textContent.includes('KEEP_TABLE'))};})()`);
  } finally { channel.close(); }
  assert.equal(ui.boldNewLiteral, true); assert.equal(ui.keptTable, true); assert.ok(ui.highlightClass?.includes("shine-highlight-yellow"));
  const bytes = { noteHtml: Buffer.byteLength(oldHtml), patchRequest: Buffer.byteLength(JSON.stringify(args)), contextResponse: Buffer.byteLength(JSON.stringify(context)), patchResponse: Buffer.byteLength(JSON.stringify(response)) };
  assert.ok(bytes.patchRequest < 2000 && bytes.patchResponse < 20_000 && bytes.contextResponse < 20_000);
  const evidence = { testedAt: new Date().toISOString(), id, title: before.title, result, bytes, htmlChars: oldHtml.length, textChars: String(before.text).length,
    sameId: true, sameCreatedAt: true, untouchedPrefixVerified: true, untouchedTailHash: hash(oldHtml.slice(oldTail)), untouchedTailVerified: true,
    backupMatches, integrity, staleVersionRejected: true, ui, acknowledgementLatencyMs: Number(after.syncedAt) - Number(after.updatedAt),
    fullNoteSentByAi: false, otherDeviceVerified: false };
  writeFileSync(outputPath, JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ outputPath, id, state: result.state, htmlPreserved: result.htmlPreserved, htmlChars: oldHtml.length, textChars: evidence.textChars, bytes, backupMatches, staleVersionRejected: true, ui, acknowledgementLatencyMs: evidence.acknowledgementLatencyMs }, null, 2));
} finally { await client.close(); db.close(); }
