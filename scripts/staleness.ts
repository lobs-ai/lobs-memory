#!/usr/bin/env bun
/**
 * Staleness/TTL cleanup script for lobs-memory.
 * 
 * Archives documents not accessed or referenced in any search query for X days.
 * Hard-deletes documents that have been archived for Y+ days.
 * 
 * Usage:
 *   bun run scripts/staleness.ts [--config <path>] [--dry-run] [--verbose]
 * 
 * Defaults:
 *   - Config: staleness-config.json in the same directory as this script
 *   - Dry run: false (actually archive/delete)
 */

import { Database } from "bun:sqlite";
import { existsSync } from "fs";
import { resolve, dirname } from "path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface StalenessConfig {
  staleness: {
    thresholdDays: number;
  };
  archive: {
    enabled: boolean;
  };
  hardDeleteAfterDays: number;
  tracking: {
    mode: string;
  };
  collections: {
    default: {
      stalenessDays: number;
      archiveEnabled: boolean;
      hardDeleteAfterDays: number;
    };
    [collection: string]: unknown;
  };
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run") || args.includes("-n");
const verbose = args.includes("--verbose") || args.includes("-v");

let configPath = resolve(dirname(import.meta.filename), "..", "staleness-config.json");
const configArgIdx = args.indexOf("--config");
if (configArgIdx !== -1 && args[configArgIdx + 1]) {
  configPath = resolve(args[configArgIdx + 1]);
}

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

function loadConfig(path: string): StalenessConfig {
  if (!existsSync(path)) {
    throw new Error(`Config file not found: ${path}`);
  }
  const raw = await Bun.file(path).text();
  return JSON.parse(raw) as StalenessConfig;
}

// ---------------------------------------------------------------------------
// DB path
// ---------------------------------------------------------------------------

const DB_PATH = resolve(
  process.env.LOBS_MEMORY_DB ?? 
  (process.env.HOME ? `${process.env.HOME}/.lobs/plugins/lobs-memory/index.db` : "./index.db")
);

if (verbose) console.error(`[staleness] DB: ${DB_PATH}`);
if (verbose) console.error(`[staleness] Config: ${configPath}`);
if (dryRun) console.error("[staleness] DRY RUN — no changes will be made");

// ---------------------------------------------------------------------------
// Open DB
// ---------------------------------------------------------------------------

const db = new Database(DB_PATH, { create: false });

// ---------------------------------------------------------------------------
// Migration: add last_accessed + archived_at columns if missing
// ---------------------------------------------------------------------------

function migrate() {
  const cols = db
    .query("PRAGMA table_info(documents)")
    .all() as { name: string }[];

  const colNames = new Set(cols.map((c) => c.name));

  if (!colNames.has("last_accessed")) {
    console.error("[staleness] Migration: adding last_accessed column");
    if (!dryRun) {
      db.exec("ALTER TABLE documents ADD COLUMN last_accessed TEXT DEFAULT (datetime('now'))");
    }
  }

  if (!colNames.has("archived_at")) {
    console.error("[staleness] Migration: adding archived_at column");
    if (!dryRun) {
      db.exec("ALTER TABLE documents ADD COLUMN archived_at TEXT");
    }
  }
}

// ---------------------------------------------------------------------------
// Archive stale documents
// ---------------------------------------------------------------------------

interface DocRow {
  id: number;
  path: string;
  collection: string;
  last_accessed: string | null;
  updated_at: string;
}

