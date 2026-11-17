import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";

import { assertDatabaseRole, createDatabaseClient, withBusinessTransaction } from "../packages/db/src/index";

export const BOOTSTRAP_CONFIRMATION = "CREATE_FIRST_PLATFORM_ADMIN";

export function parseBootstrapArguments(args: string[]): { email: string } {
  const emailFlag = args.find((argument) => argument.startsWith("--email="));
  const confirmationFlag = args.find((argument) => argument.startsWith("--confirm="));
  const email = emailFlag?.slice("--email=".length).trim().toLowerCase() ?? "";
  const confirmation = confirmationFlag?.slice("--confirm=".length) ?? "";
  if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 320) throw new Error("Pass a valid --email address.");
  if (confirmation !== BOOTSTRAP_CONFIRMATION) throw new Error(`Pass --confirm=${BOOTSTRAP_CONFIRMATION} to acknowledge the one-time promotion.`);
  return { email };
}

export async function bootstrapPlatformAdmin(args: string[]): Promise<string> {
  const { email } = parseBootstrapArguments(args);
  const database = createDatabaseClient("lobbystack_system");
  try {
    await assertDatabaseRole(database, { ...process.env, NODE_ENV: "production" });
    return await withBusinessTransaction(database.db, { actorType: "system" }, async (tx) => {
      const result = await tx.execute<{ userId: string }>(sql`
        select app.bootstrap_platform_admin(${email}, ${randomUUID()}::uuid) as "userId"
      `);
      const userId = result.rows[0]?.userId;
      if (!userId) throw new Error("Platform administrator bootstrap did not return a user.");
      return userId;
    });
  } finally {
    await database.pool.end();
  }
}

async function main() {
  const userId = await bootstrapPlatformAdmin(process.argv.slice(2));
  console.log(`Platform administrator created for user ${userId}. MFA enrollment is required before access.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Platform administrator bootstrap failed.");
    process.exitCode = 1;
  });
}
