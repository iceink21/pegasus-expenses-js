// Password and setup-code hashing (node:crypto scrypt, no extra dependency).
//
// Stored format: "scrypt$N$r$p$<salt b64url>$<key b64url>". The cost
// parameters travel with each hash, so verification always uses the cost the
// hash was made with and the default can be raised later without breaking
// existing accounts.
//
// Setup codes are hashed the same way. They carry ~49.5 bits of entropy, expire
// after 72 h and are single-use, so a fast hash would arguably do; scrypt is
// used anyway because then every login — password or setup code, known or
// unknown user — costs exactly one scrypt verification, and the response time
// says nothing about which case it was.
//
// Nothing in this module logs, and no error it throws carries the secret.

import crypto from "node:crypto";
import { promisify } from "node:util";

import { HttpError } from "./http-error.js";

const scryptAsync = promisify(crypto.scrypt);

export const DEFAULT_SCRYPT_N = 2 ** 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
// 128 * N * r = 32 MiB at the default cost; 64 MiB leaves headroom.
const SCRYPT_MAXMEM = 64 * 1024 * 1024;
const PREFIX = "scrypt";

export const PASSWORD_MIN_CHARS = 10;
export const PASSWORD_MAX_CHARS = 128;

// Setup codes: no 0/O, 1/I/L — read aloud or copied from a phone screen.
export const SETUP_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export const SETUP_CODE_LENGTH = 10;

// Only passwords of PASSWORD_MIN_CHARS or more can ever reach this check, so the
// list holds the common ones that are at least that long.
const COMMON_PASSWORDS = new Set([
  "0123456789",
  "1234567890",
  "12345678910",
  "123456789a",
  "1234567890a",
  "0987654321",
  "1111111111",
  "1q2w3e4r5t",
  "1qaz2wsx3edc",
  "a123456789",
  "aa12345678",
  "abc1234567",
  "abcd123456",
  "abcdefghij",
  "administrator",
  "admin12345",
  "admin123456",
  "changeme123",
  "football123",
  "iloveyou12",
  "letmein123",
  "password01",
  "password1!",
  "password12",
  "password123",
  "password1234",
  "passw0rd123",
  "pegasus123",
  "pegasus1234",
  "pegasus2026",
  "pegasus2027",
  "pegasusuav",
  "qazwsxedc123",
  "qwerty1234",
  "qwerty12345",
  "qwerty123456",
  "qwertyuiop",
  "qwertyuiop1",
  "q1w2e3r4t5",
  "superman123",
  "welcome123",
  "zaq12wsxcde",
]);

function b64(buffer) {
  return buffer.toString("base64url");
}

/** NFC so the same password typed on two keyboards hashes the same. */
function normalizeSecret(secret) {
  return String(secret).normalize("NFC");
}

async function derive(secret, salt, { N, r, p }) {
  return scryptAsync(normalizeSecret(secret), salt, KEY_BYTES, { N, r, p, maxmem: SCRYPT_MAXMEM });
}

function parseHash(stored) {
  if (typeof stored !== "string") return null;
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== PREFIX) return null;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (![N, r, p].every((value) => Number.isSafeInteger(value) && value > 0)) return null;
  const salt = Buffer.from(parts[4], "base64url");
  const key = Buffer.from(parts[5], "base64url");
  if (salt.length === 0 || key.length === 0) return null;
  return { N, r, p, salt, key };
}

/**
 * Hasher bound to one scrypt cost. Production always uses DEFAULT_SCRYPT_N;
 * the test suite lowers N through settings so it runs in seconds.
 */
export function createPasswordHasher({ scryptN = DEFAULT_SCRYPT_N } = {}) {
  const params = { N: scryptN, r: SCRYPT_R, p: SCRYPT_P };
  let dummyHash = null;

  async function hash(secret) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const key = await derive(secret, salt, params);
    return [PREFIX, params.N, params.r, params.p, b64(salt), b64(key)].join("$");
  }

  /** Synchronous hash, for the one-off admin bootstrap inside the sync app factory. */
  function hashSync(secret) {
    const salt = crypto.randomBytes(SALT_BYTES);
    const key = crypto.scryptSync(normalizeSecret(secret), salt, KEY_BYTES, { ...params, maxmem: SCRYPT_MAXMEM });
    return [PREFIX, params.N, params.r, params.p, b64(salt), b64(key)].join("$");
  }

  /** Constant-time verify. A malformed stored value is a mismatch, not an error. */
  async function verify(secret, stored) {
    const parsed = parseHash(stored);
    if (!parsed) {
      await burn();
      return false;
    }
    const key = await scryptAsync(normalizeSecret(secret), parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return crypto.timingSafeEqual(key, parsed.key);
  }

  /**
   * Spend one verification's worth of work and fail. Used for unknown users
   * and accounts without a usable credential, so they cost the same as a
   * wrong password.
   */
  async function burn() {
    if (dummyHash === null) dummyHash = await hash(crypto.randomBytes(16).toString("hex"));
    const parsed = parseHash(dummyHash);
    await scryptAsync("x", parsed.salt, parsed.key.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: SCRYPT_MAXMEM,
    });
    return false;
  }

  return Object.freeze({ params: Object.freeze({ ...params }), hash, hashSync, verify, burn });
}

/**
 * Throws HttpError(400, code) when `password` breaks the policy: 10–128
 * characters, not the username, not on the common list. No composition rules.
 */
export function checkPasswordPolicy(password, username = "") {
  if (typeof password !== "string" || password === "") throw new HttpError(400, "password_required");
  const normalized = normalizeSecret(password);
  const length = [...normalized].length;
  if (length < PASSWORD_MIN_CHARS) throw new HttpError(400, "password_too_short");
  if (length > PASSWORD_MAX_CHARS) throw new HttpError(400, "password_too_long");
  const lowered = normalized.toLowerCase();
  if (username && lowered === String(username).toLowerCase()) {
    throw new HttpError(400, "password_same_as_username");
  }
  // One character repeated ("aaaaaaaaaa") is as weak as anything on the list.
  if (COMMON_PASSWORDS.has(lowered) || new Set(lowered).size === 1) {
    throw new HttpError(400, "password_too_common");
  }
}

/** A fresh one-time setup code, formatted XXXXX-XXXXX for reading aloud. */
export function generateSetupCode() {
  const chars = [];
  for (let i = 0; i < SETUP_CODE_LENGTH; i += 1) {
    chars.push(SETUP_CODE_ALPHABET[crypto.randomInt(SETUP_CODE_ALPHABET.length)]);
  }
  const half = SETUP_CODE_LENGTH / 2;
  return chars.slice(0, half).join("") + "-" + chars.slice(half).join("");
}

const NOT_CODE_CHARS = /[^0-9A-Z]/g;

/** Typed setup code → canonical form: upper-case, separators and spaces dropped. */
export function normalizeSetupCode(typed) {
  return String(typed ?? "").toUpperCase().replace(NOT_CODE_CHARS, "");
}
