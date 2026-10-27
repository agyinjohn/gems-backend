const crypto = require('crypto');

/**
 * Encrypt small secrets (a person's authenticator key) before they are stored,
 * so a copy of the database alone does not hand out their second factor.
 * AES-256-GCM; the key comes from TWOFA_ENC_KEY, falling back to JWT_SECRET.
 */
const key = () => {
  const raw = process.env.TWOFA_ENC_KEY || process.env.JWT_SECRET;
  if (!raw) throw new Error('JWT_SECRET (or TWOFA_ENC_KEY) must be set.');
  return crypto.createHash('sha256').update(raw).digest();
};

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

function decrypt(blob) {
  const [iv, tag, enc] = String(blob).split('.').map((s) => Buffer.from(s, 'base64'));
  const d = crypto.createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt };
