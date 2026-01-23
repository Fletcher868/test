import { encryptBlob, decryptBlob, arrayToB64, b64ToArray } from './crypto.js';

/**
 * Save a new encrypted version snapshot with Editor Mode.
 * @param {string} editorMode - 'plain' or 'rich'
 */
export async function createVersionSnapshot(pb, derivedKey, fileId, content, editorMode) {
  try {
    const { ciphertext, iv, authTag } = await encryptBlob(content, derivedKey);

    await pb.collection('versions').create({
      file: fileId,
      user: pb.authStore.model.id,
      encryptedBlob: arrayToB64(ciphertext),
      iv: arrayToB64(iv),
      authTag: arrayToB64(authTag),
      editor: editorMode || 'plain' // <--- Save the mode
    });
    
    console.log(`Version saved (${editorMode}) for file:`, fileId);
  } catch (err) {
    console.error('Failed to save version snapshot:', err);
  }
}

/**
 * Load & decrypt all versions for a file
 */
export async function getVersions(pb, derivedKey, fileId, signal) {
  try {
    const records = await pb.collection('versions').getFullList({
      filter: `file = "${fileId}"`,
      sort: '-created',
      signal: signal, 
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
        
        // Return the object INCLUDING the editor mode
        return {
          id: r.id,
          created: r.created,
          content: content,
          editor: r.editor // <--- Retrieve the mode
        };
      })
    );
  } catch (err) {
    if (err.name === 'AbortError' || err.isAbort || (err.status === 0 && err.message.includes('autocancelled'))) {
        throw err;
    }
    console.error('Failed to load versions:', err);
    return [];
  }
}
