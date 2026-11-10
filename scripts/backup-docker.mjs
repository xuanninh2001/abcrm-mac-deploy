import { mkdirSync, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { join } from 'node:path';

const folder = join('backups', new Date().toISOString().replace(/[:.]/g, '-'));
mkdirSync(folder, { recursive: true, mode: 0o700 });
for (const db of ['abcrm', 'abcrm_dbos']) {
  const child = spawn('docker', ['compose', '--env-file', '.env.docker.local', '-f', 'compose.production.yaml', 'exec', '-T', 'postgres', 'pg_dump', '-U', 'postgres', '-d', db, '-Fc', '--no-owner'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const complete = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${db} dump failed (${code})`)));
  });
  await Promise.all([pipeline(child.stdout, createWriteStream(join(folder, `${db}.dump`), { mode: 0o600, flags: 'wx' })), complete]);
}
console.log(`Backup complete: ${folder}. Keep a separate encrypted backup of .env.docker.local; copy backups off this machine.`);
