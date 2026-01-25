import PocketBase from 'https://cdn.jsdelivr.net/npm/pocketbase/dist/pocketbase.es.mjs';
import { 
  deriveMasterKey, generateDataKey, wrapDataKey, unwrapDataKey, 
  exportKeyToString, storeDataKeyInSession, loadDataKeyFromSession, 
  encryptBlob, decryptBlob, randomSalt, arrayToB64, b64ToArray ,
  generateShareKey, exportKeyToUrl
} from './crypto.js';
import { createVersionSnapshot, getVersions } from './versions.js';

import { Editor } from 'https://esm.sh/@tiptap/core@2.2.4';
import StarterKit from 'https://esm.sh/@tiptap/starter-kit@2.2.4';
import TextStyle from 'https://esm.sh/@tiptap/extension-text-style@2.2.4';
import { Color } from 'https://esm.sh/@tiptap/extension-color@2.2.4';
import Link from 'https://esm.sh/@tiptap/extension-link@2.2.4';
import Image from 'https://esm.sh/@tiptap/extension-image@2.2.4';
import TextAlign from 'https://esm.sh/@tiptap/extension-text-align@2.2.4';
import Placeholder from 'https://esm.sh/@tiptap/extension-placeholder@2.2.4';
import { initSettings } from './settings.js'; 
import { setupExport } from './export.js'; 

// NEW: PocketBase default category IDs for new user initialization
const DEFAULT_CATEGORY_IDS = {
    WORK: 'work',
    TRASH: 'trash'
};
// NEW: Guest storage key and structure
const GUEST_STORAGE_KEY = 'kryptNoteLocalData';
let tiptapEditor = null;
let isRichMode = localStorage.getItem('kryptNote_editorMode') === 'rich'; // Load preference
let previewMode = false;        
let previewVersion = null;      
let originalBeforePreview = ''; 
const PB_URL = 'https://nonpending-teisha-depletory.ngrok-free.dev/';
let pb = null, 
    // UPDATE: Added categories and set default active category
    state = { files: [], activeId: null, categories: [], activeCategoryId: DEFAULT_CATEGORY_IDS.WORK }, 
    currentMenu = null, derivedKey = null;
let originalContent = '';
let isSavingVersion = false;
let recentlySavedLocally = new Set(); 
let isCategoriesExpanded = localStorage.getItem('kryptNote_categoriesExpanded') !== 'false';
let finalizeUIUpdateTimeout = null;
let isFinalizingUI = false;
let versionHistoryController = null;
let uiUpdateQueued = false;
let originalEditorMode = null;
// ===================================================================
// 1. GUEST STORAGE BACKEND (localStorage)
// ===================================================================
const guestStorage = {
  saveData(data) {
    localStorage.setItem(GUEST_STORAGE_KEY, JSON.stringify(data));
  },
  loadData() {
    const data = localStorage.getItem(GUEST_STORAGE_KEY);
    return data ? JSON.parse(data) : null;
  },
  // CRITICAL: Guest mode categories use the hardcoded string as their ID
  initData() {
    return {
      categories: [
        { id: DEFAULT_CATEGORY_IDS.WORK, name: 'Work', iconName: 'icon-work', sortOrder: 1 },
        { id: DEFAULT_CATEGORY_IDS.TRASH, name: 'Trash', iconName: 'icon-delete', sortOrder: 2 },
      ],
      files: []
    };
  }
};


// NEW: Key for logged-in user cache
const USER_CACHE_KEY = 'kryptNote_userCache';

// Helper: Save current state to local storage (for fast reload)
function saveToUserCache() {
  // Only cache if logged in
  if (!pb.authStore.isValid) return;
  
  try {
    const cacheData = {
      files: state.files,
      categories: state.categories,
      activeId: state.activeId,
      activeCategoryId: state.activeCategoryId,
      timestamp: Date.now()
    };
    localStorage.setItem(USER_CACHE_KEY, JSON.stringify(cacheData));
  } catch (e) {
    console.warn("Cache quota exceeded or disabled", e);
  }
}

// Helper: Load from local storage immediately
function loadFromUserCache() {
  const data = localStorage.getItem(USER_CACHE_KEY);
  if (!data) return false;

  try {
    const parsed = JSON.parse(data);
    state.files = parsed.files || [];
    state.categories = parsed.categories || [];
    // Restore selection
    state.activeId = parsed.activeId;
    state.activeCategoryId = parsed.activeCategoryId || DEFAULT_CATEGORY_IDS.WORK;
    return true;
  } catch (e) {
    console.error("Cache parse error", e);
    return false;
  }
}
// ===================================================================
// POCKETBASE & AUTH
// ===================================================================
// --- RICH PREVIEW SANDBOX LOGIC ---
let previewEditor = null;

function initPreviewEditor() {
  if (previewEditor) return;

  previewEditor = new Editor({
    element: document.getElementById('previewEditorBody'),
    extensions: [
      StarterKit,
      TextStyle, 
      Color,
      Link.configure({ openOnClick: false }),
      Image,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content: `
      <h3>Welcome to the Super Editor! 🚀</h3>
      <p>This is a <strong>live demo</strong>. You can type here, use the toolbar, and see how it feels.</p>
      <ul>
        <li>Rich formatting with <code>code blocks</code></li>
        <li>Lists, Quotes, and Headings</li>
        <li><span style="color: #6366f1">Colors</span> and Images</li>
      </ul>
      <p style="text-align: center">Centered text support!</p>
    `,
  });

  // Helper to wire buttons
  const cmd = (id, callback) => {
    const btn = document.getElementById(id);
    if(btn) {
      btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        callback(previewEditor.chain().focus());
      });
    }
  };

  // --- Wire Up Buttons ---
  cmd('prev_ttUndo', (c) => c.undo().run());
  cmd('prev_ttRedo', (c) => c.redo().run());
  cmd('prev_ttBold', (c) => c.toggleBold().run());
  cmd('prev_ttItalic', (c) => c.toggleItalic().run());
  cmd('prev_ttStrike', (c) => c.toggleStrike().run());
  cmd('prev_ttCode', (c) => c.toggleCode().run()); // Added
  
  cmd('prev_ttAlignLeft', (c) => c.setTextAlign('left').run()); // Added
  cmd('prev_ttAlignCenter', (c) => c.setTextAlign('center').run()); // Added
  cmd('prev_ttAlignRight', (c) => c.setTextAlign('right').run()); // Added

  cmd('prev_ttBullet', (c) => c.toggleBulletList().run());
  cmd('prev_ttOrdered', (c) => c.toggleOrderedList().run());
  cmd('prev_ttQuote', (c) => c.toggleBlockquote().run()); // Added

  // --- Colors & Inserts ---
  document.getElementById('prev_ttColor')?.addEventListener('input', (e) => {
    previewEditor.chain().focus().setColor(e.target.value).run();
  });

  document.getElementById('prev_ttLink')?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const url = window.prompt('Enter Link URL');
    if (url) previewEditor.chain().focus().setLink({ href: url }).run();
  });

  document.getElementById('prev_ttImage')?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const url = window.prompt('Enter Image URL');
    if (url) previewEditor.chain().focus().setImage({ src: url }).run();
  });

  // --- Preview Dropdown Logic ---
  const dropdown = document.getElementById('prev_headingDropdown');
  const trigger = dropdown?.querySelector('.dropdown-trigger');
  
  if (dropdown && trigger) {
      trigger.addEventListener('mousedown', (e) => {
          e.preventDefault();
          dropdown.classList.toggle('is-open');
      });
      dropdown.querySelectorAll('.dropdown-item').forEach(item => {
          item.addEventListener('mousedown', (e) => {
              e.preventDefault(); 
              const level = parseInt(e.target.getAttribute('data-level'));
              if (level === 0) previewEditor.chain().focus().setParagraph().run();
              else previewEditor.chain().focus().toggleHeading({ level }).run();
              dropdown.classList.remove('is-open');
          });
      });
      window.addEventListener('mousedown', (e) => {
          if (!dropdown.contains(e.target)) dropdown.classList.remove('is-open');
      });
  }
}

function showRichPreviewModal() {
  const modal = document.getElementById('richPreviewModal');
  modal.classList.remove('hidden');
  
  // Initialize the editor if it hasn't been yet
  setTimeout(() => {
    initPreviewEditor();
    if(previewEditor) previewEditor.commands.focus();
  }, 100);
}

// Close logic for Preview Modal
document.getElementById('closeRichPreview')?.addEventListener('click', () => {
  document.getElementById('richPreviewModal').classList.add('hidden');
});
document.getElementById('upgradeFromPreviewBtn')?.addEventListener('click', () => {
  window.location.href = 'Pricing.html';
});

async function initPocketBase() {
  // 1. Init PB
  pb = new PocketBase(PB_URL);

  // 2. Setup Editors
  initTiptap();
  setupEditorSwitching();
  applyEditorMode();
  updateEditorModeUI(); 

  // 3. OPTIMIZATION: Try to load Cache immediately (Instant Render)
  if (pb.authStore.isValid) {
      if (loadFromUserCache()) {
          console.log("Loaded from local cache (Fast render)");
          // Render immediately with cached data
          renderFiles();
          loadActiveToEditor();
          
          // Re-establish active file/tab info
          const activeFile = state.files.find(f => f.id === state.activeId);
          updateSidebarInfo(activeFile);
          if(activeFile) updateVersionHistory(activeFile);
      }
  }

  // 4. Refresh Auth Token
  if (pb.authStore.isValid) {
    try {
        await pb.collection('users').authRefresh();
    } catch (err) {
        console.warn("Session expired:", err);
        pb.authStore.clear();
        // If session died, clear the cache so we don't show secrets
        localStorage.removeItem(USER_CACHE_KEY);
        // Reload page or let it fall to guest mode logic
    }
  }

  // 5. Network Sync (Background Update)
  if (pb.authStore.isValid) {
    // This will fetch fresh data, decrypt it, and overwrite the cache/UI
    await restoreEncryptionKeyAndLoad();
    setupExport(pb, derivedKey, showToast);
  } else {
    // Guest Mode
    loadUserFiles();
    updateProfileState();
    setupExport(pb, derivedKey, showToast);
  }

  setupToolbarSlider();
  initSettings(pb, state, derivedKey, loadUserFiles, saveFile, renderFiles, loadActiveToEditor);
}

async function restoreEncryptionKeyAndLoad() {
  try {
    derivedKey = await loadDataKeyFromSession();
    
    if (derivedKey) {
      await loadUserFiles();
      updateProfileState();
      setupRealtimeSubscription(); 
      setupExport(pb, derivedKey, showToast);
      return;
    }

    const user = pb.authStore.model;
    if (!user.encryptionSalt || !user.wrappedKey) {
      alert('Security data missing. Please log in again.');
      logout();
      return;
    }

    const password = prompt('Session expired. Enter password to unlock notes:');
    if (!password) { logout(); return; }

    const salt = b64ToArray(user.encryptionSalt);
    const masterKey = await deriveMasterKey(password, salt);
    
    const wrappedJson = JSON.parse(atob(user.wrappedKey)); 
    
    derivedKey = await unwrapDataKey({
        iv: b64ToArray(wrappedJson.iv),
        authTag: b64ToArray(wrappedJson.authTag),
        ciphertext: b64ToArray(wrappedJson.ct)
    }, masterKey);

    const dkStr = await exportKeyToString(derivedKey);
    storeDataKeyInSession(dkStr);

    await loadUserFiles();
    updateProfileState();
    setupRealtimeSubscription(); 
    setupExport(pb, derivedKey, showToast);

  } catch (e) {
    console.error(e);
    alert('Failed to unlock: Wrong password or corrupted key.');
    logout();
  }
}

async function login(email, password) {
    // Exit preview mode if currently in preview
  if (previewMode) {
    exitPreviewMode();
    highlightSelectedVersion(null);
  }

  try {
    await pb.collection('users').authWithPassword(email, password);
    const user = pb.authStore.model;

    if (!user.wrappedKey) {
        throw new Error("Account missing wrapped key (Legacy account?)");
    }

    const salt = b64ToArray(user.encryptionSalt);
    const masterKey = await deriveMasterKey(password, salt);

    const wrappedJson = JSON.parse(atob(user.wrappedKey));
    derivedKey = await unwrapDataKey({
        iv: b64ToArray(wrappedJson.iv),
        authTag: b64ToArray(wrappedJson.authTag),
        ciphertext: b64ToArray(wrappedJson.ct)
    }, masterKey);

    const dkStr = await exportKeyToString(derivedKey);
    storeDataKeyInSession(dkStr);

    localStorage.removeItem(GUEST_STORAGE_KEY); 
    
    await loadUserFiles();
    showMenu();
    updateProfileState();
    setupRealtimeSubscription(); 
    setupExport(pb, derivedKey, showToast);

    document.getElementById('profileDropdown').classList.add('hidden');
    showToast('Logged in! Envelope Open.');
    return true;
  } catch (e) {
    alert('Login failed: ' + e.message);
    return false;
  }
}

async function signup(name, email, password) {
  try {
    const saltArray = randomSalt();
    const saltB64 = arrayToB64(saltArray);
    const masterKey = await deriveMasterKey(password, saltArray);

    const dataKey = await generateDataKey();

    const wrapped = await wrapDataKey(dataKey, masterKey);
    
    const wrappedObj = {
        iv: arrayToB64(wrapped.iv),
        authTag: arrayToB64(wrapped.authTag),
        ct: arrayToB64(wrapped.ciphertext)
    };
    const wrappedB64 = btoa(JSON.stringify(wrappedObj));

    await pb.collection('users').create({ 
      name, 
      email, 
      password, 
      passwordConfirm: password, 
      encryptionSalt: saltB64,
      wrappedKey: wrappedB64
    });
    
    return await login(email, password);
  } catch (e) {
    alert('Signup failed: ' + e.message);
    return false;
  }
}



function logout() {
  if (previewMode) {
    exitPreviewMode();
  }
  
  // CRITICAL FIX: Unsubscribe from Realtime *before* clearing authStore.
  // This ensures the unsubscribe request is sent with the valid session token.
  if (pb) {
    pb.realtime.unsubscribe('files');
    pb.realtime.unsubscribe('categories'); // Added categories unsubscribe
    console.log('Realtime subscription for files and categories stopped.');
  }
  
  pb.authStore.clear();
  sessionStorage.removeItem('dataKey');
  derivedKey = null;
  localStorage.removeItem(USER_CACHE_KEY); 
  // Fully reset state
  state = { files: [], activeId: null, categories: [], activeCategoryId: DEFAULT_CATEGORY_IDS.WORK };
  previewMode = false;
  previewVersion = null;
  originalBeforePreview = '';
  originalContent = '';

  // Clear Plain Text Editor
  const editor = document.getElementById('textEditor');
  if (editor) editor.value = '';

  // Clear Rich Text Editor
  if (tiptapEditor) {
      tiptapEditor.commands.setContent('');
  }
  
  loadUserFiles();

  updateProfileState();
  updateVersionFooter();
  showMenu();
  setupExport(pb, derivedKey, showToast);
}

