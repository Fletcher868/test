import { 
  deriveMasterKey, wrapDataKey, unwrapDataKey, 
  exportKeyToString, loadDataKeyFromSession, 
  encryptBlob, decryptBlob, arrayToB64, b64ToArray, randomSalt 
} from './crypto.js';

export function initSettings(pb, state, derivedKey, loadUserFiles, saveFile, renderFiles, loadActiveToEditor) {
  
  // Elements
  const settingsModal = document.getElementById('settingsModal');
  const closeSettings = document.getElementById('closeSettings');
  const settingsBtn   = document.getElementById('settingsBtn'); // The button in sidebar
  
  // Tabs
  const tabBtns = document.querySelectorAll('.st-tab-btn');
  const tabContents = document.querySelectorAll('.st-tab-content');

  // Fields
  const stName  = document.getElementById('stName');
  const stEmail = document.getElementById('stEmail');
  const stAvatar = document.getElementById('stAvatar');
  
  const stPlanName = document.getElementById('stPlanName');
  const stPlanBadge = document.getElementById('stPlanBadge');
  const stPlanExpiry = document.getElementById('stPlanExpiry');
  const stUpgradeBtn = document.getElementById('stUpgradeBtn');
  const stPlanCard = document.getElementById('stPlanCard');
  const stNoteCount = document.getElementById('stNoteCount');
  const stJoinedDate = document.getElementById('stJoinedDate'); 

  // Actions
  const changePasswordBtn = document.getElementById('changePasswordBtn');
  const exportJsonBtn = document.getElementById('exportJsonBtn');
  const importJsonBtn = document.getElementById('importJsonBtn');
  const importFileInput = document.getElementById('importFileInput');
  const deleteAccountBtn = document.getElementById('deleteAccountBtn');

  // --- 1. OPEN MODAL & LOAD DATA ---
  settingsBtn?.addEventListener('click', () => {
    // Show Modal
    settingsModal.classList.remove('hidden');
    document.getElementById('profileDropdown').classList.add('hidden');

    // Load User Info
    if (pb.authStore.isValid) {
      const user = pb.authStore.model;
      
      // Profile Header
      stName.textContent = user.name || 'User';
      stEmail.textContent = user.email;
      stAvatar.textContent = (user.name || user.email).charAt(0).toUpperCase();

      // Stats
      stNoteCount.textContent = state.files.length;
      // 2. ADD THIS LOGIC FOR DATE:
      if (user.created) {
        const date = new Date(user.created);
        // Format: "Oct 2023"
        stJoinedDate.textContent = date.toLocaleDateString('en-US', { 
          month: 'short', 
          year: 'numeric' 
        });
      } else {
        stJoinedDate.textContent = '—';
      }
      // Plan Logic
      const now = new Date();
      let isPro = false;
      let expiryDate = null;

      if (user.plan_expires) {
        expiryDate = new Date(user.plan_expires);
        isPro = expiryDate > now;
      }

      if (isPro) {
        // PRO UI
        stPlanName.textContent = 'Pro Plan';
        stPlanBadge.textContent = 'Premium';
        stPlanExpiry.textContent = `Valid until ${expiryDate.toLocaleDateString()}`;
        stPlanCard.classList.add('pro');
        stUpgradeBtn.style.display = 'none'; // Hide upgrade button
      } else {
        // FREE UI
        stPlanName.textContent = 'Free Plan';
        stPlanBadge.textContent = 'Free';
        stPlanExpiry.textContent = 'Unlock all premium features';
        stPlanCard.classList.remove('pro');
        stUpgradeBtn.style.display = 'block';
        stUpgradeBtn.onclick = () => window.location.href = 'Pricing.html';
      }

    } else {
      // Guest Mode Fallback
      stName.textContent = 'Guest User';
      stEmail.textContent = 'Local Storage';
      stAvatar.textContent = 'G';
      stNoteCount.textContent = state.files.length;
      stPlanName.textContent = 'Guest';
      stPlanBadge.textContent = 'Offline';
      stUpgradeBtn.textContent = 'Log in';
      stUpgradeBtn.onclick = () => document.getElementById('loginBtn').click();
    }
  });

  // --- 2. CLOSE MODAL ---
  const close = () => settingsModal.classList.add('hidden');
  closeSettings?.addEventListener('click', close);
  settingsModal?.addEventListener('click', (e) => {
    if(e.target === settingsModal) close();
  });

  // --- 3. TAB SWITCHING ---
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Remove active class from all buttons and contents
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      // Activate clicked
      btn.classList.add('active');
      document.getElementById(btn.dataset.target).classList.add('active');
    });
  });

  // --- 4. CHANGE PASSWORD ---
  changePasswordBtn?.addEventListener('click', async () => {
    const curPass = document.getElementById('currentPassword').value.trim();
    const newPass = document.getElementById('newPassword').value.trim();
    const confPass = document.getElementById('confirmPassword').value.trim();

    if (!curPass) return alert('Current password required');
    if (newPass.length < 10) return alert('New password must be at least 10 characters');
    if (newPass !== confPass) return alert('Passwords do not match');

    // Verify Session
    if (!pb.authStore.isValid) return alert('Not logged in');
    
    // Ensure we have the Data Key loaded
    let dataKey = derivedKey;
    if (!dataKey) {
        dataKey = await loadDataKeyFromSession();
        if(!dataKey) return alert("Session lost. Please re-login.");
    }

    changePasswordBtn.disabled = true;
    changePasswordBtn.textContent = 'Updating...';

    try {
        const userId = pb.authStore.model.id;
        const email = pb.authStore.model.email;

        // 1. Generate NEW Master Key (from NEW Password)
        const newSalt = randomSalt();
        const newSaltB64 = arrayToB64(newSalt);
        const newMasterKey = await deriveMasterKey(newPass, newSalt);

        // 2. Re-Wrap the EXISTING Data Key with the NEW Master Key
        // (We do NOT touch the files. We just put the key in a new box)
        const wrapped = await wrapDataKey(dataKey, newMasterKey);
        
        const wrappedObj = {
            iv: arrayToB64(wrapped.iv),
            authTag: arrayToB64(wrapped.authTag),
            ct: arrayToB64(wrapped.ciphertext)
        };
        const wrappedB64 = btoa(JSON.stringify(wrappedObj));

        // 3. Send to Server
        await pb.collection('users').update(userId, {
            oldPassword: curPass,
            password: newPass,
            passwordConfirm: newPass,
            encryptionSalt: newSaltB64,
            wrappedKey: wrappedB64
        });

        // 4. Re-Auth
        pb.authStore.clear();
        await pb.collection('users').authWithPassword(email, newPass);

        // 5. Success
        alert('Password changed successfully!');
        document.getElementById('settingsModal').classList.add('hidden');
        document.getElementById('currentPassword').value = '';
        document.getElementById('newPassword').value = '';
        document.getElementById('confirmPassword').value = '';

    } catch (err) {
        console.error(err);
        alert('Update failed: ' + err.message);
        if (err.status === 404) window.location.reload();
    } finally {
        changePasswordBtn.disabled = false;
        changePasswordBtn.textContent = 'Update Password';
    }
  });

  // --- 5. EXPORT / IMPORT ---
  exportJsonBtn?.addEventListener('click', () => {
    const data = {
      exportedAt: new Date().toISOString(),
      files: state.files.map(f => ({ name: f.name, content: f.content }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `notes-backup-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
  });

  importJsonBtn?.addEventListener('click', () => importFileInput.click());

  importFileInput?.addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (!Array.isArray(data.files)) throw new Error('Invalid JSON format');

      for (const f of data.files) {
        // Encrypt and Upload
        const { ciphertext, iv, authTag } = await encryptBlob(f.content || '', derivedKey);
        await pb.collection('files').create({
          name: f.name || 'Imported Note',
          user: pb.authStore.model.id,
          iv: arrayToB64(iv),
          authTag: arrayToB64(authTag),
          encryptedBlob: arrayToB64(ciphertext)
        });
      }
      // Refresh
      await loadUserFiles();
      alert(`Successfully imported ${data.files.length} notes.`);
    } catch (err) {
      alert('Import failed: ' + err.message);
    } finally {
      importFileInput.value = '';
    }
  });

  // --- 6. DELETE ACCOUNT ---
  deleteAccountBtn?.addEventListener('click', async () => {
    const pass = prompt('To confirm deletion, type your password:');
    if (!pass) return;

    if (!confirm('FINAL WARNING: This action cannot be undone.')) return;

    try {
        await pb.collection('users').authWithPassword(pb.authStore.model.email, pass);
        // Delete user (cascade deletes files usually, but we can be explicit if needed)
        await pb.collection('users').delete(pb.authStore.model.id);
        
        pb.authStore.clear();
        sessionStorage.clear();
        window.location.reload();
    } catch (err) {
        alert('Delete failed: ' + err.message);
    }
  });
}