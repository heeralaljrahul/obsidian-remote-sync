/**
 * Randomized multi-device system test ("model-based fuzzing").
 *
 * Three devices (PC, iPhone, iPad) and a person using the Drive web UI do random
 * creates/edits/deletes/renames, random syncs that get interrupted (iOS
 * suspending the app), random network failures (including a connection that
 * dies AFTER Drive applied a change), and random conflict resolutions.
 *
 * Every piece of content a user writes is a unique token. Invariants:
 *  1. NO DATA LOSS: every token the user did not deliberately delete/overwrite
 *     still exists in some vault, some vault's .trash, or in Drive (live,
 *     trashed or version history).
 *  2. CONVERGENCE: once the network is healthy and conflicts are resolved, all
 *     devices and Drive hold exactly the same files.
 *  3. Drive never ends up with two files at the same path; no unsafe paths.
 */
import { expect } from "chai";
import { md5Hex } from "../src/sync/engine";
import { isSafeVaultPath } from "../src/sync/paths";
import { resolveConflict, type Resolution } from "../src/sync/resolve";
import { BaseStore } from "../src/sync/store";
import { Device } from "./helpers/device";
import { FakeDrive, ROOT_ID } from "./helpers/fakeDrive";

const dec = new TextDecoder();

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2 ** 32;
  };
}

const PATHS = ["a.md", "b.md", "c.md", "notes/d.md", "notes/e.md", "notes/deep/f.md", "Inbox/g.md", "img.png"];

export interface World {
  drive: FakeDrive;
  devices: Device[];
  /** tokens the user deliberately replaced or deleted (allowed to disappear) */
  discarded: Set<string>;
  /** every token ever written */
  written: Set<string>;
  log: string[];
}

function contentOf(d: Device, p: string): string | undefined {
  const f = d.vault.files.get(p);
  return f ? dec.decode(f.data) : undefined;
}

async function syncSafely(d: Device): Promise<Awaited<ReturnType<Device["sync"]>> | null> {
  try {
    return await d.sync();
  } catch {
    return null; // aborted (network) — allowed; state must stay consistent
  }
}

async function resolveAll(w: World, d: Device, choiceOf: () => Resolution): Promise<void> {
  const r = await syncSafely(d);
  if (!r) return;
  for (const a of r.prep.plan.actions) {
    if (a.kind !== "conflict") continue;
    const choice = choiceOf();
    // Choosing a version is a deliberate user decision, like an edit: the losing
    // version may legitimately disappear from live view (it is still kept in
    // .trash / Drive history by design, and the invariant checks that too).
    try {
      await resolveConflict({ path: a.path, type: a.type, local: a.local, remote: a.remote }, choice, {
        local: d.vault,
        remote: d.provider,
        base: new BaseStore(d.kv, ROOT_ID),
        log: d.log,
        md5: md5Hex,
      });
      w.log.push(`resolve ${a.path} ${choice}`);
    } catch {
      /* stale (precondition) or network: fine, it comes back next time */
    }
  }
}

export function everythingThatStillExists(w: World): Set<string> {
  const out = w.drive.allContentEver();
  for (const d of w.devices) {
    for (const f of d.vault.files.values()) out.add(dec.decode(f.data));
    for (const t of d.vault.trashBin) out.add(dec.decode(t.data));
  }
  return out;
}

