import { 
  deriveMasterKey, wrapDataKey, loadDataKeyFromSession, 
  arrayToB64, randomSalt 
} from './crypto.js';

// Cleaned signature: Removed loadUserFiles, saveFile, renderFiles, loadActiveToEditor
export function initSettings(pb, state, derivedKey) {
  
  // Elements
  const settingsModal = document.getElementById('settingsModal');
  const closeSettings = document.getElementById('closeSettings');
  const settingsBtn   = document.getElementById('settingsBtn');
  
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
  const deleteAccountBtn = document.getElementById('deleteAccountBtn');

  // --- 1. OPEN MODAL & LOAD DATA ---
  settingsBtn?.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
    document.getElementById('profileDropdown').classList.add('hidden');

    if (pb.authStore.isValid) {
      const user = pb.authStore.model;
      
      stName.textContent = user.name || 'User';
      stEmail.textContent = user.email;
      stAvatar.textContent = (user.name || user.email).charAt(0).toUpperCase();

      stNoteCount.textContent = state.files.length;
      
      if (user.created) {
        const date = new Date(user.created);
        stJoinedDate.textContent = date.toLocaleDateString('en-US', { 
          month: 'short', year: 'numeric' 
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
        stPlanName.textContent = 'Pro Plan';
        stPlanBadge.textContent = 'Premium';
        stPlanExpiry.textContent = `Valid until ${expiryDate.toLocaleDateString()}`;
        stPlanCard.classList.add('pro');
        stUpgradeBtn.style.display = 'none';
      } else {
        stPlanName.textContent = 'Free Plan';
        stPlanBadge.textContent = 'Free';
        stPlanExpiry.textContent = 'Unlock all premium features';
        stPlanCard.classList.remove('pro');
        stUpgradeBtn.style.display = 'block';
        stUpgradeBtn.onclick = () => window.location.href = 'Pricing.html';
      }

    } else {
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
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
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

    if (!pb.authStore.isValid) return alert('Not logged in');
    
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
        const newSalt = randomSalt();
        const newMasterKey = await deriveMasterKey(newPass, newSalt);
        const wrapped = await wrapDataKey(dataKey, newMasterKey);
        
        const wrappedObj = {
            iv: arrayToB64(wrapped.iv),
            authTag: arrayToB64(wrapped.authTag),
            ct: arrayToB64(wrapped.ciphertext)
        };
        const wrappedB64 = btoa(JSON.stringify(wrappedObj));

        await pb.collection('users').update(userId, {
            oldPassword: curPass,
            password: newPass,
            passwordConfirm: newPass,
            encryptionSalt: arrayToB64(newSalt),
            wrappedKey: wrappedB64
        });

        pb.authStore.clear();
        await pb.collection('users').authWithPassword(email, newPass);

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

  // --- 5. DELETE ACCOUNT ---
  deleteAccountBtn?.addEventListener('click', async () => {
    const pass = prompt('To confirm deletion, type your password:');
    if (!pass) return;

    if (!confirm('FINAL WARNING: This action cannot be undone.')) return;

    try {
        await pb.collection('users').authWithPassword(pb.authStore.model.email, pass);
        await pb.collection('users').delete(pb.authStore.model.id);
        
        pb.authStore.clear();
        sessionStorage.clear();
        window.location.reload();
    } catch (err) {
        alert('Delete failed: ' + err.message);
    }
  });
}
