import { mkdir, writeFile, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

/**
 * Local-disk object storage.
 *
 * The architecture specifies S3-compatible storage in af-south-1 (§17). This
 * is a drop-in stand-in with the same three operations, so tomorrow's test run
 * against real photographs exercises the real pipeline — inspect, derive,
 * segment, persist — without needing an AWS account live by morning. Swapping
 * this for the S3 adapter later is a one-file change; no caller above this
 * line knows the difference.
 */

const ROOT = process.env.STORAGE_ROOT ?? join(process.cwd(), "storage");

export function randomKey(prefix: string, ext: string): string {
  return `${prefix}/${randomBytes(16).toString("hex")}.${ext}`;
}

export async function putObject(key: string, data: Buffer): Promise<void> {
  const path = join(ROOT, key);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, data);
}

export async function getObject(key: string): Promise<Buffer> {
  return readFile(join(ROOT, key));
}

/** The URL the browser fetches. Served by the static route in server.ts. */
export function publicUrl(key: string): string {
  return `/storage/${key}`;
}
