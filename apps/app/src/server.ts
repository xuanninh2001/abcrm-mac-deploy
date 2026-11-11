import { serve } from "@hono/node-server";
import { keyProviderFromEnv } from "@abcrm/crypto";
import { TenantKeyring } from "@abcrm/core";
import { createPool } from "@abcrm/db";
import { createApp } from "./app.js";
import { workosDirectory, workosVerifier } from "./workos.js";

const url = process.env.APP_DATABASE_URL;
if (!url) throw new Error("APP_DATABASE_URL is required");
const production = process.env.NODE_ENV === "production";
const workosClientId = process.env.WORKOS_CLIENT_ID;

const app = createApp({
  pool: createPool(url),
  keyring: new TenantKeyring(keyProviderFromEnv()),   // configured production provider; local key in dev
  devAuth: !production && process.env.ABCRM_DEV_AUTH === "1",
  verifier: workosClientId ? workosVerifier({ clientId: workosClientId, issuer: process.env.WORKOS_ISSUER }) : undefined,
  // Invites and first sign-in need the WorkOS API key; without it invites are created but no email is sent.
  directory: process.env.WORKOS_API_KEY ? workosDirectory(process.env.WORKOS_API_KEY) : undefined,
});

const port = Number(process.env.PORT ?? 3000);
serve({ fetch: app.fetch, port }, () => console.log(`abcrm app listening on :${port}`));
