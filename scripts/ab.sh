#!/usr/bin/env bash
# Local paired A/B of two builds in the public sim-lite simulator (a TEST TOOL that lives
# OUTSIDE this repo; never vendored or imported). Layout, all siblings of this repo:
#   ../at-sim          git clone https://github.com/anthonyteti/buildathon-mech-royale
#   ../wt-base         git worktree of best-known-good (A)
#   ../wt-cand         git worktree of the candidate branch (B)
#   ../at-config.json  the `config` object of the hello line in _kit/check/stream.jsonl.gz
#   ../opponents.json  {"base": {"cwd": "<abs>/wt-base", "cmd": ["node","dist/index.js"]}, "cand": {...}}
#
# Usage: bash scripts/ab.sh <practice|ffa|both> [seed=1000] [n_practice=96] [n_ffa=24]
# Scores are mean(16 - place). Trust the paired delta, not the absolute level (sim-lite runs
# well below the official scorer).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PARENT="$(cd "$ROOT/.." && pwd)"
MODE="${1:-practice}"
SEED="${2:-1000}"
NP="${3:-96}"
NF="${4:-24}"
export KIT="${KIT:-$ROOT/_kit}"
export CFG="${CFG:-$PARENT/at-config.json}"
export OPP_REGISTRY="${OPP_REGISTRY:-$PARENT/opponents.json}"
SIM="${SIM:-$PARENT/at-sim}"
CORES="$(nproc 2>/dev/null || echo 4)"
JOBS="${JOBS:-$((CORES > 1 ? CORES - 1 : 1))}"
FJOBS="${FJOBS:-$(( (CORES / 4) > 1 ? CORES / 4 : 1 ))}" # FFA seats 16 bot processes per match

for wt in "$PARENT/wt-base" "$PARENT/wt-cand"; do
  (cd "$wt" && node scripts/build.mjs >/dev/null 2>&1) || { echo "build failed in $wt" >&2; exit 1; }
  echo "built $(cd "$wt" && git rev-parse --short HEAD) $(cd "$wt" && git rev-parse --abbrev-ref HEAD) in $wt"
done

cd "$SIM"
if [[ "$MODE" == practice || "$MODE" == both ]]; then
  echo "== practice paired, n=$NP seed=$SEED (A=base, B=cand)"
  node sim/run.ts practice --n "$NP" --seed "$SEED" --jobs "$JOBS" --a '{"ext":"base"}' --b '{"ext":"cand"}'
fi
if [[ "$MODE" == ffa || "$MODE" == both ]]; then
  echo "== ffa, n=$NF seed=$SEED (A=cand, B=base; 8 seats each)"
  node sim/run.ts ffa --n "$NF" --seed "$SEED" --jobs "$FJOBS" --a '{"ext":"cand"}' --b '{"ext":"base"}'
fi
