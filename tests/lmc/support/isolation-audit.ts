import { probePilotWebhookContext } from "./isolation-pilot-webhook";
import { probePilotAuthContext } from "./isolation-pilot-auth";
import { probePilotPublicContext } from "./isolation-pilot-public";
import { probePilotSessionContext } from "./isolation-pilot-session";
import { probePilotSuperAdminContext } from "./isolation-pilot-superadmin";
import { probePilotManagedSetupContext } from "./isolation-pilot-managed-setup";
import { discoverPilotApiRoutes } from "./isolation-pilot-inventory";
import { probePilotMethodGuards } from "./isolation-pilot-guards";
import { probePilotDashboardContext } from "./isolation-pilot-dashboard";
import { probePilotIntegrationsContext } from "./isolation-pilot-integrations";
import { probePilotVoiceContext } from "./isolation-pilot-voice";
import { probePilotWorker } from "./isolation-pilot-worker";
import { probeAdminHealthContext } from "./isolation-admin-health";
import { openLmcTestDatabase } from "./database";
import {
  checkCatalogProtection,
  auditRouteId,
  readIsolationCatalog,
} from "./isolation-inventory";
import { seedIsolationFixtures } from "./isolation-fixtures";
import { probeStoredTables } from "./isolation-tables";
import { probeTableInserts } from "./isolation-inserts";
import {
  withHttpAudit,
  probeEmailReadContext,
  probeEmailMutationContext,
} from "./isolation-http";

/** Inventory follows the effective pilot boundary; every discovered method still requires a behavioral probe. */
export async function runTenantIsolationAudit() {
  const db = openLmcTestDatabase();
  let fixtures: Awaited<ReturnType<typeof seedIsolationFixtures>> | undefined;
  try {
    const catalog = await readIsolationCatalog(db),
      routes = discoverPilotApiRoutes();
    const failures = checkCatalogProtection(catalog);
    // Detect grant masking before interpreting a 42501 from CRUD probes as evidence.
    const columns = await db.admin.pool.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid where n.nspname='public' and c.relkind in ('r','p') and a.attnum>0 and not a.attisdropped and a.attgenerated='' and a.attidentity='' group by c.oid,c.relname having has_any_column_privilege('lobbystack_app',c.oid,'INSERT') and not bool_and(has_column_privilege('lobbystack_app',c.oid,a.attnum,'INSERT'))`,
    );
    failures.push(
      ...columns.rows.map((row) => `INSERT_COLUMN_GRANT_MASK:${row.name}`),
    );
    const primaryKeys = await db.admin.pool.query<{ name: string }>(
      `select c.relname as name from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_constraint k on k.conrelid=c.oid and k.contype='p' join pg_attribute a on a.attrelid=c.oid and a.attnum=any(k.conkey) where n.nspname='public' group by c.oid,c.relname having (has_any_column_privilege('lobbystack_app',c.oid,'UPDATE') or has_table_privilege('lobbystack_app',c.oid,'DELETE')) and not bool_and(has_column_privilege('lobbystack_app',c.oid,a.attnum,'SELECT'))`,
    );
    failures.push(
      ...primaryKeys.rows.map((row) => `MUTATION_KEY_GRANT_MASK:${row.name}`),
    );
    fixtures = await seedIsolationFixtures(db, catalog.tables);
    failures.push(...fixtures.failures);
    const stored = await probeStoredTables(
      db,
      catalog.tables,
      fixtures.a,
      fixtures.b,
    );
    const inserts = await probeTableInserts(db, catalog.tables);
    failures.push(...stored.failures, ...inserts.failures);
    const http = await withHttpAudit(
      process.env.LMC_TEST_HTTP_BASE_URL ?? "http://localhost:3000",
      async (context) => {
        await probePilotMethodGuards(context, routes);
        await probePilotDashboardContext(context);
        await probePilotVoiceContext(context);
        await probePilotSessionContext(context);
        await probePilotManagedSetupContext(context);
        await probePilotSuperAdminContext(context);
        await probeAdminHealthContext(context);
        await probeEmailReadContext(context);
        // Token-rotation controls revoke the fixture capture URLs; exercise
        // public capabilities first, without relaxing either set of assertions.
        await probePilotPublicContext(context);
        await probePilotWebhookContext(context);
        await probeEmailMutationContext(context);
        // The integration probes enqueue calendar reconciliation and disconnect
        // fixture connections, so run them only after worker-backed email probes.
        await probePilotIntegrationsContext(context);
        // Password recovery revokes fixture sessions, so it must run last.
        await probePilotAuthContext(context);
      },
    );
    const workerHealth = await probePilotWorker(routes.filter(route => route.surface === "worker"));
    failures.push(
      ...http.failures,
      ...workerHealth.failures,
    );
    const tableInventory = catalog.tables.map((table) => table.name);
    const routeInventory = routes.flatMap((route) =>
      route.methods.map((method) => auditRouteId(route, method)),
    );
    const probedTables = stored.probed.filter((table) =>
      inserts.probed.includes(table),
    );
    const probedRoutes = [
      ...new Set([
        ...http.probed,
        ...workerHealth.probed,
      ]),
    ];
    // Static landing is a separate artifact; legacy routes are denied at the pilot boundary.
    // Every allowlisted API method remains mandatory, including unsupported-method guards.
    const pendingHttpSurfaces: string[] = [];
    const skipped = [
      ...pendingHttpSurfaces.map(
        (surface) => `UNINVENTORIED_HTTP_SURFACE:${surface}`,
      ),
      ...tableInventory
        .filter((table) => !probedTables.includes(table))
        .map((table) => `UNPROBED_TABLE:${table}`),
      ...routeInventory
        .filter((route) => !probedRoutes.includes(route))
        .map((route) => `UNPROBED_ROUTE:${route}`),
    ];
    for (const route of probedRoutes)
      if (!routeInventory.includes(route))
        failures.push(`UNDISCOVERED_ROUTE_PROBE:${route}`);
    return {
      auditScope: "pilot" as const,
      tableInventory,
      routeInventory,
      probedTables,
      probedRoutes,
      skipped,
      failures,
      runtimeRoles: catalog.logins,
      pendingHttpSurfaces,
    };
  } finally {
    try {
      await fixtures?.cleanup();
    } finally {
      await db.close();
    }
  }
}
