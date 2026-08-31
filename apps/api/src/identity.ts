import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { WORKSPACE_ID } from "./db";

export interface DemoIdentity {
  id: string;
  slug: "faby" | "alex";
  name: string;
  email: string;
  color: string;
  agentId: string;
  agentName: string;
}

export const DEMO_IDENTITIES: DemoIdentity[] = [
  {
    id: "00000000-0000-4000-8000-000000000101",
    slug: "faby",
    name: "Faby Rivera",
    email: "faby@stalwartlaw.com",
    color: "#e76f51",
    agentId: "00000000-0000-4000-8000-000000000201",
    agentName: "Faby Rivera Agent",
  },
  {
    id: "00000000-0000-4000-8000-000000000102",
    slug: "alex",
    name: "Alex Chen",
    email: "alex@stalwartlaw.com",
    color: "#2a9d8f",
    agentId: "00000000-0000-4000-8000-000000000202",
    agentName: "Alex Chen Agent",
  },
];

interface IdentityPayload {
  actorId: string;
  workspaceId: string;
  issuedFor: "local-demo";
}

function signature(payload: string): Buffer {
  return createHmac("sha256", config.collaborationSecret).update(payload).digest();
}

export function signDemoIdentity(identity: DemoIdentity): string {
  const payload = Buffer.from(JSON.stringify({
    actorId: identity.id,
    workspaceId: WORKSPACE_ID,
    issuedFor: "local-demo",
  } satisfies IdentityPayload)).toString("base64url");
  return `${payload}.${signature(payload).toString("base64url")}`;
}

export function verifyDemoIdentity(token: string | undefined): DemoIdentity | null {
  if (!token) return null;
  const tokenParts = token.split(".");
  if (tokenParts.length !== 2) return null;
  const [payload, suppliedSignature] = tokenParts;
  if (!payload || !suppliedSignature) return null;
  const expected = signature(payload);
  const supplied = Buffer.from(suppliedSignature, "base64url");
  if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as IdentityPayload;
    if (parsed.workspaceId !== WORKSPACE_ID || parsed.issuedFor !== "local-demo") return null;
    return DEMO_IDENTITIES.find((identity) => identity.id === parsed.actorId) ?? null;
  } catch {
    return null;
  }
}

export function publicDemoIdentities() {
  return DEMO_IDENTITIES.map((identity) => ({ ...identity, token: signDemoIdentity(identity) }));
}
