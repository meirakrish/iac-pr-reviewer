import { after, finding, type Precheck } from "./util.js";

function tagMap(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * Only resources that expose a tags/labels map are considered taggable. GCP uses `labels`
 * (its `tags` attribute on instances is a list of network tags, not metadata).
 * With requiredTags configured, every listed key must be present (provider defaults count,
 * via tags_all / terraform_labels). Without it, we only flag taggable resources with no tags at all.
 */
export const tagsCheck: Precheck = (rc, ctx) => {
  const a = after(rc);
  if (!a) return [];
  const gcp = rc.type.startsWith("google_");
  const [own, withDefaults] = gcp ? ["labels", "terraform_labels"] : ["tags", "tags_all"];
  if (!(own in a || withDefaults in a)) return [];

  // The "with defaults" map includes provider default_tags / default_labels; if it is unknown (omitted), fall back.
  const tags = tagMap(a[withDefaults]) ?? tagMap(a[own]) ?? {};
  const defaultsUnknown = (rc.change.after_unknown as Record<string, unknown> | undefined)?.[withDefaults] === true;
  // Unknown defaults may still be filled at apply time, so absence can't be proven.
  if (defaultsUnknown && Object.keys(tags).length === 0) return [];

  // GCP label keys must be lowercase, so compare case-insensitively there.
  const keys = new Set(Object.entries(tags).filter(([, v]) => v !== "").map(([k]) => (gcp ? k.toLowerCase() : k)));
  const missing = ctx.requiredTags.length
    ? ctx.requiredTags.filter((t) => !keys.has(gcp ? t.toLowerCase() : t))
    : keys.size === 0
      ? ["(any)"]
      : [];
  if (!missing.length) return [];

  const noun = gcp ? "labels" : "tags";
  return [
    finding(rc, "missing-tags", {
      severity: "low",
      category: "tagging",
      issue: ctx.requiredTags.length ? `Missing required ${noun}: ${missing.join(", ")}.` : `Resource has no ${noun}.`,
      blastRadius: "Harder cost allocation, ownership tracking and incident response; may violate tagging policies.",
      suggestion: ctx.requiredTags.length
        ? `Add ${missing.join(", ")} to ${noun}${gcp ? " (or the provider's default_labels)" : ", or set them once via the provider's default_tags block"}.`
        : `Add ownership/environment ${noun}${gcp ? ", ideally via the provider's default_labels" : ", ideally via the provider's default_tags block"}.`,
    }),
  ];
};
