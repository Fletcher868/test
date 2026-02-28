// export.js

// Declare the main export logic function outside of setupExport
// so we can reference it to remove the listener later.
let currentExportHandler = null;

// Function to create the self-contained HTML backup file (FINAL CLEAN DESIGN)
function createEncryptedBackupHtml(exportData) {
  
  // =========================================================================
  // CRITICAL: Snippet of essential crypto functions for standalone decryption
  // =========================================================================
  const CRYPTO_SNIPPET = `
    const ENC = new TextEncoder();
    const DEC = new TextDecoder();

    // Utility functions 
    const arrayToB64 = arr => btoa(String.fromCharCode(...arr))
      .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
    const b64ToArray = str => {
      if (!str) return new Uint8Array(0);
      return Uint8Array.from(atob(str.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    };

    // --- FIX: HTML Escaping Utility ---
    const escapeHTML = str => {
        if (!str) return "";
        return str.replace(/[&<>"']/g, m => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[m]));
    };

    // --- NEW: Decrypt a packed name (used for encrypted file names) ---
    async function decryptPacked(packed, key) {
        try {
            const obj = JSON.parse(packed);
            if (obj.i && obj.a && obj.c) {
                const plainBuffer = await decryptBlobRaw({
                    iv: b64ToArray(obj.i),
                    authTag: b64ToArray(obj.a),
                    ciphertext: b64ToArray(obj.c)
                }, key);
                return DEC.decode(plainBuffer);
            }
        } catch (e) {
            // ignore – fall back to raw packed string
        }
        return packed; // fallback for old plaintext names or parsing failure
    }

    // 1. Derive MASTER KEY (MK) from Password
    async function deriveMasterKey(password, salt) {
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
        false,
        ['decrypt', 'unwrapKey']
      );
    }
    
    // 2. Decrypt Raw Blob (needed for unwrap)
    async function decryptBlobRaw({ iv, authTag, ciphertext }, key) {
      const buffer = new Uint8Array(ciphertext.byteLength + authTag.byteLength);
      buffer.set(ciphertext, 0);
      buffer.set(authTag, ciphertext.byteLength);
      return await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buffer);
    }
    
    // 3. Unwrap Logic
    async function unwrapDataKey(wrappedBlob, masterKey) {
        const rawDataKey = await decryptBlobRaw(wrappedBlob, masterKey);
        return crypto.subtle.importKey('raw', rawDataKey, 'AES-GCM', true, ['encrypt', 'decrypt']);
    }

    // 4. Standard Decrypt (for note content)
    async function decryptBlob({ iv, authTag, ciphertext }, key) {
        const plainBuffer = await decryptBlobRaw({ iv, authTag, ciphertext }, key);
        return DEC.decode(plainBuffer);
    }

    // Main Decryption Logic
    async function decryptData() {
        console.error('[EXECUTING]', new Error().stack.split('\\n')[1].trim().split(' ')[1]);
        const password = document.getElementById('passwordInput').value;
        const resultDiv = document.getElementById('result');
        const notesContentDiv = document.getElementById('notesContent');
        const decryptBtn = document.getElementById('decryptBtn');
        
        resultDiv.className = 'result';
        resultDiv.innerHTML = '<strong>🔐 Decrypting...</strong> Please wait.';
        resultDiv.classList.add('success');
        decryptBtn.disabled = true;
        notesContentDiv.style.display = 'none';

        if (!password) {
            resultDiv.innerHTML = '<strong>❌ Decryption Failed</strong><p>Please enter your password.</p>';
            resultDiv.classList.add('error');
            decryptBtn.disabled = false;
            return;
        }

        try {
            const data = JSON.parse(document.getElementById('encrypted-data').textContent);
            const salt = b64ToArray(data.encryption.salt);
            const wrappedKeyData = JSON.parse(atob(data.encryption.wrappedKey));

            const masterKey = await deriveMasterKey(password, salt);
            
            const dataKey = await unwrapDataKey({
                iv: b64ToArray(wrappedKeyData.iv),
                authTag: b64ToArray(wrappedKeyData.authTag),
                ciphertext: b64ToArray(wrappedKeyData.ct)
            }, masterKey);

            let notesHtml = '';

            for (const file of data.files) {
                let plaintext = '';
                
                try {
                    plaintext = await decryptBlob(
                        { 
                            iv: b64ToArray(file.iv), 
                            authTag: b64ToArray(file.authTag), 
                            ciphertext: b64ToArray(file.encryptedBlob) 
                        },
                        dataKey
                    );
                } catch (e) {
                    plaintext = '[ERROR: Failed to decrypt this note.]'; 
                }

                // --- FIX: Decrypt the note name using the same data key ---
                const displayName = await decryptPacked(file.name, dataKey);
                
                notesHtml += \`
                    <div class="note-card">
                        <div class="note-header">
                            <span class="note-title">\${escapeHTML(displayName)}</span>
                            <span class="note-date">\${new Date(file.updated).toLocaleDateString()} \${new Date(file.updated).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                        </div>
                        <pre class="note-content">\${escapeHTML(plaintext) || '[Empty Note]'}</pre>
                    </div>
                \`;
            }

            resultDiv.innerHTML = \`<strong>✅ Decryption Successful!</strong> <p>All \${data.files.length} notes are visible below.</p>\`;
            resultDiv.classList.remove('error');
            resultDiv.classList.add('success');
            
            document.getElementById('notesList').innerHTML = notesHtml;
            notesContentDiv.style.display = 'block';
            decryptBtn.style.display = 'none';
            document.getElementById('passwordInput').style.display = 'none';

        } catch (e) {
            console.error(e);
            resultDiv.innerHTML = '<strong>❌ Decryption Failed</strong><p>Wrong password or corrupted file.</p>';
            resultDiv.classList.remove('success');
            resultDiv.classList.add('error');
            decryptBtn.disabled = false;
        }
    }
    
    window.onload = () => {
        document.getElementById('decryptBtn').addEventListener('click', decryptData);
        document.getElementById('passwordInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') decryptData();
        });
        window.decryptData = decryptData;
    };
  `;
  // =========================================================================

  const totalNotes = exportData.files.length;
  const exportedDate = new Date(exportData.meta.exportedAt).toLocaleString();

  return `
<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>ShardNote Encrypted Backup</title>
    <style>
        body { font-family: 'Segoe UI', system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #f8fafc; color: #1e293b; }
        .container { background: white; border-radius: 12px; padding: 30px; box-shadow: 0 4px 12px rgba(0,0,0,0.08); border: 1px solid #e2e8f0; }
        h1 { color: #6366f1; margin-bottom: 10px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid #e2e8f0; padding-bottom: 15px; }
        .info-box { background: #f0f9ff; border-left: 4px solid #3b82f6; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0; }
        .warning-box { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 15px; margin: 20px 0; border-radius: 0 8px 8px 0; }
        #encrypted-data { display: none; }
        input[type="password"] { width: 100%; padding: 12px; border: 2px solid #cbd5e1; border-radius: 8px; font-size: 16px; margin: 15px 0 0; box-sizing: border-box; }
        input[type="password"]:focus { outline: none; border-color: #6366f1; box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2); }
        button { background: linear-gradient(135deg, #6366f1, #4f46e5); color: white; border: none; padding: 12px 24px; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; transition: all 0.2s ease; width: 100%; margin-top: 10px; }
        button:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3); }
        button:disabled { opacity: 0.5; cursor: not-allowed; }
        #result { margin-top: 20px; padding: 15px; border-radius: 8px; display: none; }
        .result.success { background: #d1fae5; border-left: 4px solid #10b981; display: block; }
        .result.error { background: #fee2e2; border-left: 4px solid #ef4444; display: block; }
        .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 15px; margin: 20px 0; }
        .stat-box { background: #f8fafc; padding: 15px; border-radius: 8px; text-align: center; border: 1px solid #e2e8f0; }
        .stat-value { font-size: 24px; font-weight: 700; color: #6366f1; }
        .stat-label { font-size: 12px; color: #64748b; text-transform: uppercase; }
        h3 { color: #1e293b; margin-top: 30px; font-weight: 600; font-size: 20px; }
        .note-card { border: 1px solid #e2e8f0; padding: 15px; margin-bottom: 15px; border-radius: 8px; background: #fff; }
        .note-header { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px dashed #f1f5f9; padding-bottom: 8px; margin-bottom: 8px; }
        .note-title { font-weight: 600; font-size: 16px; }
        .note-date { font-size: 12px; color: #94a3b8; }
        .note-content { white-space: pre-wrap; font-family: monospace; font-size: 14px; padding: 10px; background: #f1f5f9; border-radius: 4px; border: 1px solid #e2e8f0; overflow-x: auto; }
    </style>
</head>
<body>
    <div class="container">
        <h1>ShardNote Encrypted Backup</h1>
        <div class="info-box"><strong>🔒 Encrypted Backup File</strong><p>Decryption happens locally in your browser using your password.</p></div>
        <div class="warning-box"><strong>⚠️ Notice</strong><p>Created: ${exportedDate}</p></div>
        <div class="stats">
            <div class="stat-box"><div class="stat-value">${totalNotes}</div><div class="stat-label">Total Notes</div></div>
            <div class="stat-box"><div class="stat-value">AES-256</div><div class="stat-label">Encryption</div></div>
        </div>
        <input type="password" id="passwordInput" placeholder="Enter password" />
        <button id="decryptBtn">Decrypt & View Notes</button>
        <div id="result"></div>
        <div id="notesContent" style="display: none; margin-top: 30px;"><div id="notesList"></div></div>
    </div>
    <div id="encrypted-data">${JSON.stringify(exportData)}</div>
    <script>${CRYPTO_SNIPPET}</script>
</body>
</html>
`;
}

