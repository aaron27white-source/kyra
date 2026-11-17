import { readdirSync, readFileSync, openSync, closeSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { pilotAdminRoute } from '../../packages/shared/dist/pilot.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
// This verification starts the real production server against a disposable local
// test database. Never inherit an ambient deployment connection accidentally.
const testUrl = process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
assert(testUrl, 'A dedicated local test database is required');
const target = new URL(testUrl);
assert(['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && /test|acceptance/.test(target.pathname), 'A dedicated local test database is required');
for (const key of ['DATABASE_URL', 'LOBBYSTACK_APP_DATABASE_URL', 'LOBBYSTACK_SYSTEM_DATABASE_URL', 'LOBBYSTACK_AUTH_DATABASE_URL']) {
  assert(process.env[key], 'All database roles must point to the dedicated test database');
  const role = new URL(process.env[key]);
  assert(role.hostname === target.hostname && role.port === target.port && role.pathname === target.pathname, 'All database roles must point to the dedicated test database');
}
mkdirSync(join(root, '.tmp/security'), { recursive: true });
const app = join(root, 'apps/admin/app');
const paths = new Set();
function visit(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, entry.name);
    if (entry.isDirectory()) visit(file);
    else if (/^(?:route|page)\.tsx?$/.test(entry.name)) {
      const segments = relative(app, dir).split('/').filter(part => !/^\(.*\)$/.test(part));
      paths.add('/' + segments.map(part => part === '[locale]' ? 'en' : /^\[/.test(part) ? '11111111-1111-4111-8111-111111111111' : part).join('/'));
    }
  }
}
visit(app);
const denied = [...paths].filter(path => !pilotAdminRoute(path)).sort();
assert(denied.length > 100, 'Independent denied-route inventory unexpectedly shrank');
const env = { ...process.env, NODE_ENV: 'production', LMC_PROVIDER_MODE: 'fake', LOBBYSTACK_SKIP_ENV_FILES: 'true', OTEL_SDK_DISABLED: 'true', SERVICE_VERSION: randomBytes(24).toString('hex') };
delete env.LMC_PILOT_MODE; // Prove the production default, rather than explicit enablement.
for (const name of ['BETTER_AUTH_SECRET','INTERNAL_SERVICE_SECRET','INTERNAL_SERVICE_TOKEN','WIDGET_SESSION_SECRET','ENCRYPTION_KEY','OTP_HASH_SECRET','LOCAL_STORAGE_SIGNING_SECRET']) env[name] = randomBytes(32).toString('hex');
const log = openSync(join(root, '.tmp/security/pilot-production-http-server.log'), 'w', 0o600);
const child = spawn(process.execPath, [join(root, 'apps/admin/node_modules/next/dist/bin/next'), 'start', '--hostname', '127.0.0.1', '--port', '3100'], { cwd: join(root, 'apps/admin'), env, stdio: ['ignore', log, log] });
closeSync(log);
// The owned test server binds only 127.0.0.1; requests send no credentials or lead content.
const base = 'http://127.0.0.1:3100';
let checked = 0;
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error('Isolated production server exited during startup; inspect its private log.');
    // nosemgrep: typescript.react.security.react-insecure-request.react-insecure-request
    try { const health = await fetch(base + '/healthz', { signal: AbortSignal.timeout(1000) }); ready = health.status === 200 && (await health.json()).version === env.SERVICE_VERSION; } catch {}
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  assert(ready, 'Production health did not become ready');
  for (const path of denied) {
    for (const method of ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']) {
      const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(5000), headers: { origin: base } });
      await response.arrayBuffer();
      assert.equal(response.status, 404, `${method} ${path}`);
      assert.equal(response.headers.get('cache-control'), 'no-store', `${method} ${path} cache`);
      checked++;
    }
  }
  for (const [path, method, status] of [['/healthz','GET',200],['/healthz','DELETE',405],['/api/leads','DELETE',405],['/leads','POST',405],['/brand/lmc-logo.svg','GET',200],['/brand/lmc-logo.svg','POST',405],['/','GET',307]]) {
    const response = await fetch(base + path, { method, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer();
    assert.equal(response.status, status, `${method} ${path}`);
  }
  for (const [path, method] of [['/leads','POST'],['/api/lmc/settings','PUT']]) {
    const response = await fetch(base + path, { method, headers: { 'next-action': 'synthetic-inherited-action', origin: base }, signal: AbortSignal.timeout(5000) });
    await response.arrayBuffer();
    assert.equal(response.status, 404, `Server Action ${path}`);
  }
  mkdirSync(join(root, '.tmp/security'), { recursive: true });
  const report = { environment: 'isolated local Next production build', productionPilotFlag: 'unset (default enabled)', deniedRouteCount: denied.length, deniedMethodProbes: checked, methods: ['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS'], deniedPaths: denied, positiveAndMethodControls: 7, serverActionControls: 2, failures: [], limitations: 'Does not replace authenticated allowlist isolation or database probes.' };
  writeFileSync(join(root, '.tmp/security/pilot-production-http-smoke.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ deniedRoutes: denied.length, deniedMethodProbes: checked, controls: 9, failures: 0 }));
} finally {
  if (child.exitCode === null) {
    const ended = once(child, 'exit');
    child.kill('SIGTERM');
    await ended;
  }
}
