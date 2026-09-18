const fs = require("fs");
const path = require("path");
try {
  const pkgDir = path.dirname(require.resolve("@anthropic-ai/claude-code/package.json"));
  console.log("PKG_DIR:", pkgDir);
  console.log("cli.js:", fs.existsSync(path.join(pkgDir, "cli.js")));
  console.log("bin/cli.js:", fs.existsSync(path.join(pkgDir, "bin/cli.js")));
  console.log("bin/cli.mjs:", fs.existsSync(path.join(pkgDir, "bin/cli.mjs")));
} catch (err) {
  console.error(err);
}