// From script.js

function setupRealtimeSubscription() {
  if (!pb.authStore.isValid || !derivedKey) {
    return;
  }

  pb.realtime.unsubscribe('files');
  pb.realtime.unsubscribe('categories'); 
  
  // Helper to decrypt the record
  const decryptRecord = async (r, retries = 2) => { 
      let plaintext = '';
      if (r.iv && r.authTag && r.encryptedBlob) {
          try {
              plaintext = await decryptBlob(
                  { iv: b64ToArray(r.iv), authTag: b64ToArray(r.authTag), ciphertext: b64ToArray(r.encryptedBlob) },
                  derivedKey
              );
          } catch (decErr) {
              if (retries > 0) {
                  // Wait a short period and try again for transient network/crypto errors
                  console.warn(`Realtime decryption failed. Retrying in 100ms... (Retries left: ${retries - 1})`);
                  await new Promise(resolve => setTimeout(resolve, 100));
                  return decryptRecord(r, retries - 1);
              }
              
              // Final failure log
              console.error("Realtime decryption failed after all retries:", decErr);
              plaintext = '[ERROR: Decryption Failed]';
          }
      }
      return { 
          id: r.id, 
          name: r.name, 
          content: plaintext, 
          created: r.created, 
          updated: r.updated,
          categoryId: r.category 
      };
  };

pb.realtime.subscribe('files', async function (e) {
    
    if (e.record.user !== pb.authStore.model.id) return;
    if (isFinalizingUI) return;
    
    const record = e.record;
    
    // --- 1. Handle Delete ---
    if (e.action === 'delete') {
      const fileIndex = state.files.findIndex(f => f.id === record.id);
      if (fileIndex !== -1) {
        state.files.splice(fileIndex, 1);
        if (state.activeId === record.id) {
            selectCategory(state.activeCategoryId, true);
        }
        showToast(`Note deleted: ${record.name}`, 3000);
      }
    } 
    
    // --- 2. Handle Create / Update ---
    else if (e.action === 'create' || e.action === 'update') {
      
      const newFile = await decryptRecord(record);
      
      // CRITICAL: Map category ID - check if we have a local temp ID that matches this PB ID
      const category = state.categories.find(c => c.id === newFile.categoryId);
      if (category && category.localId && category.localId !== category.id) {
        // This is a sync from another device, update the local file's categoryId to the localId
        newFile.categoryId = category.localId;
      }
      
      const isLocalAction = recentlySavedLocally.has(newFile.id); // Checks for local saves/renames
      
      // a. Check for local 'temp' file replacement (Creation success event)
      const tempFile = state.files.find(f => f.id.startsWith('temp_') && f.name === record.name);
      
      if (e.action === 'create' && tempFile && recentlySavedLocally.has(tempFile.id)) {
          // Case A: Local Optimistic Create Confirmation
          
          const tempIndex = state.files.findIndex(f => f.id === tempFile.id);
          
          if (tempIndex !== -1) {
              // Preserve the client's newest 'updated' time from the temporary file.
              newFile.updated = state.files[tempIndex].updated; 
              
              // CRITICAL: Also preserve the categoryId mapping
              const tempCategoryId = state.files[tempIndex].categoryId;
              if (tempCategoryId && tempCategoryId.startsWith('cat_temp_')) {
                newFile.categoryId = tempCategoryId;
              }
              
              state.files.splice(tempIndex, 1, newFile); // Replace temporary file
          }

          if (state.activeId === tempFile.id) {
              state.activeId = record.id; // Update active ID
          }
          recentlySavedLocally.delete(tempFile.id); // Clear the temp flag
          showToast(`Note created: ${newFile.name}`, 2000);
          
      } else {
        // b. Handle Update of an existing permanent file or remote create
        const fileIndex = state.files.findIndex(f => f.id === record.id);
        
        if (fileIndex !== -1) {
          // Case B: Update of an existing permanent file
          
          if (isLocalAction) { 
              // If we are the originating device, IGNORE the immediate server-confirmation Realtime event.
              return; 
          } 
            
          // If we reach here, it is a remote update from another device.
          
          // CRITICAL FIX: The receiving device must apply a new local timestamp to force the note to the top.
          newFile.updated = new Date().toISOString(); 
            newFile.versionsCache = null; 

          // Remove old file and unshift the new one.
          state.files.splice(fileIndex, 1); // Remove old file
          state.files.unshift(newFile);    // Insert new file at the top
          
          // Remote Update Toast/UI
          showToast(`Note updated: ${newFile.name}`, 2000);
          
          // If active note content changed remotely, force reload/exit preview
          if (state.activeId === newFile.id) {
              if (previewMode) exitPreviewMode();
              if (document.getElementById('textEditor').value !== newFile.content) {
                  loadActiveToEditor(); 
                  showToast(`Active note content synced!`, 2500);
              }
          }
        } 
        // c. Handle Remote Create (If file was not created optimistically on this client)
        else if (e.action === 'create' && !isLocalAction) {
          // Case C: Remote Create (Synched Device)
          // Force a full fetch from server
          await loadUserFiles(); 
          showToast(`New note created: ${newFile.name} (full sync)`, 3000);
          return; // Exit here, loadUserFiles already calls finalizeUIUpdate
        }
      }
    }
    
    finalizeUIUpdate();
    
  });
  
  // CRITICAL FIX: Subscribe to Categories for deletion and creation/update events
  pb.realtime.subscribe('categories', async function (e) {
      if (e.record.user !== pb.authStore.model.id) return;

      const record = e.record;
      
      if (e.action === 'delete') {
          // Remove the category from local state
          const categoryId = record.id;
          state.categories = state.categories.filter(c => c.id !== categoryId);
          
          // Re-evaluate active category if the deleted one was active
          if (state.activeCategoryId === categoryId) {
              selectCategory(DEFAULT_CATEGORY_IDS.WORK, true); 
          }
          
          showToast(`Category deleted: ${record.name}`, 3000);

      } else if (e.action === 'create' || e.action === 'update') {
          // New or updated category record
          
          // NEW: Suppression check for originating client
          // Suppress the Realtime event if the category was just created by this client
if ((e.action === 'create' || e.action === 'update') && recentlySavedLocally.has(record.id)) {
    return; 
}
          
          const index = state.categories.findIndex(c => c.id === record.id);
          
          // CRITICAL FIX: If we receive a 'create' event and the permanent ID already exists in the state,
          // it means this is the originating device's event, and the state was already updated in createCategory().
          /* OLD CODE:
          if (e.action === 'create' && index !== -1) {
              return; // Suppress the redundant create event on the originating device
          }
          */
          
          // Ensure localId is preserved/updated for default categories
          const localId = state.categories[index]?.localId;

          const newCategory = { 
              ...record, 
              localId: localId || record.id // Use existing localId or set to PB ID if custom
          };
          
          if (index !== -1) {
              // Update
              state.categories.splice(index, 1, newCategory);
          } else {
              // Create (should only happen for remote creations OR if the synchronous update was too slow)
              state.categories.push(newCategory);
          }
          
          // Sort categories by sortOrder
          state.categories.sort((a,b) => a.sortOrder - b.sortOrder);
      }
      
      finalizeUIUpdate();
  });

  console.log('PocketBase Realtime subscription established for files and categories collections.');
}
// ===================================================================
// 2. LOAD & SELECT NOTES/CATEGORIES
// ===================================================================
/**
 * Creates the default categories in PocketBase for a new user.
 */
async function createDefaultCategories() {
    if (!pb.authStore.isValid) return [];
    
    const defaultCategories = [
        // CRITICAL: Removed PERSONAL
        { name: 'Work', localId: DEFAULT_CATEGORY_IDS.WORK, iconName: 'icon-work', sortOrder: 1 },
        { name: 'Trash', localId: DEFAULT_CATEGORY_IDS.TRASH, iconName: 'icon-delete', sortOrder: 3 },
    ];
    
    const user = pb.authStore.model.id;
    const createdCategories = [];

    for (const cat of defaultCategories) {
        try {
            const record = await pb.collection('categories').create({
                name: cat.name,
                user: user,
                sortOrder: cat.sortOrder,
                iconName: cat.iconName
            });
            // CRITICAL: Push the PB record with the original localId property
            createdCategories.push({ 
                id: record.id, 
                name: record.name,
                localId: cat.localId, // Store the hardcoded string ID
                iconName: record.iconName, 
                sortOrder: record.sortOrder,
            }); 
        } catch (e) {
            console.error(`Failed to create default category ${cat.name}:`, e);
        }
    }
    
    return createdCategories;
}

async function loadUserFiles() {
  state.files = [];
  state.categories = [];
  state.activeId = null;
  state.activeCategoryId = DEFAULT_CATEGORY_IDS.WORK; // Set default active category

  if (pb.authStore.isValid && derivedKey) {
    // ── LOGGED IN: Load from PocketBase ──
    try {
      // 1. Load Categories
      state.categories = await pb.collection('categories').getFullList({ sort: 'sortOrder, created' });
      
      if (state.categories.length === 0) {
        state.categories = await createDefaultCategories();
      } else {
          // CRITICAL: Inject localId based on ICON, not Name.
          // This allows the user to rename "Work" to anything (e.g., "My Notes") 
          // while keeping it recognized as the system default.
          state.categories = state.categories.map(c => {
              if (c.iconName === 'icon-work') {
                  c.localId = DEFAULT_CATEGORY_IDS.WORK;
              }
              else if (c.iconName === 'icon-delete') {
                  c.localId = DEFAULT_CATEGORY_IDS.TRASH;
              }
              return c;
          });
      }

      // 2. Load Encrypted Files
      const records = await pb.collection('files').getFullList({
        filter: `user = "${pb.authStore.model.id}"`, 
        sort: '-updated',
        expand: 'category' 
      });

      state.files = await Promise.all(records.map(async r => {
        let plaintext = '';
        if (r.iv && r.authTag && r.encryptedBlob) {
          try {
            plaintext = await decryptBlob(
              { iv: b64ToArray(r.iv), authTag: b64ToArray(r.authTag), ciphertext: b64ToArray(r.encryptedBlob) },
              derivedKey
            );
          } catch (err) {
            console.error(`Decryption failed for file ID ${r.id} (${r.name}):`, err);
            plaintext = '[ERROR: Failed to decrypt note. Corrupted data, please delete this file.]';
          }
        }
        return { 
          id: r.id, name: r.name, content: plaintext, created: r.created, updated: r.updated, 
          // CRITICAL: Stored ID is the PocketBase ID
          categoryId: r.category 
        };
      }));
    } catch (e) { 
        console.error("PocketBase Load Failed:", e); 
    }
  } else {
    // ── GUEST MODE: Load from localStorage ──
    let localData = guestStorage.loadData();
    if (!localData || !localData.categories) {
      localData = guestStorage.initData();
      guestStorage.saveData(localData);
    }
    state.categories = localData.categories;
    state.files = localData.files;
    state.files.forEach(f => {
        // CRITICAL: Guest files use the hardcoded string for categoryId
        if (!f.categoryId) f.categoryId = DEFAULT_CATEGORY_IDS.WORK;
    });
  }

  // CRITICAL: Only call createFile if no files are loaded.
  if (state.files.length === 0) {
    // createFile adds the new file to state.files and sets state.activeId
    await createFile();
  }
  
  // This call now runs *after* file creation (if needed) and selects the most recent file (the new one).
  selectCategory(state.activeCategoryId, true); 
  
  // NEW: Sort the state files list before the final UI update for consistency.
  // This is a stable sort: primary by 'updated' (desc), secondary by 'id' (desc string comparison).
  state.files.sort((a, b) => {
      const dateA = new Date(a.updated).getTime();
      const dateB = new Date(b.updated).getTime();
      
      // Primary Sort: descending by date
      if (dateB !== dateA) return dateB - dateA;
      
      // Secondary Sort (Tie-breaker): descending by ID string
      // Ensures a stable order when timestamps are the same.
      return b.id.localeCompare(a.id);
  });
  
  // --- CACHE UPDATE ---
  // Save the fresh server data to local cache so the NEXT refresh is instant
  saveToUserCache(); 
  // --------------------
  
  // This is the single, final, authoritative UI update call for the load process.
  updateOriginalContent();
  finalizeUIUpdate(); 
}

/**
 * Sets the active category, finds the first note in it, and selects it.
 */
function selectCategory(categoryIdentifier, shouldSelectFile = true) {
    state.activeCategoryId = categoryIdentifier;
    
    // Resolve IDs
    let pbCategoryId = categoryIdentifier; 
    let localCategoryIdentifier = categoryIdentifier; 

    if (pb.authStore.isValid) {
        const activeCategoryObject = state.categories.find(c => c.localId === categoryIdentifier || c.id === categoryIdentifier);
        if (activeCategoryObject) {
            pbCategoryId = activeCategoryObject.id;
            localCategoryIdentifier = activeCategoryObject.localId || activeCategoryObject.id;
        }
    }
    
    // Filter notes
    const notesInCategory = state.files
        .filter(f => f.categoryId === pbCategoryId || f.categoryId === localCategoryIdentifier) 
        .sort((a, b) => new Date(b.updated) - new Date(a.updated));

    if (shouldSelectFile) {
        if (notesInCategory.length > 0) {
            // CRITICAL: Always select the first file in the filtered list
            state.activeId = notesInCategory[0].id;
            
            // Only update editor if content is different (prevents cursor jumping)
            const currentEditorVal = document.getElementById('textEditor').value;
            if (notesInCategory[0].content !== currentEditorVal) {
                loadActiveToEditor();
            }
        } else {
            // No notes left? Clear everything
            state.activeId = null;
            document.getElementById('textEditor').value = '';
        }
    }
}


