#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { errorMessage, Provider } from "@meirakrish/llm-kit";
import { resolveConfig } from "./config.js";
import { loadPlanFile } from "./plan/load.js";
import { renderMarkdown } from "./report/markdown.js";
import { exceedsThreshold, reviewPlan } from "./review.js";

/** Exit codes: 0 = below the --fail-on threshold, 2 = at or above it, 1 = the review itself failed. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_THRESHOLD = 2;

const HELP = `Usage: iac-review --plan <file> [options]

Reviews a Terraform plan (terraform show -json output) for risky infrastructure changes.

Options:
  -p, --plan <file>        Plan JSON file, or "-" for stdin (required)
  -f, --format <format>    Report format: md (default) or json
  -o, --out <file>         Write the report to <file> instead of stdout
      --fail-on <level>    Exit with code 2 when the risk is at or above <level>:
                           none (default), low, medium, high or critical
      --provider <name>    LLM provider: ollama, anthropic or openai
                           (default: detected from API keys, else ollama)
      --model <name>       LLM model name
      --no-llm             Skip the LLM step; run the rule-based checks only
      --required-tags <list>
                           Comma-separated tag keys every taggable resource must have
  -q, --quiet              No progress logs on stderr
  -h, --help               Show this help

Exit codes: 0 below the threshold, 2 at or above --fail-on, 1 error.
Environment variables are listed in the README.`;

async function main(argv: string[]): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      plan: { type: "string", short: "p" },
      format: { type: "string", short: "f", default: "md" },
      out: { type: "string", short: "o" },
      "fail-on": { type: "string" },
      provider: { type: "string" },
      model: { type: "string" },
      "no-llm": { type: "boolean", default: false },
      "required-tags": { type: "string" },
      quiet: { type: "boolean", short: "q", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });

  if (values.help) {
    console.log(HELP);
    return EXIT_OK;
  }
  if (!values.plan) throw new Error('--plan is required (a plan JSON file, or "-" for stdin). See --help.');
  if (values.format !== "md" && values.format !== "json") {
    throw new Error(`--format must be "md" or "json", not "${values.format}"`);
  }
  if (values.provider !== undefined && !Provider.safeParse(values.provider).success) {
    throw new Error(`--provider must be one of ${Provider.options.join(", ")}, not "${values.provider}"`);
  }

  const config = resolveConfig({
    provider: values.provider,
    model: values.model,
    noLlm: values["no-llm"] || undefined,
    requiredTags: values["required-tags"],
    failOn: values["fail-on"],
  });
  const log = values.quiet ? () => {} : (msg: string) => console.error(`[iac-review] ${msg}`);

  const plan = await loadPlanFile(values.plan);
  const result = await reviewPlan(plan, config, { log });

  const report =
    values.format === "json"
      ? JSON.stringify(result, null, 2) + "\n"
      : renderMarkdown(result, { failOn: config.failOn });
  if (values.out) await writeFile(values.out, report);
  else process.stdout.write(report);

  log(`risk level: ${result.riskLevel} (${result.findings.length} findings)`);
  if (exceedsThreshold(result, config.failOn)) {
    log(`risk level ${result.riskLevel} >= fail-on threshold ${config.failOn}`);
    return EXIT_THRESHOLD;
  }
  return EXIT_OK;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(`iac-review: ${errorMessage(err)}`);
    process.exitCode = EXIT_ERROR;
  },
);
