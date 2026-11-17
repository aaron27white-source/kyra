import { createDatabaseClient } from "@lobbystack/db";

export function openLmcTestDatabase() {
  const url = process.env.LMC_TEST_DATABASE_URL ?? process.env.LOBBYSTACK_RELIABILITY_TEST_DATABASE_URL;
  if (!url) throw new Error("LMC_TEST_DATABASE_URL is required.");
  const target = new URL(url);
  if (process.env.NODE_ENV === "production" || !["localhost","127.0.0.1","[::1]"].includes(target.hostname) || !/test/i.test(target.pathname)) throw new Error("Use an isolated local test database.");
  for (const key of ["LOBBYSTACK_APP_DATABASE_URL","LOBBYSTACK_SYSTEM_DATABASE_URL","LOBBYSTACK_WORKER_DATABASE_URL","LOBBYSTACK_DISPATCHER_DATABASE_URL"]) {
    const value = process.env[key];
    if (!value) throw new Error(`${key} is required; no privileged fallback is allowed.`);
    const candidate = new URL(value);
    if (candidate.hostname !== target.hostname || candidate.pathname !== target.pathname || candidate.port !== target.port) throw new Error("Runtime test roles must use the isolated database.");
  }
  const admin = createDatabaseClient("lobbystack_migrator", { DATABASE_URL: url });
  const app = createDatabaseClient("lobbystack_app"), worker = createDatabaseClient("lobbystack_worker"), dispatcher = createDatabaseClient("lobbystack_dispatcher");
  const system = createDatabaseClient("lobbystack_system");
  return { admin, app, system, worker, dispatcher, async close() { await Promise.all([admin,app,system,worker,dispatcher].map(client => client.pool.end())); } };
}
