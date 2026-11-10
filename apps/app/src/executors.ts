import type { Actor, TenantTx } from "@abcrm/db";
import { cancelRejectedRun, startApprovedRun } from "@abcrm/sourcing";
import { Problem } from "@abcrm/core";
import { CARD_EXECUTORS } from "@abcrm/inbox";
import { activateIpp, activatePlaybook, activateSupplyProfile, returnIppToDraft, returnPlaybookToDraft, returnSupplyToDraft } from "@abcrm/setup";

type Action = { tool: string; args: Record<string, unknown> };
type Executor = (tx: TenantTx, actor: Actor, action: Action, decisionId: string) => Promise<void>;

/** What runs when a decision is approved, keyed by action.tool (tools.md §3.5). */
export const EXECUTORS: Record<string, Executor> = {
  ...CARD_EXECUTORS,
  "sourcing_run.start": (tx, _actor, action, decisionId) => startApprovedRun(tx, String(action.args.id), decisionId),
  "setup.activate": async (tx, actor, action, decisionId) => {
    const id = String(action.args.id);
    if (action.args.kind === "supply_profile") return activateSupplyProfile(tx, actor, id, decisionId);
    if (action.args.kind === "playbook") return activatePlaybook(tx, actor, id, decisionId);
    if (action.args.kind === "ipp") return activateIpp(tx, actor, id, decisionId);
    throw new Problem("validation-failed", `Unsupported setup kind: ${String(action.args.kind)}`);
  },
};

/** Clean-up when a decision is rejected, keyed by subject type. */
export const ON_REJECT: Record<string, (tx: TenantTx, subjectId: string) => Promise<void>> = {
  supply_profile: returnSupplyToDraft,
  playbook: returnPlaybookToDraft,
  ipp: returnIppToDraft,
  sourcing_run: cancelRejectedRun,
};
