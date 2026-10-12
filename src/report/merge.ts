import {
  maxSeverity,
  SEVERITY_ORDER,
  type Category,
  type ChangeStats,
  type Finding,
  type LlmFinding,
  type LlmReview,
  type ReviewResult,
} from "../schema.js";
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

/**
 * Reject LLM findings that cannot be true: resources that aren't in the plan,
 * or destroy/replace claims about resources that aren't being destroyed.
 */
function plausible(f: LlmFinding, actions: Map<string, ChangeKind>): boolean {
  const action = actions.get(f.resource);
  if (!action) return false;
  if (LIFECYCLE.includes(f.category) && action !== "delete" && action !== "replace" && action !== "forget")
    return false;
  return true;
}

/**
 * Rules whose suggestion is an exact, computed fix (e.g. the precise `moved` block).
 * The LLM's wording must never replace it.
 */
const EXACT_FIX_RULES = new Set(["missing-moved-block"]);

/**
 * Small models sometimes put a bare severity word ("High") in free-text fields.
 * Such text must not replace a rule's explanation.
 */
function substantive(text: string): boolean {
  return text.trim().split(/\s+/).length >= 4;
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
      // Keep the rule's exact issue text. Take the LLM's impact and fix when they're substantive,
      // except for rules whose fix is computed (see EXACT_FIX_RULES).
      blastRadius: substantive(match.blastRadius) ? match.blastRadius : pre.blastRadius,
      suggestion:
        !EXACT_FIX_RULES.has(pre.ruleId ?? "") && substantive(match.suggestion) ? match.suggestion : pre.suggestion,
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

  findings.sort(
    (a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity] || a.resource.localeCompare(b.resource),
  );

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
  if (total === 0) {
    return stats.moved
      ? `No infrastructure changes: ${stats.moved} resource${stats.moved === 1 ? " is" : "s are"} only renamed via \`moved\` blocks.`
      : "No infrastructure changes in this plan.";
  }
  const parts = (["create", "update", "replace", "delete"] as const)
    .filter((k) => stats[k] > 0)
    .map((k) => `${stats[k]} to ${k}`);
  const serious = findings.filter((f) => SEVERITY_ORDER[f.severity] >= SEVERITY_ORDER.high).length;
  return (
    `This plan changes ${total} resource${total === 1 ? "" : "s"} (${parts.join(", ")}). ` +
    (findings.length
      ? `Rule-based checks found ${findings.length} issue${findings.length === 1 ? "" : "s"}${serious ? `, ${serious} of them high or critical` : ""}.`
      : "Rule-based checks found no issues.")
  );
}
