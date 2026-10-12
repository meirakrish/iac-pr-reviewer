import { describe, expect, it } from "vitest";
import { changedResources } from "../src/plan/load.js";
import { applyMask, opaqueUpdates, SENSITIVE, trimPlan, UNKNOWN } from "../src/plan/trim.js";
import { evalPlan, rc } from "./helpers.js";

describe("applyMask", () => {
  it("replaces nested sensitive values", () => {
    expect(applyMask({ a: 1, b: { c: "secret", d: 2 } }, { b: { c: true } }, SENSITIVE)).toEqual({
      a: 1,
      b: { c: SENSITIVE, d: 2 },
    });
  });

  it("materialises unknown attributes Terraform omitted from `after`", () => {
    expect(applyMask({ name: "x" }, { id: true, arn: true }, UNKNOWN)).toEqual({
      name: "x",
      id: UNKNOWN,
      arn: UNKNOWN,
    });
  });

  it("does not invent keys for sensitive masks", () => {
    expect(applyMask({ name: "x" }, { password: true }, SENSITIVE)).toEqual({ name: "x" });
  });
});

describe("opaqueUpdates", () => {
  it("finds updates whose changed values are all unknown until apply", () => {
    const opaque = rc("aws_iam_role_policy", {}, ["update"], {
      before: { policy: "{...}", name: "p" },
      after: { name: "p" },
      after_unknown: { policy: true },
    });
    const concrete = rc("aws_iam_role_policy", {}, ["update"], {
      before: { policy: "{...}" },
      after: { policy: "{changed}" },
    });
    expect([
      ...opaqueUpdates([
        { ...opaque, address: "a" },
        { ...concrete, address: "b" },
      ]),
    ]).toEqual(["a"]);
  });
});

describe("trimPlan", () => {
  it("never leaks sensitive values into the LLM payload", () => {
    const trimmed = trimPlan(changedResources(evalPlan("07-rds-public-unencrypted")));
    const json = JSON.stringify(trimmed);
    expect(json).not.toContain("Sup3rS3cret");
    expect(trimmed.changes[0]!.values!.password).toBe(SENSITIVE);
  });

  it("only includes differing attributes for updates", () => {
    const trimmed = trimPlan(changedResources(evalPlan("01-safe-tag-update")));
    const bucket = trimmed.changes.find((c) => c.address === "aws_s3_bucket.logs")!;
    expect(bucket.action).toBe("update");
    expect(Object.keys(bucket.changed!)).toContain("tags");
    expect(bucket.changed).not.toHaveProperty("bucket");
  });

  it("keeps replace paths and orders destructive changes first", () => {
    const changes = [rc("aws_sqs_queue", { name: "a" }), ...changedResources(evalPlan("08-ec2-ami-replace"))];
    const trimmed = trimPlan(changes);
    expect(trimmed.changes[0]!.action).toBe("replace");
    expect(trimmed.changes[0]!.replacePaths).toEqual([["ami"]]);
  });

  it("omits resources beyond the character budget", () => {
    const changes = Array.from({ length: 20 }, (_, i) => ({
      ...rc("aws_sqs_queue", { name: `q${i}`, pad: "x".repeat(200) }),
      address: `aws_sqs_queue.q${i}`,
    }));
    const trimmed = trimPlan(changes, 1000);
    expect(trimmed.changes.length).toBeGreaterThan(0);
    expect(trimmed.changes.length + trimmed.omitted.length).toBe(20);
    expect(trimmed.omitted.length).toBeGreaterThan(0);
  });
});