export async function runScenario(seed: number, steps: number, trace?: (w: World, step: number) => void): Promise<World> {
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)];
  const drive = new FakeDrive();
  drive.pageSize = 3; // exercise pagination constantly
  const devices = [new Device(drive), new Device(drive), new Device(drive)];
  const w: World = { drive, devices, discarded: new Set(), written: new Set(), log: [] };
  let n = 0;
  const token = (who: string) => {
    const t = `T${seed}-${++n}-${who}`;
    w.written.add(t);
    return t;
  };
  // Each vault keeps one never-deleted note so the "vault looks empty" guard never trips.
  for (const [i, d] of devices.entries()) d.vault.put(`keep-${i}.md`, token(`keep${i}`));

  let failureRate = 0;
  drive.intercept = (req) => {
    if (r() < failureRate) {
      const k = r();
      if (k < 0.4) return { status: 503, headers: {}, text: '{"error":{"message":"backendError"}}', arrayBuffer: new ArrayBuffer(0) };
      if (k < 0.7) return { status: 429, headers: {}, text: '{"error":{"message":"rate"}}', arrayBuffer: new ArrayBuffer(0) };
      throw new Error("connection reset");
    }
    return undefined;
  };
  drive.afterCommit = () => {
    if (r() < failureRate / 2) throw new Error("connection died after Drive applied the change");
  };

  for (let i = 0; i < steps; i++) {
    const op = r();
    const d = pick(devices);
    const di = devices.indexOf(d);
    const p = pick(PATHS);
    if (op < 0.3) {
      // create or edit on a device
      const old = contentOf(d, p);
      if (old !== undefined) w.discarded.add(old);
      d.vault.put(p, token(`dev${di}`));
      w.log.push(`dev${di} write ${p}`);
    } else if (op < 0.38) {
      const old = contentOf(d, p);
      if (old !== undefined && !p.startsWith("keep")) {
        w.discarded.add(old);
        d.vault.remove(p);
        w.log.push(`dev${di} delete ${p}`);
      }
    } else if (op < 0.44) {
      const to = pick(PATHS);
      if (d.vault.files.has(p) && !d.vault.files.has(to) && p !== to) {
        d.vault.userRename(p, to);
        w.log.push(`dev${di} rename ${p} -> ${to}`);
      }
    } else if (op < 0.56) {
      // the user in the Drive web UI
      const exists = drive.countAt(p) === 1;
      const k = r();
      if (!exists && drive.countAt(p) === 0) {
        drive.addFile(p, token("web"));
        w.log.push(`web add ${p}`);
      } else if (exists && k < 0.5) {
        drive.edit(p, token("web")); // Drive keeps the old version in its history
        w.log.push(`web edit ${p}`);
      } else if (exists && k < 0.75) {
        drive.trash(p);
        w.log.push(`web trash ${p}`);
      } else if (exists) {
        const to = pick(PATHS);
        if (drive.countAt(to) === 0) {
          drive.move(p, to);
          w.log.push(`web move ${p} -> ${to}`);
        }
      }
    } else if (op < 0.62) {
      failureRate = r() < 0.5 ? 0 : 0.15;
      w.log.push(`network failureRate=${failureRate}`);
    } else if (op < 0.9) {
      d.stopAfter = r() < 0.25 ? Math.floor(r() * 3) : null; // iOS suspends mid-sync
      if (r() < 0.2) d.restart();
      await syncSafely(d);
      d.stopAfter = null;
      w.log.push(`dev${di} sync`);
    } else {
      await resolveAll(w, d, () => pick(["keep-local", "keep-remote", "keep-both"] as Resolution[]));
    }
    trace?.(w, i);
  }

  // ---- quiesce: healthy network, sync everyone, resolve leftovers by keeping both ----
  failureRate = 0;
  drive.intercept = null;
  drive.afterCommit = null;
  for (let round = 0; round < 8; round++) {
    for (const d of devices) {
      d.restart();
      await resolveAll(w, d, () => "keep-both");
      await syncSafely(d);
    }
  }
  return w;
}

describe("randomized multi-device sync (system / fuzz)", function () {
  this.timeout(120000);
  const SEEDS = Number(process.env.FUZZ_SEEDS ?? 150);
  const STEPS = Number(process.env.FUZZ_STEPS ?? 40);

  it(`${SEEDS} random scenarios x ${STEPS} steps: no data loss, convergence, no duplicates`, async () => {
    const stats = { syncs: 0, conflicts: 0, resolutions: 0, renames: 0, webOps: 0, deletes: 0, files: 0, trashed: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const w = await runScenario(seed, STEPS);
      stats.syncs += w.log.filter((l) => l.endsWith(" sync")).length;
      stats.resolutions += w.log.filter((l) => l.startsWith("resolve")).length;
      stats.renames += w.log.filter((l) => l.includes(" rename ") || l.includes(" move ")).length;
      stats.webOps += w.log.filter((l) => l.startsWith("web")).length;
      stats.deletes += w.log.filter((l) => l.includes(" delete ") || l.includes(" trash ")).length;
      stats.files += w.drive.tree().size;
      stats.trashed += w.devices.reduce((n, d) => n + d.vault.trashBin.length, 0);
      const ctx = () => `seed ${seed}\n  ${w.log.join("\n  ")}`;

      // 3. no duplicate paths in Drive (tree() throws on duplicates)
      let driveTree: Map<string, string>;
      try {
        driveTree = w.drive.tree();
      } catch (e) {
        throw new Error(`${e}\n${ctx()}`);
      }

      // 2. convergence
      for (const [i, d] of w.devices.entries()) {
        expect(Object.fromEntries(d.vault.tree()), `device ${i} != Drive\n${ctx()}`).to.deep.equal(Object.fromEntries(driveTree));
        for (const p of d.vault.files.keys()) expect(isSafeVaultPath(p), p).to.equal(true);
        const again = await d.sync();
        expect(again.prep.plan.actions.filter((a) => a.kind !== "adopt" && a.kind !== "adoptFolder"), `device ${i} not settled\n${ctx()}`).to.deep.equal([]);
      }

      // 1. no data loss
      const alive = everythingThatStillExists(w);
      const lost = [...w.written].filter((t) => !w.discarded.has(t) && !alive.has(t));
      expect(lost, `lost content\n${ctx()}`).to.deep.equal([]);
    }
    if (process.env.FUZZ_STATS) console.log("fuzz stats", stats);
    // The fuzzer must actually exercise the interesting paths.
    expect(stats.resolutions, "conflicts were resolved").to.be.greaterThan(SEEDS / 10);
    expect(stats.renames).to.be.greaterThan(SEEDS / 10);
    expect(stats.trashed).to.be.greaterThan(0);
  });
});
