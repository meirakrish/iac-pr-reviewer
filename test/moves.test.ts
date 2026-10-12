import { describe, expect, it } from "vitest";
import { detectMoves } from "../src/plan/moves.js";
import { changedResources } from "../src/plan/load.js";
import { runPrechecks } from "../src/prechecks/index.js";
import type { Action, ResourceChange } from "../src/plan/types.js";
import { evalPlan } from "./helpers.js";

function res(address: string, actions: Action[], values: Record<string, unknown> = {}): ResourceChange {
  const m = address.match(/^(.*module\.[^.]+(?:\[[^\]]*\])?)\.([^.]+)\.(.+)$/);
  const [module_address, type, name] = m ? [m[1], m[2]!, m[3]!] : [undefined, ...address.split(".")];
  const deleting = actions.includes("delete");
  return {
    address,
    module_address,
    mode: "managed",
    type: type!,
    name: name!,
    change: { actions, before: deleting ? values : null, after: deleting ? null : values },
  };
}

describe("detectMoves", () => {
  it("suggests one module-level moved block when a whole module was renamed", () => {
    const moves = detectMoves([
      res("module.old.aws_db_instance.this", ["delete"]),
      res("module.old.aws_security_group.db", ["delete"]),
      res("module.new.aws_db_instance.this", ["create"]),
      res("module.new.aws_security_group.db", ["create"]),
    ]);
    expect(moves.get("module.old.aws_db_instance.this")).toMatchObject({ to: "module.new.aws_db_instance.this", via: "module", movedFrom: "module.old", movedTo: "module.new" });
    expect(moves.size).toBe(2);
  });

  it("falls back to resource-level moved blocks when only part of a module moved", () => {
    const moves = detectMoves([
      res("module.old.aws_db_instance.this", ["delete"]),
      res("module.old.aws_s3_bucket.stays", ["no-op"]),
      res("module.new.aws_db_instance.this", ["create"]),
    ]);
    expect(moves.get("module.old.aws_db_instance.this")).toMatchObject({ movedFrom: "module.old.aws_db_instance.this", movedTo: "module.new.aws_db_instance.this" });
  });

  it("handles nested modules and for_each keys", () => {
    const moves = detectMoves([
      res('module.app.module.db["eu"].aws_db_instance.this', ["delete"]),
      res('module.platform.module.db["eu"].aws_db_instance.this', ["create"]),
    ]);
    expect(moves.get('module.app.module.db["eu"].aws_db_instance.this')).toMatchObject({ movedFrom: 'module.app.module.db["eu"]', movedTo: 'module.platform.module.db["eu"]' });
  });

  it("pairs renamed resources by identifying attribute", () => {
    const moves = detectMoves([res("aws_s3_bucket.logs", ["delete"], { bucket: "acme-logs" }), res("aws_s3_bucket.app_logs", ["create"], { bucket: "acme-logs" })]);
    expect(moves.get("aws_s3_bucket.logs")).toMatchObject({ to: "aws_s3_bucket.app_logs", via: "identity", movedFrom: "aws_s3_bucket.logs" });
  });

  it("does not pair different types, different identities, or plain deletes", () => {
    expect(detectMoves([res("aws_s3_bucket.a", ["delete"], { bucket: "x" }), res("aws_s3_bucket.b", ["create"], { bucket: "y" })]).size).toBe(0);
    expect(detectMoves([res("module.a.aws_s3_bucket.this", ["delete"]), res("module.b.aws_sqs_queue.this", ["create"])]).size).toBe(0);
    expect(detectMoves([res("aws_db_instance.orders", ["delete"], { identifier: "orders" })]).size).toBe(0);
  });

  it("pairs each created resource at most once", () => {
    const moves = detectMoves([
      res("aws_s3_bucket.a", ["delete"], { bucket: "same" }),
      res("aws_s3_bucket.b", ["delete"], { bucket: "same" }),
      res("aws_s3_bucket.c", ["create"], { bucket: "same" }),
    ]);
    expect(moves.size).toBe(1);
  });
});

describe("missing moved block finding", () => {
  it("explains the rename and gives the exact moved block on a real plan", () => {
    const plan = evalPlan("23-module-rename-no-moved");
    const findings = runPrechecks(changedResources(plan), { requiredTags: [], moves: detectMoves(plan.resource_changes ?? []) });
    const db = findings.find((f) => f.resource === "module.orders_db.aws_db_instance.this")!;
    expect(db).toMatchObject({ severity: "critical", ruleId: "missing-moved-block", category: "data-loss" });
    expect(db.issue).toContain("module.orders_database.aws_db_instance.this");
    expect(db.suggestion).toContain("`from = module.orders_db` and `to = module.orders_database`");
    const bucket = findings.find((f) => f.resource === "aws_s3_bucket.logs")!;
    expect(bucket.suggestion).toContain("`from = aws_s3_bucket.logs` and `to = aws_s3_bucket.app_logs`");
  });

  it("reports nothing for the same refactor done with moved blocks", () => {
    const plan = evalPlan("24-module-rename-with-moved");
    expect(changedResources(plan)).toEqual([]);
    expect(detectMoves(plan.resource_changes ?? []).size).toBe(0);
  });
});
