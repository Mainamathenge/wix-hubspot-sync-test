import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';

function getKey() {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(hex, 'hex');
}

/** Encrypt a plaintext string -> "ciphertext:iv:authTag" (all base64). */
export function encrypt(plaintext) {
  if (plaintext == null) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [ciphertext.toString('base64'), iv.toString('base64'), authTag.toString('base64')].join(':');
}

/** Decrypt a "ciphertext:iv:authTag" blob back to plaintext. */
export function decrypt(blob) {
  if (blob == null) return null;
  const [ct, iv, tag] = blob.split(':');
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64')), decipher.final()]).toString('utf8');
}
