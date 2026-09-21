#!/usr/bin/env bash
# One command that runs everything a reviewer or the production write sign-off needs.
# Usage (Bash/Zsh):  bash scripts/verify.sh
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> install"
pnpm install --frozen-lockfile 2>/dev/null || pnpm install

echo "==> build"
pnpm -r --filter './packages/*' run build

echo "==> typecheck"
npx tsc -b tsconfig.json

echo "==> test"
npx vitest run

echo "==> mock fidelity tally (the numbers README.md and docs/verification_status.md quote)"
python3 scripts/count_fidelity.py

echo
echo "All checks passed."
echo "Not covered here: the live eval (needs the mock running plus a model) —"
echo "  pnpm --filter @mcp-3pl/mock-extensiv start    # shell 1"
echo "  npx tsx evals/drive_client.ts --out evals/results/selections.json   # shell 2"
echo "  npx tsx evals/run.ts --from-file evals/results/selections.json"
