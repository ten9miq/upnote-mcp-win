import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import packageInfo from "../package.json";

if (process.platform !== "win32") throw new Error("This fork builds Windows MCPB bundles only. Build on the target Windows architecture.");
const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(readFileSync(resolve(root, "mcpb-bundle/manifest.json"), "utf8"));
if (manifest.name !== "upnote-mcp-win" || manifest.version !== packageInfo.version || manifest.server.entry_point !== "server/upnote-mcp-win.exe") {
  throw new Error("Package and Windows bundle metadata must agree before building.");
}
const server = resolve(root, "mcpb-bundle/server");
mkdirSync(server, { recursive: true });
mkdirSync(resolve(root, "dist"), { recursive: true });
async function run(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await child.exited !== 0) throw new Error(`Build step failed: ${args[0]}`);
}
await run([process.execPath, "build", "--compile", "src/index.ts", "--outfile", resolve(server, "upnote-mcp-win.exe")]);
copyFileSync(resolve(root, "src/note-clipboard.ps1"), resolve(server, "note-clipboard.ps1"));
copyFileSync(resolve(root, "LICENSE"), resolve(root, "mcpb-bundle/LICENSE"));
await run([process.execPath, "x", "@anthropic-ai/mcpb@2.1.2", "pack", "mcpb-bundle", `dist/upnote-mcp-win-${packageInfo.version}-win32-${process.arch}.mcpb`]);
