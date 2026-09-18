import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.FRED_INTAKE_TEST = "1";
const { matchIntakeTickers, writeIntakeFrontmatter } = await import("../src/index.ts");
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "fred-summary-test-"));
const mdPath = path.join(tempDir, "sample.md");

try {
  assert.deepEqual(matchIntakeTickers("BEST BE GLW", ["BE", "GLW"]), ["BE", "GLW"]);
  assert.deepEqual(matchIntakeTickers("BEST", ["BE"]), []);
  fs.writeFileSync(mdPath, "---\ntitle: sample\n---\n\n內文", "utf-8");
  writeIntakeFrontmatter(mdPath, ["BE"], "值得看", "這是一句摘要");
  const updated = fs.readFileSync(mdPath, "utf-8");
  assert.match(updated, /^---/);
  assert.match(updated, /summary: "這是一句摘要"/);
  assert.match(updated, /hits: \["BE"\]/);
  assert.match(updated, /signal: "值得看"/);
  console.log("PASS frontmatter + ticker boundary (BE does not match BEST)");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
