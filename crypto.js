// crypto.js – Envelope Encryption Utilities
const ENC = new TextEncoder();
const DEC = new TextDecoder();

// 1. Derive MASTER KEY (MK) from Password (RAM only)
export async function deriveMasterKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    ENC.encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    {
      name: 'PBKDF2',
      salt,
      iterations: 600_000,
      hash: 'SHA-256',
    },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false, // Master Key is NOT exportable (security)
    ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey']
  );
}

// 2. Generate Random DATA KEY (DK) (One time, upon signup)
export async function generateDataKey() {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, // Must be exportable to wrap it
    ["encrypt", "decrypt"]
  );
}

// 3. Helpers to Convert Key <-> String (For storage in Session)
export async function exportKeyToString(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return arrayToB64(new Uint8Array(raw));
}

export async function importKeyFromString(str) {
  const raw = b64ToArray(str);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

// 4. Wrap/Unwrap Logic (The Envelope)
export async function wrapDataKey(dataKey, masterKey) {
  // Export DK to raw bytes
  const rawDataKey = await crypto.subtle.exportKey('raw', dataKey);
  // Encrypt the raw bytes with MK
  return await encryptBlobRaw(rawDataKey, masterKey);
}

export async function unwrapDataKey(wrappedBlob, masterKey) {
  // Decrypt the blob with MK
  const rawDataKey = await decryptBlobRaw(wrappedBlob, masterKey);
  // Import bytes back to CryptoKey
  return await crypto.subtle.importKey('raw', rawDataKey, 'AES-GCM', true, ['encrypt', 'decrypt']);
}

// 5. Session Storage (Stores the DATA KEY, not the password key)
export function storeDataKeyInSession(keyStr) {
  sessionStorage.setItem('dataKey', keyStr);
}

export async function loadDataKeyFromSession() {
  const str = sessionStorage.getItem('dataKey');
  if (!str) return null;
  return importKeyFromString(str);
}

// 6. Standard Encryption (Used for Files AND for Wrapping Keys)
// Modified to handle both Strings (notes) and Uint8Arrays (keys)
export async function encryptBlob(content, key) {
  const plaintext = (typeof content === 'string') ? ENC.encode(content) : content;
  return encryptBlobRaw(plaintext, key);
}

async function encryptBlobRaw(dataUint8, key) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, dataUint8);
  const ctArray = new Uint8Array(ciphertext);
  const authTag = ctArray.slice(-16);
  const cipher = ctArray.slice(0, -16);
  return { iv, authTag, ciphertext: cipher };
}

export async function decryptBlob({ iv, authTag, ciphertext }, key) {
  const plainBuffer = await decryptBlobRaw({ iv, authTag, ciphertext }, key);
  return DEC.decode(plainBuffer);
}

async function decryptBlobRaw({ iv, authTag, ciphertext }, key) {
  const buffer = new Uint8Array(ciphertext.byteLength + authTag.byteLength);
  buffer.set(ciphertext, 0);
  buffer.set(authTag, ciphertext.byteLength);
  return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buffer);
}

export function randomSalt() {
  return crypto.getRandomValues(new Uint8Array(16));
}

export const arrayToB64 = arr => btoa(String.fromCharCode(...arr))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
export const b64ToArray = str => {
  if (!str) return new Uint8Array(0);
  return Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
};


// 1. Generate a random AES-GCM key for sharing
export async function generateShareKey() {
  return await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true, 
    ["encrypt", "decrypt"]
  );
}

// 2. Export Key to URL-safe Base64 (for the link fragment)
export async function exportKeyToUrl(key) {
  const raw = await crypto.subtle.exportKey('raw', key);
  return arrayToB64(new Uint8Array(raw));
}

// 3. Import Key from URL-safe Base64
export async function importKeyFromUrl(str) {
  const raw = b64ToArray(str);
  return await crypto.subtle.importKey(
    'raw', 
    raw, 
    'AES-GCM', 
    true, 
    ['encrypt', 'decrypt']
  );
}
