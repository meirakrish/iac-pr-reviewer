import { maxSeverity, type Severity } from "../schema.js";
import { after, asArray, finding, type Precheck } from "./util.js";

const OPEN_CIDRS = new Set(["0.0.0.0/0", "::/0"]);
/** SSH, RDP, and common database / cache / search ports. */
const SENSITIVE_PORTS = new Set([22, 3389, 3306, 5432, 1433, 1521, 27017, 6379, 11211, 9200, 9300, 5601, 2375, 2379]);
const WEB_PORTS = new Set([80, 443]);

interface Rule {
  from: number;
  to: number;
  protocol: string;
  cidrs: string[];
}

function rulesFor(type: string, a: Record<string, unknown>): Rule[] {
  const toRule = (r: Record<string, unknown>, cidrs: string[]): Rule => ({
    from: Number(r.from_port ?? 0),
    to: Number(r.to_port ?? 65535),
    protocol: String(r.protocol ?? r.ip_protocol ?? "tcp"),
    cidrs,
  });
  switch (type) {
    case "aws_security_group":
      return asArray<Record<string, unknown>>(a.ingress).map((r) =>
        toRule(r, [...asArray<string>(r.cidr_blocks), ...asArray<string>(r.ipv6_cidr_blocks)]),
      );
    case "aws_security_group_rule":
      if (a.type !== "ingress") return [];
      return [toRule(a, [...asArray<string>(a.cidr_blocks), ...asArray<string>(a.ipv6_cidr_blocks)])];
    case "aws_vpc_security_group_ingress_rule":
      return [toRule(a, [...asArray<string>(a.cidr_ipv4), ...asArray<string>(a.cidr_ipv6)])];
    default:
      return [];
  }
}

function describePorts(r: Rule): string {
  if (r.protocol === "-1" || r.protocol === "all") return "all ports/protocols";
  return r.from === r.to ? `port ${r.from}` : `ports ${r.from}-${r.to}`;
}

function severityFor(r: Rule): Severity {
  const allTraffic = r.protocol === "-1" || r.protocol === "all" || (r.from <= 0 && r.to >= 65535);
  if (allTraffic) return "critical";
  for (const p of SENSITIVE_PORTS) if (p >= r.from && p <= r.to) return "critical";
  if (r.from === r.to && WEB_PORTS.has(r.from)) return "low";
  return "high";
}

export const ingressCheck: Precheck = (rc) => {
  const a = after(rc);
  if (!a) return [];
  const open = rulesFor(rc.type, a).filter((r) => r.cidrs.some((c) => OPEN_CIDRS.has(c)));
  if (!open.length) return [];

  const severity = maxSeverity(open.map(severityFor));
  const ports = open.map(describePorts).join(", ");
  return [
    finding(rc, "open-ingress", {
      severity,
      category: "network-exposure",
      issue: `Ingress open to the internet (0.0.0.0/0 or ::/0) on ${ports}.`,
      blastRadius:
        severity === "low"
          ? "Public HTTP(S) exposure; expected for load balancers, risky for anything else."
          : "Anything attached to this security group is reachable from the whole internet on these ports.",
      suggestion: "Restrict the source to known CIDRs, a VPN, or another security group; use SSM Session Manager instead of open SSH/RDP.",
    }),
  ];
};