async function createFile() {
    if (previewMode) {
    exitPreviewMode();
    highlightSelectedVersion(null);
  }
  const currentCategory = state.categories.find(c => c.id === state.activeCategoryId || c.localId === state.activeCategoryId);
  const targetCategoryId = state.activeCategoryId;

  if (targetCategoryId === DEFAULT_CATEGORY_IDS.TRASH) {
      showToast('Cannot create a new note in the Trash category.', 3000);
      return; 
  }

  const today = new Date().toISOString().slice(0, 10);
  const baseName = `${currentCategory?.name || 'Note'} ${today}`;
  
  const sameCategoryNotes = state.files.filter(f => f.categoryId === targetCategoryId || f.categoryId === currentCategory?.id);
  const sameDay = sameCategoryNotes.filter(f => f.name?.startsWith(baseName));

  const nextNum = sameDay.length ? Math.max(...sameDay.map(f => {
    const m = f.name.match(/_(\d+)$/);
    return m ? +m[1] : 0;
  })) + 1 : 0;
  const name = nextNum === 0 ? baseName : `${baseName}_${nextNum}`;
  
  if (saveTimeout) {
      clearTimeout(saveTimeout);
      const activeFile = state.files.find(f => f.id === state.activeId);
      if (activeFile) await saveFile(activeFile);
  }

  const now = new Date();
  state.files.sort((a, b) => new Date(b.updated) - new Date(a.updated));
  const latestExistingTimestamp = state.files.length > 0 ? new Date(state.files[0].updated).getTime() : 0;
  const nowTime = now.getTime();
  const guaranteedUniqueTime = Math.max(nowTime, latestExistingTimestamp + 1);
  const newestTimestamp = new Date(guaranteedUniqueTime).toISOString();

  const tempId = `temp_${Date.now()}`; 
  const newFile = {
    id: tempId,
    name,
    content: '',
    created: newestTimestamp,
    updated: newestTimestamp,
    categoryId: targetCategoryId 
  };

  // Optimistic Insert
  state.files.splice(0, 0, newFile); 
  
  // Set Active ID immediately
  state.activeId = tempId;
  
  // FORCE UI update immediately
  finalizeUIUpdate(); 
  
  setTimeout(() => document.getElementById('textEditor').focus(), 0);

  if (pb.authStore.isValid && derivedKey) {
    createFileOnServer(tempId, name, targetCategoryId, newestTimestamp);
  } else {
    guestStorage.saveData({ categories: state.categories, files: state.files });
  }
}

async function createFileOnServer(tempId, name, targetCategoryId, timestamp) {
  try {
    const activeCatObj = state.categories.find(c => 
      c.id === targetCategoryId || 
      c.localId === targetCategoryId ||
      c.localId === `cat_temp_${targetCategoryId.split('_').pop()}` 
    );
    
    let pbCategoryId = activeCatObj?.id;

    if (!pbCategoryId || pbCategoryId.startsWith('cat_temp_')) {
      for (let i = 0; i < 20; i++) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const updatedCatObj = state.categories.find(c => 
          c.localId === targetCategoryId || c.id === targetCategoryId
        );
        if (updatedCatObj && !updatedCatObj.id.startsWith('cat_temp_')) {
          pbCategoryId = updatedCatObj.id;
          break;
        }
      }
    }

    recentlySavedLocally.add(tempId);

    const { ciphertext, iv, authTag } = await encryptBlob('', derivedKey);

    // Disable auto-cancellation
    const result = await pb.collection('files').create({
      name,
      user: pb.authStore.model.id,
      category: pbCategoryId,
      iv: arrayToB64(iv),
      authTag: arrayToB64(authTag),
      encryptedBlob: arrayToB64(ciphertext)
    }, { requestKey: null }); 
    
    const tempFileIndex = state.files.findIndex(f => f.id === tempId);
    if (tempFileIndex !== -1) {
      state.files[tempFileIndex].categoryId = pbCategoryId;
      state.files[tempFileIndex].id = result.id; 
      state.files[tempFileIndex].created = result.created;
      state.files[tempFileIndex].updated = result.updated;

      // CRITICAL FIX: Keep selection on this file when ID changes
      if (state.activeId === tempId) {
          state.activeId = result.id;
      }

      recentlySavedLocally.add(result.id); 
      recentlySavedLocally.delete(tempId); 
    }
    
    finalizeUIUpdate();
    
  } catch (e) {
    if (e.status !== 0) {
        console.error('Create failed on server:', e);
        showToast('Failed to create note on server.', 3000);
    }
    
    const tempIndex = state.files.findIndex(f => f.id === tempId);
    if (tempIndex !== -1) {
      state.files.splice(tempIndex, 1);
      if (state.activeId === tempId) state.activeId = null;
    }
    recentlySavedLocally.delete(tempId);
    finalizeUIUpdate();
  }
}


async function createCategory(name) {
    if (!name?.trim()) return;
    const trimmedName = name.trim();
    const now = new Date().toISOString();
    
    const tempId = `cat_temp_${Date.now()}`; 
    
    const newCategory = {
        id: tempId,
        name: trimmedName,
        iconName: 'icon-folder',
        sortOrder: state.categories.length + 1,
        created: now,
        updated: now,
        localId: tempId // Use tempId as localId for consistency
    };
    
    // Optimistic UI update (Add temp record to state)
    state.categories.push(newCategory);
    state.categories.sort((a,b) => a.sortOrder - b.sortOrder);
    
    // IMPORTANT: Update UI immediately to show the temp category
    finalizeUIUpdate();
    
    let finalCategoryId = newCategory.id; // Default to tempId

    if (pb.authStore.isValid) {
        
        try {
            const record = await pb.collection('categories').create({
                name: trimmedName,
                user: pb.authStore.model.id,
                sortOrder: newCategory.sortOrder,
                iconName: newCategory.iconName,
            });
            
            const permanentCategory = { 
                id: record.id, 
                name: record.name,
                localId: record.id, // IMPORTANT: Use permanent ID as localId
                iconName: record.iconName, 
                sortOrder: record.sortOrder,
                created: record.created,
                updated: record.updated,
            };

            // CRITICAL FIX: Remove ALL instances of the temporary category
            state.categories = state.categories.filter(c => c.id !== tempId && c.localId !== tempId);
            
            // Add the permanent record
            state.categories.push(permanentCategory);
            state.categories.sort((a,b) => a.sortOrder - b.sortOrder);

            recentlySavedLocally.add(record.id); // Add to suppression set for Realtime event
            
            finalCategoryId = record.id; // Set final ID to the permanent PB ID
            showToast(`Category "${trimmedName}" created!`, 2000);
            
            // CRITICAL: Update the UI with permanent category BEFORE creating the note
            finalizeUIUpdate();
            
            // Now create the note with the permanent category ID
            state.activeCategoryId = finalCategoryId;
            await createFile();
            
        } catch (e) {
            console.error('Category creation failed:', e);
            showToast('Failed to create category.', 3000);
            // Revert local state on server failure
            state.categories = state.categories.filter(c => c.id !== tempId && c.localId !== tempId);
            finalizeUIUpdate();
            return; 
        } finally {
             // Ensure the suppression flag is cleared
             setTimeout(() => {
                recentlySavedLocally.delete(finalCategoryId);
            }, 200);
        }
        
    } else {
        // For guest mode, just update the ID and save
        newCategory.id = `cat_guest_${Date.now()}`;
        newCategory.localId = newCategory.id;
        finalCategoryId = newCategory.id;
        guestStorage.saveData({ categories: state.categories, files: state.files });
        showToast(`Category "${trimmedName}" created locally!`, 2000);
        finalizeUIUpdate();
        
        // Create note in guest mode
        state.activeCategoryId = finalCategoryId;
        await createFile();
    }
}
async function saveFile(file) {
  // 1. Optimistic Local Update
  file.updated = new Date().toISOString();
  
  // Reorder list locally
  state.files = state.files.filter(f => f.id !== file.id);
  state.files.unshift(file); 
  
  renderFiles();
  updateSidebarInfo(file);

  // 2. Skip server save for temporary files
  if (file.id.startsWith('temp_')) {
    return;
  }
  
  // 3. Save to PocketBase
  if (pb.authStore.isValid && derivedKey) {
    recentlySavedLocally.add(file.id);

    try {
        const { ciphertext, iv, authTag } = await encryptBlob(file.content, derivedKey);
        
        // --- Resolve Category ID ---
        let finalCategoryId = file.categoryId;
        const categoryRecord = state.categories.find(c => 
            c.localId === file.categoryId || c.id === file.categoryId
        );

        if (categoryRecord && categoryRecord.id && !categoryRecord.id.startsWith('cat_temp_')) {
            finalCategoryId = categoryRecord.id;
        }
        
        // Fallback safety
        if (finalCategoryId === 'work' || finalCategoryId === 'trash') {
             const defaultCat = state.categories.find(c => c.localId === finalCategoryId);
             if (defaultCat && defaultCat.id) finalCategoryId = defaultCat.id;
        }

        const updatePayload = {
          name: file.name,
          category: finalCategoryId, 
          iv: arrayToB64(iv),
          authTag: arrayToB64(authTag),
          encryptedBlob: arrayToB64(ciphertext)
        };
        
        // Run server update (No await, let it run in background)
        pb.collection('files').update(file.id, updatePayload)
          .then((record) => {
             // Sync local state
             const localFile = state.files.find(f => f.id === file.id);
             if (localFile) {
                 localFile.updated = record.updated;
                 if (localFile.categoryId !== record.category) {
                     localFile.categoryId = record.category;
                 }
             }
          })
          .catch(e => {
            console.error('Save failed on server:', e);
          })
          .finally(() => {
             setTimeout(() => recentlySavedLocally.delete(file.id), 200);
          });

    } catch (e) {
        console.error('Encryption error:', e);
        recentlySavedLocally.delete(file.id);
    }

  } else {
    // Guest mode
    guestStorage.saveData({ categories: state.categories, files: state.files });
    finalizeUIUpdate();
  }
    saveToUserCache();

}

// Helper: Extract plain text from TipTap JSON or return string as-is
function getPreviewText(content) {
  if (!content) return '';

  // 1. Try to parse as JSON
  try {
    const json = JSON.parse(content);
    
    // 2. Check if it is a valid TipTap document structure
    if (json.type === 'doc' && Array.isArray(json.content)) {
      
      // 3. Recursive function to find all "text" nodes
      const extractText = (node) => {
        if (node.type === 'text' && node.text) {
          return node.text;
        }
        if (node.content && Array.isArray(node.content)) {
          return node.content.map(child => extractText(child)).join(' ');
        }
        return '';
      };

      return extractText(json);
    }
  } catch (e) {
    // Not JSON, so it's already plain text
  }

  // Fallback: Return original string (Plain text)
  return content;
}

async function clearTrash() {
  if (!confirm('Are you sure you want to permanently delete ALL notes in the Trash? This action cannot be undone.')) {
    return;
  }
  
  const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH; // "trash"
  let trashPbId = null;
  let trashLocalId = trashIdentifier;
  
  // 1. Resolve IDs to find everything visible in the Trash folder
  if (pb.authStore.isValid) {
    const trashCat = state.categories.find(c => c.localId === trashIdentifier || c.id === trashIdentifier);
    if (trashCat) {
        trashPbId = trashCat.id;             
        if (trashCat.localId) trashLocalId = trashCat.localId;
    }
  }

  // 2. Identify files to delete (Server ID OR Local ID)
  const filesToDelete = state.files.filter(f => 
      (trashPbId && f.categoryId === trashPbId) || f.categoryId === trashLocalId
  );
  
  if (filesToDelete.length === 0) {
      showToast('Trash is already empty.', 2000);
      return;
  }
  
  // 3. Batch Delete from Server
  if (pb.authStore.isValid) {
    try {
        const batch = pb.createBatch();
        let hasOps = false;
        
        for (const file of filesToDelete) {
            // Only delete synced files
            if (!file.id.startsWith('temp_')) {
                batch.collection('files').delete(file.id);
                hasOps = true;
            }
        }
        
        if (hasOps) await batch.send();
        
    } catch (e) {
        console.error('Batch delete failed:', e);
        if (e.status !== 0) {
            showToast('Failed to clear some notes from server.', 3000);
        }
    }
  }

  // 4. Local State Cleanup
  const deletedIds = new Set(filesToDelete.map(f => f.id));
  state.files = state.files.filter(f => !deletedIds.has(f.id));
  
  if (!pb.authStore.isValid) {
    guestStorage.saveData({ categories: state.categories, files: state.files });
  }

  // 5. Handle active file selection clearing
  if (state.activeId && deletedIds.has(state.activeId)) {
      state.activeId = null;
      document.getElementById('textEditor').value = '';
      updateOriginalContent(); 
  }

  // 6. Refresh UI
  showToast(`${filesToDelete.length} notes permanently deleted.`, 3000);
  
  // Ensure we are viewing the (now empty) trash category correctly
  if (state.activeCategoryId === trashIdentifier || state.activeCategoryId === trashPbId) {
     selectCategory(trashIdentifier, false);
  }
  
  finalizeUIUpdate();
}

async function deleteFile(id) {
  const file = state.files.find(f => f.id === id);
  if (!file) return;

  const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH;
  let trashCategoryId = trashIdentifier;

  if (pb.authStore.isValid) {
      const trashCatObj = state.categories.find(c => c.localId === trashIdentifier);
      trashCategoryId = trashCatObj?.id || trashIdentifier;
  }

  const wasActive = state.activeId === id;
  const wasLoggedIn = pb.authStore.isValid;
  
  // 1. HARD DELETE (Already in Trash)
  if (file.categoryId === trashCategoryId) {
      if (!confirm(`Permanently delete "${file.name}"?`)) return;

      // Server Delete
      if (wasLoggedIn) {
          pb.collection('files').delete(id).catch(console.error);
      }
      
      // Local Delete
      state.files = state.files.filter(f => f.id !== id);
      if (!wasLoggedIn) guestStorage.saveData({ categories: state.categories, files: state.files });

      // Handle Selection
      if (wasActive) {
          state.activeId = null; // Clear ID
          selectCategory(state.activeCategoryId, true); // Select Next
          if (!state.activeId) await createFile(); // Or create new
      }
      
      finalizeUIUpdate();
      return;
  }

  // 2. SOFT DELETE (Move to Trash)
  if (!confirm(`Move "${file.name}" to Trash?`)) return;

  const oldCategory = file.categoryId;
  
  // Update state immediately
  file.categoryId = trashCategoryId;
  
  // Server Update
  if (wasLoggedIn) {
      pb.collection('files').update(id, { category: trashCategoryId })
        .catch(e => {
            console.error('Move failed:', e);
            file.categoryId = oldCategory; // Revert on fail
            finalizeUIUpdate();
        });
  } else {
      guestStorage.saveData({ categories: state.categories, files: state.files });
  }
  
  // Handle Selection
  if (wasActive) {
    state.activeId = null; // CRITICAL: Force system to pick a NEW note
    selectCategory(state.activeCategoryId, true); 
    
    // If we moved the last note, create a new one immediately
    if (!state.activeId) {
        await createFile();
        return; 
    }
  }

  finalizeUIUpdate();
}

