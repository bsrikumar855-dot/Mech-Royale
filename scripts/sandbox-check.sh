#!/usr/bin/env bash
# Build the image and run the kit's conformance check + our latency bench INSIDE the full match sandbox.
# This is the gate every submission commit must pass (protocol.md section 1). Requires Docker and the kit in _kit/.
#
#   bash scripts/sandbox-check.sh            # build + check.py + bench
#   SKIP_BENCH=1 bash scripts/sandbox-check.sh
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${IMAGE:-mech-royale-bot}"
KIT="${KIT:-$PWD/_kit}"
[ -f "$KIT/check/check.py" ] || { echo "kit not found at $KIT (unpack mechfight-kit.tar.gz into _kit/)"; exit 2; }

# Git Bash on Windows rewrites "/arena" into a Windows path; turn that off.
export MSYS_NO_PATHCONV=1

SANDBOX=(docker run --rm -i --network none --cpus 1 --memory 512m --memory-swap 512m --pids-limit 128
         --read-only --tmpfs /tmp:rw,size=64m --user 65534:65534 -v "$KIT/arena:/arena:ro" "$IMAGE")

echo "== docker build (linux/amd64, time-boxed: the scorer allows 10 min) =="
time docker build --platform linux/amd64 -t "$IMAGE" .
docker image ls "$IMAGE" --format 'image size: {{.Size}}'

echo "== kit check.py inside the full sandbox =="
python3 "$KIT/check/check.py" --map-dir /arena -- "${SANDBOX[@]}"

if [ -z "${SKIP_BENCH:-}" ]; then
  echo "== latency bench inside the sandbox (cold start to ready includes container start) =="
  python3 scripts/bench.py --runs 5 --map-dir /arena --stream "$KIT/check/stream.jsonl.gz" -- "${SANDBOX[@]}"
fi
