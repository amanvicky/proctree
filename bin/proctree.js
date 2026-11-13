#!/usr/bin/env node
/* proctree — who is using the machine, grouped by process tree.

   A single PID is a lie: a browser is a dozen processes, a server is a worker
   pool, and "task manager" answers per process. proctree weighs whole trees —
   root plus every descendant — in resident memory and CPU share. */

import { sample, buildTrees, cpuPct } from "../lib/procs.js";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const VERSION = "0.1.0";

const HELP = `proctree ${VERSION} — who is using the machine, grouped by process tree

usage: proctree [flags]

  --pid N      only the tree that contains this process
  --name str   only trees containing a process whose name includes this
  --ms N       CPU sampling window in milliseconds (default 700)
  --top N      how many trees to print (default 12, 0 = all)
  --full       print every member of each tree, not just the heaviest few
  --json       machine-readable output (same data, no table)
  --watch [s]  refresh every s seconds (default 2)
  --help       this text

CPU shows "—" until a tree has existed across two samples, and keeps showing
"—" for any tree that gained or lost a member between them — a delta over a
changed set is a made-up number, and this tool does not make those up.`;

function parseArgs(argv) {
  const a = { pid: null, name: null, ms: 700, top: 12, full: false, json: false, watch: 0 };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === "--help" || v === "-h") { console.log(HELP); process.exit(0); }
    else if (v === "--pid") a.pid = Number(argv[++i]);
    else if (v === "--name") a.name = argv[++i];
    else if (v === "--ms") a.ms = Number(argv[++i]);
    else if (v === "--top") a.top = Number(argv[++i]);
    else if (v === "--full") a.full = true;
    else if (v === "--json") a.json = true;
    else if (v === "--watch") {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) { a.watch = n; i++; } else a.watch = 2;
    } else if (/^--(pid|name|ms|top)=/.test(v)) {
      const [k, val] = v.slice(2).split("=");
      if (k === "pid") a.pid = Number(val);
      if (k === "name") a.name = val;
      if (k === "ms") a.ms = Number(val);
      if (k === "top") a.top = Number(val);
    } else { fail("unknown flag: " + v + " (try --help)"); }
  }
  if (a.pid !== null && !Number.isFinite(a.pid)) fail("--pid needs a number");
  if (!Number.isFinite(a.ms) || a.ms < 50) fail("--ms needs a number >= 50");
  if (!Number.isFinite(a.top)) fail("--top needs a number");
  if (a.name !== null && !a.name.trim()) fail("--name needs a string");
  return a;
}

function fail(msg) {
  console.error("proctree: " + msg);
  process.exit(1);
}

const mb = (b) => b / (1024 * 1024);
const gb = (b) => b / (1024 * 1024 * 1024);
const pad = (s, n) => String(s).padStart(n);

/* Pure: one snapshot in, the same text or JSON out. `before` is the previous
   sample's procs Map (or null on the first look). The CPU column is honest
   about what a delta over a changed set would be worth: nothing. */

export function render(args, snap, before, deltaMs) {
  let trees = buildTrees(snap.procs);
  if (args.pid != null) { // loose: parseArgs gives null, hand-built args may give undefined
    const hit = trees.find((t) => t.members.some((p) => p.pid === args.pid));
    if (!hit) return { error: "no process " + args.pid + " on this machine" };
    trees = [hit];
  }
  if (args.name) {
    const n = args.name.toLowerCase();
    trees = trees.filter((t) => t.members.some((p) => p.name.toLowerCase().includes(n)));
    if (!trees.length) return { error: "no tree contains a process named like '" + args.name + "'" };
  }
  const allTrees = trees.length;
  if (args.top > 0) trees = trees.slice(0, args.top); // both branches honor --top
  const hiddenTrees = allTrees - trees.length;
  if (args.json) {
    return {
      tool: "proctree",
      version: VERSION,
      platform: snap.platform,
      totalMemoryGB: Math.round(gb(snap.totalBytes) * 10) / 10,
      processes: snap.procs.size,
      sampledAt: snap.at.toISOString(),
      deltaMs: before ? Math.round(deltaMs) : null,
      roots: trees.map((t) => ({
        pid: t.pid,
        name: t.name,
        procs: t.procs,
        residentMB: Math.round(mb(t.residentBytes) * 10) / 10,
        cpuPct: before ? cpuPct(t, before, deltaMs) : null,
        cyclic: t.cyclic,
        members: t.members.slice(0, 8).map((p) => ({
          pid: p.pid, name: p.name,
          residentMB: Math.round(mb(p.rssBytes) * 10) / 10,
          cpuMs: Math.round(p.cpuMs),
        })),
        memberList: "top " + Math.min(8, t.members.length) + " of " + t.members.length + " by resident memory",
      })),
      notes: snap.notes,
    };
  }
  const lines = [];
  lines.push("proctree — who is using the machine, grouped by process tree");
  lines.push(snap.platform + " · " + gb(snap.totalBytes).toFixed(1) + " GB RAM · " +
    snap.procs.size + " processes · " + snap.at.toTimeString().slice(0, 8) +
    (before ? " (Δ " + Math.round(deltaMs) + " ms)" : "") +
    (snap.notes.length ? " · notes: " + snap.notes.join("; ") : ""));
  lines.push("");
  lines.push(pad("RESIDENT", 9) + "  " + pad("CPU", 6) + "  " + pad("PROCS", 5) + "  TREE (root pid)");
  const top = trees;
  for (const t of top) {
    const pct = before ? cpuPct(t, before, deltaMs) : null;
    const cpu = pct === null ? "—" : pct.toFixed(1) + "%";
    lines.push(pad(mb(t.residentBytes) >= 1024
      ? (mb(t.residentBytes) / 1024).toFixed(1) + " GB"
      : mb(t.residentBytes).toFixed(1) + " MB", 9) +
      "  " + pad(cpu, 6) + "  " + pad(t.procs, 5) + "  " +
      t.name + " (" + t.pid + ")" +
      (t.cyclic ? "  [cycle in tree — reported, not looped]" : ""));
    const shown = args.full ? t.members : t.members.slice(0, 4);
    for (const p of shown.slice(1)) {
      lines.push("    " + pad(mb(p.rssBytes).toFixed(1) + " MB", 10) + " " + p.name + " (" + p.pid + ")");
    }
    if (!args.full && t.members.length > 4) {
      lines.push("       … " + (t.members.length - 4) + " more — --full prints every member");
    }
  }
  if (hiddenTrees > 0) {
    lines.push("… " + hiddenTrees + " more trees — --top 0 prints all");
  }
  return { text: lines.join("\n") };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const emit = (r) => {
    if (r.error) fail(r.error);
    console.log(args.json ? JSON.stringify(r, null, 2) : r.text);
  };
  if (args.watch) {
    let before = await sample();
    for (;;) {
      await new Promise((r) => setTimeout(r, args.watch * 1000));
      const snap = await sample();
      const r = render(args, snap, before.procs, Number(snap.at) - Number(before.at));
      before = snap;
      if (r.error) fail(r.error);
      process.stdout.write("\x1b[2J\x1b[H" + (args.json ? JSON.stringify(r, null, 2) : r.text) + "\n");
    }
  }
  const before = await sample();
  await new Promise((r) => setTimeout(r, args.ms));
  emit(render(args, await sample(), before.procs, Number(new Date()) - Number(before.at)));
}

/* run only when executed as the CLI — the tests import render() for the
   table checks, and an import must never become a process sample */
const isMain = (() => {
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch (e) { return false; }
})();
if (isMain) main().catch((e) => fail(e.message));
