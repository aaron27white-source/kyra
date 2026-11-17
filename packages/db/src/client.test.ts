import { describe, expect, it, vi } from "vitest";

import { assertDatabaseRole, createDatabaseClient, roleDatabaseUrl, withBusinessTransaction, type DatabaseClient } from "./client";

const DATABASE_URL = "postgresql://postgres:superuser@postgres.internal:5432/lobbystack";

describe("effective database role assertion", () => {
  it.each(["lobbystack_worker", "lobbystack_dispatcher", "lobbystack_app", "lobbystack_system"] as const)("checks %s in production", async (role) => {
    const query = vi.fn().mockResolvedValue({ rows: [{ role, privileged: false }] });
    const client = { role, pool: { query } } as unknown as DatabaseClient;
    await expect(assertDatabaseRole(client, { NODE_ENV: "production" })).resolves.toBeUndefined();
    query.mockResolvedValue({ rows: [{ role: "postgres", privileged: true }] });
    await expect(assertDatabaseRole(client, { NODE_ENV: "production" })).rejects.toThrow("Database role assertion failed");
    query.mockResolvedValue({ rows: [{ role, privileged: true }] });
    await expect(assertDatabaseRole(client, { NODE_ENV: "production" })).rejects.toThrow("Database role assertion failed");
    query.mockResolvedValue({ rows: [{ role: "other", privileged: false }] });
    await expect(assertDatabaseRole(client, { NODE_ENV: "production" })).rejects.toThrow("Database role assertion failed");
  });

  it("allows privileged migrator bootstrap", async () => {
    const query = vi.fn();
    await assertDatabaseRole({ role: "lobbystack_migrator", pool: { query } } as unknown as DatabaseClient, { NODE_ENV: "production" });
    expect(query).not.toHaveBeenCalled();
  });
});

describe("roleDatabaseUrl", () => {
  it("prefers an explicit role URL", () => {
    expect(
      roleDatabaseUrl("lobbystack_app", {
        DATABASE_URL,
        LOBBYSTACK_APP_DATABASE_URL: "postgresql://lobbystack_app:explicit@db:5432/lobbystack",
        LOBBYSTACK_APP_PASSWORD: "ignored",
      }),
    ).toBe("postgresql://lobbystack_app:explicit@db:5432/lobbystack");
  });

  it("builds the role URL from DATABASE_URL and the role password", () => {
    expect(roleDatabaseUrl("lobbystack_worker", { DATABASE_URL, LOBBYSTACK_WORKER_PASSWORD: "w0rker" })).toBe(
      "postgresql://lobbystack_worker:w0rker@postgres.internal:5432/lobbystack",
    );
  });

  it("encodes passwords with reserved characters", () => {
    const url = new URL(roleDatabaseUrl("lobbystack_auth", { DATABASE_URL, LOBBYSTACK_AUTH_PASSWORD: "p@ss/word" }));
    expect(decodeURIComponent(url.password)).toBe("p@ss/word");
  });

  it("falls back to DATABASE_URL when the role has no password", () => {
    expect(roleDatabaseUrl("lobbystack_dispatcher", { DATABASE_URL })).toBe(DATABASE_URL);
  });

  it("never derives the migrator URL from its password", () => {
    expect(roleDatabaseUrl("lobbystack_migrator", { DATABASE_URL, LOBBYSTACK_MIGRATOR_PASSWORD: "m" })).toBe(DATABASE_URL);
  });

  it("requires DATABASE_URL when no explicit role URL is set", () => {
    expect(() => roleDatabaseUrl("lobbystack_app", { LOBBYSTACK_APP_PASSWORD: "a" })).toThrow("DATABASE_URL is required");
  });
});

it("requires separate credentials for the internal system identity instead of using the base login", () => {
  expect(() => roleDatabaseUrl("lobbystack_system", { DATABASE_URL })).toThrow("LOBBYSTACK_SYSTEM_CREDENTIALS_REQUIRED");
  expect(new URL(roleDatabaseUrl("lobbystack_system", { DATABASE_URL, LOBBYSTACK_SYSTEM_PASSWORD: "test-only-password" })).username).toBe("lobbystack_system");
});

describe("internal system routing fails closed before executing work", () => {
  it("does not reuse app or base credentials when internal credentials are missing", async () => {
    const client = createDatabaseClient("lobbystack_app", {
      DATABASE_URL,
      LOBBYSTACK_SYSTEM_DATABASE_URL: undefined,
      LOBBYSTACK_SYSTEM_PASSWORD: undefined,
    });
    const callback = vi.fn();
    try {
      await expect(withBusinessTransaction(client.db, { actorType: "system" }, callback)).rejects.toThrow("LOBBYSTACK_SYSTEM_CREDENTIALS_REQUIRED");
      expect(callback).not.toHaveBeenCalled();
    } finally { await client.pool.end(); }
  });

  it.each([
    "postgresql://lobbystack_system:unused@other.internal:5432/lobbystack",
    "postgresql://lobbystack_system:unused@postgres.internal:5433/lobbystack",
    "postgresql://lobbystack_system:unused@postgres.internal:5432/other_database",
  ])("rejects a different internal connection target", async (internalUrl) => {
    const client = createDatabaseClient("lobbystack_app", {
      DATABASE_URL,
      LOBBYSTACK_SYSTEM_DATABASE_URL: internalUrl,
    });
    const callback = vi.fn();
    try {
      await expect(withBusinessTransaction(client.db, { actorType: "system" }, callback)).rejects.toThrow("LOBBYSTACK_SYSTEM_DATABASE_MISMATCH");
      expect(callback).not.toHaveBeenCalled();
    } finally { await client.pool.end(); }
  });
});
