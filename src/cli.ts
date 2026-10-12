#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { Command, Option } from "commander";
import { resolveConfig } from "./config.js";
import { loadPlanFile, PlanError } from "./plan/load.js";
import { renderMarkdown } from "./report/markdown.js";
import { exceedsThreshold, reviewPlan } from "./review.js";

export const EXIT_THRESHOLD = 2;

const program = new Command()
  .name("iac-review")
  .description("Review a Terraform plan (terraform show -json output) for risky infrastructure changes.")
  .requiredOption("-p, --plan <file>", 'plan JSON file, or "-" for stdin')
  .addOption(new Option("-f, --format <format>", "output format").choices(["md", "json"]).default("md"))
  .option("-o, --out <file>", "write the report to a file instead of stdout")
  .option("--fail-on <level>", "exit with code 2 when risk >= level (none|low|medium|high|critical)")
  .addOption(new Option("--provider <name>", "LLM provider").choices(["ollama", "anthropic", "openai"]))
  .option("--model <name>", "LLM model name")
  .option("--no-llm", "skip the LLM step; run deterministic checks only")
  .option("--required-tags <list>", "comma-separated tag keys every taggable resource must have")
  .option("-q, --quiet", "suppress progress logs on stderr")
  .action(async (opts) => {
    const config = resolveConfig({
      provider: opts.provider,
      model: opts.model,
      noLlm: opts.llm === false ? true : undefined,
      requiredTags: opts.requiredTags,
      failOn: opts.failOn,
    });
    const log = opts.quiet ? () => {} : (msg: string) => console.error(`[iac-review] ${msg}`);

    const plan = await loadPlanFile(opts.plan);
    const result = await reviewPlan(plan, config, { log });

    const report = opts.format === "json" ? JSON.stringify(result, null, 2) + "\n" : renderMarkdown(result, { failOn: config.failOn });
    if (opts.out) await writeFile(opts.out, report);
    else process.stdout.write(report);

    log(`risk level: ${result.riskLevel} (${result.findings.length} findings)`);
    if (exceedsThreshold(result, config.failOn)) {
      log(`risk level ${result.riskLevel} >= fail-on threshold ${config.failOn}`);
      process.exitCode = EXIT_THRESHOLD;
    }
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`iac-review: ${err instanceof PlanError || err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
