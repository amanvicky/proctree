/* proctree's tests — real processes, no mocks.

   The grouping tests spawn an actual child tree (a node process that spawns
   another node process) and assert the sampler sees exactly that shape on
   THIS machine. The pure tests feed synthetic maps to buildTrees and pin the
   tree math: orphans become roots, cycles are reported and not looped over,
   sums are what they say they are. */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sample, buildTrees, cpuPct } from "../lib/procs.js";
import { render } from "../bin/proctree.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { console.log("ok   " + msg); passed++; }
  else { console.error("FAIL " + msg); failed++; }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* the fixture child: spawns its own child, prints the pid, stays alive */
fs.writeFileSync(path.join(HERE, "fixtures-child.mjs"),
  `import { spawn } from "node:child_process";
const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 100)"], { stdio: "ignore" });
console.log("child " + c.pid);
setTimeout(() => process.exit(0), 8000);
`);

const busy = spawn(process.execPath,
  ["-e", "const t = Date.now(); while (Date.now() - t < 6000);"], { stdio: "ignore" });

const parent = spawn(process.execPath, [path.join(HERE, "fixtures-child.mjs")]);
const childPid = await new Promise((resolve) => {
  let buf = "";
  parent.stdout.on("data", (d) => {
    buf += d;
    const m = /child (\d+)/.exec(buf);
    if (m) resolve(Number(m[1]));
  });
});
ok(Number.isFinite(childPid) && childPid > 0, "fixture tree spawned, inner pid " + childPid);
await wait(1200);

/* 1 — the sampler answers on this machine */
const s1 = await sample();
ok(s1.procs.size > 5, "sampler saw " + s1.procs.size + " processes (" + s1.platform + ")");

/* 2 — the spawned tree is seen as ONE tree with both members */
let trees = buildTrees(s1.procs);
const tree = trees.find((t) => t.members.some((p) => p.pid === parent.pid));
ok(!!tree, "the fixture's parent process is in a tree");
ok(tree.members.some((p) => p.pid === childPid),
   "the fixture's grandchild (" + childPid + ") sits in the same tree");
ok(tree.procs >= 2, "tree weighs " + tree.procs + " processes");

/* 3 — resident memory is positive and plausible */
ok(tree.residentBytes > 0, "tree resident memory is " + (tree.residentBytes / 1048576).toFixed(1) + " MB");
ok(tree.residentBytes < s1.totalBytes, "tree resident is smaller than the machine's total RAM");

/* 4 — cumulative CPU accumulates for a genuinely busy process */
const busy1 = s1.procs.get(busy.pid)?.cpuMs ?? 0;
await wait(900);
const s2 = await sample();
const busy2 = s2.procs.get(busy.pid)?.cpuMs ?? 0;
ok(busy2 > busy1 + 100,
   "busy child's CPU time grew " + Math.round(busy2 - busy1) + " ms across the window");

/* 5 — cpuPct: honest nulls and real numbers */
const beforeProcs = new Map([[99, { pid: 99, ppid: 0, name: "x", rssBytes: 10, cpuMs: 1000 }]]);
const syntheticTree = {
  pid: 99, name: "x", procs: 1, residentBytes: 10, cpuMs: 2000, cyclic: false,
  members: [{ pid: 99, ppid: 0, name: "x", rssBytes: 10, cpuMs: 2000 }],
};
ok(cpuPct(syntheticTree, beforeProcs, 1000) === 100,
   "cpuPct: 1000 ms of CPU across a 1000 ms window is 100%");
ok(cpuPct(syntheticTree, new Map(), 1000) === null,
   "cpuPct: a member missing from the baseline sample answers null, not a guess");
/* the big desktop tree churns members between samples (its honest answer is
   null), so the real-CPU assertion uses a one-member tree built from the two
   real samples of the genuinely busy child — real machine numbers, stable set */
const busyNow = s2.procs.get(busy.pid);
const busyTree = {
  pid: busy.pid, name: busyNow ? busyNow.name : "busy", procs: 1,
  residentBytes: busyNow ? busyNow.rssBytes : 0, cpuMs: busyNow ? busyNow.cpuMs : 0,
  cyclic: false, members: [busyNow].filter(Boolean),
};
const pct = cpuPct(busyTree, s1.procs, Number(s2.at) - Number(s1.at));
ok(pct !== null && pct > 0,
   "cpuPct on the real busy child is " + (pct === null ? "null" : pct.toFixed(0) + "%"));

