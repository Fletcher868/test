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

            // Derive Master Key
            const masterKey = await deriveMasterKey(password, salt);
            
            // Unwrap Data Key (DK) using Master Key (MK)
            const dataKey = await unwrapDataKey({
                iv: b64ToArray(wrappedKeyData.iv),
                authTag: b64ToArray(wrappedKeyData.authTag),
                ciphertext: b64ToArray(wrappedKeyData.ct)
            }, masterKey);

            let notesHtml = '';

            for (const file of data.files) {
                let plaintext = ''; // Initialize plaintext
                
                try { // <--- ADDED TRY BLOCK HERE
                    plaintext = await decryptBlob(
                        { 
                            iv: b64ToArray(file.iv), 
                            authTag: b64ToArray(file.authTag), 
                            ciphertext: b64ToArray(file.encryptedBlob) 
                        },
                        dataKey
                    );
                } catch (e) { // <--- ADDED CATCH BLOCK HERE
                    console.error("Note decryption failed in export file:", e);
                    plaintext = '[ERROR: Failed to decrypt this note. The data is likely corrupted.]'; 
                }
                
                notesHtml += \`
                    <div class="note-card">
                        <div class="note-header">
                            <span class="note-title">\${file.name}</span>
                            <span class="note-date">\${new Date(file.updated).toLocaleDateString()} \${new Date(file.updated).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'})}</span>
                        </div>
                        <pre class="note-content">\${plaintext || '[Empty Note]'}</pre>
                    </div>
                \`;
            }

            // Success State
            resultDiv.innerHTML = \`<strong>✅ Decryption Successful!</strong> <p>All \${data.files.length} notes are now visible below.</p>\`;
            resultDiv.classList.remove('error');
            resultDiv.classList.add('success');
            
            document.getElementById('notesList').innerHTML = notesHtml;
            notesContentDiv.style.display = 'block';
            decryptBtn.style.display = 'none'; // Hide decrypt button on success
            document.getElementById('passwordInput').style.display = 'none'; // Hide input

        } catch (e) {
            console.error(e);
            resultDiv.innerHTML = '<strong>❌ Decryption Failed</strong><p>Wrong password or corrupted file.</p>';
            resultDiv.classList.remove('success');
            resultDiv.classList.add('error');
            decryptBtn.disabled = false;
        }
    }
    
    // Initialize
    window.onload = () => {
        document.getElementById('decryptBtn').addEventListener('click', decryptData);
        document.getElementById('passwordInput').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') decryptData();
        });
        
        // Expose function globally for the onclick attribute
        window.decryptData = decryptData;
    };
  `;
  // =========================================================================

  // Dynamic values for the header
  const totalNotes = exportData.files.length;
  const exportedDate = new Date(exportData.meta.exportedAt).toLocaleString();


  // The full HTML structure for the self-contained backup file (FINAL DESIGN)
  return `
<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>KryptNote Encrypted Backup</title>
    <style>
        body {
            font-family: 'Segoe UI', system-ui, -apple-system, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            background: #f8fafc;
            color: #1e293b;
        }
        .container {
            background: white;
            border-radius: 12px;
            padding: 30px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.08);
            border: 1px solid #e2e8f0;
        }
        h1 {
            color: #6366f1;
            margin-bottom: 10px;
            display: flex;
            align-items: center;
            gap: 10px;
            border-bottom: 1px solid #e2e8f0;
            padding-bottom: 15px;
        }
        .info-box {
            background: #f0f9ff;
            border-left: 4px solid #3b82f6;
            padding: 15px;
            margin: 20px 0;
            border-radius: 0 8px 8px 0;
        }
        .warning-box {
            background: #fef3c7;
            border-left: 4px solid #f59e0b;
            padding: 15px;
            margin: 20px 0;
            border-radius: 0 8px 8px 0;
        }
        /* Hidden data box */
        #encrypted-data {
             display: none;
        }
        
        input[type="password"] {
            width: 100%;
            padding: 12px;
            border: 2px solid #cbd5e1;
            border-radius: 8px;
            font-size: 16px;
            margin: 15px 0 0;
            box-sizing: border-box;
        }
        input[type="password"]:focus {
            outline: none;
            border-color: #6366f1;
            box-shadow: 0 0 0 3px rgba(99, 102, 241, 0.2);
        }
        button {
            background: linear-gradient(135deg, #6366f1, #4f46e5);
            color: white;
            border: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.2s ease;
            width: 100%;
            margin-top: 10px;
        }
        button:hover {
            transform: translateY(-1px);
            box-shadow: 0 4px 12px rgba(99, 102, 241, 0.3);
        }
        button:disabled {
            opacity: 0.5;
            cursor: not-allowed;
            transform: none;
            box-shadow: none;
        }
        
        /* Result Box Styling */
        #result {
            margin-top: 20px;
            padding: 15px;
            border-radius: 8px;
            display: none;
        }
        .result.success {
            background: #d1fae5;
            border-left: 4px solid #10b981;
            display: block;
        }
        .result.error {
            background: #fee2e2;
            border-left: 4px solid #ef4444;
            display: block;
        }
        
        /* Stats Grid */
        .stats {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
            gap: 15px;
            margin: 20px 0;
        }
        .stat-box {
            background: #f8fafc;
            padding: 15px;
            border-radius: 8px;
            text-align: center;
            border: 1px solid #e2e8f0;
        }
        .stat-value {
            font-size: 24px;
            font-weight: 700;
            color: #6366f1;
        }
        .stat-label {
            font-size: 12px;
            color: #64748b;
            text-transform: uppercase;
            letter-spacing: 0.5px;
        }
        
        /* Notes List Styling */
        h3 { 
            color: #1e293b; 
            margin-top: 30px; 
            font-weight: 600; 
            font-size: 20px; 
        }
        .note-card { 
            border: 1px solid #e2e8f0; 
            padding: 15px; 
            margin-bottom: 15px; 
            border-radius: 8px; 
            background: #fff; 
        }
        .note-header { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            border-bottom: 1px dashed #f1f5f9; 
            padding-bottom: 8px; 
            margin-bottom: 8px; 
        }
        .note-title { font-weight: 600; font-size: 16px; }
        .note-date { font-size: 12px; color: #94a3b8; }
        .note-content {
            white-space: pre-wrap;
            font-family: monospace;
            font-size: 14px;
            padding: 10px;
            background: #f1f5f9;
            border-radius: 4px;
            border: 1px solid #e2e8f0;
            overflow-x: auto;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                <polyline points="17 21 17 13 7 13 7 21"></polyline>
                <polyline points="7 3 7 8 15 8"></polyline>
            </svg>
            KryptNote Encrypted Backup
        </h1>
        
        <div class="info-box">
            <strong>🔒 Encrypted Backup File</strong>
            <p>This HTML file contains your notes encrypted with AES-GCM 256-bit. Decryption happens locally in your browser using your KryptNote password.</p>
        </div>
        
        <div class="warning-box">
            <strong>⚠️ Important Security Notice</strong>
            <p>
               • You MUST remember your **KryptNote Password** to decrypt<br>
               • Created: ${exportedDate}</p>
        </div>
        
        <div class="stats">
            <div class="stat-box">
                <div class="stat-value">${totalNotes}</div>
                <div class="stat-label">Total Notes</div>
            </div>
            <div class="stat-box">
                <div class="stat-value">AES-256</div>
                <div class="stat-label">Encryption</div>
            </div>
            <div class="stat-box">
                <div class="stat-value">E2E</div>
                <div class="stat-label">Scheme</div>
            </div>
        </div>
        
        <h3>🔓 Decrypt Your Notes</h3>
        
        <input type="password" id="passwordInput" placeholder="Enter your KryptNote password" />
        
        <button id="decryptBtn" onclick="decryptData()">Decrypt & View Notes</button>
        
        <div id="result" class="result"></div>
        
        <div id="notesContent" style="display: none; margin-top: 30px;">
            <h3>📋 Your Decrypted Notes</h3>
            <div id="notesList"></div>
        </div>
    </div>
    
    <div id="encrypted-data">
        <!-- ENCRYPTED DATA JSON EMBEDDED HERE -->
        ${JSON.stringify(exportData)}
    </div>

    <script>
        // Embedded KryptNote Crypto Functions for Standalone Decryption
        ${CRYPTO_SNIPPET}
    </script>
</body>
</html>
`;
}

