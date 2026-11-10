import type { z } from "zod";
import type { TenantTx } from "@abcrm/db";
import type { Permission, Principal } from "./permissions.js";

export type SideEffect = "none" | "internal" | "external";
export type Gate = "G-T1" | "G-T2" | "G-Q" | "G-OUT" | "G-M1" | "G-M2" | "G-B1" | "G-B2";

export interface ToolCtx {
  tenantId: string;
  actor: { type: "agent"; runId: string } | { type: "user"; userId: string } | { type: "system" };
  onBehalfOf: Principal;
  tx: TenantTx;
  killSwitch: boolean;
  /** Present only when the executor runs a tool on behalf of an approved decision. */
  approvedDecisionId?: string;
}

export interface MeterCharge { meter: "agent" | "contact"; actionType: string; credits: number }

export interface ToolDef<I, O> {
  name: string;
  description: string;
  sideEffect: SideEffect;
  gate?: Gate;
  permission: Permission;
  exposeToLLM: boolean;
  input: z.ZodType<I>;
  output: z.ZodType<O>;
  execute(ctx: ToolCtx, input: I): Promise<O>;
  meter?(input: I, output: O): MeterCharge | null;
}

export function defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O> {
  if (def.sideEffect === "external" && !def.gate) throw new Error(`tool ${def.name}: external tools must declare a gate`);
  return def;
}
