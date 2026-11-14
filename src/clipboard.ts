import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync } from "node:fs";

export function windowsClipboardHtml(fragment: string): Buffer {
  const prefix = "<html><body><!--StartFragment-->";
  const suffix = "<!--EndFragment--></body></html>";
  const header = (start: number, end: number, fragmentStart: number, fragmentEnd: number) =>
    `Version:0.9\r\nStartHTML:${String(start).padStart(10, "0")}\r\nEndHTML:${String(end).padStart(10, "0")}\r\nStartFragment:${String(fragmentStart).padStart(10, "0")}\r\nEndFragment:${String(fragmentEnd).padStart(10, "0")}\r\n`;
  const start = Buffer.byteLength(header(0, 0, 0, 0));
  const fragmentStart = start + Buffer.byteLength(prefix);
  const fragmentEnd = fragmentStart + Buffer.byteLength(fragment);
  const end = fragmentEnd + Buffer.byteLength(suffix);
  return Buffer.from(header(start, end, fragmentStart, fragmentEnd) + prefix + fragment + suffix + "\0", "utf8");
}

/** Clipboard data preparation only; actual editor input stays with the UI client. */
export async function stageNoteClipboard(payloadPath: string): Promise<void> {
  if (process.platform !== "win32") throw new Error("App-editor clipboard staging currently supports Windows only.");
  const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
  payload.cfHtmlBase64 = windowsClipboardHtml(payload.html).toString("base64");
  writeFileSync(payloadPath, JSON.stringify(payload, null, 2));
  const script = fileURLToPath(new URL("./note-clipboard.ps1", import.meta.url));
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-File", script, "-PayloadPath", payloadPath], {
    stdout: "ignore", stderr: "pipe", windowsHide: true,
  });
  const stderr = await new Response(child.stderr).text();
  if (await child.exited !== 0) throw new Error(`Clipboard staging failed: ${stderr.trim()}`);
}
