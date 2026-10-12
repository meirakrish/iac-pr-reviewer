import { maxSeverity, type Severity } from "../schema.js";
import { after, asArray, finding, type Precheck } from "./util.js";

/** Sources meaning "the whole internet" across AWS CIDRs, Azure NSG service tags and GCP source ranges. */
const OPEN_SOURCES = new Set(["0.0.0.0/0", "::/0", "*", "internet", "any", "0.0.0.0"]);
/** SSH, RDP, and common database / cache / search / container-API ports. */
const SENSITIVE_PORTS = new Set([22, 3389, 3306, 5432, 1433, 1521, 27017, 6379, 11211, 9200, 9300, 5601, 2375, 2379]);
const WEB_PORTS = new Set([80, 443]);

interface Rule {
  /** Inclusive port ranges; empty with allTraffic = every port. */
  ranges: [number, number][];
  allTraffic: boolean;
  sources: string[];
}

const ALL_PROTOCOLS = new Set(["-1", "all", "*"]);

/** Parse "22", "1000-2000", "*" (Azure/GCP port specs). Returns null for "any port". */
function parsePortSpec(spec: unknown): [number, number] | null {
  const s = String(spec).trim();
  if (s === "*" || s === "") return null;
  const [a, b] = s.split("-").map(Number);
  return [a!, b ?? a!];
}

function awsRule(r: Record<string, unknown>, sources: string[]): Rule {
  const protocol = String(r.protocol ?? r.ip_protocol ?? "tcp").toLowerCase();
  const from = Number(r.from_port ?? 0);
  const to = Number(r.to_port ?? 65535);
  return { ranges: [[from, to]], allTraffic: ALL_PROTOCOLS.has(protocol) || (from <= 0 && to >= 65535), sources };
}

function azureRule(r: Record<string, unknown>): Rule | null {
  if (String(r.direction).toLowerCase() !== "inbound" || String(r.access).toLowerCase() !== "allow") return null;
  const specs = [r.destination_port_range, ...asArray(r.destination_port_ranges)].filter(
    (p) => p !== null && p !== undefined && p !== "",
  );
  const ranges = specs.map(parsePortSpec);
  return {
    ranges: ranges.filter((x): x is [number, number] => x !== null),
    allTraffic: ranges.includes(null) || specs.length === 0,
    sources: [r.source_address_prefix, ...asArray(r.source_address_prefixes)].filter(
      (s): s is string => typeof s === "string",
    ),
  };
}

function gcpRules(a: Record<string, unknown>): Rule[] {
  if (a.disabled === true || String(a.direction ?? "INGRESS").toUpperCase() !== "INGRESS") return [];
  const sources = asArray<string>(a.source_ranges);
  return asArray<Record<string, unknown>>(a.allow).map((allow) => {
    const ports = asArray<string>(allow.ports);
    const ranges = ports.map(parsePortSpec);
    return {
      ranges: ranges.filter((x): x is [number, number] => x !== null),
      allTraffic:
        ALL_PROTOCOLS.has(String(allow.protocol).toLowerCase()) || ports.length === 0 || ranges.includes(null),
      sources,
    };
  });
}

function rulesFor(type: string, a: Record<string, unknown>): Rule[] {
  switch (type) {
    case "aws_security_group":
      return asArray<Record<string, unknown>>(a.ingress).map((r) =>
        awsRule(r, [...asArray<string>(r.cidr_blocks), ...asArray<string>(r.ipv6_cidr_blocks)]),
      );
    case "aws_security_group_rule":
      return a.type === "ingress"
        ? [awsRule(a, [...asArray<string>(a.cidr_blocks), ...asArray<string>(a.ipv6_cidr_blocks)])]
        : [];
    case "aws_vpc_security_group_ingress_rule":
      return [awsRule(a, [...asArray<string>(a.cidr_ipv4), ...asArray<string>(a.cidr_ipv6)])];
    case "azurerm_network_security_rule":
      return [azureRule(a)].filter((r): r is Rule => r !== null);
    case "azurerm_network_security_group":
      return asArray<Record<string, unknown>>(a.security_rule)
        .map(azureRule)
        .filter((r): r is Rule => r !== null);
    case "google_compute_firewall":
      return gcpRules(a);
    default:
      return [];
  }
}

