import type * as DbModule from "@lobbystack/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ enqueue: vi.fn(), admin: vi.fn(), member: vi.fn() }));
const tx = {
  select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => [], then: (resolve: (rows: unknown[]) => void) => resolve([]) }) }) }) }),
  insert: () => ({ values: () => ({ returning: async () => [{ id: "rule-1" }] }) }),
};
vi.mock("@lobbystack/db", async (original) => ({ ...(await original<typeof DbModule>()), withBusinessTransaction: vi.fn(async (_db, _actor, callback) => callback(tx)), enqueueOutbox: mocks.enqueue }));
vi.mock("../authz", () => ({ requireBusinessAdmin: mocks.admin, requireBusinessMembership: mocks.member }));

import { createAgentRule, listAgentRules } from "./rules";

const context = { db: {} as never };

beforeEach(() => { vi.clearAllMocks(); });

describe("voice rule snapshot consistency", () => {
  it("publishes a refresh in the same transaction as the rule change", async () => {
    await expect(createAgentRule(context, { userId: "owner", businessId: "business", title: "Greeting", content: "Use the approved greeting." })).resolves.toBe("rule-1");
    expect(mocks.enqueue).toHaveBeenCalledWith(tx, expect.objectContaining({ topic: "snapshot.refresh", businessId: "business", payload: { businessId: "business", reason: "agent_rules_changed" } }));
  });

  it("does not refresh the snapshot for a read", async () => {
    await expect(listAgentRules(context, { userId: "owner", businessId: "business" })).resolves.toEqual([]);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
});
