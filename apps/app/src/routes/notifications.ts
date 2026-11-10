import { Hono } from "hono";
import { Problem } from "@abcrm/core";
import { listNotifications, markRead } from "@abcrm/notify";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, pageLimit } from "./util.js";

/** In-app notifications of the signed-in user (badge + list). */
export function notificationRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  const me = (p: AppEnv["Variables"]["principal"]) => {
    if (p.type !== "user") throw new Problem("permission-denied", "Notifications belong to people");
    return p.id;
  };
  r.get("/", async (c) => {
    const userId = me(c.get("principal"));
    return c.json(await inTenant(deps, c, (tx) => listNotifications(tx, userId, { unreadOnly: c.req.query("unread") === "true", limit: pageLimit(c) })));
  });
  r.post("/:id/read", async (c) => {
    const userId = me(c.get("principal"));
    return c.json(await inTenant(deps, c, (tx) => markRead(tx, userId, c.req.param("id"))));
  });
  return r;
}
