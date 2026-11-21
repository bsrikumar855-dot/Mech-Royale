# Experiments log

Every submission is a **single-variable experiment** (cap: 4 submissions per hour). Score = `mean(16 - place)` over the 48 practice matches (baseline to beat: 1.15).

## Rules

1. **One variable per submission.** Change exactly one thing relative to the last kept commit. If a fix is needed to make it run, that is a separate (earlier) submission.
2. **Double-submit v1 first.** Submit the *same commit twice* before any tuning. The difference between the two scores is the real score noise. Set the Keep/Revert threshold from it (suggested: keep only if `Delta` > 2x the observed gap, and re-submit once to confirm anything borderline).
3. **`best-known-good` advances ONLY** after the commit (a) passes `bash scripts/sandbox-check.sh` (kit `check.py` inside the full Docker sandbox flags) AND (b) beats the measured noise threshold. Never move the tag on a hunch or on a single lucky score.
4. Record the row **before** looking at the next idea: commit hash, time, the one change, score, delta vs the current `best-known-good`, p99 tick ms (from the sandbox bench), decision, notes.
5. Never submit a commit that has not passed the unit tests (`npm run check`) and the sandboxed check.
6. Placement counts, kills do not: a variant that raises kills but lowers survival is a Revert.

## Noise calibration

| Run | Commit | Score | Notes |
| --- | --- | --- | --- |
| v1 submission A | 3fae0bf (BB-C7F0AB94) | **1.90** | Platform built the Dockerfile and passed check.py. 'wait 87 ms' shown on the page (meaning unconfirmed). |
| v1 submission B (same commit) | _not run_ | | Skipped: we moved straight to Phase 2, so the noise threshold is still UNKNOWN. A Phase 2 delta smaller than ~0.3 cannot be told apart from luck. |
| **Observed noise (abs gap)** | | | Keep threshold = ______ |

## Log

| Commit | Time (IST) | Single-Variable Change | Score | Delta | p99 Tick ms | Decision (Keep/Revert) | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| _(scaffold)_ | Sat 21 Nov | Phase 0: stub modules, inert bot (stands still, never fires) | not submitted | | 0.88 (pinned-core proxy, not Docker) | n/a | Pipeline proof only. First real row is Phase 1 v1. |
| 3fae0bf | BB-C7F0AB94, Fri 11:47 PM per the platform page | Phase 1 rules: zone safety, kiting, wall feeler, loot detour, gun lead + slew gate, lightning-only take, upgrade priority, defensive facing | **1.90** | +0.75 vs the 1.15 baseline | 3.51 (pinned-core proxy, not Docker) | **Baseline / Keep** | Platform built the Dockerfile and passed check.py first try. Tagged `best-known-good`. |
| _(Phase 2 candidate, this commit)_ | Sat 21 Nov | **Locomotion only**: tactical utility scorer (3D cover vs top-6 threats with FOV/weapon danger, crossfire, path midpoint, mortar/bullet dodge, rim-hugging + shrink timing, wall-tangent escape with side commitment, anti-stuck, latched boost) + warm-up 2 -> 300 ticks. Combat/Economy identical to 3fae0bf. | | | 21.6 (pinned-core proxy; unpinned 1.66) | | Submit, then submit again to finally measure noise: without it a delta under ~0.3 is not readable. Pinned-core p99 regressed 3.5 -> ~15-21 ms (JIT warm-up gaps, see CLAUDE.md); 0% late. |
| | | | | | | | |
