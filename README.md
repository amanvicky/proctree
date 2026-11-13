# proctree

who is using the machine, grouped by **process tree** — Windows and Linux, **zero dependencies**.

A single PID is a lie. A browser is a dozen processes, a dev server is a worker pool, and a
per-process list tells you a renderer used 300 MB without telling you *which app* it belongs to.
`proctree` weighs whole trees — a root plus every descendant — in resident memory and CPU share,
heaviest first:

```
proctree — who is using the machine, grouped by process tree
win32 · 15.7 GB RAM · 276 processes · 01:08:48 (Δ 2011 ms)

 RESIDENT     CPU  PROCS  TREE (root pid)
   3.6 GB       —     62  explorer (14360)
      314.9 MB ZCode (15968)
      266.6 MB explorer (14360)
      250.6 MB Freebuff (16472)
       … 58 more — --full prints every member
   2.7 GB    0.8%     19  firefox (5844)
      409.1 MB firefox (5844)
      355.9 MB firefox (19292)
      303.1 MB firefox (22540)
       … 15 more — --full prints every member
   2.7 GB    5.4%    168  wininit (696)
```

## Start

```
node bin/proctree.js            # the top 12 trees, sampled twice for CPU
node bin/proctree.js --watch 2  # refresh every 2 s
node bin/proctree.js --pid 5844 # just one tree
node bin/proctree.js --json     # machine-readable, same data
```

| Flag | What it does |
| --- | --- |
| `--pid N` | only the tree that contains this process |
| `--name str` | only trees containing a process whose name includes this |
| `--ms N` | CPU sampling window in milliseconds (default 700) |
| `--top N` | how many trees to print (default 12, `0` = all) |
| `--full` | print every member of each tree, not just the heaviest few |
| `--json` | machine-readable output |
| `--watch [s]` | refresh every s seconds (default 2) |

Or install it as a command: `npm install -g .` (or `npm link`) → `proctree`.

## How the numbers are made

- **Windows**: one `Get-CimInstance Win32_Process` call per sample through PowerShell — roughly
  0.3–0.7 s per look, the honest cost of asking CIM politely. `WorkingSetSize` is treated as
  **bytes**, verified pid-for-pid against `tasklist`'s KB column; the CIM documentation says
  kilobytes and is wrong.
- **Linux**: `/proc/[pid]/stat` read directly — no subprocess, fast. Page size and clock ticks come
  from `getconf` once, with an honest note in the output when the fallback (4096 / 100) had to be
  assumed.
- **Resident memory** is the sum of what the OS reports each process physically holds (working set
  on Windows, RSS on Linux).
- **CPU** is the change in cumulative CPU time between two samples, divided by the wall-clock gap:
  100% is one core fully used, and a four-core machine can honestly sum past 400%.

## Honest limits

- **Shared pages are counted per process.** Summing resident memory inside a tree double-counts
  shared pages (a browser's renderers share their binary), so a tree total can exceed the machine's
  true usage by the shared part. Process Explorer has the same property; the exact alternative
  (unique-set accounting) needs APIs this tool deliberately avoids.
- **CPU shows `—` until a tree has existed across two samples**, and keeps showing `—` for any tree
  that gained or lost a member between them. A delta over a changed set is a made-up number, and
  this tool does not make those up. (This is why a busy desktop tree can sit at `—` while a stable
  server tree shows real percentages.)
- **First-sample JSON carries `cpuPct: null`**, and the same null marks every tree whose membership
  changed — scripts should treat null as "not measurable now", not as zero.
- **A process that exits mid-sample is simply absent** in the next one — it is gone, not guessed.
- **PID 0 is skipped**: System Idle is a Windows accounting fiction, not a process.
- **Working set is not total footprint.** Swapped or committed-but-resident-free memory is invisible
  by definition — this is the "physically held right now" number.
- The member list in `--json` output is capped at the 8 heaviest per tree and says so
  (`memberList: "top 8 of 60 …"`).

## Tests

27 tests, all real: the grouping tests spawn an actual child tree (a node process that spawns
another) and assert the sampler sees exactly that shape on the machine the tests run on; the busy
process is a real CPU-burning loop; the CLI is driven end to end and its JSON shape is pinned.
`buildTrees` gets synthetic maps for the pure math — orphans become roots, a self-parenting cycle
is flagged and counted once instead of looping forever.

```
node tests/run.mjs
```

CI runs the suite on **Ubuntu and Windows** (Node 18 + 22) — the two samplers are different code
paths (CIM vs `/proc`), so the cross-platform gate is the point, not a formality.

## License

MIT
