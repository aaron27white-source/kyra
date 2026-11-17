import { discoverLandingHttpRoutes } from "./isolation-landing-inventory";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";
import ts from "typescript";
import type { openLmcTestDatabase } from "./database";
import { discoverWorkerHttpRoutes } from "./isolation-worker-inventory";

export type AuditColumn = {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  generated: string;
  identity: string;
  enumValues: string[];
};
export type AuditTable = {
  name: string;
  rls: boolean;
  forced: boolean;
  columns: AuditColumn[];
  primaryKey: string[];
  foreignKeys: {
    name: string;
    columns: string[];
    target: string;
    targetColumns: string[];
  }[];
  checks: { name: string; expression: string }[];
  policies: {
    name: string;
    command: string;
    roles: string[];
    using: string | null;
    check: string | null;
  }[];
};
export type AuditLogin = {
  expected: string;
  actual: string;
  superuser: boolean;
  bypassRls: boolean;
};
export type IsolationCatalog = {
  tables: AuditTable[];
  logins: AuditLogin[];
  roles: { name: string; superuser: boolean; bypassRls: boolean }[];
  appElevations: string[];
};
const runtimeRoles = [
  "lobbystack_app",
  "lobbystack_system",
  "lobbystack_auth",
  "lobbystack_worker",
  "lobbystack_dispatcher",
  "lobbystack_readonly",
  "lobbystack_finance_export",
];
export type AuditRoute = {
  path: string;
  file: string;
  methods: string[];
  surface?: "admin" | "worker" | "landing";
};
const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));
const methods = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);

/** Reads pg_catalog rather than trusting ORM declarations or a checked-in table list. */
export async function readIsolationCatalog(
  db: ReturnType<typeof openLmcTestDatabase>,
): Promise<IsolationCatalog> {
  const tables = await db.admin.pool.query<{ data: AuditTable }>(`
    select jsonb_build_object(
      'name', c.relname, 'rls', c.relrowsecurity, 'forced', c.relforcerowsecurity,
      'columns', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', a.attname, 'type', format_type(a.atttypid,a.atttypmod), 'nullable', not a.attnotnull,
        'default', pg_get_expr(d.adbin,d.adrelid), 'generated', a.attgenerated, 'identity', a.attidentity,
        'enumValues', (select coalesce(jsonb_agg(e.enumlabel order by e.enumsortorder),'[]'::jsonb) from pg_enum e where e.enumtypid=a.atttypid)
      ) order by a.attnum),'[]'::jsonb) from pg_attribute a left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),
      'primaryKey', (select coalesce(jsonb_agg(a.attname order by array_position(k.conkey,a.attnum)),'[]'::jsonb) from pg_constraint k join pg_attribute a on a.attrelid=c.oid and a.attnum=any(k.conkey) where k.conrelid=c.oid and k.contype='p'),
      'foreignKeys', (select coalesce(jsonb_agg(jsonb_build_object(
        'name', k.conname, 'target', t.relname,
        'columns', (select jsonb_agg(a.attname order by x.n) from unnest(k.conkey) with ordinality x(num,n) join pg_attribute a on a.attrelid=c.oid and a.attnum=x.num),
        'targetColumns', (select jsonb_agg(a.attname order by x.n) from unnest(k.confkey) with ordinality x(num,n) join pg_attribute a on a.attrelid=k.confrelid and a.attnum=x.num)
      ) order by k.conname),'[]'::jsonb) from pg_constraint k join pg_class t on t.oid=k.confrelid where k.conrelid=c.oid and k.contype='f'),
      'checks', (select coalesce(jsonb_agg(jsonb_build_object('name',k.conname,'expression',pg_get_constraintdef(k.oid)) order by k.conname),'[]'::jsonb) from pg_constraint k where k.conrelid=c.oid and k.contype='c'),
      'policies', (select coalesce(jsonb_agg(jsonb_build_object('name',p.policyname,'command',p.cmd,'roles',p.roles,'using',p.qual,'check',p.with_check) order by p.policyname),'[]'::jsonb) from pg_policies p where p.schemaname='public' and p.tablename=c.relname)
    ) as data
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind in ('r','p') and c.relname not in ('__drizzle_migrations','__lobbystack_migrations')
    order by c.relname
  `);
  const roles = await db.admin.pool.query<{
    name: string;
    superuser: boolean;
    bypassRls: boolean;
  }>(
    `select rolname as name, rolsuper as superuser, rolbypassrls as "bypassRls" from pg_roles where rolname in ('lobbystack_app','lobbystack_system','lobbystack_auth','lobbystack_worker','lobbystack_dispatcher','lobbystack_readonly','lobbystack_finance_export') order by rolname`,
  );
  const logins = await Promise.all(
    [db.app, db.system, db.worker, db.dispatcher].map(async (client) => {
      const result = await client.pool.query<{
        actual: string;
        superuser: boolean;
        bypassRls: boolean;
      }>(
        `select current_user as actual, rolsuper as superuser, rolbypassrls as "bypassRls" from pg_roles where rolname=current_user`,
      );
      if (!result.rows[0]) throw new Error("MISSING_RUNTIME_LOGIN");
      return { expected: client.role, ...result.rows[0] };
    }),
  );
  const memberships = await db.admin.pool.query<{ name: string }>(
    `select rolname as name from pg_roles where rolname <> 'lobbystack_app' and pg_has_role('lobbystack_app',oid,'MEMBER') order by rolname`,
  );
  return {
    tables: tables.rows.map((row) => row.data),
    roles: roles.rows,
    logins,
    appElevations: memberships.rows.map((row) => row.name),
  };
}

