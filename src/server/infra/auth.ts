// Password hashing and signed, expiring session tokens for cookie authentication.
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import type { StoredAuth } from "./config.js";

const scrypt = promisify(scryptCallback);
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface SessionPayload {
  iat: number;
  exp: number;
  nonce: string;
}

// Derive a scrypt password hash with the given salt and return both parts.
export async function hashPassword(password: string, salt = randomBytes(16).toString("base64url")) {
  validatePassword(password);
  const derived = (await scrypt(password, Buffer.from(salt, "base64url"), 64)) as Buffer;
  return { passwordSalt: salt, passwordHash: derived.toString("base64url") };
}

// Compare a password against the stored scrypt hash in constant time.
export async function verifyPassword(password: string, auth: StoredAuth): Promise<boolean> {
  try {
    const expected = Buffer.from(auth.passwordHash, "base64url");
    const actual = (await scrypt(password, Buffer.from(auth.passwordSalt, "base64url"), expected.length)) as Buffer;
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// Issue a signed session token that expires after the configured session lifetime.
export function createSessionToken(auth: StoredAuth, now = Date.now()): string {
  const payload: SessionPayload = {
    iat: now,
    exp: now + SESSION_TTL_MS,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${encoded}.${sign(encoded, auth.sessionSecret)}`;
}

// Check the token's signature, shape, and expiry against the stored secret.
export function verifySessionToken(token: string | undefined, auth: StoredAuth, now = Date.now()): boolean {
  if (!token) return false;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) return false;
  const expected = Buffer.from(sign(encoded, auth.sessionSecret));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  try {
    const payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as SessionPayload;
    return Number.isFinite(payload.iat) && payload.iat <= now && payload.exp > now && Boolean(payload.nonce);
  } catch {
    return false;
  }
}

// Generate a fresh random secret for signing session tokens.
export function newSessionSecret(): string {
  return randomBytes(48).toString("base64url");
}

// Enforce the minimum and maximum login password lengths.
export function validatePassword(password: string): void {
  if (password.length < 10) throw new Error("Access password must be at least 10 characters");
  if (password.length > 256) throw new Error("Access password is too long");
}

// Compute the HMAC-SHA256 signature of a value with the given secret.
function sign(value: string, secret: string): string {
  return createHmac("sha256", Buffer.from(secret, "base64url")).update(value).digest("base64url");
}
