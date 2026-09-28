#!/usr/bin/env sh
# Offline reproduction of the idle existing-data analysis. No network, no model call, no timer.
# usage (from the omo-keepwarm root):
#   ROLLOVER_REPO=<omo-rollover checkout at d8a4abd> sh research/existing-data-analysis/scripts/run-all.sh [out dir]
# The scripts import the idle-cost engine and analyzer from that checkout (extension/rollover.ts,
# scripts/idle-live-analyze.mjs, docs/idle-live-results.json on branch wt/idle-cost-shadow-implementation).
set -eu
: "${ROLLOVER_REPO:?set ROLLOVER_REPO to an omo-rollover checkout at d8a4abd}"
OUT=${1:-research/existing-data-analysis/evidence/out}
S=research/existing-data-analysis/scripts
RERUN=C:/dev/omo/omo-rollover-wt/idle-rerun-w1/.omo/ulw-execute/evidence/idle-live-run/rerun/20260927-052028
node "$S/q-episodes.mjs" --out "$OUT"
node "$S/gauge-lag-scan.mjs" --out "$OUT"
node "$S/restore-reanalysis.mjs" --out "$OUT" --repo "$ROLLOVER_REPO"
node "$S/dp-replay.mjs" --out "$OUT" --repo "$ROLLOVER_REPO" --q "$OUT/q-summary.json" --restore "$OUT/restore-reanalysis.json" \
  --gauge "$OUT/gauge-lag-scan.json" --rerun "$RERUN"
