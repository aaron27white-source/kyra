import { eq, sql } from "drizzle-orm";

import { users, withBusinessTransaction } from "@lobbystack/db";
import { requirePlatformAdmin } from "@lobbystack/domain";

import { getSession, type Session } from "./auth";
import { getAppDatabase } from "./api-helpers";

export const SUPERADMIN_LIFECYCLES = ["draft", "needs_connection", "ready_for_test", "active", "paused", "error"] as const;
export type SuperAdminLifecycle = (typeof SUPERADMIN_LIFECYCLES)[number];

export class SuperAdminAccessError extends Error {
  constructor(readonly status: 401 | 403, message: string) {
    super(message);
    this.name = "SuperAdminAccessError";
  }
}

export type SuperAdminSession = NonNullable<Session>;

export function assertSuperAdminIdentity(identity: { platformRole: string; emailVerified: boolean; twoFactorEnabled: boolean }): void {
  if (identity.platformRole !== "platform_admin") throw new SuperAdminAccessError(403, "Platform administrator access is required.");
  if (!identity.emailVerified) throw new SuperAdminAccessError(403, "A verified identity is required.");
  if (!identity.twoFactorEnabled) throw new SuperAdminAccessError(403, "Multi-factor authentication is required.");
}

export async function requireSuperAdminSession(requestHeaders: Headers): Promise<SuperAdminSession> {
  const session = await getSession(requestHeaders);
  if (!session) throw new SuperAdminAccessError(401, "Authentication required.");

  await withBusinessTransaction(
    getAppDatabase().db,
    { userId: session.user.id, actorType: "operator" },
    async (tx) => {
      await requirePlatformAdmin(tx, session.user.id);
      const [identity] = await tx
        .select({ platformRole: users.platformRole, emailVerified: users.emailVerified, twoFactorEnabled: users.twoFactorEnabled })
        .from(users)
        .where(eq(users.id, session.user.id))
        .limit(1);
      if (!identity) throw new SuperAdminAccessError(403, "Platform administrator access is required.");
      assertSuperAdminIdentity(identity);
    },
  );
  return session;
}

export async function requireSuperAdminEnrollmentSession(requestHeaders: Headers): Promise<SuperAdminSession> {
  const session = await getSession(requestHeaders);
  if (!session) throw new SuperAdminAccessError(401, "Authentication required.");
  await withBusinessTransaction(getAppDatabase().db, { userId: session.user.id, actorType: "operator" }, async (tx) => {
    await requirePlatformAdmin(tx, session.user.id);
    const [identity] = await tx.select({ emailVerified: users.emailVerified }).from(users).where(eq(users.id, session.user.id)).limit(1);
    if (!identity?.emailVerified) throw new SuperAdminAccessError(403, "A verified identity is required.");
  });
  return session;
}

export type SuperAdminClient = {
  id: string;
  name: string;
  slug: string;
  ownerEmail: string | null;
  lifecycle: SuperAdminLifecycle;
  updatedAt: Date;
};

type ClientRow = SuperAdminClient & { totalCount: string | number };

export async function listSuperAdminClients(input: { userId: string; search?: string; limit: number; offset: number }) {
  const search = (input.search ?? "").trim().slice(0, 160);
  return await withBusinessTransaction(getAppDatabase().db, { userId: input.userId, actorType: "operator" }, async (tx) => {
    const result = await tx.execute<ClientRow>(sql`
      select id, name, slug, owner_email as "ownerEmail", lifecycle,
        updated_at as "updatedAt", total_count as "totalCount"
      from app.superadmin_clients(${search}, ${input.limit}, ${input.offset})
    `);
    const data = result.rows.map(({ totalCount: _totalCount, ...client }) => client);
    const total = Number(result.rows[0]?.totalCount ?? 0);
    return { data, total, hasNext: input.offset + data.length < total };
  });
}

export async function getSuperAdminOverview(userId: string) {
  return await withBusinessTransaction(getAppDatabase().db, { userId, actorType: "operator" }, async (tx) => {
    const countsResult = await tx.execute<{ lifecycle: SuperAdminLifecycle; clientCount: string | number }>(sql`
      select lifecycle, client_count as "clientCount" from app.superadmin_overview()
    `);
    const recent = await tx.execute<ClientRow>(sql`
      select id, name, slug, owner_email as "ownerEmail", lifecycle,
        updated_at as "updatedAt", total_count as "totalCount"
      from app.superadmin_clients('', 5, 0)
    `);
    const counts = Object.fromEntries(SUPERADMIN_LIFECYCLES.map((state) => [state, 0])) as Record<SuperAdminLifecycle, number>;
    for (const row of countsResult.rows) counts[row.lifecycle] = Number(row.clientCount);
    return {
      counts,
      total: Object.values(counts).reduce((sum, count) => sum + count, 0),
      needsAttention: counts.error + counts.needs_connection,
      recent: recent.rows.map(({ totalCount: _totalCount, ...client }) => client),
    };
  });
}
