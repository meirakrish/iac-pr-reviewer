import { SEVERITY_ORDER, type Finding } from "../schema.js";
import type { ResourceChange } from "../plan/types.js";
import { destroyCheck } from "./destroy.js";
import { encryptionCheck } from "./encryption.js";
import { iamCheck } from "./iam.js";
import { ingressCheck } from "./ingress.js";
import { s3PublicCheck } from "./s3-public.js";
import { tagsCheck } from "./tags.js";
import type { Precheck, PrecheckContext } from "./util.js";

export type { PrecheckContext } from "./util.js";

export const PRECHECKS: Precheck[] = [destroyCheck, iamCheck, ingressCheck, s3PublicCheck, encryptionCheck, tagsCheck];

/** Run every deterministic check against the changed resources. Findings are sorted most severe first. */
export function runPrechecks(changes: ResourceChange[], ctx: PrecheckContext): Finding[] {
  const findings = changes.flatMap((rc) => PRECHECKS.flatMap((check) => check(rc, ctx)));
  return findings.sort((a, b) => SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity]);
}
