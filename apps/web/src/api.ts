export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body != null && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; detail?: string };
    throw new Error(body.detail ?? body.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function upload<T>(path: string, files: File[]): Promise<T> {
  const form = new FormData();
  files.forEach((file) => form.append("files", file));
  return api<T>(path, { method: "POST", body: form });
}

export async function streamEvent<T>(path: string, eventName: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "text/event-stream");
  if (init?.body != null && !(init.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(path, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: response.statusText })) as { error?: string; detail?: string };
    throw new Error(body.detail ?? body.error ?? `Request failed (${response.status})`);
  }
  if (!response.body) throw new Error("The streaming response did not include a body.");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const frames = buffer.split(/\r?\n\r?\n/);
    buffer = frames.pop() ?? "";
    for (const frame of frames) {
      const event = frame.split(/\r?\n/).find((line) => line.startsWith("event:"))?.slice(6).trim();
      const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart()).join("\n");
      if (event === "failed") {
        const failure = data ? JSON.parse(data) as { error?: string } : {};
        throw new Error(failure.error ?? "Streaming request failed.");
      }
      if (event === eventName && data) return JSON.parse(data) as T;
    }
    if (done) break;
  }
  throw new Error(`The stream ended before the ${eventName} event arrived.`);
}
