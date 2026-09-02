import { createHmac, timingSafeEqual } from "node:crypto";
import { config } from "./config";

type JsonObject = Record<string, unknown>;

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

function secret(): string {
  if (!config.onlyOfficeJwtSecret) throw new Error("ONLYOFFICE_JWT_SECRET is required when the Word editor is enabled.");
  return config.onlyOfficeJwtSecret;
}

export function onlyOfficeEnabled(): boolean {
  return Boolean(config.onlyOfficePublicUrl && config.onlyOfficeInternalUrl && config.onlyOfficeAppUrl && config.onlyOfficeJwtSecret);
}

export function signOnlyOfficeToken(payload: JsonObject, ttlSeconds = 15 * 60): string {
  const header = encode({ alg: "HS256", typ: "JWT" });
  const body = encode({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeconds });
  const unsigned = `${header}.${body}`;
  const signature = createHmac("sha256", secret()).update(unsigned).digest("base64url");
  return `${unsigned}.${signature}`;
}

export function verifyOnlyOfficeToken(token: string): JsonObject {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid ONLYOFFICE token.");
  const [header, body, signature] = parts as [string, string, string];
  const decodedHeader = JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as JsonObject;
  if (decodedHeader.alg !== "HS256" || decodedHeader.typ !== "JWT") throw new Error("Invalid ONLYOFFICE token header.");
  const expected = createHmac("sha256", secret()).update(`${header}.${body}`).digest();
  const received = Buffer.from(signature, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("Invalid ONLYOFFICE token signature.");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as JsonObject;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) throw new Error("Expired ONLYOFFICE token.");
  return payload;
}

export function onlyOfficeDocumentKey(args: { draftId: string; version: number; sha256: string }): string {
  return `${args.draftId}-v${args.version}-${args.sha256.slice(0, 12)}`;
}

export function onlyOfficeEditorConfig(args: {
  draftId: string;
  version: number;
  sha256: string;
  title: string;
}) {
  if (!onlyOfficeEnabled()) throw new Error("The Word editor is not configured.");
  const documentAccess = signOnlyOfficeToken({ scope: "document", draftId: args.draftId, version: args.version }, 60 * 60);
  const callbackAccess = signOnlyOfficeToken({ scope: "callback", draftId: args.draftId, version: args.version }, 24 * 60 * 60);
  const document = {
    fileType: "docx",
    key: onlyOfficeDocumentKey(args),
    title: `${args.title}-v${args.version}.docx`,
    url: `${config.onlyOfficeAppUrl}/api/drafts/${args.draftId}/versions/${args.version}/document.docx?access=${encodeURIComponent(documentAccess)}`,
    permissions: {
      chat: false,
      comment: false,
      copy: true,
      download: false,
      edit: false,
      fillForms: true,
      modifyContentControl: false,
      print: true,
      protect: false,
      review: false,
    },
  };
  const editorConfig = {
    callbackUrl: `${config.onlyOfficeAppUrl}/api/drafts/${args.draftId}/versions/${args.version}/onlyoffice-callback?access=${encodeURIComponent(callbackAccess)}`,
    mode: "edit",
    user: { id: "attorney", name: "Attorney reviewer" },
    customization: {
      autosave: true,
      compactHeader: true,
      compactToolbar: true,
      forcesave: true,
      help: false,
      hideRightMenu: true,
    },
  };
  const editorPayload = { documentType: "word", type: "desktop", document, editorConfig };
  return {
    documentServerUrl: config.onlyOfficePublicUrl,
    config: { ...editorPayload, token: signOnlyOfficeToken(editorPayload, 60 * 60) },
  };
}

export async function requestOnlyOfficeForceSave(args: { draftId: string; version: number; sha256: string }) {
  if (!config.onlyOfficeInternalUrl) throw new Error("The Word editor service is not configured.");
  const key = onlyOfficeDocumentKey(args);
  const command = { c: "forcesave", key, userdata: `${args.draftId}:v${args.version}` };
  const body = JSON.stringify({ ...command, token: signOnlyOfficeToken(command, 5 * 60) });
  const send = (endpoint: string) => fetch(`${config.onlyOfficeInternalUrl}${endpoint}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body, redirect: "error",
  });
  let response = await send(`/command?shardkey=${encodeURIComponent(key)}`);
  if (response.status === 404) response = await send("/coauthoring/CommandService.ashx");
  if (!response.ok) throw new Error(`ONLYOFFICE force-save failed with HTTP ${response.status}.`);
  const result = await response.json() as { error?: number; key?: string };
  if (result.error !== 0) throw new Error(`ONLYOFFICE force-save failed with code ${result.error ?? "unknown"}.`);
  return result;
}

export function requireScopedAccess(token: string | undefined, scope: string, draftId: string, version: number): void {
  if (!token) throw new Error("Missing ONLYOFFICE access token.");
  const payload = verifyOnlyOfficeToken(token);
  if (payload.scope !== scope || payload.draftId !== draftId || payload.version !== version) {
    throw new Error("ONLYOFFICE access token does not match this document.");
  }
}

export function allowedOnlyOfficeDownload(url: string): boolean {
  if (!config.onlyOfficeInternalUrl) return false;
  try {
    const expected = new URL(config.onlyOfficeInternalUrl);
    const candidate = new URL(url);
    return candidate.protocol === expected.protocol && candidate.host === expected.host;
  } catch {
    return false;
  }
}