/**
 * Initializes the export functionality by setting up the event listener for the export button.
 * This function now first removes any previous handler before adding a new one.
 * 
 * @param {PocketBase} pb - The PocketBase instance.
 * @param {CryptoKey} derivedKey - The active derived (Data) encryption key.
 * @param {function} showToast - Function to display user notifications.
 */
export function setupExport(pb, derivedKey, showToast) {
    const exportBtn = document.getElementById('exportAll');
    if (!exportBtn) return;

    // --- FIX: Remove previous handler to prevent duplicates ---
    if (currentExportHandler) {
        exportBtn.removeEventListener('click', currentExportHandler);
    }
    // ---------------------------------------------------------
    
    // Define the new handler function
    const newExportHandler = async () => {
      if (!pb.authStore.isValid || !derivedKey) {
        showToast('You must be logged in to export encrypted data.', 4000);
        return;
      }
      
      showToast('Preparing encrypted backup, please wait...', 5000);

      try {
        const user = pb.authStore.model;
        
        // --- Fetch Setup (Bypassing getFullList for stability) ---
        const url = pb.baseUrl + `/api/collections/files/records`;
        const params = new URLSearchParams({
            filter: `user = "${user.id}"`, 
            sort: '-updated', 
            fields: 'id,name,created,updated,iv,authTag,encryptedBlob',
            perPage: 500,
            page: 1
        });

        const fullUrl = `${url}?${params.toString()}`;

        const response = await fetch(fullUrl, {
            method: 'GET',
            headers: {
                'Authorization': pb.authStore.token, 
                'Content-Type': 'application/json'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP Error: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        const records = data.items;
        // -------------------
        
        if (records.length === 0) {
            showToast('No notes found to export.', 4000);
            return;
        }

        // 2. Prepare the data structure
        const exportData = {
            meta: { 
                name: user.name, 
                email: user.email, 
                exportedAt: new Date().toISOString() 
            },
            encryption: { 
                salt: user.encryptionSalt,
                wrappedKey: user.wrappedKey
            },
            files: records.map(r => ({
                id: r.id, name: r.name, created: r.created, updated: r.updated,
                iv: r.iv, authTag: r.authTag, encryptedBlob: r.encryptedBlob
            }))
        };
        
        // 3. Generate the self-contained HTML file
        const htmlContent = createEncryptedBackupHtml(exportData);
        
        // 4. Download the HTML file (Includes cleanup)
        const blob = new Blob([htmlContent], { type: 'text/html' });
        const a = document.createElement('a');
        
        a.href = URL.createObjectURL(blob);
        a.download = `KryptNote_Encrypted_Backup_${new Date().toISOString().slice(0, 10)}.html`;
        a.style.display = 'none';

        document.body.appendChild(a);
        a.click();
        
        URL.revokeObjectURL(a.href); 
        document.body.removeChild(a); 

        showToast('Encrypted backup downloaded successfully! Keep this file and your password safe.', 6000);

      } catch (e) {
        console.error("Export failed:", e);
        showToast('Export failed. An error occurred during the fetch. Check console.', 8000);
      }
    };
    
    // Assign the handler and store its reference
    currentExportHandler = newExportHandler;
    exportBtn.addEventListener('click', currentExportHandler);

}