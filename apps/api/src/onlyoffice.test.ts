import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { config } from "./config";
import {
  allowedOnlyOfficeDownload,
  onlyOfficeEnabled,
  onlyOfficeEditorConfig,
  requestOnlyOfficeForceSave,
  requireScopedAccess,
  signOnlyOfficeToken,
  verifyOnlyOfficeToken,
} from "./onlyoffice";

const original = {
  onlyOfficePublicUrl: config.onlyOfficePublicUrl,
  onlyOfficeInternalUrl: config.onlyOfficeInternalUrl,
  onlyOfficeAppUrl: config.onlyOfficeAppUrl,
  onlyOfficeJwtSecret: config.onlyOfficeJwtSecret,
};

beforeEach(() => {
  config.onlyOfficePublicUrl = "http://127.0.0.1:8080";
  config.onlyOfficeInternalUrl = "http://127.0.0.1:8080";
  config.onlyOfficeAppUrl = "http://host.docker.internal:3001";
  config.onlyOfficeJwtSecret = "test-onlyoffice-secret";
});

afterEach(() => {
  Object.assign(config, original);
  vi.unstubAllGlobals();
});

describe("ONLYOFFICE integration security", () => {
  it("stays disabled until every runtime URL and JWT setting is present", () => {
    expect(onlyOfficeEnabled()).toBe(true);
    config.onlyOfficeJwtSecret = null;
    expect(onlyOfficeEnabled()).toBe(false);
  });

  it("signs a fill-forms editor config for the exact immutable version", () => {
    const result = onlyOfficeEditorConfig({ draftId: "draft-1", version: 3, sha256: "a".repeat(64), title: "Demand" });
    const document = result.config.document as { key: string; url: string; permissions: Record<string, boolean> };
    expect(document.key).toContain("draft-1-v3");
    expect(document.url).toContain("/draft-1/versions/3/document.docx?access=");
    expect(document.permissions).toMatchObject({ edit: false, fillForms: true, modifyContentControl: false });
    expect(verifyOnlyOfficeToken(result.config.token as string)).toMatchObject({ documentType: "word" });
  });

  it("rejects a tampered, expired, or wrong-scope access token", () => {
    const valid = signOnlyOfficeToken({ scope: "document", draftId: "draft-1", version: 3 });
    expect(() => requireScopedAccess(valid, "callback", "draft-1", 3)).toThrow("does not match");
    expect(() => verifyOnlyOfficeToken(`${valid.slice(0, -1)}x`)).toThrow("signature");
    expect(() => verifyOnlyOfficeToken(signOnlyOfficeToken({ scope: "document" }, -1))).toThrow("Expired");
  });

  it("accepts saved-document downloads only from the configured document server", () => {
    expect(allowedOnlyOfficeDownload("http://127.0.0.1:8080/cache/files/saved.docx")).toBe(true);
    expect(allowedOnlyOfficeDownload("http://127.0.0.1:8081/cache/files/saved.docx")).toBe(false);
    expect(allowedOnlyOfficeDownload("https://attacker.example/saved.docx")).toBe(false);
    expect(allowedOnlyOfficeDownload("not a url")).toBe(false);
  });

  it("signs and sends a force-save command for the same document key", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ error: 0, key: "ok" }) });
    vi.stubGlobal("fetch", fetchMock);
    await requestOnlyOfficeForceSave({ draftId: "draft-1", version: 3, sha256: "a".repeat(64) });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/command?shardkey=draft-1-v3-");
    const body = JSON.parse(init.body as string) as { c: string; key: string; token: string };
    expect(body).toMatchObject({ c: "forcesave", key: expect.stringContaining("draft-1-v3-") });
    expect(verifyOnlyOfficeToken(body.token)).toMatchObject({ c: "forcesave", key: body.key });
    expect(fetchMock.mock.calls[1]?.[0]).toBe("http://127.0.0.1:8080/coauthoring/CommandService.ashx");
  });

  it("reports an unavailable document-server command service", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED")));
    await expect(requestOnlyOfficeForceSave({ draftId: "draft-1", version: 3, sha256: "a".repeat(64) }))
      .rejects.toThrow("ECONNREFUSED");
  });
});
