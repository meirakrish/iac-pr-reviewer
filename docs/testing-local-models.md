# Testing local models

How to compare small local Ollama models on this project's eval set, and decide whether one should replace the default (`qwen3.5:9b`).

## Prompt for a new Claude Code session

Paste this into a new session started in this repo:

> Read `docs/testing-local-models.md` and follow it. Compare these small Ollama models against the current default `qwen3.5:9b`: `qwen3.5:4b`, `qwen3:8b`, `ministral-3:8b`, `gemma4:e4b`, `granite4:tiny-h`. Use `scripts/compare-models.sh` (two cold runs per model). Only consider models that run 100% on the GPU. When done, show me one comparison table including the baseline models below, read every "extra" finding to judge whether it's a real issue or an invented one, and recommend whether to change the default. Don't change any code or commit anything without asking me.

## Before you start

1. **Close the browser and other GPU-heavy Windows apps.** On this WSL machine, Windows apps hold GPU memory that WSL can't use, even when `nvidia-smi` shows it as free. The symptom is `cudaMalloc failed: out of memory` in the eval output. If closing apps doesn't help, run `wsl --shutdown` in PowerShell and reopen WSL. That raised the usable GPU memory from about 6 GB to about 10 GB.
2. **Check that Ollama is running:**
   ```bash
   curl -s localhost:11434/api/version
   ```
3. **Build the project** (the script uses `dist/`):
   ```bash
   npm install && npm run build
   ```

## Run the comparison

```bash
./scripts/compare-models.sh qwen3.5:4b qwen3:8b ministral-3:8b gemma4:e4b granite4:tiny-h
```

For each model, the script:

1. downloads it, retrying if Ollama's registry returns a temporary error (this happened once with `qwen3.5:9b`)
2. loads it once and checks `ollama ps`. Models that don't fit **100% on the GPU are skipped**, because running partly on the CPU is several times slower and isn't worth it
3. runs `npm run eval` twice, each time from a cold start (the first request after loading is where small models misbehave most)
4. prints a markdown table and saves it to `evals/results/compare-<timestamp>.md`

It takes about 5–8 minutes per model. Options:

- `RUNS=1`: one eval run per model (faster, less reliable)
- `REMOVE_AFTER=1`: delete each model after testing it, to save disk space

Models that can "think" (Qwen3/3.5, Gemma 4) are handled automatically: the reviewer turns thinking off for models that support it.

## Baseline to compare against

Measured on the same 25 cases, two cold runs each, 100% on the GPU:

| Model | GPU memory | Risk level correct | Findings caught | Precision | LLM-only risks | Failing cases | Avg time |
|---|---|---|---|---|---|---|---|
| **`qwen3.5:9b`** (default) | 6.1 GB | 100% | 100% | 91%\* | 100% | 05, 17, 23\* | 6.9 s |
| `qwen2.5:7b-instruct` | 5.6 GB | 100% | 97% | 100% | 80% | 25 | 4.5 s |
| `qwen2.5-coder:7b` | 5.6 GB | 96% | 94% | 91% | 60% | 16, 21, 25 | 4.1 s |

\* `qwen3.5:9b`'s three "extra" findings are real issues reported on a neighbouring resource (for example, the S3 bucket a policy makes public), not invented ones. In practice its precision is about 100%.

Ruled out earlier: models above ~9 GB (`qwen3:14b`, `qwen2.5:14b-instruct`, `gemma4:12b`) don't fit fully on this GPU, and partial CPU offload was too slow to be worth it.

## How to judge the results

The numbers alone can mislead, so check these before recommending a model:

- **Read every "extra" finding.** In `evals/results/<timestamp>.json`, look at the case's `result.findings` with `source: "llm"`. If the claim is true from the plan (just attributed to a different resource than the expected one), it's fine. If it states something the plan doesn't show (for example "the storage account is publicly accessible" on the safe Azure case 16), it's an **invented risk**, which is the worst failure for a reviewer.
- **Invented risks on safe cases (01, 02, 11, 16, 22, 24) rule a model out**: they're false alarms on clean PRs.
- **Case 25** (a public database two modules deep) is the hardest case: only `qwen3.5:9b` has caught it.
- **"Stable across runs = no"** means the two runs disagreed. Don't trust a single good run.
- **LLM errors** in the table mean failed calls. If they're `cudaMalloc` errors, it's the GPU memory issue above, not the model. Free the GPU and rerun that model.

A model should only replace `qwen3.5:9b` if it catches at least as many risks, invents none, and is either clearly faster or clearly better on the hard cases.

## Confirm a winner on deployed infrastructure

If a model looks better than the default, run it through the LocalStack demo, which reviews four PRs against a stack deployed in Docker:

```bash
./examples/localstack/demo.sh down
```

```bash
IAC_REVIEW_MODEL=<model> ./examples/localstack/demo.sh all
```

Run `down` first: after a WSL restart, the saved Terraform state no longer matches LocalStack's (empty) memory. Expected results: `safe` LOW with no findings, `risky` CRITICAL with 5 findings, `rename` CRITICAL with one finding and the `moved` fix, `rename-moved` LOW.

## Known pitfalls

- **Don't `pkill -f <pattern>` / `pgrep -f <pattern>`** with a pattern that appears in your own command line: it kills the shell running it. Use a bracket trick like `pgrep -f "[e]vals/run.ts"`.
- **The first eval case is sometimes slower** because the model is loading. That's normal.
- **Deleting a model:** `ollama rm <model>`.
