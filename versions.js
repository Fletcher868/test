// versions.js
// New module for handling note version snapshots (end-to-end encrypted, auto-save on blur only when changed)

import { encryptBlob, decryptBlob, arrayToB64, b64ToArray } from './crypto.js';

/**
 * Save a new encrypted version snapshot.
 * Only called when content actually changed.
 * @param {PocketBase} pb 
 * @param {CryptoKey} derivedKey 
 * @param {string} fileId 
 * @param {string} content 
 */
export async function createVersionSnapshot(pb, derivedKey, fileId, content) {
  try {
    const { ciphertext, iv, authTag } = await encryptBlob(content, derivedKey);

    await pb.collection('versions').create({
      file: fileId,
      user: pb.authStore.model.id,
      encryptedBlob: arrayToB64(ciphertext),
      iv: arrayToB64(iv),
      authTag: arrayToB64(authTag),
    });
    
    console.log('Version snapshot saved for file:', fileId);
  } catch (err) {
    console.error('Failed to save version snapshot:', err);
    // Silent fail – user still has auto-save on main file
  }
}

/**
 * Load & decrypt all versions for a file (sorted newest → oldest)
 * @param {PocketBase} pb 
 * @param {CryptoKey} derivedKey 
 * @param {string} fileId 
 * @returns {Array<{id:string, created:string, content:string}>}
 */
export async function getVersions(pb, derivedKey, fileId) {
  try {
    const records = await pb.collection('versions').getFullList({
      filter: `file = "${fileId}"`,
      sort: '-created',
    });

    return await Promise.all(
      records.map(async (r) => {
        let content = '[Decryption failed]';
        try {
          content = await decryptBlob(
            {
              iv: b64ToArray(r.iv),
              authTag: b64ToArray(r.authTag),
              ciphertext: b64ToArray(r.encryptedBlob),
            },
            derivedKey
          );
        } catch (decErr) {
          console.error('Version decryption error:', decErr);
        }
        return {
          id: r.id,
          created: r.created,
          content,
        };
      })
    );
  } catch (err) {
    console.error('Failed to load versions:', err);
    return [];
  }
}

/**
 * Delete all versions for a file (when file is deleted)
 * @param {PocketBase} pb 
 * @param {string} fileId 
 */
export async function deleteFileVersions(pb, fileId) {
  try {
    const versions = await pb.collection('versions').getFullList({
      filter: `file = "${fileId}"`
    });
    
    for (const version of versions) {
      await pb.collection('versions').delete(version.id);
    }
    
    console.log(`Deleted ${versions.length} versions for file:`, fileId);
  } catch (err) {
    console.error('Failed to delete file versions:', err);
  }
}