// === Helper function to create a folder item (with SVG icon) ===
function createFolderItem(name, id, isActive = false, iconName = 'icon-folder', noteCount = 0, isDeletable = false, isTrash = false) {
  const folderDiv = document.createElement('div');
  folderDiv.className = 'folder-item' + (isActive ? ' active' : '');
  folderDiv.dataset.folderId = id;

  const iconSvg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  iconSvg.setAttribute('class', 'btn-icon folder-icon');
  iconSvg.setAttribute('width', '20');
  iconSvg.setAttribute('height', '20');
  iconSvg.setAttribute('viewBox', '0 0 24 24');
  iconSvg.setAttribute('fill', 'none');

  const useElement = document.createElementNS("http://www.w3.org/2000/svg", "use");
  useElement.setAttribute('href', `#${iconName}`);
  iconSvg.appendChild(useElement);

  const nameSpan = document.createElement('span');
  nameSpan.className = 'folder-name';
  nameSpan.textContent = name;
  
  // NEW: Note Count Span
  const countSpan = document.createElement('span');
  countSpan.className = 'folder-count';
  countSpan.textContent = noteCount;

  folderDiv.appendChild(iconSvg);
  folderDiv.appendChild(nameSpan);
  folderDiv.appendChild(countSpan); // <-- ADDED

  // NEW: Add the dots menu button for category actions
  const moreBtn = document.createElement('button');
  moreBtn.className = 'more-btn';
  moreBtn.textContent = '⋯';
  moreBtn.type = 'button';
  moreBtn.style.marginLeft = '10px'; 
  moreBtn.style.padding = '0 6px'; 
  moreBtn.style.alignSelf = 'center';
  moreBtn.style.flexShrink = '0';
  
  moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      showCategoryMenu(moreBtn, id, name, isDeletable, isTrash); 
  });
  
  folderDiv.appendChild(moreBtn);

  return folderDiv;
}

// === Updated renderFiles() with Dynamic Categories and Filtering ===
function renderFiles() {
  const list = document.getElementById('filesList');
  if (!list) return;

  list.innerHTML = '';

  // 1. =======================
// CATEGORIES HEADER (Collapsible)
// ==========================
const categoriesHeader = document.createElement('div');
categoriesHeader.className = 'notes-header-row category-toggle-header';

const title = document.createElement('span');
title.className = 'categories-title';
title.textContent = 'Categories';

const addFolderBtn = document.createElement('button');
addFolderBtn.className = 'new-note-btn-small';
addFolderBtn.textContent = '+';
addFolderBtn.title = 'New category';

// Show for both logged-in users AND guest users when categories are expanded
if (isCategoriesExpanded) {
  addFolderBtn.addEventListener('click', (e) => {
    e.stopPropagation();

    // NEW: Check for premium status before allowing creation
    if (!isUserPremium()) {
        showUpgradeModal();
        return;
    }

    // Existing logic continues here for premium users...
    const name = prompt('New category name:');
    if (name?.trim()) {
      createCategory(name);
    }
  });
} else {
  addFolderBtn.style.visibility = 'hidden';
  addFolderBtn.style.pointerEvents = 'none';
}

categoriesHeader.addEventListener('click', (e) => {
  // Only toggle if the click is not on the '+' button area
  if (!e.target.closest('.new-note-btn-small')) {
    isCategoriesExpanded = !isCategoriesExpanded;
    // Save the preference to localStorage (use string 'true' or 'false')
    localStorage.setItem('kryptNote_categoriesExpanded', isCategoriesExpanded.toString());
    renderFiles();
  }
});

categoriesHeader.appendChild(title);
categoriesHeader.appendChild(addFolderBtn);
list.appendChild(categoriesHeader);

  // 2. =======================
  // FOLDERS (DYNAMICALLY RENDERED)
  // ==========================
if (isCategoriesExpanded) {
  const foldersSection = document.createElement('div');
  foldersSection.className = 'folders-section';

  const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH;
  const workIdentifier = DEFAULT_CATEGORY_IDS.WORK; 

  // Calculate note counts for all categories
  const categoryMap = state.files.reduce((acc, file) => {
      const catId = file.categoryId;
      acc[catId] = (acc[catId] || 0) + 1;
      return acc;
  }, {});
  
// Utility function to get the correct count based on whether we use PB ID or localId
const getNoteCount = (cat) => {
    // CRITICAL FIX: Base the count on the PB ID only, as files use the PB ID once synced.
    // The single initial note uses the PB ID after createCategory updates state.
    const pbId = cat.id;
    
    // Fallback: If it's a default category, check the localId as well to catch temporary notes (like on the main client before sync)
    // NOTE: This fallback logic is necessary for Work/Trash categories
    const localId = cat.localId;
    
    // Start with the count for the permanent PB ID
    let count = categoryMap[pbId] || 0;
    
    // If the category has a distinct localId (like 'work' or 'trash') and it's not the same as the PB ID,
    // we also count the files under the localId. This handles optimistic files/guest files.
    if (localId && localId !== pbId) {
        count += categoryMap[localId] || 0;
    }
    
    return count;
};
  
  const trashCategory = state.categories.find(c => c.localId === trashIdentifier || c.id === trashIdentifier);
  
let sortedCategories = state.categories
    // Filter out trash for sorting, using either localId or PB ID for comparison
    .filter(c => c.localId !== trashIdentifier && (pb.authStore.isValid ? c.id !== trashCategory?.id : c.id !== trashIdentifier))
    // NEW: Remove duplicates by ID
    .filter((category, index, self) => 
        index === self.findIndex((c) => c.id === category.id)
    )
    .sort((a,b) => a.sortOrder - b.sortOrder);
  
  if (trashCategory) {
      sortedCategories.push(trashCategory); // Add Trash back at the end
  }
  
  sortedCategories.forEach(c => {
      const identifier = c.localId || c.id; // Use localId for defaults, PB ID for custom
      const isActive = identifier === state.activeCategoryId;
      const isTrash = identifier === trashIdentifier;
      const isWork = identifier === workIdentifier; 
      
      // Custom folders (not Work or Trash) are deletable
      const isDeletable = !isTrash && !isWork; 
      
      const folderItem = createFolderItem(
          c.name, 
          identifier, 
          isActive,
          c.iconName,
          getNoteCount(c), // Pass the calculated note count
          isDeletable,
          isTrash
      );
      
      folderItem.addEventListener('click', e => {
          if (e.target.closest('.more-btn')) return; 
          selectCategory(identifier);
          finalizeUIUpdate(); 
      });
      
      foldersSection.appendChild(folderItem);
  });

  list.appendChild(foldersSection);
  
  const divider = document.createElement('div');
  divider.className = 'folders-divider'; 
  list.appendChild(divider);
}

  // 3. =======================
  // NOTES TITLE & FILTERED NOTES
  // ==========================
 const notesHeader = document.createElement('div');
// CHANGE: Apply a new class when categories are collapsed for better visual separation
notesHeader.className = 'notes-header-row' + (isCategoriesExpanded ? '' : ' notes-header-collapsed');
  
const activeCategory = state.categories.find(c => c.localId === state.activeCategoryId || c.id === state.activeCategoryId);

const notesTitle = document.createElement('span');
notesTitle.className = 'categories-title';
notesTitle.textContent = activeCategory ? `${activeCategory.name} Notes` : 'Your Notes'; 

// NEW: Add the New Note Button
const newNoteBtnSmall = document.createElement('button');
newNoteBtnSmall.className = 'new-note-btn-small';
newNoteBtnSmall.textContent = '+';
newNoteBtnSmall.title = 'Create New Note';
newNoteBtnSmall.addEventListener('click', (e) => {
    e.stopPropagation();
    createFile();
});

notesHeader.appendChild(notesTitle);
notesHeader.appendChild(newNoteBtnSmall); // ADDED the button
list.appendChild(notesHeader);
  
  // 4. =======================
  // RENDER DYNAMIC NOTES (FILTERED BY ACTIVE CATEGORY)
  // ==========================
  
  // CRITICAL FIX: Determine both the PB ID and the Local/Temporary ID for filtering
  let pbCategoryId = state.activeCategoryId; 
  let localCategoryIdentifier = state.activeCategoryId; 

  if (pb.authStore.isValid && activeCategory) {
      pbCategoryId = activeCategory.id;
      // Ensure localCategoryIdentifier is either the localId ('work') or the PB ID if no localId exists
      localCategoryIdentifier = activeCategory.localId || activeCategory.id;
  }
  
  const filteredFiles = state.files
    // CRITICAL: Filter notes by EITHER the PB ID OR the Local ID (to catch new 'temp_' notes)
    .filter(f => f.categoryId === pbCategoryId || f.categoryId === localCategoryIdentifier)
    .sort((a, b) => new Date(b.updated) - new Date(a.updated));

  if (filteredFiles.length === 0) {
      const emptyMsg = document.createElement('div');
      emptyMsg.className = 'file-item muted';
      emptyMsg.style.justifyContent = 'center';
      emptyMsg.style.minHeight = '30px';
      emptyMsg.innerHTML = '<span class="file-preview">[No notes in this category]</span>';
      list.appendChild(emptyMsg);
      return;
  }
  
  filteredFiles.forEach(f => {
    const d = document.createElement('div');
    d.className = 'file-item' + (f.id === state.activeId ? ' active' : '');
    d.dataset.id = f.id;

    const rawText = getPreviewText(f.content?.trim());
    let previewText = '';

    if (!rawText) {
      previewText = '[Empty note]';
    } else {
      // Get first meaningful line, truncated
      const firstLine = rawText.split('\n')[0];
      previewText = firstLine.length > 35 
        ? firstLine.substring(0, 35) + '...' 
        : firstLine;
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = 'file-content';

    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = f.name || 'Untitled';
    nameSpan.title = f.name || 'Untitled';

    const previewSpan = document.createElement('span');
    previewSpan.className = 'file-preview';
    previewSpan.textContent = previewText;

    const moreBtn = document.createElement('button');
    moreBtn.className = 'more-btn';
    moreBtn.textContent = '⋯';
    moreBtn.type = 'button';

    contentDiv.appendChild(nameSpan);
    contentDiv.appendChild(previewSpan);
    d.appendChild(contentDiv);
    d.appendChild(moreBtn);

    d.addEventListener('click', e => {
      if (!e.target.closest('.more-btn')) {
        selectFile(f.id);
      }
    });

    moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      showFileMenu(moreBtn, f.id, f.name);
    });

    list.appendChild(d);
  });
}

