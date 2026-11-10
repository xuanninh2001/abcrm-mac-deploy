import type { Pool } from "@abcrm/db";
import type { TenantKeyring } from "@abcrm/core";
import type { Principal } from "@abcrm/agents";
import type { RequestContext } from "@abcrm/core";

import type { AccessTokenVerifier, WorkosDirectory } from "./workos.js";

export type Deps = { pool: Pool; keyring: TenantKeyring; devAuth: boolean; verifier?: AccessTokenVerifier;
  /** WorkOS User Management (invites, first sign-in). Unset: invites are created but no email is sent. */
  directory?: WorkosDirectory;
  /** Overrides for tests; defaults in limits.ts. */
  limits?: Partial<import("./limits.js").Limits> };

export type AppEnv = {
  Variables: { ctx: RequestContext; principal: Principal };
};
