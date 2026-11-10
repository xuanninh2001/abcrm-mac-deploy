import type { Actor, TenantTx } from "@abcrm/db";
import { appendAudit, emit, notFound, Problem, uuidv7, type TenantKeyring } from "@abcrm/core";
import { normalizeEmail } from "@abcrm/crypto";
import { recordChanges } from "./changes.js";
import { getAccount } from "./accounts.js";
import { isSuppressed } from "./suppression.js";

export type ContactInput = {
  firstName?: string | null; lastName?: string | null; title?: string | null; email?: string | null;
  phone?: string | null; linkedinUrl?: string | null; timezone?: string | null;
  source: { kind: "manual" | "import" | "provider" | "referral"; [k: string]: unknown };
};

export type Contact = {
  id: string; account_id: string; first_name: string | null; last_name: string | null; title: string | null;
  email: string | null; phone: string | null; linkedin_url: string | null; timezone: string | null; status: string;
  email_verification: unknown; source: unknown; created_at: Date; updated_at: Date;
};

type Row = {
  id: string; account_id: string; first_name_enc: Buffer | null; last_name_enc: Buffer | null; title: string | null;
  email_enc: Buffer | null; phone_enc: Buffer | null; linkedin_url: string | null; timezone: string | null; status: string;
  email_verification: unknown; source: unknown; created_at: Date; updated_at: Date;
};

const COLS = "id, account_id, first_name_enc, last_name_enc, title, email_enc, phone_enc, linkedin_url, timezone, status, email_verification, source, created_at, updated_at";
const PII = { first_name: "contacts.first_name", last_name: "contacts.last_name", email: "contacts.email", phone: "contacts.phone" } as const;

async function decryptRow(tx: TenantTx, keyring: TenantKeyring, r: Row): Promise<Contact> {
  const dec = (blob: Buffer | null, col: string) => (blob ? keyring.decrypt(tx, col, blob) : Promise.resolve(null));
  return {
    id: r.id, account_id: r.account_id, title: r.title, linkedin_url: r.linkedin_url, timezone: r.timezone, status: r.status,
    email_verification: r.email_verification, source: r.source, created_at: r.created_at, updated_at: r.updated_at,
    first_name: await dec(r.first_name_enc, PII.first_name), last_name: await dec(r.last_name_enc, PII.last_name),
    email: await dec(r.email_enc, PII.email), phone: await dec(r.phone_enc, PII.phone),
  };
}

const enc = (tx: TenantTx, keyring: TenantKeyring, col: string, v: string | null | undefined) =>
  (v ? keyring.encrypt(tx, col, v) : Promise.resolve(null));

/** Creates a contact (PII encrypted). Same email in the tenant → returns the existing contact unless `ifExists` is "conflict". */
export async function createContact(
  tx: TenantTx, keyring: TenantKeyring, actor: Actor, accountId: string, input: ContactInput,
  ifExists: "conflict" | "return" = "conflict",
): Promise<{ contact: Contact; created: boolean }> {
  await getAccount(tx, accountId);   // 404 for unknown/foreign accounts
  let email: string | null = null;
  if (input.email) {
    try { email = normalizeEmail(input.email); } catch { throw new Problem("validation-failed", "Invalid email"); }
  }
  const bidx = email ? await keyring.bidx(tx, "email", email) : null;
  const status = email && (await isSuppressed(tx, keyring, email)) ? "suppressed" : "active";
  const id = uuidv7();
  const res = await tx.client.query<Row>(
    `INSERT INTO abcrm.contacts(id, tenant_id, account_id, first_name_enc, last_name_enc, title, email_enc, email_bidx,
       phone_enc, linkedin_url, timezone, source, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (tenant_id, email_bidx) WHERE email_bidx IS NOT NULL DO NOTHING RETURNING ${COLS}`,
    [id, tx.tenantId, accountId, await enc(tx, keyring, PII.first_name, input.firstName), await enc(tx, keyring, PII.last_name, input.lastName),
      input.title ?? null, await enc(tx, keyring, PII.email, email), bidx, await enc(tx, keyring, PII.phone, input.phone),
      input.linkedinUrl ?? null, input.timezone ?? null, { ...input.source, acquired_at: new Date().toISOString() }, status]);
  if (res.rows[0]) {
    await appendAudit(tx, { actor, action: "contact.created", subject: { type: "contact", id } });
    await emit(tx, "crm.contact.created", { contact_id: id, account_id: accountId });
    return { contact: await decryptRow(tx, keyring, res.rows[0]), created: true };
  }
  if (ifExists === "conflict") throw new Problem("conflict", "A contact with this email already exists");
  const { rows: [existing] } = await tx.client.query<Row>(`SELECT ${COLS} FROM abcrm.contacts WHERE email_bidx = $1`, [bidx]);
  return { contact: await decryptRow(tx, keyring, existing!), created: false };
}

export async function getContact(tx: TenantTx, keyring: TenantKeyring, id: string): Promise<Contact> {
  const { rows: [r] } = await tx.client.query<Row>(`SELECT ${COLS} FROM abcrm.contacts WHERE id = $1 AND status <> 'deleted'`, [id]);
  if (!r) throw notFound("Contact");
  return decryptRow(tx, keyring, r);
}

export async function listContacts(tx: TenantTx, keyring: TenantKeyring, accountId: string): Promise<Contact[]> {
  await getAccount(tx, accountId);
  const { rows } = await tx.client.query<Row>(
    `SELECT ${COLS} FROM abcrm.contacts WHERE account_id = $1 AND status <> 'deleted' ORDER BY created_at`, [accountId]);
  return Promise.all(rows.map((r) => decryptRow(tx, keyring, r)));
}

export type ContactPatch = Partial<{ firstName: string | null; lastName: string | null; title: string | null; phone: string | null; linkedinUrl: string | null; timezone: string | null }>;

/** Email is immutable (it is the identity used for dedupe and suppression); create a new contact instead. */
export async function updateContact(tx: TenantTx, keyring: TenantKeyring, actor: Actor, id: string, patch: ContactPatch): Promise<Contact> {
  const before = await getContact(tx, keyring, id);
  const sets: string[] = [];
  const vals: unknown[] = [id];
  const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if ("firstName" in patch) add("first_name_enc", await enc(tx, keyring, PII.first_name, patch.firstName));
  if ("lastName" in patch) add("last_name_enc", await enc(tx, keyring, PII.last_name, patch.lastName));
  if ("phone" in patch) add("phone_enc", await enc(tx, keyring, PII.phone, patch.phone));
  if ("title" in patch) add("title", patch.title);
  if ("linkedinUrl" in patch) add("linkedin_url", patch.linkedinUrl);
  if ("timezone" in patch) add("timezone", patch.timezone);
  if (sets.length === 0) return before;
  await tx.client.query(`UPDATE abcrm.contacts SET ${sets.join(", ")} WHERE id = $1`, vals);
  const after = await getContact(tx, keyring, id);
  // Field history records which fields changed, not the PII values themselves.
  const redact = (c: Contact) => ({ first_name: c.first_name ? "•" + c.first_name.length : null, last_name: c.last_name ? "•" + c.last_name.length : null,
    phone: c.phone ? "•" : null, title: c.title, linkedin_url: c.linkedin_url, timezone: c.timezone });
  await recordChanges(tx, actor, "contact", id, redact(before), redact(after));
  return after;
}
