/** Normalise a vault-relative path into the key form used everywhere in the engine. */
export function normKey(p: string): string {
  let s = p.normalize("NFC").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
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
