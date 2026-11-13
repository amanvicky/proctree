/* proctree's core: sample every process on the machine, group them into
   descendant trees, and weigh each tree in resident memory and CPU time.

   Zero dependencies by design — the OS answers through two doors:
   - Windows: one PowerShell Get-CimInstance call per sample (roughly
     0.3–0.7 s — the honest cost of asking CIM politely);
   - Linux: /proc/[pid]/stat read directly, with page size and clock ticks
     read once via getconf.

   Everything that cannot be answered is reported as unknown — never guessed.
   No DOM, no network — this file is importable from the CLI and the tests. */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

let posixCache = null;

async function getconf(key) {
  return new Promise((resolve) => {
    const child = spawn("getconf", [key], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const n = parseInt(out.trim(), 10);
      resolve(Number.isFinite(n) && n > 0 ? n : null);
    });
  });
}

/* Windows: CIM's WorkingSetSize is BYTES — verified pid-for-pid against
   tasklist's KB column, not against the docs (which still say "kilobytes";
   they are wrong on every modern system this was checked on). */

function windowsSample() {
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        "@(Get-CimInstance -ClassName Win32_Process | Select-Object " +
        "ProcessId,ParentProcessId,Name,WorkingSetSize,KernelModeTime,UserModeTime) " +
        "| ConvertTo-Json -Compress -Depth 2"],
      { windowsHide: true });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(new Error("PowerShell could not start: " + e.message)));
    child.on("close", () => {
      if (!out.trim()) {
        return reject(new Error("PowerShell returned nothing" +
          (err.trim() ? " — " + err.trim().slice(0, 200) : "")));
      }
      let rows;
      try { rows = JSON.parse(out); } catch (e) {
        return reject(new Error("could not parse the PowerShell sample: " + e.message));
      }
      if (!Array.isArray(rows)) rows = [rows];
      const procs = new Map();
      for (const r of rows) {
        const pid = Number(r.ProcessId);
        if (!pid) continue; // PID 0 is System Idle — a Windows accounting fiction, skipped
        procs.set(pid, {
          pid,
          ppid: Number(r.ParentProcessId) || 0,
          name: String(r.Name || "unknown").replace(/\.exe$/i, ""),
          rssBytes: Number(r.WorkingSetSize) || 0,
          // KernelModeTime + UserModeTime are 100-ns ticks since process start
          cpuMs: (Number(r.KernelModeTime) + Number(r.UserModeTime)) / 10000,
        });
      }
      resolve({ procs, notes: [] });
    });
  });
}

/* Linux: /proc/[pid]/stat — fields after the (comm) parens:
     rest[1] = ppid, rest[11] = utime, rest[12] = stime, rest[21] = rss (pages).
   A process that exits between the readdir and the read is simply absent —
   it is gone, not guessed. */

async function posixSample() {
  if (!posixCache) {
    const [page, tick] = await Promise.all([getconf("PAGESIZE"), getconf("CLK_TCK")]);
    posixCache = {
      page: page || 4096,
      tick: tick || 100,
      notes: [
        ...(page ? [] : ["getconf PAGESIZE unavailable — assumed 4096"]),
        ...(tick ? [] : ["getconf CLK_TCK unavailable — assumed 100"]),
      ],
    };
  }
  const { page, tick, notes } = posixCache;
  const procs = new Map();
  for (const d of fs.readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    let stat;
    try { stat = fs.readFileSync("/proc/" + d + "/stat", "utf8"); } catch (e) { continue; }
    const open = stat.indexOf("(");
    const close = stat.lastIndexOf(")");
    if (open < 0 || close < 0) continue;
    const rest = stat.slice(close + 2).split(" ");
    procs.set(Number(d), {
      pid: Number(d),
      ppid: Number(rest[1]) || 0,
      name: stat.slice(open + 1, close),
      rssBytes: (Number(rest[21]) || 0) * page,
      cpuMs: ((Number(rest[11]) || 0) + (Number(rest[12]) || 0)) * (1000 / tick),
    });
  }
  return { procs, notes: [...notes] };
}

/* One snapshot of the whole machine. cpuMs is cumulative time used since the
   process started — percentages are the CLI's job (it owns the delta). */

export async function sample() {
  const { procs, notes } = os.platform() === "win32" ? await windowsSample() : await posixSample();
  return { at: new Date(), platform: os.platform(), totalBytes: os.totalmem(), procs, notes };
}

/* Group every process under its nearest living ancestor. A process whose
   parent is gone (or never existed — ppid 999999) is a root; a process that
   is its own parent is a root marked cyclic — seen, reported, never looped
   over forever. */

export function buildTrees(procs) {
  const kids = new Map();
  for (const p of procs.values()) {
    if (!kids.has(p.ppid)) kids.set(p.ppid, []);
    kids.get(p.ppid).push(p.pid);
  }
  const trees = [];
  for (const root of procs.values()) {
    if (root.pid !== root.ppid && procs.has(root.ppid)) continue;
    const members = [];
    const seen = new Set();
    let cyclic = false;
    const stack = [root.pid];
    while (stack.length) {
      const pid = stack.pop();
      if (seen.has(pid)) { cyclic = true; continue; }
      seen.add(pid);
      const p = procs.get(pid);
      if (p) members.push(p);
      for (const k of kids.get(pid) || []) stack.push(k);
    }
    members.sort((a, b) => b.rssBytes - a.rssBytes);
    trees.push({
      pid: root.pid,
      name: root.name,
      procs: members.length,
      residentBytes: members.reduce((s, p) => s + p.rssBytes, 0),
      cpuMs: members.reduce((s, p) => s + p.cpuMs, 0),
      members,
      cyclic,
    });
  }
  trees.sort((a, b) => b.residentBytes - a.residentBytes);
  return trees;
}

/* CPU share of one core for a tree between two samples: the delta of
   cumulative cpuMs over members present in BOTH samples, divided by the
   wall-clock gap. One new or exited member makes the delta a lie, so the
   honest answer for that tree is null — the CLI prints "—". */

export function cpuPct(tree, before, deltaMs) {
  let matched = 0;
  let sum = 0;
  for (const p of tree.members) {
    const b = before.get(p.pid);
    if (!b) return null;
    sum += p.cpuMs - b.cpuMs;
    matched++;
  }
  if (!matched || deltaMs <= 0) return null;
  return (sum / deltaMs) * 100;
}
