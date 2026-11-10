import { Hono } from "hono";
import { z } from "zod";
import { hasPermission } from "@abcrm/agents";
import type { AppEnv, Deps } from "../env.js";
import { inviteUser, listUsers, resendInvite, updateProfile, updateUser } from "../iam.js";
import { inTenant, requirePermission } from "./util.js";

const ROLE = z.enum(["owner", "admin", "head_of_bd", "sales_rep", "viewer"]);
const HOURS = z.record(z.string(), z.tuple([z.string(), z.string()]));

/** Team management (api.md §2.1: `/users`, owner/admin) and the caller's own profile. */
export function userRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  // Everyone sees active colleagues (reassign picker); owner/admin can ask for invited and disabled ones too.
  r.get("/", async (c) => {
    const all = c.req.query("all") === "true" && hasPermission(c.get("principal"), "users.manage");
    return c.json({ data: await inTenant(deps, c, (tx) => listUsers(tx, { all })) });
  });
  r.post("/", async (c) => {
    requirePermission(c, "users.manage");
    const b = z.object({ email: z.email().max(254), name: z.string().trim().min(1).max(120).optional(), role: ROLE,
      timezone: z.string().max(64).optional() }).parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => inviteUser(tx, c.get("ctx").actor, c.get("principal"), deps.directory, b)), 201);
  });
  r.patch("/me", async (c) => {
    const b = z.object({ name: z.string().trim().min(1).max(120).nullable().optional(), timezone: z.string().max(64).optional(),
      locale: z.enum(["en", "vi"]).optional(), working_hours: HOURS.optional() }).parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => updateProfile(tx, c.get("principal"), b)));
  });
  r.patch("/:id", async (c) => {
    requirePermission(c, "users.manage");
    const b = z.object({ role: ROLE.optional(), status: z.enum(["active", "disabled"]).optional(),
      name: z.string().trim().min(1).max(120).nullable().optional() }).parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => updateUser(tx, c.get("ctx").actor, c.get("principal"), c.req.param("id"), b)));
  });
  // DELETE never removes the row (decisions and audit reference it): it disables the user.
  r.delete("/:id", async (c) => {
    requirePermission(c, "users.manage");
    return c.json(await inTenant(deps, c, (tx) => updateUser(tx, c.get("ctx").actor, c.get("principal"), c.req.param("id"), { status: "disabled" })));
  });
  r.post("/:id/resend-invite", async (c) => {
    requirePermission(c, "users.manage");
    return c.json(await inTenant(deps, c, (tx) => resendInvite(tx, deps.directory, c.req.param("id"))));
  });
  return r;
}
