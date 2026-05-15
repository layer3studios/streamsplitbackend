/**
 * Shared AES-256-CBC encryption utility.
 * Uses a SINGLE key source to prevent encrypt/decrypt mismatches across modules.
 */
const crypto = require('crypto');

const IV_LENGTH = 16;

// Use one deterministic key. In production, VAULT_ENCRYPTION_KEY MUST be set.
let ENCRYPTION_KEY = process.env.VAULT_ENCRYPTION_KEY;

if (!ENCRYPTION_KEY) {
  // Dev fallback: generate once per process and warn loudly.
  ENCRYPTION_KEY = crypto.randomBytes(32).toString('hex');
  console.warn('⚠️  VAULT_ENCRYPTION_KEY not set — using ephemeral key. Encrypted data will NOT survive restarts!');
}

function encryptText(text) {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString('hex') + ':' + encrypted.toString('hex');
}

function decryptText(text) {
  const textParts = text.split(':');
  const iv = Buffer.from(textParts.shift(), 'hex');
  const encryptedText = Buffer.from(textParts.join(':'), 'hex');
  const decipher = crypto.createDecipheriv('aes-256-cbc', Buffer.from(ENCRYPTION_KEY, 'hex'), iv);
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

module.exports = { encryptText, decryptText };
