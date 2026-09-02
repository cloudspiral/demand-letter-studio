import { afterEach, describe, expect, it, vi } from "vitest";
import { api, streamEvent } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("SSE client", () => {
  it("requests event-stream transport and returns the named event", async () => {
    const fetchMock = vi.fn(async (_path: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("Accept")).toBe("text/event-stream");
      return new Response([
        "event: status\ndata: {\"step\":\"Generating proposal\"}\n\n",
        "event: proposal\ndata: {\"id\":\"proposal-1\"}\n\n",
      ].join(""), { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(streamEvent<{ id: string }>("/refine", "proposal", {
      method: "POST",
      body: "{}",
    })).resolves.toEqual({ id: "proposal-1" });
  });

  it("surfaces a failed stream event", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "event: failed\ndata: {\"error\":\"Refinement failed\"}\n\n",
      { status: 200, headers: { "Content-Type": "text/event-stream" } },
    )));
    await expect(streamEvent("/refine", "proposal", { method: "POST", body: "{}" }))
      .rejects.toThrow("Refinement failed");
  });
});

describe("JSON client", () => {
  it("does not declare a JSON content type for a bodyless request", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_path: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).has("Content-Type")).toBe(false);
      return new Response('{"removed":true}', { status: 200, headers: { "Content-Type": "application/json" } });
    }));

    await expect(api<{ removed: boolean }>("/templates/template-1", { method: "DELETE" }))
      .resolves.toEqual({ removed: true });
  });
});
