import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config, ensureDataDir } from "../config.js";

const PREFIX = "v1";

let cachedKey: Buffer | null = null;

function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const fromEnv = process.env.ADS_ENCRYPTION_KEY;
  if (fromEnv) {
    cachedKey = parseKey(fromEnv);
    return cachedKey;
  }
  ensureDataDir();
  const keyFile = path.join(config.dataDir, ".adsmarch.key");
  if (fs.existsSync(keyFile)) {
    cachedKey = parseKey(fs.readFileSync(keyFile, "utf8").trim());
    return cachedKey;
  }
  const generated = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, generated.toString("base64"), { mode: 0o600 });
  console.error(
    `[adsmarch] No ADS_ENCRYPTION_KEY set. Generated a local key at ${keyFile}. ` +
      "Set ADS_ENCRYPTION_KEY in production so credentials survive redeploys.",
  );
  cachedKey = generated;
  return cachedKey;
}

function parseKey(raw: string): Buffer {
  const trimmed = raw.trim();
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return Buffer.from(trimmed, "hex");
  const buf = Buffer.from(trimmed, "base64");
  if (buf.length !== 32) {
    throw new Error("ADS_ENCRYPTION_KEY must be a 32-byte key encoded as base64 or 64-char hex.");
  }
  return buf;
}

export function encryptJson(value: unknown): string {
  const key = loadKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [PREFIX, iv.toString("base64"), tag.toString("base64"), encrypted.toString("base64")].join(":");
}

export function decryptJson<T = unknown>(payload: string): T {
  const parts = payload.split(":");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("Unrecognized encrypted payload format.");
  const [, ivB64, tagB64, dataB64] = parts as [string, string, string, string];
  const key = loadKey();
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return JSON.parse(decrypted.toString("utf8")) as T;
}
