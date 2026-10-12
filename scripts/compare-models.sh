#!/usr/bin/env bash
# Compare local Ollama models on the eval set and print a markdown table.
#
#   ./scripts/compare-models.sh qwen3.5:4b qwen3:8b ministral-3:8b
#   RUNS=1 ./scripts/compare-models.sh qwen2.5:7b-instruct      # one eval run instead of two
#   REMOVE_AFTER=1 ./scripts/compare-models.sh gemma4:e4b       # delete each model after testing it
#
# For each model: pull it (with retries), check it loads 100% on the GPU (models that would spill to the
# CPU are skipped), run `pnpm eval` RUNS times from a cold start, and collect the scores.
set -uo pipefail
cd "$(dirname "$0")/.."

RUNS=${RUNS:-2}
NUM_CTX=${LLM_NUM_CTX:-16384}
OUT=evals/results/compare-$(date +%Y%m%d-%H%M%S).md
ROWS=()

log() { printf '\033[1m==> %s\033[0m\n' "$*"; }

[[ $# -gt 0 ]] || {
  sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}
curl -s localhost:11434/api/version >/dev/null || {
  echo "Ollama isn't running on localhost:11434" >&2
  exit 1
}
[[ -f dist/cli.js ]] || pnpm build >/dev/null

for model in "$@"; do
  log "$model"

  if ! ollama list | awk 'NR>1 {print $1}' | grep -qx "$model"; then
    ok=""
    for attempt in 1 2 3; do
      ollama pull "$model" >/dev/null 2>&1 && ok=1 && break
      echo "   pull failed (attempt $attempt), retrying in 10s"
      sleep 10
    done
    [[ -n "$ok" ]] || {
      ROWS+=("| \`$model\` | — | pull failed | | | | | | |")
      continue
    }
  fi

  caps=$(curl -s localhost:11434/api/show -d "{\"model\":\"$model\"}" |
    node -e 'console.log((JSON.parse(require("fs").readFileSync(0)).capabilities||[]).join(","))')
  echo "   capabilities: $caps"

  # Load it once at the review's context size and check where Ollama put it.
  ollama stop "$model" >/dev/null 2>&1
  think=$([[ ",$caps," == *",thinking,"* ]] && echo ',"think":false' || echo '')
  load_err=$(curl -s --max-time 300 localhost:11434/api/generate \
    -d "{\"model\":\"$model\",\"prompt\":\"Say OK\",\"stream\":false$think,\"options\":{\"num_ctx\":$NUM_CTX,\"num_predict\":5}}" |
    node -e 'const j=JSON.parse(require("fs").readFileSync(0));console.log(j.error||"")')
  placement=$(ollama ps | awk -v m="$model" '$1==m {for (i=4;i<=NF;i++) if ($i ~ /GPU|CPU/) {print $(i-1), $i; exit}}')
  size=$(ollama ps | awk -v m="$model" '$1==m {print $3, $4}')
  ollama stop "$model" >/dev/null 2>&1
  if [[ -n "$load_err" ]]; then
    echo "   failed to load: $load_err"
    echo "   (cudaMalloc out of memory usually means Windows apps hold GPU memory: close the browser, or restart WSL)"
    ROWS+=("| \`$model\` | — | failed to load | | | | | | |")
    continue
  fi
  echo "   loaded: $size, $placement"
  if [[ "$placement" != "100% GPU" ]]; then
    echo "   skipped: doesn't fit fully on the GPU"
    ROWS+=("| \`$model\` | $size | skipped: $placement | | | | | | |")
    continue
  fi

  files=()
  for run in $(seq "$RUNS"); do
    ollama stop "$model" >/dev/null 2>&1
    echo "   eval run $run/$RUNS (cold start)..."
    result=$(LLM_NUM_CTX=$NUM_CTX pnpm eval --model "$model" 2>&1 | grep -oE 'results: .*' | cut -d' ' -f2)
    [[ -n "$result" ]] && files+=("$result")
  done
  [[ ${#files[@]} -gt 0 ]] || {
    ROWS+=("| \`$model\` | $size | eval failed | | | | | | |")
    continue
  }

  row=$(node -e '
    const fs = require("fs");
    const runs = process.argv.slice(1).map((f) => JSON.parse(fs.readFileSync(f, "utf8")));
    const avg = (f) => runs.reduce((n, r) => n + f(r), 0) / runs.length;
    const pct = (x) => (x === null || Number.isNaN(x) ? "n/a" : `${Math.round(x * 100)}%`);
    const failing = runs.map((r) => r.runs.filter((c) => {
      const s = c.score;
      return !s.riskOk || s.missed.length || s.underRated.length || s.extra.length;
    }).map((c) => c.name.slice(0, 2)));
    const llmErrors = runs.reduce((n, r) => n + r.runs.filter((c) => c.result.llm.error).length, 0);
    const ms = avg((r) => r.runs.reduce((n, c) => n + c.ms, 0) / r.runs.length);
    const stable = failing.every((f) => f.join() === failing[0].join()) ? "yes" : "no";
    console.log([
      pct(avg((r) => r.aggregate.riskAccuracy)),
      pct(avg((r) => r.aggregate.recall)),
      pct(avg((r) => r.aggregate.precision)),
      pct(avg((r) => r.aggregate.llmOnlyRecall ?? NaN)),
      failing[0].join(", ") || "none",
      `${(ms / 1000).toFixed(1)} s`,
      `${stable}${llmErrors ? ` (${llmErrors} LLM errors)` : ""}`,
    ].join(" | "));
  ' "${files[@]}")
  echo "   $row"
  ROWS+=("| \`$model\` | $size | $row |")

  [[ -n "${REMOVE_AFTER:-}" ]] && ollama rm "$model" >/dev/null && echo "   removed $model"
done

{
  echo "| Model | GPU memory | Risk level correct | Findings caught | Precision | LLM-only risks | Failing cases | Avg time | Stable across runs |"
  echo "|---|---|---|---|---|---|---|---|---|"
  printf '%s\n' "${ROWS[@]}"
} | tee "$OUT"
echo
echo "Saved to $OUT. Per-case details are in the evals/results/*.json files listed above."
echo "Before trusting precision, read the 'extra' findings: some are real issues reported on a neighbouring resource."
