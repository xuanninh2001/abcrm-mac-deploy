import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('new-install secret generator refuses overwrite and rejects unsafe domains', () => {
  const dir = mkdtempSync(join(tmpdir(), 'abcrm-docker-'));
  const script = resolve('scripts/init-docker-env.mjs');
  try {
    assert.notEqual(spawnSync(process.execPath, [script, 'https://bad.example/path'], { cwd: dir }).status, 0);
    assert.equal(spawnSync(process.execPath, [script, 'crm.example.com'], { cwd: dir }).status, 0);
    const before = readFileSync(join(dir, '.env.docker.local'), 'utf8');
    const entries = Object.fromEntries(before.trim().split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
    for (const key of ['POSTGRES_PASSWORD', 'APP_DB_PASSWORD', 'GLOBAL_DB_PASSWORD', 'DBOS_DB_PASSWORD']) assert.match(entries[key], /^[a-f0-9]{64}$/);
    const keys = ['ABCRM_MASTER_KEY', 'ABCRM_PLATFORM_HMAC_KEY', 'ABCRM_PLATFORM_CACHE_KEY', 'ABCRM_WEB_SESSION_SECRET'].map(key => entries[key]);
    for (const key of keys) assert.equal(Buffer.from(key, 'base64').length, 32);
    assert.equal(new Set(keys).size, 4);
    assert.notEqual(spawnSync(process.execPath, [script, 'other.example.com'], { cwd: dir }).status, 0);
    assert.equal(readFileSync(join(dir, '.env.docker.local'), 'utf8'), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
