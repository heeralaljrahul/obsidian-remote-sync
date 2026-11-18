import { expect } from "chai";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// (This test file runs under Node; the plugin bundle itself must not.)
function check(code: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "gdvs-"));
  const f = join(dir, "main.js");
  writeFileSync(f, code);
  try {
    return { ok: true, out: execFileSync("node", ["scripts/check-bundle.mjs", f], { encoding: "utf8" }) };
  } catch (e) {
    return { ok: false, out: String((e as { stderr?: string }).stderr) };
  }
}

describe("bundle check (no Node/Electron in main.js)", () => {
  it("accepts a bundle that only requires obsidian", () => {
    expect(check('var o=require("obsidian");module.exports=o;').ok).to.equal(true);
  });
  it("rejects require('fs'), Buffer and electron", () => {
    for (const bad of ['require("fs")', 'require("path")', "Buffer.from('x')", 'require("electron")', "require(name)", "eval('1')", "new Function('return 1')", "el.innerHTML = s", "el.insertAdjacentHTML('x', s)"]) {
      const r = check(`var o=require("obsidian");${bad};`);
      expect(r.ok, bad).to.equal(false);
    }
  });
});