function showCategoryMenu(btn, id, name, isDeletable, isTrash) {
  if (currentMenu) currentMenu.remove();
  
  const menu = document.createElement('div');
  menu.className = 'file-context-menu'; 
  
  let menuHTML = '';

  if (isTrash) {
    // TRASH MENU: Clear Trash
    menuHTML = `
      <button class="ctx-delete ctx-clear-trash danger-item">
        <div class="icon-box"><svg class="btn-icon"><use href="#icon-delete"></use></svg></div>
        <span>Clear Trash</span>
      </button>
    `;
  } else {
    // WORK / CUSTOM CATEGORY MENU: Rename
    menuHTML += `
      <button class="ctx-rename">
        <svg class="btn-icon"><use href="#icon-rename"></use></svg>
        Rename
      </button>
    `;
    
    if (isDeletable) {
      // CUSTOM CATEGORY MENU: Delete (Move to Trash + Delete Category)
      menuHTML += `
        <button class="ctx-delete ctx-delete-category danger-item">
          <div class="icon-box"><svg class="btn-icon"><use href="#icon-delete"></use></svg></div>
          <span>Delete Category</span>
        </button>
      `;
    }
  }

  menu.innerHTML = menuHTML;
  document.body.appendChild(menu);

  const r = btn.getBoundingClientRect();
  
  // Position the menu
  let top = r.bottom + 4;
  if (top + menu.offsetHeight > window.innerHeight) {
    top = r.top - menu.offsetHeight - 4;
  }
  
  menu.style.top = top + 'px';
  menu.style.left = r.left + 'px';
  
  if (r.left + menu.offsetWidth > window.innerWidth) {
      menu.style.left = r.right - menu.offsetWidth + 'px'; 
  }

  // --- Event Listeners ---
  
  // 1. Clear Trash
  if (isTrash) {
    menu.querySelector('.ctx-clear-trash').onclick = () => {
      menu.remove();
      clearTrash();
    };
  } 
  
// 2. Rename Category (For Work and Custom Categories)
if (!isTrash) {
  menu.querySelector('.ctx-rename').onclick = async () => {
      menu.remove();
      
      const newName = prompt(`Rename category "${name}" to:`, name);
      if (!newName?.trim() || newName.trim() === name) { return; }

      const trimmedName = newName.trim();
      const category = state.categories.find(c => c.id === id || c.localId === id);
      if (!category) { return; }
      
      const oldName = category.name;
      category.name = trimmedName; // Optimistic update
      
      // Update the UI immediately
      if (id === state.activeCategoryId) {
         const activeCategoryTitle = document.querySelector('.categories-title');
         if(activeCategoryTitle) activeCategoryTitle.textContent = `${trimmedName} Notes`;
      }
      finalizeUIUpdate();

      if (pb.authStore.isValid) {
          // Ensure we have a valid PB ID
          if (category.id && !category.id.startsWith('cat_temp_') && !category.id.startsWith('cat_guest_')) {
              
              // 1. ADD TO SUPPRESSION LIST
              recentlySavedLocally.add(category.id);

              try {
                  await pb.collection('categories').update(category.id, { name: trimmedName }); 
                  showToast(`Category renamed to: ${trimmedName}`, 2000); 
              }
              catch (e) { 
                  console.error('Rename failed on server:', e); 
                  category.name = oldName; // Revert
                  showToast('Category rename failed', 3000); 
                  finalizeUIUpdate(); 
              }
              finally {
                  // 2. REMOVE FROM SUPPRESSION LIST AFTER SHORT DELAY
                  setTimeout(() => recentlySavedLocally.delete(category.id), 500);
              }
          }
      } else {
           guestStorage.saveData({ categories: state.categories, files: state.files });
           showToast(`Category renamed to: ${trimmedName}!`, 2000); 
           finalizeUIUpdate();
      }
  };
}

  // 3. Delete Category
  if (isDeletable) {
    menu.querySelector('.ctx-delete-category').onclick = async () => {
        if (!confirm(`Are you sure you want to delete category "${name}"? All notes in it will be moved to Trash.`)) {
            return;
        }
        menu.remove();
        
        const categoryToDelete = state.categories.find(c => c.id === id || c.localId === id);
        if (!categoryToDelete) { return; }
        
        const categoryToDeleteId = pb.authStore.isValid ? categoryToDelete.id : categoryToDelete.localId || categoryToDelete.id;
        const filesToMove = state.files.filter(f => f.categoryId === categoryToDeleteId);
        
        const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH;
        const trashCategory = state.categories.find(c => c.localId === trashIdentifier || c.id === trashIdentifier);
        const trashCategoryId = pb.authStore.isValid ? trashCategory?.id : trashIdentifier;
        
        if (!trashCategoryId) {
            showToast('Cannot delete: Trash category not found.', 4000);
            return;
        }

        if (pb.authStore.isValid) {
            const promises = filesToMove.map(f => 
                pb.collection('files').update(f.id, { category: trashCategoryId })
                .then(() => f.categoryId = trashCategoryId) 
                .catch(e => console.error(`Failed to move file ${f.id} to trash:`, e))
            );
            await Promise.all(promises);
        } else {
            filesToMove.forEach(f => f.categoryId = trashCategoryId);
        }

        if (pb.authStore.isValid && categoryToDelete.id) {
            try {
                await pb.collection('categories').delete(categoryToDelete.id);
            } catch (e) {
                console.error('Category deletion failed:', e);
                showToast('Category deletion failed on server.', 4000);
            }
        }

        state.categories = state.categories.filter(c => c.id !== id && c.localId !== id);
        
        if (!pb.authStore.isValid) {
            guestStorage.saveData({ categories: state.categories, files: state.files });
        }
        
        if (state.activeCategoryId === id) {
            selectCategory(DEFAULT_CATEGORY_IDS.WORK, true); 
        }

        showToast(`Category "${name}" deleted. Notes moved to Trash.`, 4000);
        finalizeUIUpdate();
    };
  }

  // --- Menu Close Logic ---
  const close = (e) => {
    if (!menu.contains(e.target) && !btn.contains(e.target)) {
      menu.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);

  currentMenu = menu;
}

function showFileMenu(btn, id, name) {
  if (currentMenu) currentMenu.remove();

  const file = state.files.find(f => f.id === id);
  if (!file) return;
  
  // Determine if the file is in the Trash category
  const isTrash = file.categoryId === DEFAULT_CATEGORY_IDS.TRASH || 
                  (pb.authStore.isValid && state.categories.find(c => c.localId === DEFAULT_CATEGORY_IDS.TRASH)?.id === file.categoryId);

  const deleteText = isTrash ? 'Permanently Delete' : 'Move to Trash';

  const menu = document.createElement('div');
  menu.className = 'file-context-menu';
  menu.innerHTML = `
<button class="ctx-rename">
  <svg class="btn-icon"><use href="#icon-rename"></use></svg>
  Rename
</button>

<button class="ctx-info">
  <svg class="btn-icon"><use href="#icon-info"></use></svg>
  Note Info
</button>

<button class="ctx-versions">
  <svg class="btn-icon"><use href="#icon-history"></use></svg>
  Versions
</button>

<button class="ctx-download">
  <svg class="btn-icon"><use href="#icon-download"></use></svg>
  Download
</button>

<button class="ctx-share">
  <svg class="btn-icon"><use href="#icon-export"/></svg> <!-- Reusing export icon or add a share icon -->
  Share
</button>

<button class="ctx-delete">
  <svg class="btn-icon"><use href="#icon-delete"></use></svg>
  ${deleteText}
</button>
  `;

  document.body.appendChild(menu);

  const r = btn.getBoundingClientRect();
  
  // SIMPLE FIX: Position the menu
  let top = r.bottom + 4;
  
  // Check if menu would go off-screen
  if (top + menu.offsetHeight > window.innerHeight) {
    // Move it above the button instead
    top = r.top - menu.offsetHeight - 4;
  }
  
  menu.style.top = top + 'px';
  menu.style.left = r.left + 'px';

  const close = (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);

  currentMenu = menu;

  menu.querySelector('.ctx-rename').onclick = async () => {
    const newName = prompt('New name:', name);
    if (!newName?.trim()) { menu.remove(); return; }

    const trimmedName = newName.trim();
    const file = state.files.find(f => f.id === id);
    if (!file) { menu.remove(); return; }

    if (file.name !== trimmedName) {
        
        const oldName = file.name;
        file.name = trimmedName;

        recentlySavedLocally.add(file.id); 

        if (pb.authStore.isValid) {
          try { 
            await pb.collection('files').update(id, { name: trimmedName }); 
            showToast(`Note renamed to: ${trimmedName}`, 2000); 
          }
          catch (e) { 
            console.error(e); 
            file.name = oldName; 
            showToast('Rename failed', 3000); 
          }
        } else {
          guestStorage.saveData({ categories: state.categories, files: state.files });
          showToast(`Note renamed to: ${trimmedName}`, 2000); 
        }
        
        setTimeout(() => recentlySavedLocally.delete(file.id), 200);
        
        renderFiles();
        finalizeUIUpdate();
    }
    
    menu.remove();
  };

  menu.querySelector('.ctx-info').onclick = () => {
    selectFile(id);
    openSidebarTab('note-info');
    menu.remove();
  };

  menu.querySelector('.ctx-versions').onclick = () => {
    selectFile(id);
    openSidebarTab('version-history');
    menu.remove();
  };

  menu.querySelector('.ctx-download').onclick = () => {
    downloadNote(file);
    menu.remove();
  };

  menu.querySelector('.ctx-share').onclick = () => {
    openShareModal(id);
    menu.remove();
  };

  menu.querySelector('.ctx-delete').onclick = () => {
    deleteFile(id); // deleteFile now handles the soft/hard delete logic internally
    menu.remove();
  };
}

function loadActiveToEditor() {
  const f = state.files.find(x => x.id === state.activeId);
  const newContent = f ? f.content : '';

  // --- STANDARD NOTES LOGIC ---
  if (isUserPremium()) {
    if (newContent.trim().startsWith('{"type":"doc"')) {
      isRichMode = true;
    } else if (newContent.trim().length > 0) {
      isRichMode = false;
    } else {
      isRichMode = false; 
    }
  } else {
    isRichMode = false;
  }
  
  applyEditorMode(); 
  updateEditorModeUI();

  // 1. Load Plain Text Editor
  const textarea = document.getElementById('textEditor');
  if (textarea.value !== newContent) {
    textarea.value = newContent;
  }

  // 2. Load Rich Text Editor WITH SAFE LOADING
  if (tiptapEditor) {
    // Temporarily disable the onUpdate handler to prevent auto-save
    const originalOnUpdate = tiptapEditor.options.onUpdate;
    tiptapEditor.options.onUpdate = undefined;
    
    try {
      if (!newContent) {
        tiptapEditor.commands.setContent('');
      } else {
        try {
          const json = JSON.parse(newContent);
          tiptapEditor.commands.setContent(json);
        } catch (e) {
          // Manual JSON construction
          const lines = newContent.split('\n');
          const docStructure = {
            type: 'doc',
            content: lines.map(line => ({
              type: 'paragraph',
              content: line ? [{ type: 'text', text: line }] : [] 
            }))
          };
          tiptapEditor.commands.setContent(docStructure);
        }
      }
    } finally {
      // Restore the onUpdate handler after a short delay
      setTimeout(() => {
        tiptapEditor.options.onUpdate = originalOnUpdate;
      }, 100);
    }
  }
  
  originalContent = newContent;
}

function openSidebarTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === tabName);
  });
  
  const file = state.files.find(f => f.id === state.activeId);
  
  if (tabName === 'note-info') {
    updateSidebarInfo(file);
  } else if (tabName === 'version-history') {
    updateVersionHistory(file); 
    updateVersionFooter(); 
  }
}

function updateSidebarInfo(file = null) {
  const infoFileNameDisplay = document.getElementById('infoFileName');
  const infoFileId = document.getElementById('infoFileId');
  const infoCreated = document.getElementById('infoCreated');
  const infoModified = document.getElementById('infoModified');
  const encryptionOffline = document.getElementById('encryptionOffline');
  const encryptionOnline = document.getElementById('encryptionOnline');
  
  // Select buttons
  const infoDownload = document.getElementById('infoDownload');
  const infoShare = document.getElementById('infoShare'); // <--- NEW
  
  if (infoFileNameDisplay) {
    infoFileNameDisplay.onblur = null;
    infoFileNameDisplay.onkeydown = null;
    infoFileNameDisplay.onclick = null; 
  }

  // --- NO FILE SELECTED ---
  if (!file) {
    if (infoFileNameDisplay) infoFileNameDisplay.textContent = '—';
    if (infoFileId) infoFileId.textContent = '—';
    if (infoCreated) infoCreated.textContent = '—';
    if (infoModified) infoModified.textContent = '—';

    // Disable buttons
    if (infoDownload) { infoDownload.disabled = true; infoDownload.onclick = null; }
    if (infoShare) { infoShare.disabled = true; infoShare.onclick = null; } // <--- NEW
    
    if (encryptionOffline) encryptionOffline.style.display = 'flex';
    if (encryptionOnline) encryptionOnline.style.display = 'none';

    return;
  }

  // --- FILE SELECTED ---
  const isLoggedIn = pb.authStore.isValid && derivedKey;
  
  if (infoFileNameDisplay) infoFileNameDisplay.textContent = file.name;
  if (infoFileId) infoFileId.textContent = file.id;
  if (infoCreated) infoCreated.textContent = formatDate(file.created);
  if (infoModified) infoModified.textContent = formatDate(file.updated);

  if (encryptionOffline && encryptionOnline) {
      encryptionOffline.style.display = isLoggedIn ? 'none' : 'flex';
      encryptionOnline.style.display = isLoggedIn ? 'flex' : 'none';
  }
  
  // Enable Download
  if (infoDownload) {
    infoDownload.disabled = false;
    infoDownload.onclick = () => downloadNote(file);
  }

  // Enable Share (NEW)
  if (infoShare) {
    infoShare.disabled = false;
    infoShare.onclick = () => openShareModal(file.id);
  }
}

async function saveVersionIfChanged() {
  console.error('function', (new Error()).stack.split('\n')[1].trim().split(' ')[1], 'runed:');
  const file = state.files.find(f => f.id === state.activeId);
  
  // 1. Determine Content and Mode
  let currentContent = '';
  let versionMode = 'plain'; 

  if (isRichMode && tiptapEditor) {
      currentContent = JSON.stringify(tiptapEditor.getJSON());
      versionMode = 'rich';
  } else {
      currentContent = document.getElementById('textEditor').value;
      versionMode = 'plain';
  }

  if (!file || currentContent === originalContent) return;

  if (isSavingVersion) return;
  isSavingVersion = true;

  try {
    if (pb.authStore.isValid && derivedKey) {
      // Pass 'versionMode' 
      await createVersionSnapshot(pb, derivedKey, file.id, currentContent, versionMode); 
      file.versionsCache = null; 
    } else {
      // Guest Mode
      if (!file.versions) file.versions = [];
      file.versions.unshift({
        id: `v_${Date.now()}_${Math.random().toString(36).substr(2,6)}`,
        created: new Date().toISOString(),
        content: originalContent, 
        editor: isRichMode ? 'rich' : 'plain'
      });
      if (file.versions.length > 50) file.versions.length = 50;
      guestStorage.saveData({ categories: state.categories, files: state.files });
    }

    originalContent = currentContent;
    
    // --- FIX 1: Explicitly refresh the history list immediately ---
    await updateVersionHistory(file); 
    // --------------------------------------------------------------

  } catch (e) {
    console.error('Version save failed:', e);
  } finally {
    isSavingVersion = false;
  }
}

function updateOriginalContent() {
  if (isRichMode && tiptapEditor) {
      originalContent = JSON.stringify(tiptapEditor.getJSON());
  } else {
      originalContent = document.getElementById('textEditor').value;
  }
}

async function updateVersionHistory(file = null) {
  console.error('function', (new Error()).stack.split('\n')[1].trim().split(' ')[1], 'runed:');
  const versionList = document.getElementById('versionList');
  if (!versionList) return;

  // CANCEL any previous background request
  if (versionHistoryController) {
    versionHistoryController.abort();
    versionHistoryController = null; 
  }
  
  if (!file || !file.id) {
    versionList.innerHTML = '<li class="muted">No note selected.</li>';
    versionList.classList.remove('loading');
    return;
  }

  // --- HEADER SETUP ---
  const titleElement = document.querySelector('#version-history h4');
  let titleHTML = 'History'; 
  let iconName = 'icon-history'; 
  let badgeHTML = ''; 
  let badgeClass = '';
  const isLoggedIn = pb.authStore.isValid;
  const isPremium = isUserPremium(); 

  if (!isLoggedIn) {
    badgeHTML = 'Guest (3 Days)';
    badgeClass = 'badge-guest';
  } else if (isPremium) {
    badgeHTML = 'Pro (Unlimited)';
    badgeClass = 'badge-premium';
    iconName = 'icon-crown';
  } else {
    badgeHTML = 'Free (7 Days)';
    badgeClass = 'badge-free';
  }

  if (titleElement) {
    titleElement.innerHTML = `
      <svg class="btn-icon" style="margin-right: -2px;"><use href="#${iconName}"/></svg>
      <div class="version-title-group">
        <span>${titleHTML}</span>
        <span class="version-badge ${badgeClass}">${badgeHTML}</span>
      </div>
    `;
  }

  // --- CACHE LOGIC ---
  let versions = [];
  let useCache = false;

  // 1. Check if we already have versions in memory (Logged In)
  if (isLoggedIn && file.versionsCache) {
    versions = file.versionsCache;
    useCache = true;
  } 
  // 2. Check Local Storage (Guest)
  else if (!isLoggedIn && file.versions) {
    versions = file.versions;
    useCache = true;
  }

  // Only show "Loading..." if we don't have a cache
  if (!useCache) {
    versionList.innerHTML = '<li class="muted" style="padding:12px;">Loading...</li>';
    versionList.classList.add('loading');
  } else {
    versionList.classList.remove('loading');
  }

  // --- FETCH LOGIC ---
  if (!useCache && isLoggedIn && derivedKey) {
    if (file.id.startsWith('temp_')) {
      versions = [];
    } else {
      versionHistoryController = new AbortController();
      try {
        versions = await getVersions(pb, derivedKey, file.id, versionHistoryController.signal);
        
        // **CRITICAL: Sort versions by date (newest first)**
        versions.sort((a, b) => {
          const dateA = new Date(a.created).getTime();
          const dateB = new Date(b.created).getTime();
          return dateB - dateA; // Descending: newest first
        });
        
        // SAVE TO CACHE
        file.versionsCache = versions;
      } catch (e) {
        if (e.name === 'AbortError' || e.isAbort || (e.status === 0 && e.message.includes('autocancelled'))) return;
        
        if (e.status === 0 || e.message.includes('Failed to fetch')) {
          versionList.innerHTML = `
            <li class="version-item" style="cursor: default; border-left: 3px solid #f59e0b; background: #fffbeb;">
              <strong style="color: #92400e;">Offline / Slow Connection</strong>
              <small style="color: #b45309;">History unavailable</small>
            </li>
          `;
          versionList.classList.remove('loading');
          return;
        }
        versions = [];
      }
    }
  }

  // **ALSO SORT GUEST VERSIONS**
  if (!isLoggedIn && versions.length > 0) {
    versions.sort((a, b) => {
      const dateA = new Date(a.created).getTime();
      const dateB = new Date(b.created).getTime();
      return dateB - dateA; // Descending: newest first
    });
  }

  // --- RENDER LOGIC ---
  let html = `
    <li class="version-current">
      <strong>Current version</strong>
      <small>${formatDate(file.updated)}</small>
    </li>
  `; 

  const filteredVersions = versions.filter(v => v.content !== file.content);

  if (filteredVersions.length === 0) {
    html += `<li class="muted">No previous versions saved yet.</li>`;
  } else {
    filteredVersions.forEach(v => {
      const rawText = getPreviewText(v.content);
      const preview = rawText.length > 50 ? rawText.substring(0, 50) + '...' : rawText || '[empty]';
      
      html += `
        <li class="version-item" data-version-id="${v.id}">
          <strong>${formatDate(v.created)}</strong>
          <small>${preview}</small>
        </li>
      `;
    });
  }

  versionList.innerHTML = html;
  versionList.classList.remove('loading');

  // Re-attach listeners
  versionList.querySelector('.version-current')?.addEventListener('click', () => {
    exitPreviewMode();
    loadActiveToEditor();
    highlightSelectedVersion(null);
  });

  versionList.querySelectorAll('.version-item').forEach(item => {
    item.addEventListener('click', () => {
      const versionId = item.dataset.versionId;
      const version = versions.find(v => v.id === versionId); 
      if (version) {
        enterPreviewMode(version);
        highlightSelectedVersion(versionId);
      }
    });
  });

  if (previewMode && previewVersion) highlightSelectedVersion(previewVersion.id);
  else highlightSelectedVersion(null);
  
  versionHistoryController = null; 
}