export function checkCatalogProtection(catalog: IsolationCatalog): string[] {
  const failures: string[] = [];
  for (const table of catalog.tables) {
    if (!table.rls || !table.forced || table.policies.length === 0)
      failures.push(`UNPROTECTED_TABLE:${table.name}`);
    const businessOwned =
      table.name === "businesses" ||
      table.columns.some(
        (column) => column.name === "business_id" && !column.nullable,
      );
    if (businessOwned) {
      const tenant = table.columns.find(
        (column) => column.name === "tenant_id",
      );
      if (
        !tenant ||
        tenant.nullable ||
        tenant.type !== "uuid" ||
        tenant.generated !== "s" ||
        tenant.default !== (table.name === "businesses" ? "id" : "business_id")
      )
        failures.push(`UNSAFE_LEGACY_TENANT_ID:${table.name}`);
    }
  }
  for (const login of catalog.logins)
    if (login.expected !== login.actual || login.superuser || login.bypassRls)
      failures.push(`UNSAFE_RUNTIME_LOGIN:${login.expected}`);
  for (const role of catalog.roles)
    if (role.superuser || role.bypassRls)
      failures.push(`UNSAFE_RUNTIME_ROLE:${role.name}`);
  for (const role of runtimeRoles)
    if (!catalog.roles.some((candidate) => candidate.name === role))
      failures.push(`MISSING_RUNTIME_ROLE:${role}`);
  for (const role of catalog.appElevations)
    failures.push(`APP_ROLE_ELEVATION:${role}`);
  return failures;
}

export function auditRouteId(route: AuditRoute, method: string): string {
  return `${route.surface && route.surface !== "admin" ? `${route.surface}:` : ""}${method} ${route.path}`;
}

/** Enumerates route files and exported HTTP methods via TypeScript AST, including destructured auth exports. */
export function discoverApiRoutes(root = projectRoot): AuditRoute[] {
  const app = join(root, "apps/admin/app");
  const result: AuditRoute[] = [];
  function visit(directory: string) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
        continue;
      }
      if (!/^route\.(?:[jt]sx?)$/.test(entry.name)) continue;
      const exported = new Set<string>();
      const source = ts.createSourceFile(
        file,
        readFileSync(file, "utf8"),
        ts.ScriptTarget.Latest,
        true,
      );
      for (const statement of source.statements) {
        if (
          ts.isExportDeclaration(statement) &&
          statement.exportClause &&
          ts.isNamedExports(statement.exportClause)
        )
          for (const element of statement.exportClause.elements)
            if (methods.has(element.name.text)) exported.add(element.name.text);
        if (
          !ts.canHaveModifiers(statement) ||
          !ts
            .getModifiers(statement)
            ?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
        )
          continue;
        if (
          ts.isFunctionDeclaration(statement) &&
          statement.name &&
          methods.has(statement.name.text)
        )
          exported.add(statement.name.text);
        if (ts.isVariableStatement(statement))
          for (const declaration of statement.declarationList.declarations) {
            if (
              ts.isIdentifier(declaration.name) &&
              methods.has(declaration.name.text)
            )
              exported.add(declaration.name.text);
            if (ts.isObjectBindingPattern(declaration.name))
              for (const element of declaration.name.elements)
                if (
                  ts.isIdentifier(element.name) &&
                  methods.has(element.name.text)
                )
                  exported.add(element.name.text);
          }
      }
      if (!exported.size)
        throw new Error(`UNRESOLVED_ROUTE_METHODS:${relative(root, file)}`);
      const segments = relative(app, directory)
        .split(/[\\/]/)
        .filter((segment) => !/^\(.*\)$/.test(segment));
      const path = `/${segments.join("/")}`;
      if (exported.has("GET")) exported.add("HEAD");
      exported.add("OPTIONS");
      result.push({
        path,
        surface: "admin",
        file: relative(root, file).replace(/\\/g, "/"),
        methods: [...exported].sort(),
      });
    }
  }
  visit(app);
  if (new Set(result.map((route) => route.path)).size !== result.length)
    throw new Error("DUPLICATE_API_ROUTE");
  return [
    ...result.sort((a, b) => a.path.localeCompare(b.path)),
    ...discoverWorkerHttpRoutes(root),
    ...discoverLandingHttpRoutes(root),
  ];
}
