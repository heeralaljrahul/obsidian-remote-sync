import { ancestors, baseName, isUnder } from "./paths";

export const PLUGIN_ID = "gdrive-vault-sync";

export const DEFAULT_IGNORE_PATTERNS = [
  "# One pattern per line. Lines starting with # are comments.",
  "# *  matches anything inside one folder level, ** matches across folders.",
  "# A pattern with no / matches that name in any folder.",
  "# A pattern ending in / matches a folder and everything inside it.",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  ".obsidian/workspace.json",
  ".obsidian/workspace-mobile.json",
].join("\n");

interface CompiledPattern {
  re: RegExp;
  anchored: boolean;
  dirOnly: boolean;
}

function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // "**/" => any number of folders (including none)
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 2;
        } else {
          re += ".*";
          i += 1;
        }
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`);
}

export function compilePatterns(text: string): CompiledPattern[] {
  const out: CompiledPattern[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    if (line.startsWith("/")) line = line.slice(1);
    if (line === "") continue;
    const anchored = line.includes("/");
    out.push({ re: globToRegExp(line), anchored, dirOnly });
  }
  return out;
}

export interface IgnoreOptions {
  configDir: string;
  syncConfigDir: boolean;
  patterns: string;
}

/**
 * Decides which paths take part in sync. The same filter is applied to the
 * local side, the remote side AND the stored base state, so adding an ignore
 * pattern never looks like a deletion.
 */
export class IgnoreFilter {
  private readonly compiled: CompiledPattern[];
  constructor(private readonly opts: IgnoreOptions) {
    this.compiled = compilePatterns(opts.patterns);
  }

  isIgnored(path: string, isFolder: boolean): boolean {
    if (path === "") return false;
    const { configDir, syncConfigDir } = this.opts;
    const ownPluginDir = `${configDir}/plugins/${PLUGIN_ID}`;

    // Hard rules that the user can't turn off:
    // our own plugin folder holds data.json with OAuth tokens — never upload it.
    if (path === ownPluginDir || isUnder(path, ownPluginDir)) return true;
    if (path === ".trash" || isUnder(path, ".trash")) return true;

    // Hidden files/folders are ignored, except the config dir when enabled.
    const inConfig = path === configDir || isUnder(path, configDir);
    if (!(inConfig && syncConfigDir)) {
      if (path.split("/").some((seg) => seg.startsWith("."))) return true;
    }

    const candidates: Array<[string, boolean]> = [[path, isFolder], ...ancestors(path).map((a) => [a, true] as [string, boolean])];
    for (const p of this.compiled) {
      for (const [cand, candIsFolder] of candidates) {
        if (p.dirOnly && !candIsFolder) continue;
        const subject = p.anchored ? cand : baseName(cand);
        if (p.re.test(subject)) return true;
      }
    }
    return false;
  }
}
