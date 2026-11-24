import { readdir, stat, statfs, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import type { Pool } from "pg";
import { storageRoot } from "../lib/storage/local.js";

/**
 * Photo storage: how full it is, and getting back space nothing uses.
 *
 * On 2026-11-24 the 500 MB production volume filled up mid-import: a restart
 * lost the in-memory record of two uploaded batches, their files stayed on
 * disk with nothing pointing at them, and every later batch failed with
 * ENOSPC. Two defences live here: the importer checks free space before it
 * accepts photos, and a sweep removes files no row refers to.
 */

export interface DiskStatus { totalBytes: number; freeBytes: number; usedBytes: number; usedPct: number }

export async function diskStatus(): Promise<DiskStatus | null> {
  try {
    const s = await statfs(storageRoot());
    const total = s.blocks * s.bsize;
    const free = s.bavail * s.bsize;
    const used = Math.max(0, total - free);
    return { totalBytes: total, freeBytes: free, usedBytes: used, usedPct: total ? Math.round((used / total) * 100) : 0 };
  } catch {
    return null;
  }
}

/** Space a batch will take: the original plus its watermarked preview and thumbnail, with headroom. */
export function bytesNeeded(uploadBytes: number): number {
  return Math.ceil(uploadBytes * 1.15) + 20 * 1024 * 1024;
}

export function storageFullMessage(free: number, need: number): string {
  const mb = (b: number) => (b >= 1e9 ? (b / 1e9).toFixed(1) + " GB" : Math.round(b / 1e6) + " MB");
  return `Photo storage on the server is full: ${mb(free)} free, and this needs about ${mb(need)}. ` +
    `Increase the storage (Railway → precious-joy-volume) and upload again — nothing already published is affected.`;
}

async function walk(dir: string, out: string[]): Promise<void> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile()) out.push(p);
  }
}

/**
 * Delete stored files that no row refers to.
 *
 * Referenced = every asset original, every variant, and every file still
 * staged for publishing. A file is only removed when it is in none of those
 * AND is older than `minAgeMs` (30 min) — so a batch that is being written right now
 * is never touched. If the database can't be read, nothing is deleted.
 * Staged uploads abandoned for over 14 days are released first.
 */
export async function sweepOrphans(pool: Pool, opts: { minAgeMs?: number; dryRun?: boolean } = {}) {
  const minAge = opts.minAgeMs ?? 30 * 60_000; // longer than any upload request can run
  const root = storageRoot();

  if (!opts.dryRun) {
    await pool.query(
      `update import_file set status = 'failed', failure_reason = 'abandoned: never published'
        where status in ('uploaded','processed') and created_at < now() - interval '14 days'`,
    );
  }
  const refs = await pool.query(
    `select storage_key as k from asset
     union select storage_key from asset_variant
     union select original_key from import_file where status in ('uploaded','processed') and original_key is not null
     union select thumb_key from import_file where status in ('uploaded','processed') and thumb_key is not null
     union select preview_key from import_file where status in ('uploaded','processed') and preview_key is not null`,
  );
  const referenced = new Set(refs.rows.map((r) => r.k as string));
  const assetCount = Number((await pool.query(`select count(*) as n from asset`)).rows[0].n);
  if (assetCount > 0 && referenced.size === 0) throw new Error("sweep aborted: assets exist but no keys were read");

  const files: string[] = [];
  await walk(join(root, "originals"), files);
  await walk(join(root, "variants"), files);

  let deleted = 0, freed = 0;
  const now = Date.now();
  for (const f of files) {
    const key = relative(root, f).split("\\").join("/");
    if (referenced.has(key)) continue;
    const st = await stat(f).catch(() => null);
    if (!st || now - st.mtimeMs < minAge) continue;
    if (!opts.dryRun) await unlink(f).catch(() => {});
    deleted++; freed += st.size;
  }
  return { scanned: files.length, referenced: referenced.size, deleted, freedBytes: freed };
}