function describePorts(r: Rule): string {
  if (r.allTraffic) return "all ports";
  return r.ranges.map(([f, t]) => (f === t ? `port ${f}` : `ports ${f}-${t}`)).join(", ");
}

function severityFor(r: Rule): Severity {
  if (r.allTraffic) return "critical";
  for (const p of SENSITIVE_PORTS) if (r.ranges.some(([f, t]) => p >= f && p <= t)) return "critical";
  if (r.ranges.every(([f, t]) => f === t && WEB_PORTS.has(f))) return "low";
  return "high";
}

const DB_FIREWALL_TYPES = new Set([
  "azurerm_mssql_firewall_rule",
  "azurerm_postgresql_flexible_server_firewall_rule",
  "azurerm_mysql_flexible_server_firewall_rule",
]);

/** Database-level firewalls: Azure server firewall rules and Cloud SQL authorized networks. */
const dbFirewallCheck: Precheck = (rc) => {
  const a = after(rc);
  if (!a) return [];

  if (DB_FIREWALL_TYPES.has(rc.type)) {
    const start = String(a.start_ip_address);
    const end = String(a.end_ip_address);
    if (start === "0.0.0.0" && end === "255.255.255.255") {
      return [
        finding(rc, "open-ingress", {
          severity: "critical",
          category: "network-exposure",
          issue: "Database firewall rule allows every IPv4 address (0.0.0.0-255.255.255.255).",
          blastRadius: "The database endpoint is reachable from the whole internet; only the password protects it.",
          suggestion: "Allow specific client IP ranges, or disable public network access and use a private endpoint.",
        }),
      ];
    }
    if (start === "0.0.0.0" && end === "0.0.0.0") {
      return [
        finding(rc, "open-ingress", {
          severity: "medium",
          category: "network-exposure",
          issue:
            'Database firewall rule 0.0.0.0-0.0.0.0 ("Allow Azure services") admits connections from any Azure customer\'s resources, not just yours.',
          blastRadius: "Any workload running in Azure, including other tenants', can reach the database endpoint.",
          suggestion: "Use a private endpoint or VNet integration instead of the Allow-Azure-services rule.",
        }),
      ];
    }
    return [];
  }

  if (rc.type === "google_sql_database_instance") {
    const ipConfig = asArray<Record<string, unknown>>(
      asArray<Record<string, unknown>>(a.settings)[0]?.ip_configuration,
    )[0];
    if (!ipConfig || ipConfig.ipv4_enabled === false) return [];
    const open = asArray<Record<string, unknown>>(ipConfig.authorized_networks).filter((n) =>
      OPEN_SOURCES.has(String(n?.value)),
    );
    if (!open.length) return [];
    return [
      finding(rc, "open-ingress", {
        severity: "critical",
        category: "network-exposure",
        issue: `Cloud SQL instance has a public IP and authorizes ${open.map((n) => n.value).join(", ")}.`,
        blastRadius: "The database is reachable from the whole internet; only the password protects it.",
        suggestion:
          "Remove the 0.0.0.0/0 authorized network; use private IP, or the Cloud SQL Auth Proxy with IAM authentication.",
      }),
    ];
  }

  return [];
};

const firewallRuleCheck: Precheck = (rc) => {
  const a = after(rc);
  if (!a) return [];
  const open = rulesFor(rc.type, a).filter((r) => r.sources.some((s) => OPEN_SOURCES.has(s.toLowerCase())));
  if (!open.length) return [];

  const severity = maxSeverity(open.map(severityFor));
  return [
    finding(rc, "open-ingress", {
      severity,
      category: "network-exposure",
      issue: `Ingress open to the internet (${[...new Set(open.flatMap((r) => r.sources.filter((s) => OPEN_SOURCES.has(s.toLowerCase()))))].join(", ")}) on ${open.map(describePorts).join(", ")}.`,
      blastRadius:
        severity === "low"
          ? "Public HTTP(S) exposure; expected for load balancers, risky for anything else."
          : "Anything this rule applies to is reachable from the whole internet on these ports.",
      suggestion:
        "Restrict the source to known CIDRs, a VPN, or a private network; use a bastion/IAP/SSM-style access service instead of open SSH/RDP.",
    }),
  ];
};

export const ingressCheck: Precheck = (rc, ctx) => [...firewallRuleCheck(rc, ctx), ...dbFirewallCheck(rc, ctx)];
