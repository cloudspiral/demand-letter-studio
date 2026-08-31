import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config";

const safeFilename = (filename: string) => filename.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");

export async function putFile(buffer: Buffer, filename: string): Promise<{ key: string; sha256: string; path: string }> {
  const sha256 = crypto.createHash("sha256").update(buffer).digest("hex");
  const key = `${sha256.slice(0, 2)}/${sha256}-${safeFilename(filename)}`;
  const target = path.join(config.storageDir, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, buffer, { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  return { key, sha256, path: target };
}

export function pathForKey(key: string): string {
  const resolved = path.resolve(config.storageDir, key);
  if (!resolved.startsWith(path.resolve(config.storageDir) + path.sep)) throw new Error("Invalid storage key");
  return resolved;
}

export async function readFile(key: string): Promise<Buffer> {
  return fs.readFile(pathForKey(key));
}
