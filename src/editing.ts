import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { decodeHTML } from "entities";

export type UpdateNoteParams = {
  id: string;
  expectedVersion: string;
  title?: string;
  content?: string;
  contentFormat?: "markdown" | "text";
  mode?: "replace" | "append";
  dryRun?: boolean;
  allowWhileRunning?: boolean;
};

export function noteVersion(row: Record<string, unknown>): string {
  return createHash("sha256")
    .update(JSON.stringify(Object.keys(row).sort().map((key) => [key, row[key]])))
    .digest("hex");
}

/** Process detection fails closed: a failed detector must never enable writes. */
export function isUpNoteRunning(): boolean {
  if (process.platform === "win32") {
    const result = spawnSync("tasklist.exe", ["/FI", "IMAGENAME eq UpNote.exe", "/FO", "CSV", "/NH"], {
      encoding: "utf8", windowsHide: true, timeout: 5_000,
    });
    if (result.error || result.status !== 0 || !result.stdout.trim()) {
      throw new Error("Cannot determine whether UpNote is running; refusing to write.");
    }
    return /"UpNote\.exe"/i.test(result.stdout);
  }
  const result = spawnSync("pgrep", ["-x", "UpNote"], { encoding: "utf8", timeout: 5_000 });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error("Cannot determine whether UpNote is running; refusing to write.");
  }
  return result.status === 0;
}

function escapeHtml(text: string): string {
  return Bun.escapeHTML(text);
}

export function htmlToPlainText(html: string): string {
  let text = "";
  // Preserve block boundaries and decode entities after tokenization (never before it).
  new HTMLRewriter()
    .on("p,div,h1,h2,h3,h4,h5,h6,li,pre,blockquote,tr,br,hr", {
      element(element) {
        text += "\n";
        if (element.canHaveContent) element.onEndTag(() => { text += "\n"; });
      },
    })
    .on("td,th", { element() { text += "\t"; } })
    .onDocument({ text(chunk) { text += chunk.text; } })
    .transform(html);
  return decodeHTML(text).replace(/\r\n/g, "\n").replace(/\n[ \t]*\n+/g, "\n").trim();
}

/** Body replacements intentionally do not import HTML or attachments. */
export function renderBody(content: string, format: "markdown" | "text"): string {
  if (format === "text") {
    return content.split(/\r?\n/).map((line) => `<p>${escapeHtml(line) || "<br>"}</p>`).join("\n");
  }
  if (!Bun.markdown?.html) {
    throw new Error("Markdown editing requires Bun 1.4 or newer. Use contentFormat=text or upgrade Bun.");
  }
  const html = Bun.markdown.html(content, { noHtmlBlocks: true, noHtmlSpans: true });
  new HTMLRewriter().on("img", {
    element() { throw new Error("Adding images is not supported; import attachments in UpNote."); },
  }).on("a[href]", {
    element(element) {
      const href = decodeHTML(element.getAttribute("href") ?? "").replace(/[\u0000-\u0020\u007f]/g, "");
      if (/^[a-z][a-z\d+.-]*:/i.test(href) && !/^(https?:|mailto:|upnote:)/i.test(href)) {
        throw new Error("Unsupported link protocol in note content.");
      }
    },
  }).transform(html);
  return html;
}

export function prepareNoteUpdate(row: Record<string, unknown>, params: UpdateNoteParams): Record<string, string | number> {
  const patch: Record<string, string | number> = {};
  const oldTitle = String(row.title ?? "");
  const title = params.title ?? oldTitle;
  const oldHtml = String(row.html ?? "");
  const heading = oldHtml.match(/^(\s*<h([1-6])\b[^>]*>)([\s\S]*?)(<\/h\2>)/i);
  const hasTitleHeading = heading && htmlToPlainText(heading[3]!) === oldTitle.trim();
  const titleHeading = hasTitleHeading
    ? title === oldTitle ? heading[0] : `${heading[1]}${escapeHtml(title)}${heading[4]}`
    : `<h2>${escapeHtml(title)}</h2>`;
  let html = oldHtml;

  if (params.content !== undefined) {
    let hasFiles = Number(row.filesCount ?? 0) > 0;
    if (row.fileIds) {
      try {
        const fileIds: unknown = JSON.parse(String(row.fileIds));
        hasFiles ||= !Array.isArray(fileIds) || fileIds.length > 0;
      } catch { hasFiles = true; }
    }
    if ((params.mode ?? "replace") === "replace" && (hasFiles || /<img\b|<attachment\b/i.test(oldHtml))) {
      throw new Error("Replacing a body with attachments/images is refused. Use mode=append to preserve the existing body.");
    }
    const addition = renderBody(params.content, params.contentFormat ?? "markdown");
    html = params.mode === "append" ? oldHtml + "\n" + addition : titleHeading + "\n" + addition;
  }
  if (params.title !== undefined) {
    patch.title = title;
    if (title !== oldTitle && (params.content === undefined || params.mode === "append")) {
      if (hasTitleHeading) html = titleHeading + html.slice(heading[0].length);
      else throw new Error("Cannot safely rename this note: its leading title heading is not recognized.");
    }
  }
  Object.assign(patch, htmlUpdateFields(row, html));
  return Object.fromEntries(Object.entries(patch).filter(([key, value]) => row[key] !== value));
}

/** Rebuild derived fields without reconstructing any existing HTML. */
export function htmlUpdateFields(row: Record<string, unknown>, html: string): Record<string, string | number> {
  if (html === String(row.html ?? "")) return {};
  const text = htmlToPlainText(html);
  const fields = { html, text, summary: text.replace(/\s+/g, " ").slice(0, 240),
    hasTodo: /<input\b[^>]*\btype\s*=\s*["']?checkbox\b|data-checked\s*=/i.test(html) ? 1 : 0 };
  return Object.fromEntries(Object.entries(fields).filter(([key, value]) => row[key] !== value));
}
