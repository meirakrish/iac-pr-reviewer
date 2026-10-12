import type { Category } from "../schema.js";

/** Categories that describe the same underlying risk; used to match LLM findings to prechecks and to expected eval findings. */
const CATEGORY_GROUP: Record<Category, string> = {
  destroy: "lifecycle",
  replace: "lifecycle",
  "data-loss": "lifecycle",
  iam: "iam",
  "network-exposure": "exposure",
  "public-storage": "exposure",
  encryption: "encryption",
  tagging: "tagging",
  cost: "cost",
  other: "other",
};

export function sameIssue(a: { resource: string; category: Category }, b: { resource: string; category: Category }): boolean {
  return a.resource === b.resource && CATEGORY_GROUP[a.category] === CATEGORY_GROUP[b.category];
}
