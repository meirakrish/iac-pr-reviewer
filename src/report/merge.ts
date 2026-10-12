import { maxSeverity, SEVERITY_ORDER, type Category, type ChangeStats, type Finding, type LlmFinding, type LlmReview, type ReviewResult } from "../schema.js";
import type { ChangeKind } from "../plan/types.js";
import { sameIssue } from "./match.js";

export interface MergeInput {
  prechecks: Finding[];
  llm: LlmReview | null;
  llmMeta: ReviewResult["llm"];
  stats: ChangeStats;
  /** Planned action per changed resource; LLM findings about anything else are dropped. */
  actions: Map<string, ChangeKind>;
}

const LIFECYCLE: Category[] = ["destroy", "replace"];

/** Reject LLM findings that cannot be true: unknown resources, or destroy/replace claims about resources not being destroyed. */
function plausible(f: LlmFinding, actions: Map<string, ChangeKind>): boolean {
  const action = actions.get(f.resource);
  if (!action) return false;
  if (LIFECYCLE.includes(f.category) && action !== "delete" && action !== "replace" && action !== "forget") return false;
  return true;
}

/**
 * Combine deterministic and LLM findings.
 * The LLM can add findings and raise the risk level, but never remove or downgrade a precheck finding.
 */
export function mergeReview({ prechecks, llm, llmMeta, stats, actions }: MergeInput): ReviewResult {
  const llmFindings = (llm?.findings ?? []).filter((f) => plausible(f, actions));
  const used = new Set<number>();

  const findings: Finding[] = prechecks.map((pre) => {
    const idx = llmFindings.findIndex((f, i) => !used.has(i) && sameIssue(f, pre));
    if (idx === -1) return pre;
    used.add(idx);
    const match = llmFindings[idx]!;
    return {
      ...pre,
      source: "both",
      severity: maxSeverity([pre.severity, match.severity]),
      // Keep the deterministic issue text (it is exact), take the LLM's context-aware impact and fix.
      blastRadius: match.blastRadius || pre.blastRadius,
      suggestion: match.suggestion || pre.suggestion,
    };
  });

  for (const [i, f] of llmFindings.entries()) {
    if (used.has(i)) continue;
    const dup = findings.find((x) => x.source === "llm" && sameIssue(x, f));
    if (dup) {
      dup.severity = maxSeverity([dup.severity, f.severity]);
      continue;
    }
    findings.push({ ...f, source: "llm", ruleId: null });
  }

  findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.resource.localeCompare(b.resource));

  const riskLevel = maxSeverity([...(llm ? [llm.riskLevel] : []), ...findings.map((f) => f.severity)]);
  return {
    riskLevel,
    summary: llm?.summary.trim() || fallbackSummary(stats, findings),
    findings,
    stats,
    llm: llmMeta,
  };
}

function fallbackSummary(stats: ChangeStats, findings: Finding[]): string {
  const total = stats.create + stats.update + stats.delete + stats.replace;
  if (total === 0) return "No infrastructure changes in this plan.";
  const parts = Object.entries(stats)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${n} to ${k}`);
  const serious = findings.filter((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER.high).length;
  return `This plan changes ${total} resource${total === 1 ? "" : "s"} (${parts.join(", ")}). ` +
    (findings.length
      ? `Rule-based checks found ${findings.length} issue${findings.length === 1 ? "" : "s"}${serious ? `, ${serious} of them high or critical` : ""}.`
      : "Rule-based checks found no issues.");
}
