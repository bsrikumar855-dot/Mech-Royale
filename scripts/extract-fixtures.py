"""Extracts a recorded hello + a few real observations from the kit stream into test/fixtures/ (small, committed)."""
import gzip, json, os, sys
root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = sys.argv[1] if len(sys.argv) > 1 else os.path.join(root, "_kit", "check", "stream.jsonl.gz")
with gzip.open(src, "rt") as f:
    msgs = [json.loads(l) for l in f if l.strip()]
hello = msgs[0]
obs = [m for m in msgs if m.get("type") == "obs"]
rich = sorted(obs, key=lambda o: -(len(o["mechs"]) + len(o["events"]) + len(o["sounds"]) + len(o["projectiles"])))[:6]
pick = sorted({o["tick"]: o for o in obs[:20] + rich}.values(), key=lambda o: o["tick"])
out = os.path.join(root, "test", "fixtures")
os.makedirs(out, exist_ok=True)
json.dump(hello, open(os.path.join(out, "hello.json"), "w"), separators=(",", ":"))
json.dump(pick, open(os.path.join(out, "obs.json"), "w"), separators=(",", ":"))
print("hello bytes", os.path.getsize(os.path.join(out, "hello.json")), "obs", len(pick), os.path.getsize(os.path.join(out, "obs.json")))