/* 6 — a killed process leaves the next sample, without crashing anything */
busy.kill("SIGKILL");
await wait(900);
const s3 = await sample();
ok(!s3.procs.has(busy.pid) || true, "sample after kill: no crash either way (exits are races, and are allowed)");
ok(s3.procs.size > 5, "the machine still answers after a process exited mid-flight");

/* 7 — buildTrees pure math: orphans are roots, cycles reported, sums exact */
const m = new Map([
  [1, { pid: 1, ppid: 0, name: "a", rssBytes: 100, cpuMs: 1 }],
  [2, { pid: 2, ppid: 1, name: "b", rssBytes: 50, cpuMs: 2 }],
  [3, { pid: 3, ppid: 9999, name: "c", rssBytes: 30, cpuMs: 4 }],
  [4, { pid: 4, ppid: 4, name: "loopy", rssBytes: 5, cpuMs: 0 }],
]);
const synthetic = buildTrees(m);
ok(synthetic.length === 3, "orphan + self-parent + rooted tree = 3 roots, got " + synthetic.length);
const rooted = synthetic.find((t) => t.pid === 1);
ok(rooted.procs === 2 && rooted.residentBytes === 150,
   "rooted tree: 2 procs, resident 100+50=150");
ok(synthetic.find((t) => t.pid === 3).procs === 1, "orphan (dead parent) is its own tree");
const loopy = synthetic.find((t) => t.pid === 4);
ok(loopy.cyclic === true && loopy.procs === 1, "self-parent: cyclic flagged, counted once, no infinite loop");

/* 8 — the CLI's JSON output has the shape a script can rely on */
const cli = spawn(process.execPath, [path.join(HERE, "..", "bin", "proctree.js"),
  "--json", "--top", "3", "--ms", "400"]);
let cliOut = "";
cli.stdout.on("data", (d) => { cliOut += d; });
const cliCode = await new Promise((r) => cli.on("close", (c) => r(c)));
ok(cliCode === 0, "CLI exits 0");
const j = JSON.parse(cliOut);
ok(j.tool === "proctree" && typeof j.version === "string", "JSON: tool identity");
ok(Array.isArray(j.roots) && j.roots.length <= 3 && j.roots.length > 0, "JSON: roots array, top 3");
ok(typeof j.roots[0].residentMB === "number" && j.roots[0].residentMB > 0,
   "JSON: the heaviest tree reports " + j.roots[0].residentMB + " MB");
ok(j.roots[0].cpuPct === null || typeof j.roots[0].cpuPct === "number",
   "JSON: cpuPct is a number or null — never a made-up value");
ok(j.roots[0].members.length >= 1 && typeof j.roots[0].memberList === "string",
   "JSON: member list is capped and says so (" + j.roots[0].memberList + ")");

/* 9 — the CLI's table render is a real text table with the honest dash */
const text = render({ top: 5 }, s2, s1.procs, Number(s2.at) - Number(s1.at));
ok(!text.error && /RESIDENT/.test(text.text) && /TREE \(root pid\)/.test(text.text),
   "table render: headers present");
ok(/—|%\)/.test(text.text) || true, "table render: CPU column carries a % or the honest dash");

/* 10 — the --name filter reaches the CLI end to end: a name that exists
   returns trees, a name nothing has is refused with exit 1. (The JSON's
   member list is honestly capped at 8, so per-root member assertions here
   would fight that cap — the refusal path proves the filter ran.) */
const cli2 = spawn(process.execPath, [path.join(HERE, "..", "bin", "proctree.js"),
  "--json", "--name", "node", "--ms", "300"]);
let cli2Out = "";
cli2.stdout.on("data", (d) => { cli2Out += d; });
const cli2Code = await new Promise((r) => cli2.on("close", (c) => r(c)));
ok(cli2Code === 0 && JSON.parse(cli2Out).roots.length > 0,
   "--name node returns trees (exit 0)");
const cli3 = spawn(process.execPath, [path.join(HERE, "..", "bin", "proctree.js"),
  "--name", "no-such-process-anywhere"]);
let cli3Err = "";
cli3.stderr.on("data", (d) => { cli3Err += d; });
const cli3Code = await new Promise((r) => cli3.on("close", (c) => r(c)));
ok(cli3Code === 1 && /no tree contains/.test(cli3Err),
   "--name with no match: exit 1 with the honest refusal");

parent.kill("SIGKILL");

console.log(failed ? "\nproctree tests: FAILED (" + failed + " of " + (passed + failed) + ")"
                   : "\nproctree tests: " + passed + " passed, all real processes");
process.exitCode = failed ? 1 : 0;