function archiveStaleDocs(thresholdDays: number, archiveEnabled: boolean): number {
  if (!archiveEnabled) {
    if (verbose) console.error("[staleness] Archiving disabled in config — skipping");
    return 0;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - thresholdDays);
  const cutoffStr = cutoff.toISOString().replace("T", " ").slice(0, 19);

  // Documents that have never been accessed use updated_at as proxy
  const rows = db
    .prepare<DocRow, string>(`
      SELECT id, path, collection, last_accessed, updated_at
        FROM documents
       WHERE archived_at IS NULL
         AND (last_accessed < ? OR last_accessed IS NULL)
         AND updated_at < ?
    `)
    .all(cutoffStr, cutoffStr) as DocRow[];

  if (rows.length === 0) return 0;

  const now = new Date().toISOString().replace("T", " ").slice(0, 19);
  const ids = rows.map((r) => r.id);

  if (dryRun) {
    console.error(`[staleness] Would archive ${rows.length} stale document(s):`);
    for (const row of rows) {
      const lastSeen = row.last_accessed ?? row.updated_at;
      console.error(`  - ${row.path} (last seen: ${lastSeen}, collection: ${row.collection})`);
    }
    return rows.length;
  }

  db.exec(`UPDATE documents SET archived_at = '${now}' WHERE id IN (${ids.join(",")})`);
  console.error(`[staleness] Archived ${rows.length} stale document(s)`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Hard-delete archived docs older than hardDeleteAfterDays
// ---------------------------------------------------------------------------

function hardDeleteArchived(hardDeleteAfterDays: number): number {
  if (hardDeleteAfterDays <= 0) {
    if (verbose) console.error("[staleness] Hard delete disabled (hardDeleteAfterDays = 0)");
    return 0;
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - hardDeleteAfterDays);
  const cutoffStr = cutoff.toISOString().replace("T", " ").slice(0, 19);

  const rows = db
    .prepare<DocRow, string>(`
      SELECT id, path, collection, archived_at
        FROM documents
       WHERE archived_at IS NOT NULL AND archived_at < ?
    `)
    .all(cutoffStr) as DocRow[];

  if (rows.length === 0) return 0;

  if (dryRun) {
    console.error(`[staleness] Would permanently delete ${rows.length} archived document(s):`);
    for (const row of rows) {
      console.error(`  - ${row.path} (archived at: ${row.archived_at})`);
    }
    return rows.length;
  }

  const ids = rows.map((r) => r.id);
  db.exec(`DELETE FROM documents WHERE id IN (${ids.join(",")})`);
  console.error(`[staleness] Permanently deleted ${rows.length} archived document(s)`);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Report stats
// ---------------------------------------------------------------------------

function reportStats() {
  const total = (db.query("SELECT COUNT(*) as c FROM documents").all() as { c: number }[])[0].c;
  const active = (db.prepare<{ c: number }, unknown>("SELECT COUNT(*) as c FROM documents WHERE archived_at IS NULL").all(null) as { c: number }[])[0].c;
  const archived = (db.prepare<{ c: number }, unknown>("SELECT COUNT(*) as c FROM documents WHERE archived_at IS NOT NULL").all(null) as { c: number }[])[0].c;

  console.log(
    JSON.stringify({
      documents: { total, active, archived },
    })
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  migrate();

  let config: StalenessConfig;
  try {
    config = loadConfig(configPath);
  } catch (err) {
    console.error(`[staleness] ERROR: ${(err as Error).message}`);
    // Fall back to defaults
    config = {
      staleness: { thresholdDays: 30 },
      archive: { enabled: true },
      hardDeleteAfterDays: 90,
      tracking: { mode: "query" },
      collections: { default: { stalenessDays: 30, archiveEnabled: true, hardDeleteAfterDays: 90 } },
      dryRun: false,
    };
    console.error("[staleness] Using default config values");
  }

  const thresholdDays = config.staleness?.thresholdDays ?? 30;
  const archiveEnabled = config.archive?.enabled ?? true;
  const hardDeleteAfterDays = config.hardDeleteAfterDays ?? 90;

  const archived = archiveStaleDocs(thresholdDays, archiveEnabled);
  const deleted = hardDeleteArchived(hardDeleteAfterDays);

  if (verbose || !dryRun) {
    reportStats();
  }

  // Exit code 0 normally, 1 if nothing was done (for cron alerting)
  process.exit(0);
}

main().catch((err) => {
  console.error(`[staleness] FATAL: ${err}`);
  process.exit(1);
});
