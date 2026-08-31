import crypto from "crypto";

const BASE32_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Encodes a buffer to Base32 string (RFC 4648).
 */
export const base32Encode = (buffer) => {
  let bits = 0;
  let value = 0;
  let output = "";

  for (let i = 0; i < buffer.length; i++) {
    value = (value << 8) | buffer[i];
    bits += 8;

    while (bits >= 5) {
      output += BASE32_CHARS[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_CHARS[(value << (5 - bits)) & 31];
  }

  return output;
};

/**
 * Decodes a Base32 string back to Buffer.
 */
export const base32Decode = (input) => {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes = [];

  for (let i = 0; i < cleaned.length; i++) {
    const idx = BASE32_CHARS.indexOf(cleaned[i]);
    if (idx === -1) continue;

    value = (value << 5) | idx;
    bits += 5;

    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
};

/**
 * Generates a cryptographically secure 20-byte Base32 TOTP secret.
 */
export const generateTotpSecret = () => {
  const randomBytes = crypto.randomBytes(20);
  return base32Encode(randomBytes);
};

/**
 * Calculates RFC 6238 TOTP code for a given secret and counter.
 */
export const generateTotpCode = (secret, timeStep = Math.floor(Date.now() / 1000 / 30)) => {
  const key = base32Decode(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigInt64BE(BigInt(timeStep), 0);

  const hmac = crypto.createHmac("sha1", key);
  hmac.update(counterBuffer);
  const digest = hmac.digest();

  const offset = digest[digest.length - 1] & 0xf;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);

  const otp = binary % 1000000;
  return String(otp).padStart(6, "0");
};

/**
 * Verifies a 6-digit TOTP code against a secret with ±1 step (30s) drift tolerance.
 */
export const verifyTotpCode = (token, secret) => {
  if (!token || !secret) return false;
  const cleanToken = String(token).trim();
  if (!/^\d{6}$/.test(cleanToken)) return false;

  const currentStep = Math.floor(Date.now() / 1000 / 30);
  for (let offset = -1; offset <= 1; offset++) {
    const expected = generateTotpCode(secret, currentStep + offset);
    if (crypto.timingSafeEqual(Buffer.from(cleanToken), Buffer.from(expected))) {
      return true;
    }
  }
  return false;
};

/**
 * Generates a list of 8 random backup codes and their SHA-256 hashes.
 */
export const generateBackupCodes = (count = 8) => {
  const plainCodes = [];
  const hashedCodes = [];

  for (let i = 0; i < count; i++) {
    const code = crypto.randomBytes(4).toString("hex").toUpperCase(); // 8-char hex code e.g. "A1B2C3D4"
    const hash = crypto.createHash("sha256").update(code).digest("hex");
    plainCodes.push(code);
    hashedCodes.push({ codeHash: hash, used: false });
  }

  return { plainCodes, hashedCodes };
};

/**
 * Verifies and consumes a backup code.
 */
export const verifyBackupCode = (code, storedBackupCodes = []) => {
  if (!code || typeof code !== "string") return { valid: false };
  const cleanCode = code.trim().toUpperCase();
  const hash = crypto.createHash("sha256").update(cleanCode).digest("hex");

  const codeIndex = storedBackupCodes.findIndex(
    (item) => !item.used && item.codeHash === hash
  );

  if (codeIndex === -1) {
    return { valid: false };
  }

  return { valid: true, index: codeIndex };
};