export function setupExport(pb, derivedKey, showToast) {
    console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
    
    // CHANGED: Target the button inside Settings Modal
    const exportBtn = document.getElementById('exportJsonBtn');
    
    if (!exportBtn) return;

    // Clean up old listener if it exists
    if (currentExportHandler) {
        exportBtn.removeEventListener('click', currentExportHandler);
    }
    
    const newExportHandler = async () => {
      console.error('[EXECUTING] exportHandler');
      if (!pb.authStore.isValid || !derivedKey) {
        showToast('You must be logged in to export.', 4000);
        return;
      }
      
      // Visual feedback on the button
      const originalText = exportBtn.innerHTML;
      exportBtn.innerHTML = '<span class="st-action-text">Generating Backup...</span>';
      exportBtn.disabled = true;

      try {
        const user = pb.authStore.model;
        // Fetch ALL encrypted records directly (Full Backup)
        const url = pb.baseUrl + `/api/collections/files/records`;
        const params = new URLSearchParams({
            filter: `user = "${user.id}"`, 
            perPage: 500, // Adjust pagination if you have >500 notes
            fields: 'id,name,created,updated,iv,authTag,encryptedBlob'
        });

        const response = await fetch(`${url}?${params.toString()}`, {
            headers: { 'Authorization': pb.authStore.token }
        });

        const data = await response.json();
        const records = data.items;
        
        if (records.length === 0) {
            showToast('No notes to export.', 4000);
            return;
        }

        const exportData = {
            meta: { name: user.name, email: user.email, exportedAt: new Date().toISOString() },
            encryption: { salt: user.encryptionSalt, wrappedKey: user.wrappedKey },
            files: records.map(r => ({
                id: r.id, name: r.name, updated: r.updated,
                iv: r.iv, authTag: r.authTag, encryptedBlob: r.encryptedBlob
            }))
        };
        
        const blob = new Blob([createEncryptedBackupHtml(exportData)], { type: 'text/html' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `ShardNote_Backup_${new Date().toISOString().slice(0,10)}.html`;
        a.click();
        URL.revokeObjectURL(a.href); 
        showToast('Backup downloaded successfully!');

      } catch (e) {
        console.error(e);
        showToast('Export failed.');
      } finally {
        // Reset button
        exportBtn.innerHTML = originalText;
        exportBtn.disabled = false;
      }
    };
    
    currentExportHandler = newExportHandler;
    exportBtn.addEventListener('click', currentExportHandler);
}
