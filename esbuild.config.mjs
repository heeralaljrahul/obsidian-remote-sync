import esbuild from "esbuild";
import process from "process";

const prod = process.argv[2] === "production";

const ctx = await esbuild.context({
  banner: { js: "/* Google Drive Vault Sync — bundled file. Source: https://github.com/heeralaljrahul/obsidian-remote-sync (Apache-2.0) */" },
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Only Obsidian's own module is external. Everything else must bundle for the
  // browser: no Node built-ins exist on iOS.
  external: ["obsidian"],
  platform: "browser",
  format: "cjs",
  target: "es2020",
  logLevel: "info",
  sourcemap: prod ? false : "inline",
  treeShaking: true,
  minify: prod,
  outfile: "main.js",
});

if (prod) {
  await ctx.rebuild();
  await ctx.dispose();
} else {
  await ctx.watch();
}
