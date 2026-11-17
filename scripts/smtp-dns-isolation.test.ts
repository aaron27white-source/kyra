import { createRequire } from "node:module";
import { expect, it } from "vitest";

const provider = createRequire(new URL("../packages/providers/package.json", import.meta.url));
type Resolution = { host: string; servername: string };
const shared = provider("nodemailer/lib/shared/index.js") as {
  dnsCache: Map<string, unknown>;
  resolveHostname: (options: {host:string;servername:string}, callback: (error: Error | null, value: Resolution) => void) => void;
};

it("keeps each SMTP transport TLS identity independent of a shared DNS cache", async () => {
  const host = "shared-smtp-gateway.example.invalid";
  const previous = shared.dnsCache.get(host);
  // Seed DNS data only: no DNS lookup, socket, SMTP credential or email delivery.
  shared.dnsCache.set(host, {value:{addresses:["192.0.2.1"],servername:"tenant-a.example.invalid"},expires:Date.now()+60_000});
  const resolve = (servername: string) => new Promise<Resolution>((done, reject) =>
    shared.resolveHostname({host,servername}, (error,value) => error ? reject(error) : done(value)));
  try {
    const first = await resolve("tenant-a.example.invalid");
    expect(first.host).toBe("192.0.2.1");
    expect(first.servername).toBe("tenant-a.example.invalid");
    const second = await resolve("tenant-b.example.invalid");
    expect(second.host).toBe("192.0.2.1");
    expect(second.servername).toBe("tenant-b.example.invalid");
    expect((await resolve("tenant-a.example.invalid")).servername).toBe("tenant-a.example.invalid");
  } finally {
    if(previous===undefined)shared.dnsCache.delete(host);
    else shared.dnsCache.set(host,previous);
  }
});
