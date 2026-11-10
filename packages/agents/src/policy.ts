import { hasPermission } from "./permissions.js";
import type { ToolCtx, ToolDef } from "./tool.js";

export type PolicyDecision =
  | { verdict: "execute" }
  | { verdict: "propose"; gate: NonNullable<ToolDef<unknown, unknown>["gate"]> }
  | { verdict: "deny"; reason: string };

/**
 * Platform invariants (ADR-006, tools.md §1). Order matters: kill switch, permission, gate.
 * Gated tools are never executed directly by an agent or user call — only proposed — unless the
 * executor runs them for an approved decision.
 */
export function evaluateToolCall(tool: ToolDef<any, any>, ctx: ToolCtx): PolicyDecision {
  if (ctx.killSwitch && ctx.actor.type === "agent") return { verdict: "deny", reason: "kill_switch" };
  if (!hasPermission(ctx.onBehalfOf, tool.permission)) return { verdict: "deny", reason: `missing_permission:${tool.permission}` };
  if (tool.gate) return ctx.approvedDecisionId ? { verdict: "execute" } : { verdict: "propose", gate: tool.gate };
  if (tool.sideEffect === "external") return { verdict: "deny", reason: "external_without_gate" };
  return { verdict: "execute" };
}
