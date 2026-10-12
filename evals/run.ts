/**
 * Run the full review pipeline over every eval case and score it against expected.json.
 *
 *   npm run eval                        # default provider (env / Ollama)
 *   npm run eval -- --model llama3.1:8b
 *   npm run eval -- --provider anthropic --case 09
 *   npm run eval -- --no-llm            # prechecks-only baseline
 *
 * Results are written to evals/results/<timestamp>.json.
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { resolveConfig } from "../src/config.js";
import { parsePlan } from "../src/plan/load.js";
import { reviewPlan } from "../src/review.js";
import type { ReviewResult } from "../src/schema.js";
import { aggregate, Expected, scoreCase, type CaseScore } from "./score.js";

const CASES_DIR = join(import.meta.dirname, "cases");
const RESULTS_DIR = join(import.meta.dirname, "results");

const { values: args } = parseArgs({
  options: {
    provider: { type: "string" },
    model: { type: "string" },
    "no-llm": { type: "boolean", default: false },
    case: { type: "string" },
  },
});

const config = resolveConfig({ provider: args.provider, model: args.model, noLlm: args["no-llm"] || undefined });
const baselineConfig = { ...config, llm: null };
const label = config.llm ? `${config.llm.provider}/${config.llm.model}` : "prechecks only";

const caseNames = (await readdir(CASES_DIR)).filter((n) => !args.case || n.includes(args.case)).sort();
if (!caseNames.length) throw new Error(`No eval cases match "${args.case}"`);

console.log(`Evaluating ${caseNames.length} cases with ${label}\n`);

interface CaseRun {
  name: string;
  ms: number;
  result: ReviewResult;
  score: CaseScore;
  baseline: CaseScore;
}
const runs: CaseRun[] = [];

for (const name of caseNames) {
  const dir = join(CASES_DIR, name);
  const plan = parsePlan(await readFile(join(dir, "plan.json"), "utf8"));
  const expected = Expected.parse(JSON.parse(await readFile(join(dir, "expected.json"), "utf8")));

  const start = performance.now();
  const result = await reviewPlan(plan, config);
  const ms = performance.now() - start;
  const score = scoreCase(result, expected);
  const baseline = scoreCase(await reviewPlan(plan, baselineConfig), expected);
  runs.push({ name, ms, result, score, baseline });

  const ok = score.riskOk && !score.missed.length && !score.underRated.length && !score.extra.length;
  const llmNote = result.llm.error ? `  ⚠ LLM failed: ${result.llm.error}` : "";
  console.log(
    `${ok ? "✅" : "❌"} ${name.padEnd(32)} risk ${result.riskLevel.padEnd(8)} (want ${expected.risk.min === expected.risk.max ? expected.risk.min : `${expected.risk.min}-${expected.risk.max}`})` +
      `  ${(ms / 1000).toFixed(1)}s${llmNote}`,
  );
  for (const m of score.missed) console.log(`     missed:      ${m}`);
  for (const u of score.underRated) console.log(`     under-rated: ${u}`);
  for (const e of score.extra) console.log(`     extra:       ${e}`);
}

const agg = aggregate(runs.map((r) => r.score));
const base = aggregate(runs.map((r) => r.baseline));
const pct = (n: number | null) => (n === null ? "  n/a" : `${(n * 100).toFixed(0).padStart(4)}%`);

console.log(`\n${"".padEnd(18)}${label.padStart(28)}   prechecks only`);
console.log(`${"risk accuracy".padEnd(18)}${pct(agg.riskAccuracy).padStart(28)}   ${pct(base.riskAccuracy)}`);
console.log(`${"finding recall".padEnd(18)}${pct(agg.recall).padStart(28)}   ${pct(base.recall)}`);
console.log(`${"finding precision".padEnd(18)}${pct(agg.precision).padStart(28)}   ${pct(base.precision)}`);
console.log(`${"LLM-only recall".padEnd(18)}${pct(agg.llmOnlyRecall).padStart(28)}   ${pct(base.llmOnlyRecall)}`);
const llmFailures = runs.filter((r) => r.result.llm.error).length;
if (llmFailures) console.log(`\n⚠ LLM call failed on ${llmFailures}/${runs.length} cases; those fell back to prechecks only.`);
console.log(`avg latency ${(runs.reduce((n, r) => n + r.ms, 0) / runs.length / 1000).toFixed(1)}s`);

await mkdir(RESULTS_DIR, { recursive: true });
const out = join(RESULTS_DIR, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
await writeFile(out, JSON.stringify({ label, aggregate: agg, baseline: base, runs }, null, 2));
console.log(`results: ${out}`);
