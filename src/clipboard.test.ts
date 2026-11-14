import { expect, test } from "bun:test";
import { windowsClipboardHtml } from "./clipboard";

test("CF_HTML preserves UTF-8 Japanese and uses byte offsets rather than string lengths", () => {
  const fragment = "<h2>日本語 &amp; 😀</h2><p><b>太字</b></p>";
  const data = windowsClipboardHtml(fragment);
  const header = data.toString("utf8");
  const offsets = Object.fromEntries([...header.matchAll(/(StartHTML|EndHTML|StartFragment|EndFragment):(\d+)/g)].map(m => [m[1]!, Number(m[2])]));
  expect(data.subarray(offsets.StartFragment, offsets.EndFragment).toString("utf8")).toBe(fragment);
  expect(data.subarray(offsets.StartHTML, offsets.EndHTML).toString("utf8")).toBe(`<html><body><!--StartFragment-->${fragment}<!--EndFragment--></body></html>`);
  expect(offsets.EndHTML).toBe(data.length - 1);
  expect(data[data.length - 1]).toBe(0);
});