// Helper function to handle toolbar visibility
function setToolbarVisibility(visible) {
  document.querySelectorAll('.toolbar-container').forEach(el => {
    el.style.display = visible ? '' : 'none';
  });
}

function enterPreviewMode(version) {
  // Capture original state
  if (originalBeforePreview === '') {
    originalBeforePreview = isRichMode && tiptapEditor 
      ? JSON.stringify(tiptapEditor.getJSON())
      : document.getElementById('textEditor').value;
    originalEditorMode = isRichMode;
  }

  // Determine version mode and ensure it has editor property
  const versionIsRich = version.editor === 'rich' || 
    (!version.editor && version.content.trim().startsWith('{"type":"doc"'));

  // Set editor property if missing
  if (!version.editor) {
    version.editor = versionIsRich ? 'rich' : 'plain';
  }

  // Hide toolbars
  setToolbarVisibility(false);

  // Show the correct wrapper and load content
  const plainWrap = document.getElementById('plainWrapper');
  const richWrap = document.getElementById('richWrapper');

  if (versionIsRich) {
    plainWrap.classList.add('hidden');
    richWrap.classList.remove('hidden');
    
    try {
      tiptapEditor.commands.setContent(JSON.parse(version.content));
    } catch(e) {
      tiptapEditor.commands.setContent(`<p>${version.content}</p>`);
    }
    
    tiptapEditor.setOptions({ editable: false });
    document.querySelector('.ProseMirror')?.classList.add('preview-mode');
  } else {
    richWrap.classList.add('hidden');
    plainWrap.classList.remove('hidden');
    
    const textarea = document.getElementById('textEditor');
    textarea.value = version.content;
    textarea.disabled = true;
    textarea.classList.add('preview-mode');
  }

  // Create banner
  createPreviewBanner(version.created);

  previewMode = true;
  previewVersion = version;
}

// And update exitPreviewMode to restore editability:
function exitPreviewMode() {
  // Restore original mode
  isRichMode = originalEditorMode;
  applyEditorMode();

  // Restore content
  if (isRichMode) {
    try {
      const json = JSON.parse(originalBeforePreview);
      tiptapEditor.commands.setContent(json);
    } catch(e) {
      const lines = originalBeforePreview.split('\n');
      const docStructure = {
        type: 'doc',
        content: lines.map(line => ({
          type: 'paragraph',
          content: line ? [{ type: 'text', text: line }] : []
        }))
      };
      tiptapEditor.commands.setContent(docStructure);
    }
    
    // CRITICAL: Restore editability
    tiptapEditor.setOptions({ editable: true });
    document.querySelector('.ProseMirror')?.classList.remove('preview-mode');
    document.querySelector('.ProseMirror')?.setAttribute('contenteditable', 'true');
  } else {
    document.getElementById('textEditor').value = originalBeforePreview;
  }

  // Clean up preview state
  document.getElementById('textEditor').disabled = false;
  document.getElementById('textEditor').classList.remove('preview-mode');

  // Remove banner and show toolbars
  document.getElementById('previewBanner')?.remove();
  setToolbarVisibility(true);

  // Reset state
  previewMode = false;
  previewVersion = null;
  originalBeforePreview = '';
}

// Simplified createPreviewBanner
function createPreviewBanner(date) {
  // Remove existing banner
  document.getElementById('previewBanner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'previewBanner';
  banner.className = 'preview-banner';
  banner.innerHTML = `
    <div class="banner-text">Previewing version from ${formatDate(date)} (Read Only)</div>
    <div class="banner-actions">
      <button id="restoreBtn">Restore This Version</button>
      <button id="cancelBtn">Exit Preview</button>
    </div>
  `;

  // Insert into active wrapper before editor
  const activeWrapper = document.querySelector('.editor-mode-wrapper:not(.hidden)');
  const editorArea = activeWrapper?.querySelector('.editor-left');
  
  if (activeWrapper && editorArea) {
    activeWrapper.insertBefore(banner, editorArea);
  }

  // Attach events
  banner.querySelector('#restoreBtn').onclick = handleRestore;
  banner.querySelector('#cancelBtn').onclick = () => {
    exitPreviewMode();
    highlightSelectedVersion(null);
  };
}

async function handleRestore() {
  const file = state.files.find(f => f.id === state.activeId);
  if (!file) return;

  // 1. Lock to prevent interference from blur events
  if (isSavingVersion) return;
  isSavingVersion = true;

  try {
    // 2. Exit preview mode FIRST and capture the version
    const versionToRestore = previewVersion; 
    exitPreviewMode();
    
    if (!versionToRestore) {
      showToast('No version to restore', 2000);
      return;
    }

    // 3. Save the content we want to restore
    const contentToRestore = versionToRestore.content;
    const restoredFromTimestamp = versionToRestore.created;
    
    // 4. Determine editor mode safely
    const editorMode = versionToRestore.editor || 
                      (contentToRestore.trim().startsWith('{"type":"doc"') ? 'rich' : 'plain');
    
    // 5. SMART BACKUP: Save CURRENT content as a version only if it differs from the latest snapshot
    // This prevents the "000" duplicate issue.
    if (file.content !== '' && pb.authStore.isValid && derivedKey) {
        let shouldBackup = true;
        
        // Check against the cache (which is populated if the history tab is open)
        if (file.versionsCache && file.versionsCache.length > 0) {
            // Compare current content with the most recent version in history
            const latestVersion = file.versionsCache[0];
            if (latestVersion.content === file.content) {
                shouldBackup = false; // It's already saved, don't duplicate
            }
        }

        if (shouldBackup) {
            await createVersionSnapshot(pb, derivedKey, file.id, file.content, isRichMode ? 'rich' : 'plain');
        }
    }
    
    // 6. Update the file with NEW timestamp locally
    const now = new Date().toISOString();
    file.content = contentToRestore;
    file.updated = now;
    
    // 7. Load into editor based on content type
    if (editorMode === 'rich' || contentToRestore.trim().startsWith('{"type":"doc"')) {
      isRichMode = true;
      updateEditorModeUI();
      if (tiptapEditor) {
        try {
          const json = JSON.parse(contentToRestore);
          tiptapEditor.commands.setContent(json);
        } catch (e) {
          // Fallback to plain text
          const lines = contentToRestore.split('\n');
          const docStructure = {
            type: 'doc',
            content: lines.map(line => ({
              type: 'paragraph',
              content: line ? [{ type: 'text', text: line }] : []
            }))
          };
          tiptapEditor.commands.setContent(docStructure);
        }
      }
    } else {
      isRichMode = false;
      updateEditorModeUI();
      const textarea = document.getElementById('textEditor');
      if (textarea) {
        textarea.value = contentToRestore;
        textarea.dispatchEvent(new Event('input'));
      }
    }

    // 8. CRITICAL: Update baseline to prevent blur-save
    if (isRichMode && tiptapEditor) {
        originalContent = JSON.stringify(tiptapEditor.getJSON());
    } else {
        originalContent = contentToRestore;
    }

    // 9. Save the file (Update "Current Version" on server)
    await saveFile(file);
    
    // 10. Save for guest users (Simple Append)
    if (!pb.authStore.isValid) {
      if (!file.versions) file.versions = [];
      file.versions.unshift({
        id: `restored_${Date.now()}`,
        created: now,
        content: contentToRestore,
        editor: editorMode
      });
      guestStorage.saveData({ categories: state.categories, files: state.files });
    }

    // 11. Force refresh UI
    renderFiles();
    updateSidebarInfo(file);
    
    // Invalidate cache so the new "Backup" (if created) appears
    file.versionsCache = null; 
    await updateVersionHistory(file);
    
    showToast(`Version from ${formatDate(restoredFromTimestamp)} restored!`, 2000);

  } catch (e) {
    console.error("Restore failed:", e);
    showToast("Failed to restore version", 3000);
  } finally {
    // Unlock always
    isSavingVersion = false;
  }
}



function showToast(message, duration = 2500) {
  const oldToast = document.getElementById('appToast');
  if (oldToast) oldToast.remove();

  const toast = document.createElement('div');
  toast.id = 'appToast';
  toast.className = 'app-toast';
  toast.textContent = message;

  document.body.appendChild(toast);

  toast.offsetHeight;

  toast.classList.add('show');

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, duration);
}

function isUserPremium() {
    if (!pb.authStore.isValid) return false;
    
    const user = pb.authStore.model;
    if (!user || !user.plan_expires) return false;
    
    const expiry = new Date(user.plan_expires);
    const now = new Date();
    return expiry > now;
}



function highlightSelectedVersion(versionId) {
  const versionList = document.getElementById('versionList');
  if (!versionList) return;

  versionList.querySelectorAll('.version-item, .version-current').forEach(el => {
    el.classList.remove('selected');
  });

  if (versionId) {
    versionList.querySelector(`.version-item[data-version-id="${versionId}"]`)?.classList.add('selected');
  } else {
    versionList.querySelector('.version-current')?.classList.add('selected');
  }
}

