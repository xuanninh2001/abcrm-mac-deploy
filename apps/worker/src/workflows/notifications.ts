import { DBOS } from "@dbos-inc/dbos-sdk";
import { notifyRoles } from "@abcrm/core";
import { withTenant, type Pool } from "@abcrm/db";
import { deliverNotification, type Mailer } from "@abcrm/notify";
import { onEvent } from "../dispatcher.js";

const system = { type: "system", id: "notifications" } as const;

/** Email delivery for in-app notifications, and alerts for billing thresholds and paused agents. */
export function registerNotifications(pool: Pool, mailer: Mailer) {
  onEvent("notifications.notification.created", async (e) => {
    await DBOS.runStep(() => deliverNotification(pool, mailer, e.tenant_id, String(e.payload.notification_id)), { name: "deliver" });
  });
  onEvent("billing.balance.threshold_crossed", async (e) => {
    const pct = Number(e.payload.pct);
    if (pct < 80) return;   // 50% is shown in-app on the usage page only (pricing doc §3)
    const meter = e.payload.meter === "contact" ? "Contact" : "Agent";
    await DBOS.runStep(() => withTenant(pool, e.tenant_id, system, (tx) => notifyRoles(tx, ["owner", "admin"], {
      kind: "billing_threshold", title: `${meter} credits ${pct}% used`, body: `This month's ${meter.toLowerCase()} credits are ${pct}% used. Buy a credit pack or adjust overage in Usage.`,
      payload: { meter: e.payload.meter, pct },
    })), { name: "notify" });
  });
  onEvent("billing.balance.exhausted", async (e) => {
    const meter = e.payload.meter === "contact" ? "Contact" : "Agent";
    await DBOS.runStep(() => withTenant(pool, e.tenant_id, system, (tx) => notifyRoles(tx, ["owner", "admin"], {
      kind: "billing_exhausted", title: `${meter} credits exhausted`, body: `Chargeable ${meter.toLowerCase()} actions are paused until credits are added or overage is enabled. Compliance actions keep running.`,
      payload: { meter: e.payload.meter },
    })), { name: "notify" });
  });
  onEvent("agents.agent.paused", async (e) => {
    if (e.payload.reason === "manual") return;
    await DBOS.runStep(() => withTenant(pool, e.tenant_id, system, (tx) => notifyRoles(tx, ["owner", "admin", "head_of_bd"], {
      kind: "agent_paused", title: "An agent was paused", body: `Reason: ${String(e.payload.reason)}. Review its budget or results, then resume it in Agents.`,
      payload: { agent_definition_id: e.payload.agent_definition_id, reason: e.payload.reason },
    })), { name: "notify" });
  });
}
