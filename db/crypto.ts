import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const DEV_KEY = createHash("sha256").update("slop-bot-local-development-only").digest();

function encryptionKey(): Buffer {
  const encoded = process.env.TOKEN_ENCRYPTION_KEY;
  if (encoded) {
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new Error("TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes.");
    return key;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("TOKEN_ENCRYPTION_KEY is required in production.");
  }
  return DEV_KEY;
}

export function encryptSecret(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64url")}.${tag.toString("base64url")}.${encrypted.toString("base64url")}`;
}

export function decryptSecret<T>(value: string): T {
  const [version, iv, tag, encrypted] = value.split(".");
  if (version !== "v1" || !iv || !tag || !encrypted) throw new Error("Invalid encrypted secret.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(encrypted, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  return JSON.parse(plaintext) as T;
}