function formatDate(dateString) {
  if (!dateString) return '—';
  const date = new Date(dateString);
  return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function downloadNote(file) {
  const blob = new Blob([file.content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${file.name}.txt`;
  a.click();
}

// Auto-save
let saveTimeout = null;
document.getElementById('textEditor')?.addEventListener('input', () => {
  const file = state.files.find(f => f.id === state.activeId);
  if (!file) return;
  file.content = document.getElementById('textEditor').value;
  const now = new Date().toISOString();
  file.updated = now;
  clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => saveFile(file), 800);
  renderFiles();
  updateSidebarInfo(file);
});

document.getElementById('textEditor')?.addEventListener('blur', async () => {
  await saveVersionIfChanged();
});

function selectFile(id) {
  // 1. Exit Preview if active
  if (previewMode) {
    exitPreviewMode();
    highlightSelectedVersion(null);
  }

  // 2. Update State
  state.activeId = id;
  const file = state.files.find(f => f.id === id);

  // 3. Update Category State (Keep consistency)
  if (file) {
      const targetCategory = state.categories.find(c => c.id === file.categoryId || c.localId === file.categoryId);
      if (targetCategory) {
          state.activeCategoryId = targetCategory.localId || targetCategory.id;
      }
  }

  // 4. FAST UI UPDATE (Toggle CSS instead of re-rendering list)
  const prevActive = document.querySelector('.file-item.active');
  if (prevActive) prevActive.classList.remove('active');

  const nextActive = document.querySelector(`.file-item[data-id="${id}"]`);
  if (nextActive) nextActive.classList.add('active');

  // 5. Load Content
  loadActiveToEditor();
  updateSidebarInfo(file);

  // 6. OPTIMIZED HISTORY FETCH
  // Only fetch versions if the History tab is currently VISIBLE
  const historyPanel = document.getElementById('version-history');
  if (historyPanel && historyPanel.classList.contains('active')) {
      if (file) {
          // Fire-and-forget (background fetch) to prevent UI freeze
          updateVersionHistory(file).catch(err => console.error(err));
      }
  } else {
      // If tab is hidden, clear the list to avoid showing old data later
      const versionList = document.getElementById('versionList');
      if (versionList) versionList.innerHTML = ''; 
  }
}


function finalizeUIUpdate() {
  // If we are currently rendering the DOM, queue the next update
  if (isFinalizingUI) {
      uiUpdateQueued = true; 
      return;
  }
  
  clearTimeout(finalizeUIUpdateTimeout);

  finalizeUIUpdateTimeout = setTimeout(() => {
    // Double check lock
    if (isFinalizingUI) {
        uiUpdateQueued = true;
        return;
    }
    
    isFinalizingUI = true;
    uiUpdateQueued = false;

    try {
      const file = state.files.find(f => f.id === state.activeId);
      
      // 1. Sort Files (Synchronous/Fast)
      state.files.sort((a, b) => {
        const timeA = new Date(a.updated).getTime();
        const timeB = new Date(b.updated).getTime();
        if (timeA !== timeB) return timeB - timeA; 
        return a.name.localeCompare(b.name);
      });
      
      // 2. Update Editor & Sidebar (Synchronous/Fast)
      renderFiles();
      loadActiveToEditor();
      updateSidebarInfo(file);

      // 3. Trigger History Fetch in BACKGROUND (Non-blocking)
      // We removed 'await' so the UI doesn't freeze while fetching
      if (file) {
        updateVersionHistory(file).catch(err => console.error("History bg fetch error", err)); 
      } else {
        // Clear history immediately if no file
        const versionList = document.getElementById('versionList');
        if(versionList) {
            versionList.innerHTML = '<li class="muted">No note selected.</li>';
            versionList.classList.remove('loading');
        }
      }
      
      updateVersionFooter();

    } catch(e) {
      console.error("UI Update failed:", e);
    } finally {
      // Unlock immediately after DOM updates are done
      // (We do NOT wait for the network request anymore)
      isFinalizingUI = false;
      
      // If user clicked another note while we were rendering, run again
      if (uiUpdateQueued) {
          finalizeUIUpdate();
      }
    }
  }, 0);
}


// NEW: Save version on page unload (optional)
window.addEventListener('beforeunload', async (event) => {
  if (document.getElementById('textEditor').value !== originalContent) {
    await saveVersionIfChanged();
  }
});
// Toolbar Slider
function setupToolbarSlider() {
  const oldNavButtons = document.querySelectorAll('#nav_default, #nav_tools');
  oldNavButtons.forEach(btn => {
    if (btn.parentNode) {
      btn.remove();
    }
  });
  
  const toolsBtn = document.getElementById('toolsMenuBtn');
  const toolsDropdown = document.getElementById('toolsDropdown');
  
  if (toolsBtn && toolsDropdown) {
    toolsBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      
      const rect = toolsBtn.getBoundingClientRect();
      toolsDropdown.style.top = (rect.bottom + 4) + 'px';
      toolsDropdown.style.left = rect.left + 'px';
      
      toolsDropdown.classList.toggle('hidden');
    });
    
    document.addEventListener('click', (e) => {
      if (!toolsBtn.contains(e.target) && !toolsDropdown.contains(e.target)) {
        toolsDropdown.classList.add('hidden');
      }
    });
    
    const toolButtons = toolsDropdown.querySelectorAll('button');
    toolButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        toolsDropdown.classList.add('hidden');
      });
    });
  }
}

// Toolbar Buttons
['undo','redo'].forEach(id => document.getElementById(id+'Btn')?.addEventListener('click', () => document.execCommand(id)));
document.getElementById('copyBtn')?.addEventListener('click', () => { const el = document.activeElement; if (el?.tagName === 'TEXTAREA' || el?.tagName === 'INPUT') el.select(); document.execCommand('copy'); });
['cut','paste'].forEach(id => document.getElementById(id+'Btn')?.addEventListener('click', () => document.execCommand(id)));
document.getElementById('selectAllBtn')?.addEventListener('click', () => {
  document.getElementById('textEditor')?.select();
});


document.getElementById('tool_remove_duplicates')?.addEventListener('click', () => {
  const e = document.getElementById('textEditor');
  e.value = e.value.split('\n').filter((l,i,a) => l.trim() && a.indexOf(l) === i).join('\n');
  e.dispatchEvent(new Event('input'));
});
document.getElementById('tool_sort_lines')?.addEventListener('click', () => {
  const e = document.getElementById('textEditor');
  e.value = e.value.split('\n').filter(l => l.trim()).sort((a,b) => a.localeCompare(b)).join('\n');
  e.dispatchEvent(new Event('input'));
});
document.getElementById('tool_remove_empty_lines')?.addEventListener('click', () => {
  const e = document.getElementById('textEditor');
  e.value = e.value.split('\n').filter(line => line.trim() !== '').join('\n');
  e.dispatchEvent(new Event('input'));
});

// Find/Replace Dock
const dock = document.getElementById('findDock'), findIn = document.getElementById('dock_find'), repIn = document.getElementById('dock_replace'), regex = document.getElementById('dock_regex');
let last = 0;
function openDock(m) { dock.classList.remove('hidden'); (m==='find'?findIn:repIn).focus(); }
function closeDock() { dock.classList.add('hidden'); findIn.value = repIn.value = ''; last = 0; }
document.getElementById('findDockBtn')?.addEventListener('click', () => dock.classList.contains('hidden') || document.activeElement !== findIn ? openDock('find') : closeDock());
document.getElementById('replaceDockBtn')?.addEventListener('click', () => dock.classList.contains('hidden') || document.activeElement !== repIn ? openDock('replace') : closeDock());
document.getElementById('dock_close')?.addEventListener('click', closeDock);

document.getElementById('dock_find_btn')?.addEventListener('click', () => {
  const q = findIn.value; if (!q) return alert('Enter text');
  const e = document.getElementById('textEditor');
  const p = regex.checked ? new RegExp(q,'g') : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),'g');
  p.lastIndex = last; const m = p.exec(e.value);
  if (m) { const s = m.index, en = s + m[0].length; e.setSelectionRange(s,en); e.focus(); last = en; }
  else { last = 0; alert('No match'); }
});

document.getElementById('dock_replace_btn')?.addEventListener('click', () => {
  const q = findIn.value, r = repIn.value; if (!q) return alert('Enter text');
  const e = document.getElementById('textEditor'), isReg = regex.checked;
  const p = isReg ? new RegExp(q) : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (e.selectionStart !== e.selectionEnd) {
    const sel = e.value.slice(e.selectionStart, e.selectionEnd);
    if (p.test(sel)) {
      const rep = sel.replace(p, r);
      e.value = e.value.slice(0,e.selectionStart) + rep + e.value.slice(e.selectionEnd);
      e.setSelectionRange(e.selectionStart, e.selectionStart + rep.length);
      e.dispatchEvent(new Event('input'));
    } else alert('No match');
  } else {
    const m = p.exec(e.value);
    if (m) {
      const s = m.index, en = s + m[0].length;
      e.value = e.value.slice(0,s) + m[0].replace(p,r) + e.value.slice(en);
      e.setSelectionRange(s, s + (m[0].replace(p,r)).length);
      e.dispatchEvent(new Event('input'));
    } else alert('No match');
  }
});

document.getElementById('dock_replace_all_btn')?.addEventListener('click', () => {
  const q = findIn.value, r = repIn.value; if (!q) return alert('Enter text');
  const e = document.getElementById('textEditor');
  const p = regex.checked ? new RegExp(q,'g') : new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),'g');
  e.value = e.value.replace(p, r);
  e.dispatchEvent(new Event('input'));
  alert('Done');
});




const pBtn = document.getElementById('profileBtn'), pDrop = document.getElementById('profileDropdown'),
  mDef = document.getElementById('menuDefault'), mLog = document.getElementById('menuLoggedIn'),
  lForm = document.getElementById('loginForm'), sForm = document.getElementById('signupForm');

function toggleDrop() {
  const isHidden = pDrop.classList.contains('hidden');
  pDrop.classList.toggle('hidden');
  if (!isHidden) resetDropdownState();
}
function resetDropdownState() {
  lForm.classList.add('hidden'); sForm.classList.add('hidden');
  if (pb.authStore.isValid) {
    mDef.classList.add('hidden'); mLog.classList.remove('hidden');
  } else {
    mDef.classList.remove('hidden'); mLog.classList.add('hidden');
  }
}
function showMenu() { resetDropdownState(); }
function showLogin() { mDef.classList.add('hidden'); mLog.classList.add('hidden'); sForm.classList.add('hidden'); lForm.classList.remove('hidden'); document.getElementById('loginEmail').focus(); }
function showSignup() { mDef.classList.add('hidden'); mLog.classList.add('hidden'); lForm.classList.add('hidden'); sForm.classList.remove('hidden'); document.getElementById('signupName').focus(); }

function updateProfileState() {
  const user = pb.authStore.model;
  const isLoggedIn = pb.authStore.isValid;
  
  const rawName = user?.name || user?.email?.split('@')[0] || 'Guest User';
  const firstLetter = rawName.charAt(0);
  
  let statusText = 'Guest';
  let statusClass = 'guest';
  const isPremium = isUserPremium(); // Refactored

  if (isLoggedIn) {
     if (isPremium) {
        statusText = 'Premium Plan';
        statusClass = 'premium';
     } else {
        statusText = 'Free Plan';
        statusClass = 'free';
     }
  }

  const pBtn = document.getElementById('profileBtn');
  if (pBtn) {
    pBtn.innerHTML = `
        <div class="avatar">${firstLetter}</div>
        <div class="info">
            <div class="name" title="${rawName}">${rawName}</div>
            <div class="status ${statusClass}">${statusText}</div>
        </div>
        <div class="profile-dots">⋯</div>
    `;
  }

  const encryptionOffline = document.getElementById('encryptionOffline');
  const encryptionOnline = document.getElementById('encryptionOnline');
  
  if (encryptionOffline && encryptionOnline) {
      if (isLoggedIn) {
        encryptionOffline.style.display = 'none';
        encryptionOnline.style.display = 'flex';
      } else {
        encryptionOffline.style.display = 'flex';
        encryptionOnline.style.display = 'none';
      }
  }

  const upgradeBtn = document.getElementById('upgradeBtn');
  
  if (isLoggedIn && upgradeBtn) {
    if (isPremium) {
      upgradeBtn.style.display = 'none';
    } else {
      upgradeBtn.style.display = 'flex';
      upgradeBtn.onclick = () => window.location.href = 'Pricing.html';
    }
  }
  
  showMenu(); 
  updateVersionFooter();
}

function updateVersionFooter() {
  // 1. Check if user previously dismissed the footer
  if (localStorage.getItem('kryptNote_dismissFooter') === 'true') {
    return;
  }

  const historyPanel = document.getElementById('version-history');
  if (!historyPanel) return;

  const existingFooter = document.getElementById('versionFooter');
  if (existingFooter) {
    existingFooter.remove();
  }

  // Refactored: Use helper instead of manual date check
  const isPremium = isUserPremium();

  if (isPremium) {
    return;
  }

  let footerContent;

  if (!pb.authStore.isValid) {
    footerContent = `
      <div class="sign-in-text">Sign in to keep the last 7 days</div>
      <div class="pro-text">
        <a href="Pricing.html" style="color:var(--accent1);text-decoration:none;">Go Pro</a> for unlimited versions
      </div>
    `;
  }
  else {
    footerContent = `
      <div class="pro-text">
        <a href="Pricing.html" style="color:var(--accent1);text-decoration:none;">Upgrade</a> to restore all previous versions.
      </div>
    `;
  }

  // 2. Add the button HTML (×)
  const fullFooterHTML = `
    <div class="sticky-bottom-box" id="versionFooter">
      ${footerContent}
      <button id="dismissFooterBtn" class="footer-close-btn" title="Dismiss">×</button>
    </div>
  `;

  historyPanel.insertAdjacentHTML('beforeend', fullFooterHTML);

  // 3. Add Event Listener to Dismiss and Save to Storage
  document.getElementById('dismissFooterBtn').addEventListener('click', (e) => {
    e.stopPropagation(); // Prevent triggering any parent clicks
    const footer = document.getElementById('versionFooter');
    if (footer) footer.remove();
    
    // Save preference so it doesn't appear again on reload
    localStorage.setItem('kryptNote_dismissFooter', 'true');
  });
}

pBtn?.addEventListener('click', toggleDrop);
document.getElementById('loginBtn')?.addEventListener('click', showLogin);
document.getElementById('signupBtn')?.addEventListener('click', showSignup);
document.getElementById('logoutBtn')?.addEventListener('click', () => { logout(); toggleDrop(); });
document.getElementById('submitLogin')?.addEventListener('click', async () => {
  const e = document.getElementById('loginEmail').value.trim(), p = document.getElementById('loginPassword').value;
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(e)) {
    return alert('Please enter a valid email address.');
  }
  if (e && p) await login(e, p);
});
document.getElementById('submitSignup')?.addEventListener('click', async () => {
  const n = document.getElementById('signupName').value.trim();
  const e = document.getElementById('signupEmail').value.trim();
  const p = document.getElementById('signupPassword').value;
  const pc = document.getElementById('signupPasswordConfirm').value;

  if (!n || !e || !p || !pc) {
    return alert('Please fill in all fields.');
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(e)) {
    return alert('Please enter a valid email address.');
  }

  if (p !== pc) {
    return alert('Passwords do not match.');
  }
  
  if (p.length < 10) {
    return alert('Password must be at least 10 characters long.');
  }

  await signup(n, e, p);
});
document.querySelectorAll('#backToMenu, #backToMenuSignup').forEach(b => b.addEventListener('click', showMenu));
document.addEventListener('click', e => {
  if (!pBtn.contains(e.target) && !pDrop.contains(e.target)) pDrop.classList.add('hidden');
});

document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    openSidebarTab(btn.dataset.tab);
  });
});
document.querySelectorAll('.submenu .dropdown-item').forEach(item => {
  item.addEventListener('click', () => {
    document.getElementById('profileDropdown').classList.add('hidden');
  });
});
// --- Upgrade Modal Logic ---
const upgradeModal = document.getElementById('upgradeModal');
const closeUpgradeBtn = document.getElementById('closeUpgradeModal');
const cancelUpgradeBtn = document.getElementById('cancelUpgradeBtn');
const goToPricingBtn = document.getElementById('goToPricingBtn');

function showUpgradeModal() {
    upgradeModal.classList.remove('hidden');
}

function hideUpgradeModal() {
    upgradeModal.classList.add('hidden');
}

if (closeUpgradeBtn) closeUpgradeBtn.addEventListener('click', hideUpgradeModal);
if (cancelUpgradeBtn) cancelUpgradeBtn.addEventListener('click', hideUpgradeModal);

if (goToPricingBtn) {
    goToPricingBtn.addEventListener('click', () => {
        window.location.href = 'Pricing.html';
    });
}

// Close modal when clicking outside
if (upgradeModal) {
    upgradeModal.addEventListener('click', (e) => {
        if (e.target === upgradeModal) hideUpgradeModal();
    });
}

// ==========================================
// SHARE MODAL LOGIC
// ==========================================

const shareModal = document.getElementById('shareModal');
const closeShareModalBtn = document.getElementById('closeShareModal'); // Renamed for clarity
const shareLinkInput = document.getElementById('shareLinkInput');
const shareStepConfig = document.getElementById('shareStepConfig');
const shareResult = document.getElementById('shareResult');
let currentShareFileId = null;

// 1. Define reusable Close/Reset function
function hideShareModal() {
    shareModal.classList.add('hidden');
    
    // Reset the view state after the fade-out animation (200ms)
    setTimeout(() => {
        if (shareStepConfig && shareResult) {
            shareStepConfig.classList.remove('hidden');
            shareResult.classList.add('hidden');
        }
        if (shareLinkInput) shareLinkInput.value = '';
    }, 200);
}

// 2. Attach Close Event to 'X' Button
if (closeShareModalBtn) {
    closeShareModalBtn.onclick = hideShareModal;
}

// 3. Attach Close Event to Backdrop (Click Outside)
if (shareModal) {
    shareModal.addEventListener('click', (e) => {
        // If the click target is the modal container itself (not the card inside)
        if (e.target === shareModal) {
            hideShareModal();
        }
    });
}

// ===================================================================
// TIPTAP & SWITCHING LOGIC
// ===================================================================

function initTiptap() {
  tiptapEditor = new Editor({
    element: document.getElementById('tiptapEditor'),
    extensions: [
      StarterKit,
      TextStyle, 
      Color, 
      Link.configure({ openOnClick: false }),
      Image, 
      Placeholder.configure({ placeholder: 'Write rich text...' }),
      // --- FIX: Add TextAlign Extension ---
      TextAlign.configure({
        types: ['heading', 'paragraph'],
      }),
    ],
    content: '',
    onUpdate: ({ editor }) => {
      updateTiptapToolbar(editor);
      const json = JSON.stringify(editor.getJSON());
      handleAutoSave(json);
    },
    onSelectionUpdate: ({ editor }) => updateTiptapToolbar(editor),
    onBlur: async () => {
        if(isRichMode) await saveVersionIfChanged();
    }
  });
  
  setupTiptapButtons();
}

function setupEditorSwitching() {
  // 1. Toggle the Dropdown Menus
  const triggers = document.querySelectorAll('#editorModeTrigger');
  const dropdowns = document.querySelectorAll('#editorModeDropdown');

  triggers.forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Toggle the specific dropdown next to the button clicked
      const menu = btn.nextElementSibling;
      // Hide others first
      dropdowns.forEach(d => { if(d !== menu) d.classList.add('hidden'); });
      menu.classList.toggle('hidden');
    });
  });

  // Close menus on outside click
  window.addEventListener('click', () => {
    dropdowns.forEach(d => d.classList.add('hidden'));
  });

  // 2. Handle Option Clicks
  const options = document.querySelectorAll('.mode-option');
  const textarea = document.getElementById('textEditor');

  options.forEach(opt => {
    opt.addEventListener('click', () => {
      const targetMode = opt.getAttribute('data-mode');

      // --- CASE A: SWITCHING TO RICH ---
  if (targetMode === 'rich') {
        if (!isUserPremium()) {
           showRichPreviewModal(); 
           return; 
        }

        if (isRichMode) return; 

        const raw = textarea.value;
        
        try {
           // 1. Try to parse as existing JSON (in case it was hidden code)
           const json = JSON.parse(raw);
           // Safety check: ensure it's actually a TipTap doc
           if (json.type === 'doc') {
               tiptapEditor.commands.setContent(json);
           } else {
               throw new Error("Not a doc");
           }
        } catch(e) {
           // 2. ROBUST FALLBACK: Convert Plain Text lines -> TipTap JSON Paragraphs
           // This avoids HTML parsing issues entirely.
           const lines = raw.split('\n');
           const docStructure = {
               type: 'doc',
               content: lines.map(line => ({
                   type: 'paragraph',
                   // If line has text, create a text node. If empty, empty array (creates blank line)
                   content: line ? [{ type: 'text', text: line }] : [] 
               }))
           };
           tiptapEditor.commands.setContent(docStructure);
        }

        isRichMode = true;
        updateEditorModeUI();
        handleAutoSave(JSON.stringify(tiptapEditor.getJSON()));
      }

      // --- CASE B: SWITCHING TO PLAIN ---
      else if (targetMode === 'plain') {
        if (!isRichMode) return; // Already active

        // Warning
        if(!confirm("Switching to Plain Text will remove all formatting (images, colors). Continue?")) return;

        // Convert
        const cleanText = tiptapEditor.getText({ blockSeparator: "\n" });
        textarea.value = cleanText;

        isRichMode = false;
        updateEditorModeUI();
        textarea.dispatchEvent(new Event('input'));
      }
    });
  });
  
  // Initial UI Update
  updateEditorModeUI();
}

function updateEditorModeUI() {
  // 1. Switch the main editor wrappers
  applyEditorMode(); 

  // 2. Update the Toolbar Button Label
  const labelText = isRichMode ? "Super Editor" : "Plain Text";
  document.querySelectorAll('.current-mode-label').forEach(el => el.textContent = labelText);

  // 3. STRICT CHECKMARK UPDATE
  const allOptions = document.querySelectorAll('.mode-option');
  
  // Step A: Reset ALL options first (Fixes "Both Selected" bug)
  allOptions.forEach(btn => btn.classList.remove('selected'));

  // Step B: Select ONLY the correct ones based on current state
  allOptions.forEach(btn => {
    const mode = btn.getAttribute('data-mode');
    
    if (isRichMode && mode === 'rich') {
        btn.classList.add('selected');
    } 
    else if (!isRichMode && mode === 'plain') {
        btn.classList.add('selected');
    }
  });

  // 4. Save preference
  localStorage.setItem('kryptNote_editorMode', isRichMode ? 'rich' : 'plain');
  
  // 5. Toggle Premium Body Class (for styling locks)
  if (isUserPremium()) {
    document.body.classList.add('is-premium');
  } else {
    document.body.classList.remove('is-premium');
  }
}

function applyEditorMode() {
  const plainWrap = document.getElementById('plainWrapper');
  const richWrap = document.getElementById('richWrapper');
  
  if (isRichMode) {
    plainWrap.classList.add('hidden');
    richWrap.classList.remove('hidden');
    setTimeout(() => tiptapEditor?.commands.focus(), 0);
  } else {
    richWrap.classList.add('hidden');
    plainWrap.classList.remove('hidden');
    setTimeout(() => document.getElementById('textEditor').focus(), 0);
  }
}

function updateTiptapToolbar(editor) {
  const set = (id, active) => {
    const btn = document.getElementById(id);
    if(btn) btn.classList.toggle('is-active', active);
  };

  // Standard Buttons
  set('ttBold', editor.isActive('bold'));
  set('ttItalic', editor.isActive('italic'));
  set('ttStrike', editor.isActive('strike'));
  set('ttCode', editor.isActive('code'));
  set('ttBullet', editor.isActive('bulletList'));
  set('ttOrdered', editor.isActive('orderedList'));
  set('ttQuote', editor.isActive('blockquote'));
  set('ttLink', editor.isActive('link'));
  
  // Alignment
  set('ttAlignLeft', editor.isActive({ textAlign: 'left' }));
  set('ttAlignCenter', editor.isActive({ textAlign: 'center' }));
  set('ttAlignRight', editor.isActive({ textAlign: 'right' }));
  
  // Color
  const colorInput = document.getElementById('ttColor');
  if(colorInput && editor.getAttributes('textStyle').color) {
      colorInput.value = editor.getAttributes('textStyle').color;
  }

  // Heading Dropdown Label
  const currentLabel = document.getElementById('currentHeading');
  if (currentLabel) {
    if (editor.isActive('heading', { level: 1 })) currentLabel.textContent = 'Heading 1';
    else if (editor.isActive('heading', { level: 2 })) currentLabel.textContent = 'Heading 2';
    else if (editor.isActive('heading', { level: 3 })) currentLabel.textContent = 'Heading 3';
    else currentLabel.textContent = 'Normal';
  }
}

function setupTiptapButtons() {
  
  // 1. Specialized Handler for History (Undo/Redo)
  const setupHistoryBtn = (id, action) => {
    const btn = document.getElementById(id);
    if (!btn) return;

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault(); // STOP focus loss
      e.stopPropagation(); // Stop bubbling
      
      // Force focus back to editor immediately
      tiptapEditor.view.focus();
      
      // Execute command
      if (action === 'undo') {
        tiptapEditor.commands.undo();
      } else {
        tiptapEditor.commands.redo();
      }
    });
  };

  setupHistoryBtn('ttUndo', 'undo');
  setupHistoryBtn('ttRedo', 'redo');

  // 2. General Handler for Formatting (Bold, Italic, etc.)
  const cmd = (id, callback) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault(); // Stop focus loss
      // Chain allows keeping selection state valid
      callback(tiptapEditor.chain().focus()); 
    });
  };

  // --- FORMATTING ---
  cmd('ttBold', (chain) => chain.toggleBold().run());
  cmd('ttItalic', (chain) => chain.toggleItalic().run());
  cmd('ttStrike', (chain) => chain.toggleStrike().run());
  cmd('ttCode', (chain) => chain.toggleCode().run());

  // --- ALIGNMENT ---
  cmd('ttAlignLeft', (chain) => chain.setTextAlign('left').run());
  cmd('ttAlignCenter', (chain) => chain.setTextAlign('center').run());
  cmd('ttAlignRight', (chain) => chain.setTextAlign('right').run());

  // --- LISTS & QUOTES ---
  cmd('ttBullet', (chain) => chain.toggleBulletList().run());
  cmd('ttOrdered', (chain) => chain.toggleOrderedList().run());
  cmd('ttQuote', (chain) => chain.toggleBlockquote().run());

  // --- SPECIAL INPUTS ---
  
  // Color Picker (FIXED)
  const colorInput = document.getElementById('ttColor');
  if (colorInput) {
      // 1. Intercept the click to prevent the editor from losing focus (and selection)
      colorInput.addEventListener('mousedown', (e) => {
          e.preventDefault(); 
          // Manually trigger the click after a tiny delay so the browser opens the picker
          // without blurring the text editor field.
          setTimeout(() => {
             colorInput.click();
          }, 10);
      });

      // 2. Apply the color
      colorInput.addEventListener('input', (e) => {
          tiptapEditor.chain().focus().setColor(e.target.value).run();
      });
  }
  
  // Link
  document.getElementById('ttLink')?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const previousUrl = tiptapEditor.getAttributes('link').href;
    setTimeout(() => {
        const url = window.prompt('URL', previousUrl);
        if (url === null) return;
        if (url === '') {
            tiptapEditor.chain().focus().extendMarkRange('link').unsetLink().run();
        } else {
            tiptapEditor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
        }
    }, 10);
  });
  
  // Image
  document.getElementById('ttImage')?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    setTimeout(() => {
        const url = window.prompt('Image URL');
        if (url) {
            tiptapEditor.chain().focus().setImage({ src: url }).run();
        }
    }, 10);
  });

  // --- HEADING DROPDOWN ---
  const dropdown = document.getElementById('headingDropdown');
  const trigger = dropdown?.querySelector('.dropdown-trigger');
  
  if (dropdown && trigger) {
      trigger.addEventListener('mousedown', (e) => {
          e.preventDefault();
          dropdown.classList.toggle('is-open');
      });

      dropdown.querySelectorAll('.dropdown-item').forEach(item => {
          item.addEventListener('mousedown', (e) => {
              e.preventDefault(); 
              const level = parseInt(e.target.getAttribute('data-level'));
              if (level === 0) {
                  tiptapEditor.chain().focus().setParagraph().run();
              } else {
                  tiptapEditor.chain().focus().toggleHeading({ level }).run();
              }
              dropdown.classList.remove('is-open');
          });
      });

      window.addEventListener('mousedown', (e) => {
          if (!dropdown.contains(e.target)) dropdown.classList.remove('is-open');
      });
  }
}

document.getElementById('textEditor')?.addEventListener('input', (e) => {
  if (!isRichMode) {
      handleAutoSave(e.target.value);
  }
});

function handleAutoSave(newContent) {
  const file = state.files.find(f => f.id === state.activeId);
  if (!file) return;

  if (file.content !== newContent) {
      file.content = newContent;
      file.updated = new Date().toISOString();
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => saveFile(file), 800);
      updateSidebarInfo(file); // assuming you have this function
  }
}

function openShareModal(fileId) {
    if (!pb.authStore.isValid) {
        showToast("You must be logged in to share notes.");
        return;
    }
    currentShareFileId = fileId;
    
    // Ensure correct initial state before showing
    shareStepConfig.classList.remove('hidden');
    shareResult.classList.add('hidden');
    
    shareModal.classList.remove('hidden');
}

document.getElementById('generateShareBtn')?.addEventListener('click', async () => {
    if (!currentShareFileId) return;
    
    const btn = document.getElementById('generateShareBtn');
    const originalText = btn.innerHTML;
    btn.innerHTML = 'Generating...';
    btn.disabled = true;

    try {
        // 1. Get File
        const file = state.files.find(f => f.id === currentShareFileId);
        if (!file) throw new Error("File not found");

        // 2. Generate Key & Encrypt
        const shareKey = await generateShareKey();
        const { ciphertext, iv, authTag } = await encryptBlob(file.content, shareKey);

        // 3. Handle Expiration Logic
        const expirationValue = document.getElementById('shareExpiration').value;
        let expirationDate = ""; // Default to empty (Unlimited)

        if (expirationValue !== "0") {
            const hours = parseInt(expirationValue);
            const date = new Date();
            date.setTime(date.getTime() + (hours * 60 * 60 * 1000));
            expirationDate = date.toISOString();
        }
        
        // 4. Upload
        const record = await pb.collection('shared_notes').create({
            user: pb.authStore.model.id,
            file: currentShareFileId,
            encryptedBlob: arrayToB64(ciphertext),
            iv: arrayToB64(iv),
            authTag: arrayToB64(authTag),
            expires: expirationDate // Sends ISO string OR empty string
        });

        // 5. Construct Link
        const keyStr = await exportKeyToUrl(shareKey);
        const shareUrl = `${window.location.origin}/share.html?id=${record.id}#key=${keyStr}`;

        // 6. UI Transition
        shareLinkInput.value = shareUrl;
        
        shareStepConfig.classList.add('hidden');
        shareResult.classList.remove('hidden');

    } catch (e) {
        console.error(e);
        showToast('Failed to generate link');
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
});

document.getElementById('copyShareLinkBtn')?.addEventListener('click', () => {
    // 1. Get the text
    const textToCopy = shareLinkInput.value;

    // 2. Use the modern Clipboard API
    navigator.clipboard.writeText(textToCopy).then(() => {
        // --- Success Animation ---
        const copyBtn = document.getElementById('copyShareLinkBtn');
        const originalText = copyBtn.textContent;
        
        copyBtn.textContent = "Copied!";
        copyBtn.style.backgroundColor = "#10b981"; // Green
        copyBtn.style.color = "#ffffff";
        
        setTimeout(() => {
            copyBtn.textContent = originalText;
            copyBtn.style.backgroundColor = ""; // Reset to default
            copyBtn.style.color = "";
        }, 2000);
    }).catch(err => {
        // Fallback for older browsers or if permission denied
        console.error('Async: Could not copy text: ', err);
        
        // Optional: Keep execCommand as a backup if the above fails
        shareLinkInput.select();
        document.execCommand('copy');
    });
});

// Init
initPocketBase();
