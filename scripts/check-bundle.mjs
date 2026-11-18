// Fails the build if main.js would need anything other than Obsidian's own module
// or touches Node/Electron-only globals: those don't exist on iOS.
import { readFileSync } from "fs";

const file = process.argv[2] ?? new URL("../main.js", import.meta.url);
const src = readFileSync(file, "utf8");
const problems = [];

for (const m of src.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
  if (m[1] !== "obsidian") problems.push(`require("${m[1]}")`);
}
if (/\brequire\(\s*[^"'`\s)]/.test(src)) problems.push("dynamic require(...)");
for (const g of ["process.versions", "__dirname", "__filename", "Buffer.from", "Buffer.alloc", "electron"]) {
  if (src.includes(g)) problems.push(g);
}

if (problems.length) {
  console.error("Bundle check FAILED — Node/Electron usage found in main.js:\n  " + [...new Set(problems)].join("\n  "));
  process.exit(1);
}
console.log(`Bundle check OK: main.js (${(src.length / 1024).toFixed(0)} KB) only requires "obsidian".`);
