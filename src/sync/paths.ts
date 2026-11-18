/** Normalise a vault-relative path into the key form used everywhere in the engine. */
export function normKey(p: string): string {
  let s = p
    .normalize("NFC")
    .replace(/\\/g, "/")
    .replace(/\/{2,}/g, "/");
  if (s.startsWith("/")) s = s.slice(1);
  if (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Case-insensitive key, used to detect names that collide on Windows/iOS file systems. */
export function foldKey(p: string): string {
  return normKey(p).toLowerCase();
}

export function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? "" : p.slice(0, i);
}

export function baseName(p: string): string {
  const i = p.lastIndexOf("/");
  return i < 0 ? p : p.slice(i + 1);
}

export function joinPath(parent: string, name: string): string {
  return parent === "" ? name : `${parent}/${name}`;
}

/** true if `p` is strictly inside folder `folder` */
export function isUnder(p: string, folder: string): boolean {
  return folder === "" ? p !== "" : p.startsWith(folder + "/");
}

/** All ancestor folders of a path, nearest first, excluding the root "". */
export function ancestors(p: string): string[] {
  const out: string[] = [];
  let cur = parentOf(p);
  while (cur !== "") {
    out.push(cur);
    cur = parentOf(cur);
  }
  return out;
}

export function depth(p: string): number {
  return p === "" ? 0 : p.split("/").length;
}

/**
 * Why a single file/folder NAME (from Drive) can't be used locally, or null if fine.
 * Blocks path tricks (`..`, `\`), control characters, and the characters Obsidian
 * itself refuses in file names on Windows/iOS: \ / : * ? " < > |
 */
export function unsafeNameReason(name: string): string | null {
  if (name === "" || name.trim() === "") return "empty name";
  if (name === "." || name === "..") return `name "${name}" is not allowed`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return "name contains control characters";
  if (/[\\/:*?"<>|]/.test(name)) return "name contains a character Obsidian doesn't allow (\\ / : * ? \" < > |)";
  return null;
}

/** A path is safe if it is vault-relative and every segment is a safe name. Defence in depth before any local write. */
export function isSafeVaultPath(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.endsWith("/")) return false;
  return p.split("/").every((seg) => unsafeNameReason(seg) === null);
}

export class UnsafePathError extends Error {
  constructor(p: string) {
    super(`refusing to touch unsafe path ${JSON.stringify(p)}`);
    this.name = "UnsafePathError";
  }
}

export function assertSafeVaultPath(p: string): void {
  if (!isSafeVaultPath(p)) throw new UnsafePathError(p);
}
