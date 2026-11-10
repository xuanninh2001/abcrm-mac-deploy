import { Hono } from "hono";
import { z } from "zod";
import { getContact, updateContact } from "@abcrm/crm";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, requirePermission } from "./util.js";

const PatchContact = z.object({
  first_name: z.string().max(100).nullable(), last_name: z.string().max(100).nullable(), title: z.string().max(150).nullable(),
  phone: z.string().max(40).nullable(), linkedin_url: z.url().nullable(), timezone: z.string().max(64).nullable(),
}).partial().strict();

export function contactRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();
  r.get("/:id", async (c) => c.json(await inTenant(deps, c, (tx) => getContact(tx, deps.keyring, c.req.param("id")))));
  r.patch("/:id", async (c) => {
    requirePermission(c, "crm.write");
    const p = PatchContact.parse(await c.req.json());
    const patch = Object.fromEntries(Object.entries({
      firstName: p.first_name, lastName: p.last_name, title: p.title, phone: p.phone, linkedinUrl: p.linkedin_url, timezone: p.timezone,
    }).filter(([, v]) => v !== undefined));
    return c.json(await inTenant(deps, c, (tx) => updateContact(tx, deps.keyring, c.get("ctx").actor, c.req.param("id"), patch)));
  });
  return r;
}
