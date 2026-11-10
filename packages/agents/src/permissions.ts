// tools.md §2. Personas never hold decisions.approve.* (agents cannot approve their own proposals).
export type Role = "owner" | "admin" | "head_of_bd" | "sales_rep" | "viewer";
export type Permission =
  | "setup.supply.write" | "setup.ipp.write" | "setup.playbook.write" | "setup.approve"
  | "sourcing.run.start" | "sourcing.write" | "web.read" | "contactdata.lookup" | "qualification.write"
  | "decisions.propose" | "decisions.approve.G-Q" | "decisions.reassign" | "crm.read" | "crm.write" | "compliance.manage" | "import.run" | "agents.manage" | "billing.manage" | "users.manage";

const ALL_SETUP: Permission[] = ["setup.supply.write", "setup.ipp.write", "setup.playbook.write", "setup.approve"];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  owner: new Set<Permission>([...ALL_SETUP, "sourcing.run.start", "sourcing.write", "contactdata.lookup", "decisions.propose",
    "decisions.approve.G-Q", "decisions.reassign", "crm.read", "crm.write", "compliance.manage", "import.run", "agents.manage", "billing.manage", "users.manage"]),
  admin: new Set<Permission>([...ALL_SETUP, "sourcing.run.start", "sourcing.write", "contactdata.lookup", "decisions.propose",
    "decisions.approve.G-Q", "decisions.reassign", "crm.read", "crm.write", "compliance.manage", "import.run", "agents.manage", "billing.manage", "users.manage"]),
  head_of_bd: new Set<Permission>([...ALL_SETUP, "sourcing.run.start", "contactdata.lookup", "decisions.propose",
    "decisions.approve.G-Q", "decisions.reassign", "crm.read", "crm.write", "agents.manage"]),
  sales_rep: new Set<Permission>(["sourcing.run.start", "contactdata.lookup", "decisions.propose", "decisions.approve.G-Q", "crm.read", "crm.write"]),
  viewer: new Set<Permission>(["crm.read"]),
};

export const PERSONA_PERMISSIONS: Record<string, ReadonlySet<Permission>> = {
  sourcing: new Set<Permission>(["sourcing.write", "web.read", "decisions.propose", "crm.read", "crm.write"]),
  qualification: new Set<Permission>(["web.read", "contactdata.lookup", "qualification.write", "decisions.propose", "crm.read"]),
};

export type Principal = { type: "user"; id: string; role: Role } | { type: "persona"; id: string; key: string };

export function hasPermission(p: Principal, perm: Permission): boolean {
  if (p.type === "persona") return !perm.startsWith("decisions.approve") && (PERSONA_PERMISSIONS[p.key]?.has(perm) ?? false);
  return ROLE_PERMISSIONS[p.role].has(perm);
}
