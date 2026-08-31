import { describe, expect, it } from "vitest";
import { DEMO_IDENTITIES, publicDemoIdentities, signDemoIdentity, verifyDemoIdentity } from "./identity";

describe("signed local collaboration identities", () => {
  it("round-trips each configured human identity and its paired agent", () => {
    for (const identity of DEMO_IDENTITIES) {
      const verified = verifyDemoIdentity(signDemoIdentity(identity));
      expect(verified).toMatchObject({
        id: identity.id,
        slug: identity.slug,
        agentId: identity.agentId,
        agentName: `${identity.name} Agent`,
      });
    }
  });

  it("rejects a tampered token", () => {
    const token = signDemoIdentity(DEMO_IDENTITIES[0]!);
    const [payload, signature] = token.split(".");
    const replacement = signature?.endsWith("A") ? "B" : "A";
    expect(verifyDemoIdentity(`${payload}.${signature?.slice(0, -1)}${replacement}`)).toBeNull();
    expect(verifyDemoIdentity(`${token}.unexpected`)).toBeNull();
  });

  it("exposes signed tokens without dropping actor metadata", () => {
    const identities = publicDemoIdentities();
    expect(identities.map(({ slug }) => slug)).toEqual(["faby", "alex"]);
    for (const identity of identities) expect(verifyDemoIdentity(identity.token)?.id).toBe(identity.id);
  });
});
