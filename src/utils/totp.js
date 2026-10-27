const crypto = require('crypto');

/**
 * Time-based one-time passwords (RFC 6238) — the six-digit codes an
 * authenticator app shows. Written out rather than pulled in: it is a page of
 * arithmetic, and checked against the RFC's own test vectors.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '')) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 secret');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

const generateSecret = () => base32Encode(crypto.randomBytes(20));

function hotp(secretBuf, counter, digits = 6, algorithm = 'sha1') {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac(algorithm, secretBuf).update(msg).digest();
  const off = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[off] & 0x7f) << 24) | (hmac[off + 1] << 16) | (hmac[off + 2] << 8) | hmac[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

const STEP = 30;
const stepAt = (ms = Date.now()) => Math.floor(ms / 1000 / STEP);

/** The code for a moment in time (tests and the setup page's self-check use it). */
const totp = (secret, ms = Date.now()) => hotp(base32Decode(secret), stepAt(ms));

/**
 * Check a submitted code, allowing one step either side for clock drift.
 * Returns the matched step number (so the caller can refuse a replay of the
 * same code) or null.
 */
function verifyTotp(secret, code, { ms = Date.now(), window = 1 } = {}) {
  const submitted = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(submitted)) return null;
  const key = base32Decode(secret);
  const now = stepAt(ms);
  for (let d = -window; d <= window; d++) {
    const expected = hotp(key, now + d);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(submitted))) return now + d;
  }
  return null;
}

const otpauthUrl = ({ secret, account, issuer = 'GEMS' }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

module.exports = { generateSecret, totp, verifyTotp, otpauthUrl, base32Encode, base32Decode, hotp };
