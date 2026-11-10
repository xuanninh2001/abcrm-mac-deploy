import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const domain = process.argv[2];
if (!domain || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i.test(domain)) {
  throw new Error('Usage: node scripts/init-docker-env.mjs crm.example.com');
}
const values = { APP_DOMAIN: domain, WEB_PORT: '3001' };
for (const k of ['POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'GLOBAL_DB_PASSWORD', 'DBOS_DB_PASSWORD']) values[k] = randomBytes(32).toString('hex');
for (const k of ['ABCRM_MASTER_KEY', 'ABCRM_PLATFORM_HMAC_KEY', 'ABCRM_PLATFORM_CACHE_KEY', 'ABCRM_WEB_SESSION_SECRET']) values[k] = randomBytes(32).toString('base64');
Object.assign(values, { WORKOS_CLIENT_ID: '', WORKOS_API_KEY: '', CLOUDFLARE_TUNNEL_TOKEN: '', ANTHROPIC_API_KEY: '', BRAVE_SEARCH_API_KEY: '' });
writeFileSync('.env.docker.local', Object.entries(values).map(([k,v]) => `${k}=${v}`).join('\n')+'\n', { encoding: 'utf8', mode: 0o600, flag: 'wx' });
console.log('Created .env.docker.local for a NEW database. Set WorkOS keys and Tunnel token before deployment. Existing files are never overwritten.');
