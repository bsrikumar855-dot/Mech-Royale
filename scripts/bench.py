#!/usr/bin/env python3
"""Latency benchmark for a mechfight/1 bot. Standard library only.

Plays the kit's recorded stream (hello + 300 observations) to ANY command, lockstep like the server (one obs, wait
for its answer), and reports cold-start-to-ready and per-tick wall-clock p50/p95/p99/max.

    python scripts/bench.py -- node dist/index.js
    python scripts/bench.py --runs 5 --pin-cpu 0 -- node dist/index.js          # Windows: pin the bot to one core
    python scripts/bench.py --map-dir /arena -- docker run --rm -i --network none --cpus 1 --memory 512m \
        --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$PWD/_kit/arena:/arena:ro" my-bot

Latency is measured from the moment the obs line is written to the moment the answer line is read (same as the
server's definition), INCLUDING pipe + scheduler time. `--pin-cpu N` (Windows only) approximates the 1-CPU sandbox;
it is a proxy, NOT a substitute for the real `docker run --cpus 1` flags.
"""
import argparse
import gzip
import json
import os
import queue
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def pin_windows(proc, cpu):
    import ctypes

    k32 = ctypes.windll.kernel32
    k32.OpenProcess.restype = ctypes.c_void_p
    h = k32.OpenProcess(0x0200 | 0x0400, False, proc.pid)  # SET_INFORMATION | QUERY_INFORMATION
    ok = k32.SetProcessAffinityMask(ctypes.c_void_p(h), ctypes.c_size_t(1 << cpu))
    k32.CloseHandle(ctypes.c_void_p(h))
    return bool(ok)


def run_once(cmd, hello, obs, args):
    p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, bufsize=0)
    if args.pin_cpu is not None and os.name == "nt":
        pin_windows(p, args.pin_cpu)
    q = queue.Queue()

    def reader():
        for raw in p.stdout:
            q.put((time.perf_counter(), raw))
        q.put((time.perf_counter(), None))

    threading.Thread(target=reader, daemon=True).start()

    def send(m):
        p.stdin.write((json.dumps(m, separators=(",", ":")) + "\n").encode())
        p.stdin.flush()

    t0 = time.perf_counter()
    send(hello)
    t, raw = q.get(timeout=hello["config"]["bot"]["hello_budget_ms"] / 1000)
    ready_ms = (t - t0) * 1000
    assert raw and json.loads(raw).get("type") == "ready", f"expected ready, got {raw!r}"
    budget = hello["config"]["bot"]["tick_budget_ms"] / 1000
    lat, late, wrong = [], 0, 0
    for o in obs:
        s = time.perf_counter()
        send(o)
        try:
            while True:
                t, raw = q.get(timeout=budget + 0.5)
                if raw is None:
                    raise RuntimeError("bot exited mid-stream")
                if json.loads(raw).get("tick") == o["tick"]:
                    break
                wrong += 1
        except queue.Empty:
            late += 1
            lat.append(budget + 0.5)
            continue
        d = t - s
        lat.append(d)
        if d > budget:
            late += 1
    try:
        send({"type": "end", "place": 1, "kills": 0})
        p.stdin.close()
        p.wait(timeout=3)
    except Exception:
        p.kill()
    return ready_ms, sorted(x * 1000 for x in lat), late, wrong


def pct(v, q):
    return v[min(len(v) - 1, int(q * len(v)))]


def main():
    ap = argparse.ArgumentParser(usage="%(prog)s [options] -- <bot command...>")
    ap.add_argument("--stream", default=os.path.join(ROOT, "_kit", "check", "stream.jsonl.gz"))
    ap.add_argument("--map-dir", default=os.path.join(ROOT, "_kit", "arena"), help="what hello.map.dir says")
    ap.add_argument("--runs", type=int, default=5)
    ap.add_argument("--pin-cpu", type=int, default=None, help="Windows only: pin the bot process to this core")
    ap.add_argument("--json", action="store_true")
    ap.add_argument("cmd", nargs=argparse.REMAINDER)
    a = ap.parse_args()
    cmd = a.cmd[1:] if a.cmd[:1] == ["--"] else a.cmd
    if not cmd:
        ap.error("give the bot command after --")
    with gzip.open(a.stream, "rt") as f:
        msgs = [json.loads(l) for l in f if l.strip()]
    hello = msgs[0]
    hello["map"]["dir"] = a.map_dir if a.map_dir.startswith("/") else os.path.abspath(a.map_dir)
    obs = [m for m in msgs if m.get("type") == "obs"]

    readies, all_lat, late_total, wrong_total = [], [], 0, 0
    for _ in range(a.runs):
        r, lat, late, wrong = run_once(cmd, hello, obs, a)
        readies.append(r)
        all_lat += lat
        late_total += late
        wrong_total += wrong
    all_lat.sort()
    n = len(all_lat)
    res = {
        "cmd": " ".join(cmd),
        "runs": a.runs,
        "ticks": n,
        "ready_ms": {"min": min(readies), "median": sorted(readies)[len(readies) // 2], "max": max(readies)},
        "tick_ms": {"p50": pct(all_lat, 0.5), "p95": pct(all_lat, 0.95), "p99": pct(all_lat, 0.99), "p999": pct(all_lat, 0.999), "max": all_lat[-1]},
        "late_over_budget": late_total,
        "late_pct": 100.0 * late_total / n,
        "wrong_tick_lines": wrong_total,
    }
    if a.json:
        print(json.dumps(res))
    else:
        r, t = res["ready_ms"], res["tick_ms"]
        print(f"{res['cmd']}  ({a.runs} runs x {len(obs)} ticks = {n}){'  pinned to cpu ' + str(a.pin_cpu) if a.pin_cpu is not None else ''}")
        print(f"  ready ms : min {r['min']:.0f}  median {r['median']:.0f}  max {r['max']:.0f}")
        print(f"  tick ms  : p50 {t['p50']:.2f}  p95 {t['p95']:.2f}  p99 {t['p99']:.2f}  p99.9 {t['p999']:.2f}  max {t['max']:.2f}")
        print(f"  late (> {hello['config']['bot']['tick_budget_ms']} ms): {late_total} ({res['late_pct']:.2f}%)  [limit 2%]")


if __name__ == "__main__":
    sys.exit(main())
