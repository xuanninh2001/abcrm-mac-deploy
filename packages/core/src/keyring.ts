import type { TenantTx } from "@abcrm/db";
import { blindIndex, decryptField, encryptField, generateKey, type KeyProvider } from "@abcrm/crypto";

type Purpose = "dek" | "bidx";

/** Per-tenant key access (envelope encryption). Keys are created lazily on first use. */
export class TenantKeyring {
  private cache = new Map<string, Buffer>();
  constructor(private readonly provider: KeyProvider) {}

  async key(tx: TenantTx, purpose: Purpose): Promise<Buffer> {
    const cacheKey = `${tx.tenantId}:${purpose}`;
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;
    const ctx = `tenant:${tx.tenantId}:${purpose}`;
    const { rows } = await tx.client.query<{ wrapped_key: Buffer }>(
      "SELECT wrapped_key FROM abcrm.tenant_keys WHERE purpose = $1 AND status = 'active' ORDER BY key_version DESC LIMIT 1", [purpose]);
    let key: Buffer;
    if (rows[0]) {
      key = await this.provider.unwrap(rows[0].wrapped_key, ctx);
    } else {
      key = generateKey();
      const inserted = await tx.client.query<{ wrapped_key: Buffer }>(
        `INSERT INTO abcrm.tenant_keys(tenant_id, key_version, purpose, wrapped_key, kms_key_ref) VALUES ($1, 1, $2, $3, $4)
         ON CONFLICT (tenant_id, purpose, key_version) DO NOTHING RETURNING wrapped_key`,
        [tx.tenantId, purpose, await this.provider.wrap(key, ctx), this.provider.keyRef]);
      if (!inserted.rows[0]) return this.key(tx, purpose);   // lost a creation race: reload
    }
    this.cache.set(cacheKey, key);
    return key;
  }

  async encrypt(tx: TenantTx, column: string, plaintext: string): Promise<Buffer> {
    return encryptField(await this.key(tx, "dek"), plaintext, `${tx.tenantId}:${column}`);
  }

  async decrypt(tx: TenantTx, column: string, blob: Buffer): Promise<string> {
    return decryptField(await this.key(tx, "dek"), blob, `${tx.tenantId}:${column}`);
  }

  async bidx(tx: TenantTx, purpose: string, normalized: string): Promise<Buffer> {
    return blindIndex(await this.key(tx, "bidx"), purpose, normalized);
  }
}
