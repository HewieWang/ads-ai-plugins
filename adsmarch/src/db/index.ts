import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config, ensureDataDir } from "../config.js";

let instance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (instance) return instance;
  ensureDataDir();
  const db = new DatabaseSync(config.dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  const schemaPath = new URL("./schema.sql", import.meta.url);
  db.exec(fs.readFileSync(schemaPath, "utf8"));
  instance = db;
  return db;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function genId(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Keep the SQLite file path short and make it easy to swap to MySQL later. */
export function dbFileInfo(): { path: string; sizeBytes: number } {
  ensureDataDir();
  try {
    const stat = fs.statSync(config.dbPath);
    return { path: config.dbPath, sizeBytes: stat.size };
  } catch {
    return { path: config.dbPath, sizeBytes: 0 };
  }
}

export function dataFilePath(name: string): string {
  return path.join(config.dataDir, name);
}
