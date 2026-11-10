import { Hono } from "hono";
import { z } from "zod";
import {
  ACCOUNT_FLAGS, addActivity, createAccount, createContact, getAccount, listAccounts, listActivities, listContacts,
  setAccountFlags, updateAccount,
} from "@abcrm/crm";
import { listEvidence } from "@abcrm/sourcing";
import type { AppEnv, Deps } from "../env.js";
import { inTenant, pageLimit, requirePermission } from "./util.js";

const State = z.string().length(2).toUpperCase();
const CreateAccount = z.object({ name: z.string().min(1).max(200), domain: z.string().min(3).max(253), hq_state: State.optional() });
const PatchAccount = z.object({
  name: z.string().min(1).max(200), buyer_type: z.enum(["direct_brand", "aggregator", "affiliate_network", "ping_post_exchange", "call_buyer"]).nullable(),
  verticals: z.array(z.string().max(40)).max(10), lead_types: z.array(z.string().max(40)).max(30), hq_state: State.nullable(),
  hq_country: z.string().length(2).toUpperCase().nullable(), employee_range: z.string().max(20).nullable(),
  owner_user_id: z.uuid().nullable(), status: z.enum(["lost", "blocked", "prospect"]),
}).partial().strict();
const Flags = z.object({ add: z.array(z.enum(ACCOUNT_FLAGS)).default([]), remove: z.array(z.enum(ACCOUNT_FLAGS)).default([]) });
export const CreateContact = z.object({
  first_name: z.string().max(100).optional(), last_name: z.string().max(100).optional(), title: z.string().max(150).optional(),
  email: z.string().max(254).optional(), phone: z.string().max(40).optional(), linkedin_url: z.url().optional(),
}).refine((v) => v.email || v.first_name || v.last_name, "email or name is required");
const Activity = z.object({ kind: z.enum(["note", "task", "call", "meeting"]), body: z.string().min(1).max(10_000), contact_id: z.uuid().optional(), due_at: z.iso.datetime().optional() });

export function accountRoutes(deps: Deps) {
  const r = new Hono<AppEnv>();

  r.get("/", async (c) => c.json(await inTenant(deps, c, (tx) => listAccounts(tx, {
    limit: pageLimit(c), cursor: c.req.query("cursor"), q: c.req.query("q"), status: c.req.query("status"), flag: c.req.query("flag"),
  }))));

  r.get("/:id", async (c) => c.json(await inTenant(deps, c, (tx) => getAccount(tx, c.req.param("id")))));

  r.post("/", async (c) => {
    requirePermission(c, "crm.write");
    const body = CreateAccount.parse(await c.req.json());
    const { account } = await inTenant(deps, c, (tx) =>
      createAccount(tx, deps.keyring, c.get("ctx").actor, { name: body.name, domain: body.domain, hqState: body.hq_state }));
    return c.json(account, 201);
  });

  r.patch("/:id", async (c) => {
    requirePermission(c, "crm.write");
    const patch = PatchAccount.parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => updateAccount(tx, c.get("ctx").actor, c.req.param("id"), patch)));
  });

  r.post("/:id/flags", async (c) => {
    requirePermission(c, "crm.write");
    const { add, remove } = Flags.parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => setAccountFlags(tx, c.get("ctx").actor, c.req.param("id"), add, remove)));
  });

  r.get("/:id/contacts", async (c) => c.json({ data: await inTenant(deps, c, (tx) => listContacts(tx, deps.keyring, c.req.param("id"))) }));

  r.post("/:id/contacts", async (c) => {
    requirePermission(c, "crm.write");
    const b = CreateContact.parse(await c.req.json());
    const { contact } = await inTenant(deps, c, (tx) => createContact(tx, deps.keyring, c.get("ctx").actor, c.req.param("id"), {
      firstName: b.first_name, lastName: b.last_name, title: b.title, email: b.email, phone: b.phone, linkedinUrl: b.linkedin_url,
      source: { kind: "manual" } }));
    return c.json(contact, 201);
  });

  r.get("/:id/evidence", async (c) => c.json({ data: await inTenant(deps, c, async (tx) => {
    await getAccount(tx, c.req.param("id"));
    return listEvidence(tx, c.req.param("id"));
  }) }));

  r.get("/:id/activities", async (c) => c.json({ data: await inTenant(deps, c, (tx) => listActivities(tx, c.req.param("id"))) }));

  r.post("/:id/activities", async (c) => {
    requirePermission(c, "crm.write");
    const b = Activity.parse(await c.req.json());
    return c.json(await inTenant(deps, c, (tx) => addActivity(tx, c.get("ctx").actor, {
      accountId: c.req.param("id"), contactId: b.contact_id, kind: b.kind, body: b.body, dueAt: b.due_at })), 201);
  });

  return r;
}
