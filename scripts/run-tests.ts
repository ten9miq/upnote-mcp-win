import { resolve } from "node:path";

// Bun 1.4.0/Windows can corrupt shared VM/native test state when the bridge's
// node:vm fixtures and large HTML fixtures run in one process. Keep each file
// in a fresh OS process; no test is skipped or retried.
const root = resolve(import.meta.dir, "..");
const files = [...new Bun.Glob("src/**/*.test.ts").scanSync({ cwd: root })].sort();
if (!files.length) throw new Error("No test files found.");
let passed = 0; const failed: string[] = [];
for (const file of files) {
  const result = Bun.spawnSync([process.execPath, "test", "./" + file.replaceAll("\\", "/")], {
    cwd: root, stdout: "pipe", stderr: "pipe", timeout: 60_000,
  });
  process.stdout.write(result.stdout); process.stderr.write(result.stderr);
  const output = result.stdout.toString() + result.stderr.toString();
  passed += Number(/(?:^|\n)\s*(\d+) pass\b/.exec(output)?.[1] ?? 0);
  if (result.exitCode !== 0) failed.push(file);
}
console.log(JSON.stringify({ testFiles: files.length, passedTests: passed, failedFiles: failed }));
if (failed.length) process.exitCode = 1;
