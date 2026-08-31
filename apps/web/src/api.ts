let demoToken: string | null = null;

export function setDemoToken(token: string | null) {
  demoToken = token;
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData) && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (demoToken) headers.set("x-demo-token", demoToken);
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

export async function download(path: string): Promise<{ blob: Blob; filename: string }> {
  const headers = new Headers();
  if (demoToken) headers.set("x-demo-token", demoToken);
  const response = await fetch(path, { headers });
  if (!response.ok) throw new Error(`Download failed (${response.status})`);
  const disposition = response.headers.get("content-disposition") ?? "";
  const filename = /filename="([^"]+)"/.exec(disposition)?.[1] ?? "demand-letter.docx";
  return { blob: await response.blob(), filename };
}
