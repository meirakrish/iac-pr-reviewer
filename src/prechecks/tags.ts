import { after, finding, type Precheck } from "./util.js";

function tagMap(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Only resources that expose a `tags` attribute are considered taggable.
 * With requiredTags configured, every listed key must be present (provider default_tags count, via tags_all).
 * Without it, we only flag taggable resources that have no tags at all.
 */
export const tagsCheck: Precheck = (rc, ctx) => {
  const a = after(rc);
  if (!a || !("tags" in a || "tags_all" in a)) return [];

  // tags_all includes provider default_tags; if it is unknown (omitted), fall back to tags.
  const tags = tagMap(a.tags_all) ?? tagMap(a.tags) ?? {};
  const tagsAllUnknown = (rc.change.after_unknown as Record<string, unknown> | undefined)?.tags_all === true;
  // Unknown tags_all may still be filled by default_tags at apply time, so absence can't be proven.
  if (tagsAllUnknown && Object.keys(tags).length === 0) return [];

  const missing = ctx.requiredTags.length
    ? ctx.requiredTags.filter((t) => !(t in tags) || tags[t] === "")
    : Object.keys(tags).length === 0
      ? ["(any)"]
      : [];
  if (!missing.length) return [];

  return [
    finding(rc, "missing-tags", {
      severity: "low",
      category: "tagging",
      issue: ctx.requiredTags.length ? `Missing required tags: ${missing.join(", ")}.` : "Resource has no tags.",
      blastRadius: "Harder cost allocation, ownership tracking and incident response; may violate tagging policies.",
      suggestion: ctx.requiredTags.length
        ? `Add ${missing.join(", ")} to tags, or set them once via the provider's default_tags block.`
        : "Add ownership/environment tags, ideally via the provider's default_tags block.",
    }),
  ];
};
