import PocketBase from 'https://cdn.jsdelivr.net/npm/pocketbase/dist/pocketbase.es.mjs';
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
import { 
  deriveMasterKey, generateDataKey, wrapDataKey, unwrapDataKey, 
  exportKeyToString, storeDataKeyInSession, loadDataKeyFromSession, 
  encryptBlob, decryptBlob, randomSalt, arrayToB64, b64ToArray ,
  generateShareKey, exportKeyToUrl
} from './crypto.js';

// NEW: PocketBase default category IDs for new user initialization
const DEFAULT_CATEGORY_IDS = {
    WORK: 'work',
    TRASH: 'trash'
};
// NEW: Guest storage key and structure
const GUEST_STORAGE_KEY = 'kryptNoteLocalData';
let tiptapEditor = null;
const SESSION_ID = crypto.randomUUID();
let isRichMode = localStorage.getItem('kryptNote_editorMode') === 'rich'; // Load preference
let previewMode = false;        
let previewVersion = null;      
// Auto-save
let saveTimeout = null;
let originalBeforePreview = ''; 
let activeVersionController = null; // Track the current version fetch

const PB_URL = 'https://pam-unhideous-chastenedly.ngrok-free.dev/';
let pb = null, 
    // UPDATE: Added categories and set default active category
    state = { files: [], activeId: null, categories: [], activeCategoryId: DEFAULT_CATEGORY_IDS.WORK }, 
    currentMenu = null, derivedKey = null;
let originalContent = '';
let isSavingVersion = false;
// ANTI-ABUSE LIMITS
const MAX_FILENAME_LENGTH = 100;    
let isCategoriesExpanded = localStorage.getItem('kryptNote_categoriesExpanded') !== 'false';
let finalizeUIUpdateTimeout = null;
let isFinalizingUI = false;
let versionHistoryController = null;
let uiUpdateQueued = false;
let originalEditorMode = null;
const sharedDateFormatter = new Intl.DateTimeFormat('default', {
  year: 'numeric', 
  month: 'numeric', 
  day: 'numeric',
  hour: '2-digit', 
  minute: '2-digit'
});
let saveQueue = [];
let isProcessingQueue = false;
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


/* =================================================================
   MOBILE UI LOGIC
   ================================================================= */
function setupMobileUI() {
  const mobileMenuBtn = document.getElementById('mobileMenuBtn');
  const mobileInfoBtn = document.getElementById('mobileInfoBtn');
  const overlay = document.getElementById('mobileOverlay');
  const sidebar = document.querySelector('.sidebar');
  const rightSidebar = document.querySelector('.editor-right');

  // Helper to close all
  const closeAllDrawers = () => {
    sidebar.classList.remove('active');
    rightSidebar.classList.remove('active');
    overlay.classList.remove('active');
  };

  // Toggle Left Sidebar
  if (mobileMenuBtn) {
    mobileMenuBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isActive = sidebar.classList.contains('active');
      closeAllDrawers(); // Close others first
      if (!isActive) {
        sidebar.classList.add('active');
        overlay.classList.add('active');
      }
    });
  }

  // Toggle Right Sidebar
  if (mobileInfoBtn) {
    mobileInfoBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isActive = rightSidebar.classList.contains('active');
      closeAllDrawers(); // Close others first
      if (!isActive) {
        rightSidebar.classList.add('active');
        overlay.classList.add('active');
      }
    });
  }

  // Close when clicking overlay
  if (overlay) {
    overlay.addEventListener('click', closeAllDrawers);
  }

  // OPTIONAL: Auto-close sidebar when a file is selected on mobile
  // We attach this to the file list container
  const filesList = document.getElementById('filesList');
  if (filesList) {
    filesList.addEventListener('click', (e) => {
      // Only close if we clicked a file-item AND we are on mobile (window width < 768)
      if (window.innerWidth < 768 && e.target.closest('.file-item')) {
        closeAllDrawers();
      }
    });
  }
}
// Helper to encrypt short strings (names/titles) into a single packed string
async function packEncrypt(text, key) {
    console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
    if (!key) return text;
    const { iv, authTag, ciphertext } = await encryptBlob(text, key);
    return JSON.stringify({
        i: arrayToB64(iv),
        a: arrayToB64(authTag),
        c: arrayToB64(ciphertext)
    });
}

// Helper to decrypt packed strings, with fallback for old plaintext names
async function packDecrypt(packed, key) {
    console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
    if (!key || !packed) return packed;
    try {
        const json = JSON.parse(packed);
        if (!json.i || !json.a || !json.c) return packed; // Not our encrypted format
        return await decryptBlob({
            iv: b64ToArray(json.i),
            authTag: b64ToArray(json.a),
            ciphertext: b64ToArray(json.c)
        }, key);
    } catch (e) {
        return packed; // Return as-is if it's old plaintext
    }
}

// ===================================================================
// POCKETBASE & AUTH
// ===================================================================
// --- RICH PREVIEW SANDBOX LOGIC ---
let previewEditor = null;

function initPreviewEditor() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
    console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);

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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  setupMobileUI(); 

  // 1. Initial Start (Message update)
  toggleAppLoading(true, "Loading Secure Environment...");

  pb = new PocketBase(PB_URL);
  setupEditorSwitching();

  if (pb.authStore.isValid) {
    try {
      await pb.collection('users').authRefresh();
      memoizedIsPremium = null; 
      // This calls restoreEncryptionKeyAndLoad which handles file fetching
      await restoreEncryptionKeyAndLoad();
    } catch (err) {
      logout();
    }
  } else {
    // Guest flow
    await loadUserFiles();
    updateProfileState();
  }

  // 2. ONLY HIDE ONCE EVERYTHING IS LOADED
  toggleAppLoading(false);
  
  initSettings(pb, state, derivedKey);
}

async function restoreEncryptionKeyAndLoad() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  try {
    // 1. Try to retrieve the key from the current session (fastest)
    derivedKey = await loadDataKeyFromSession();
    
    if (derivedKey) {
      // INSTANT UI UPDATE: Show profile info before starting decryption
      updateProfileState();
      
      // Proceed to decrypt files (uses the "No Blackout" loadUserFiles logic)
      await loadUserFiles();
      
      // Setup background sync and realtime
      setupRealtimeSubscription(); 
      setupExport(pb, derivedKey, showToast);
      return;
    }

    // 2. If no session key, check if we have user security data
    const user = pb.authStore.model;
    if (!user || !user.encryptionSalt || !user.wrappedKey) {
      console.warn('Security data missing from user model.');
      logout();
      return;
    }

    // 3. Prompt user to unlock (Standard flow)
    const password = prompt('Session expired. Enter password to unlock notes:');
    if (!password) { 
      logout(); 
      return; 
    }

    const salt = b64ToArray(user.encryptionSalt);
    const masterKey = await deriveMasterKey(password, salt);
    
    const wrappedJson = JSON.parse(atob(user.wrappedKey)); 
    
    derivedKey = await unwrapDataKey({
        iv: b64ToArray(wrappedJson.iv),
        authTag: b64ToArray(wrappedJson.authTag),
        ciphertext: b64ToArray(wrappedJson.ct)
    }, masterKey);

    // Save derived key to session so they don't have to enter password again this session
    const dkStr = await exportKeyToString(derivedKey);
    storeDataKeyInSession(dkStr);

    // 4. Update Profile and Start Loading
    updateProfileState(); // Fix "Guest User" immediately after password entry
    
    await loadUserFiles();
    setupRealtimeSubscription(); 
    setupExport(pb, derivedKey, showToast);

  } catch (e) {
    console.error("Unlock failed:", e);
    alert('Failed to unlock: Wrong password or corrupted key.');
    logout();
  }
}

async function login(email, password) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  const btn = document.getElementById('submitLogin');
  if (previewMode) exitPreviewMode();

  // START LOADING
  toggleAppLoading(true, "Decrypting Vault...");

  try {
    const authData = await pb.collection('users').authWithPassword(email, password);
    const user = authData.record;

    memoizedIsPremium = null;
    updateProfileState(); 
    document.getElementById('profileDropdown').classList.add('hidden');

    if (!user.wrappedKey) throw new Error("Account missing security keys.");

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

    // Sync files
    await loadUserFiles();
    setupRealtimeSubscription(); 
    setupExport(pb, derivedKey, showToast);

    showToast('Logged in! Notes decrypted.');
    return true;

  } catch (e) {
    alert('Login failed: ' + e.message);
    loadUserFiles(); // Restore guest view
    return false;
  } finally {
    // STOP LOADING
    toggleAppLoading(false);
  }
}

async function signup(name, email, password) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  try {
    // 1. Client-Side Encryption
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

    // 2. Server Request
    await pb.collection('users').create({ 
      name, 
      email: email.toLowerCase(), 
      password, 
      passwordConfirm: password, 
      encryptionSalt: saltB64,
      wrappedKey: wrappedB64
    });
    
    // 3. Auto-Login
    return await login(email, password);

  } catch (e) {
    // Case 1: Validation Error (400)
    if (e.status === 400) {
        // Extract validation errors from nested structure (e.data.data)
        const responseData = e.data || {}; 
        const fieldErrors = responseData.data || {}; 

        if (fieldErrors.email) {
            throw new Error("This email is already registered. Please log in.");
        }
        if (fieldErrors.username) {
            throw new Error("Username is already taken.");
        }
        if (fieldErrors.password) {
            throw new Error("Password must be at least 10 characters.");
        }
        if (fieldErrors.passwordConfirm) {
            throw new Error("Passwords do not match.");
        }

        // Fallback message
        throw new Error(responseData.message || "Invalid registration details.");
    }
    
    // Case 2: Offline
    if (e.status === 0 || e.isAbort) {
        throw new Error("No internet connection. Please check your network.");
    }

    // Case 3: Other Server Error
    throw new Error(e.message || "Server error. Please try again later.");
  }
}


function logout() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  toggleAppLoading(true, "Logging out...");

  if (previewMode) exitPreviewMode();
  
  if (pb) {
    pb.realtime.unsubscribe();
  }
  
  // 1. CLEAR AUTH & KEYS
  pb.authStore.clear();
  sessionStorage.removeItem('dataKey');
  derivedKey = null;

  // 2. FORCE UI RESET TO PLAIN MODE
  isRichMode = false;           // Reset global flag
  localStorage.setItem('kryptNote_editorMode', 'plain'); // Reset preference
  destroyTiptap();              // Kill TipTap instance
  
  // 3. RESET STATE
  state = { files: [], activeId: null, categories: [], activeCategoryId: DEFAULT_CATEGORY_IDS.WORK };
  previewMode = false;
  previewVersion = null;
  originalBeforePreview = '';
  originalContent = '';

  // 4. SYNC UI WRAPPERS
  applyEditorMode();            // This hides #richWrapper and shows #plainWrapper
  updateEditorModeUI();         // Updates the toolbar labels/checks

  // 5. RELOAD AS GUEST
  loadUserFiles().then(() => {
    updateProfileState();
    updateVersionFooter();
    toggleAppLoading(false); 
    showToast('Signed out');
  });
}

function setupRealtimeSubscription() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  if (!pb.authStore.isValid || !derivedKey) return;

  pb.realtime.unsubscribe('files');
  pb.realtime.unsubscribe('categories'); 
  pb.realtime.unsubscribe('versions');

  pb.realtime.subscribe('files', async function (e) {
    if (e.record.user !== pb.authStore.model.id) return;
    if (e.record.lastEditor === SESSION_ID) return;

    if (e.action === 'delete') {
      state.files = state.files.filter(f => f.id !== e.record.id);
      if (state.activeId === e.record.id) {
          state.activeId = null;
          loadActiveToEditor();
      }
      showToast(`Note deleted remotely`);
    } 
    else {
      // 1. DECRYPT THE NAME (Metadata Encryption)
      const decryptedName = await packDecrypt(e.record.name, derivedKey);

      // 2. CREATE REMOTE STUB (Metadata only)
      const remoteFile = { 
          id: e.record.id, 
          name: decryptedName, 
          content: null, 
          created: e.record.created, 
          updated: e.record.updated, 
          _localSortTime: new Date(e.record.updated).getTime(),
          categoryId: e.record.category, 
          editor: e.record.editor, 
          lastEditor: e.record.lastEditor, 
          _isLoaded: false, 
          _cachedPreview: null 
      };

      const index = state.files.findIndex(f => f.id === remoteFile.id);
      
      if (index !== -1) {
          if (state.activeId === remoteFile.id) {
              // FORCED CONTENT DECRYPTION (Active note)
              const decryptedContent = await (async () => {
                  try {
                      return await decryptBlob(
                          { iv: b64ToArray(e.record.iv), authTag: b64ToArray(e.record.authTag), ciphertext: b64ToArray(e.record.encryptedBlob) },
                          derivedKey
                      );
                  } catch (err) { return '[Decryption Error]'; }
              })();
              
              remoteFile.content = decryptedContent;
              remoteFile._isLoaded = true;
              remoteFile._cachedPreview = getPreviewText(decryptedContent);
              
              state.files[index] = { ...state.files[index], ...remoteFile };
              loadActiveToEditor();
              
              state.files[index].versionsMetadataCache = null;
              updateVersionHistory(state.files[index]);
          } else {
              // Lazy Update
              state.files[index] = { ...state.files[index], ...remoteFile };
          }
          showToast(`Note updated remotely`);
      } else {
          state.files.unshift(remoteFile);
          showToast(`New note synced`);
      }
    }
    finalizeUIUpdate();
  });
  
  pb.realtime.subscribe('categories', async function (e) {
      if (e.record.user !== pb.authStore.model.id) return;
      if (e.record.lastEditor === SESSION_ID) return;

      if (e.action === 'delete') {
          state.categories = state.categories.filter(c => c.id !== e.record.id);
      } else {
          // DECRYPT THE CATEGORY NAME
          const decryptedName = await packDecrypt(e.record.name, derivedKey);
          const localId = (e.record.iconName === 'icon-work') ? DEFAULT_CATEGORY_IDS.WORK : 
                          (e.record.iconName === 'icon-delete') ? DEFAULT_CATEGORY_IDS.TRASH : e.record.id;
          
          const updatedCat = { ...e.record, name: decryptedName, localId: localId };
          
          const index = state.categories.findIndex(c => c.id === e.record.id);
          if (index !== -1) state.categories[index] = updatedCat;
          else state.categories.push(updatedCat);
          
          state.categories.sort((a,b) => a.sortOrder - b.sortOrder);
      }
      finalizeUIUpdate();
  });

  pb.realtime.subscribe('versions', async function (e) {
      if (e.record.user !== pb.authStore.model.id) return;
      if (e.record.lastEditor === SESSION_ID) return; 
      if (e.action !== 'create') return;

      const file = state.files.find(f => f.id === e.record.file);
      if (!file) return;

      if (!file.versionsMetadataCache) file.versionsMetadataCache = [];
      
      const newVersionMeta = {
          id: e.record.id,
          created: e.record.created,
          editor: e.record.editor || 'plain'
      };

      file.versionsMetadataCache.unshift(newVersionMeta);

      if (state.activeId === file.id) {
          const historyPanel = document.getElementById('version-history');
          if (historyPanel && historyPanel.classList.contains('active')) {
              renderVersionList(file, file.versionsMetadataCache);
          }
      }
  });
}
// ===================================================================
// 2. LOAD & SELECT NOTES/CATEGORIES
// ===================================================================
/**
 * Creates the default categories in PocketBase for a new user.
 */
async function createDefaultCategories() {
    console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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



async function selectCategory(categoryIdentifier, shouldSelectFile = true) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  state.activeCategoryId = categoryIdentifier;
    
  let pbCategoryId = categoryIdentifier; 
  let localCategoryIdentifier = categoryIdentifier; 

  if (pb.authStore.isValid) {
      const activeCategoryObject = state.categories.find(c => c.localId === categoryIdentifier || c.id === categoryIdentifier);
      if (activeCategoryObject) {
          pbCategoryId = activeCategoryObject.id;
          localCategoryIdentifier = activeCategoryObject.localId || activeCategoryObject.id;
      }
  }
    
  const notesInCategory = state.files
      .filter(f => f.categoryId === pbCategoryId || f.categoryId === localCategoryIdentifier);

  if (shouldSelectFile && notesInCategory.length > 0) {
      await selectFile(notesInCategory[0].id);
  } else {
      // FIX: Reset activeId and trigger the Empty State Overlay
      state.activeId = null;
      loadActiveToEditor(); 
      updateSidebarInfo(null);
      finalizeUIUpdate();
  }
}


async function createFile() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  if (previewMode) {
    exitPreviewMode();
    highlightSelectedVersion(null);
  }

  const targetCategoryId = state.activeCategoryId;
  if (targetCategoryId === DEFAULT_CATEGORY_IDS.TRASH) {
    showToast('Cannot create a note in Trash.', 3000);
    return;
  }

  const today = new Date().toISOString().slice(0, 10);
  const baseName = `Note ${today}`;
  const sameDay = state.files.filter(f => f.name?.startsWith(baseName));
  const nextNum = sameDay.length ? Math.max(...sameDay.map(f => {
    const m = f.name.match(/_(\d+)$/);
    return m ? +m[1] : 0;
  })) + 1 : 0;
  const name = nextNum === 0 ? baseName : `${baseName}_${nextNum}`;

  const now = new Date().toISOString();
  // Ensure this is slightly higher than any current timestamp
  const localSortTime = Date.now(); 

  const tempId = `temp_${Date.now()}`;
  const newFile = {
    id: tempId,
    name,
    content: '',
    created: now,
    updated: now,
    _localSortTime: localSortTime,
    categoryId: targetCategoryId,
    _isLoaded: true,
    _cachedPreview: '[Empty note]',
  };

  // Use unshift to be safe, though .sort() in finalizeUIUpdate handles it
  state.files.unshift(newFile);
  state.activeId = tempId;

  loadActiveToEditor();
  originalContent = '';
  
  // Refresh UI immediately
  finalizeUIUpdate();

  if (pb.authStore.isValid && derivedKey) {
    createFileOnServer(tempId, name, targetCategoryId);
  } else {
    const guestId = `guest_${Date.now()}`;
    newFile.id = guestId;
    if (state.activeId === tempId) state.activeId = guestId;
    guestStorage.saveData({ categories: state.categories, files: state.files });
    finalizeUIUpdate();
  }
}

async function createFileOnServer(tempId, name, targetCategoryId) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  try {
    const activeCatObj = state.categories.find(c => c.id === targetCategoryId || c.localId === targetCategoryId);
    const pbCategoryId = activeCatObj?.id;

    // Encrypt both content and name
    const encryptedName = await packEncrypt(name, derivedKey);
    const { ciphertext, iv, authTag } = await encryptBlob('', derivedKey);

    const result = await pb.collection('files').create({
      name: encryptedName, // ENCRYPTED
      user: pb.authStore.model.id,
      category: pbCategoryId,
      iv: arrayToB64(iv),
      authTag: arrayToB64(authTag),
      encryptedBlob: arrayToB64(ciphertext),
      editor: 'plain',
      lastEditor: SESSION_ID
    }, { requestKey: null });

    const tempFile = state.files.find(f => f.id === tempId);
    if (tempFile) {
      const qIndex = saveQueue.indexOf(tempId);
      if (qIndex !== -1) saveQueue[qIndex] = result.id;
      tempFile.id = result.id;
      if (state.activeId === tempId) state.activeId = result.id;
    }
    finalizeUIUpdate();
  } catch (e) {
    saveQueue = saveQueue.filter(id => id !== tempId);
    finalizeUIUpdate();
  }
}

async function performActualSave(file) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  if (pb.authStore.isValid && derivedKey) {
    const editorMode = file.editor || (isRichMode ? 'rich' : 'plain');
    
    // Encrypt Name and Content
    const encryptedName = await packEncrypt(file.name, derivedKey);
    const { ciphertext, iv, authTag } = await encryptBlob(file.content, derivedKey);
    
    const categoryRecord = state.categories.find(c => c.localId === file.categoryId || c.id === file.categoryId);
    const pbCategoryId = categoryRecord?.id || file.categoryId;

    await pb.collection('files').update(file.id, {
      name: encryptedName, // ENCRYPTED
      category: pbCategoryId, 
      iv: arrayToB64(iv),
      authTag: arrayToB64(authTag),
      encryptedBlob: arrayToB64(ciphertext),
      editor: editorMode, 
      lastEditor: SESSION_ID 
    });
  } else if (!pb.authStore.isValid) {
    guestStorage.saveData({ categories: state.categories, files: state.files });
  }
}



async function createCategory(name) {
    console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
    if (!name?.trim()) return;
    const trimmedName = name.trim();
    const now = new Date().toISOString();
    const tempId = `cat_temp_${Date.now()}`; 
    
    const newCategory = {
        id: tempId, name: trimmedName, iconName: 'icon-folder',
        sortOrder: state.categories.length + 1, localId: tempId
    };
    
    state.categories.push(newCategory);
    finalizeUIUpdate();
    
    if (pb.authStore.isValid && derivedKey) {
        try {
            const encryptedName = await packEncrypt(trimmedName, derivedKey);
            const record = await pb.collection('categories').create({
                name: encryptedName, // ENCRYPTED
                user: pb.authStore.model.id,
                sortOrder: newCategory.sortOrder,
                iconName: newCategory.iconName,
                lastEditor: SESSION_ID
            });
            const index = state.categories.findIndex(c => c.id === tempId);
            if (index !== -1) state.categories[index] = { ...record, name: trimmedName, localId: record.id };
            state.activeCategoryId = record.id;
            await createFile(); 
        } catch (e) {
            state.categories = state.categories.filter(c => c.id !== tempId);
        }
    }
    finalizeUIUpdate();
}

async function saveFile(file) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  // 1. Interaction timestamp (already in handleAutoSave, but good for safety)
  file._localSortTime = Date.now();

  // 2. Add to queue if not already there
  if (!saveQueue.includes(file.id)) {
    saveQueue.push(file.id);
  }
  
  // 3. Set flags
  file._isQueued = true;
  file._saveError = false;

  // 4. Update UI (Priority: Saving > Queued)
  updateFilePreviewDOM(file.id, file._isSaving ? "Saving..." : "Queued");

  // 5. Start Processor
  if (!isProcessingQueue) {
    processSaveQueue();
  }
}

async function processSaveQueue() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  if (isProcessingQueue) return;
  isProcessingQueue = true;

  while (saveQueue.length > 0) {
    const currentId = saveQueue[0];
    const file = state.files.find(f => f.id === currentId);

    if (!file) {
      saveQueue.shift();
      continue;
    }

    // Handle Temp ID creation wait
    if (file.id.startsWith('temp_')) {
      if (!file._waitStarted) file._waitStarted = Date.now();
      if (Date.now() - file._waitStarted > 10000) {
        file._saveError = true;
        file._isQueued = false;
        saveQueue.shift();
        continue;
      }
      await new Promise(r => setTimeout(r, 1000));
      continue; 
    }

    // --- START SAVE TASK ---
    file._isSaving = true;
    updateFilePreviewDOM(file.id, "Saving...");

    try {
      await performActualSave(file);
      file._saveError = false;
    } catch (e) {
      console.error("Critical save failure:", e);
      file._saveError = true;
    } finally {
      file._isSaving = false;
      
      // Remove the task we just finished
      saveQueue.shift(); 

      // CHECK: Is this note still in the queue for a follow-up save?
      const stillQueued = saveQueue.includes(file.id);
      file._isQueued = stillQueued;

      if (!stillQueued) {
        // No more saves pending for this note: Restore preview
        const rawText = file._cachedPreview || getPreviewText(file.content);
        const display = rawText.split('\n')[0].substring(0, 35);
        updateFilePreviewDOM(
          file.id, 
          file._saveError ? "Save Failed" : (display || "[Empty note]"), 
          file._saveError
        );
      } else {
        // It is still in queue, next iteration of "while" will pick it up.
        // We keep the text as "Saving..." or "Queued" via updateFilePreviewDOM
        updateFilePreviewDOM(file.id, "Queued");
      }
    }
  }

  isProcessingQueue = false;
}




async function clearTrash() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  const file = state.files.find(f => f.id === id);
  if (!file) return;

  const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH; 
  const trashCat = state.categories.find(c => c.localId === trashIdentifier || c.id === trashIdentifier);
  const trashSystemId = pb.authStore.isValid ? trashCat?.id : trashIdentifier;
  const isInTrash = file.categoryId === trashSystemId || file.categoryId === trashIdentifier;

  if (isInTrash) {
    // === HARD DELETE ===
    if (!confirm(`Permanently delete "${file.name}"?`)) return;

    state.files = state.files.filter(f => f.id !== id);
    if (state.activeId === id) {
        state.activeId = null;
        destroyTiptap(); // <--- CLEANUP
    }

    if (pb.authStore.isValid && !id.startsWith('temp_')) {
      try { await pb.collection('files').delete(id); } catch (e) { console.error(e); }
    }
    showToast("Permanently deleted.");
  } 
  else {
    // === SOFT DELETE ===
    const oldCategoryId = file.categoryId;
    file.categoryId = trashSystemId; 
    file.updated = new Date().toISOString();

    // Clear editor if this was the active note
    if (state.activeId === id) {
       state.activeId = null;
       destroyTiptap(); // <--- CLEANUP
       document.getElementById('textEditor').value = '';
    }

    if (pb.authStore.isValid && !id.startsWith('temp_')) {
      try {
        await pb.collection('files').update(id, { category: trashSystemId, lastEditor: SESSION_ID });
      } catch (e) {
        file.categoryId = oldCategoryId; 
      }
    }
    showToast("Moved to Trash");
  }

  if (!pb.authStore.isValid) {
    guestStorage.saveData({ categories: state.categories, files: state.files });
  }

  if (!state.activeId) {
    selectCategory(state.activeCategoryId, true);
  }
  finalizeUIUpdate();
}

async function createVersionSnapshot(pb, derivedKey, fileId, content, editorMode) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  try {
    const { ciphertext, iv, authTag } = await encryptBlob(content, derivedKey);
    return await pb.collection('versions').create({
      file: fileId,
      user: pb.authStore.model.id,
      encryptedBlob: arrayToB64(ciphertext),
      iv: arrayToB64(iv),
      authTag: arrayToB64(authTag),
      editor: editorMode || 'plain', // Enforced by versions collection rule
      lastEditor: SESSION_ID
    });
  } catch (err) { 
    console.error("Version snapshot failed:", err); 
    throw err; 
  }
}



// === Helper function to create a folder item (with SVG icon) ===
function createFolderItem(name, id, isActive = false, iconName = 'icon-folder', noteCount = 0, isDeletable = false, isTrash = false) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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

// ===================================================================
// NEW: MODULAR SIDEBAR RENDERING
// ===================================================================

/**
 * Helper: Ensures the sidebar has two distinct containers.
 * This prevents the list from being wiped completely on partial updates.
 */
function ensureSidebarStructure() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const list = document.getElementById('filesList');
  if (!list) return { catContainer: null, noteContainer: null };

  let catContainer = document.getElementById('sb-categories-container');
  let noteContainer = document.getElementById('sb-notes-container');

  // If the spinner is there, or containers are missing, reset everything
  if (!catContainer || !noteContainer) {
    list.innerHTML = ''; 
    
    catContainer = document.createElement('div');
    catContainer.id = 'sb-categories-container';
    
    noteContainer = document.createElement('div');
    noteContainer.id = 'sb-notes-container';
    
    list.appendChild(catContainer);
    list.appendChild(noteContainer);
  }
  return { catContainer, noteContainer };
}

/**
 * PART 1: Render Categories Only (Heavy logic: sorting, counting, DOM creation)
 */
function renderSidebarCategories() {
  console.error('[EXECUTING] renderSidebarCategories'); 
  const { catContainer } = ensureSidebarStructure();
  if (!catContainer) return;

  catContainer.innerHTML = '';

  // 1. HEADER
  const categoriesHeader = document.createElement('div');
  categoriesHeader.className = 'notes-header-row category-toggle-header';

  const title = document.createElement('span');
  title.className = 'categories-title';
  title.textContent = 'Categories';

  const addFolderBtn = document.createElement('button');
  addFolderBtn.className = 'new-note-btn-small';
  addFolderBtn.textContent = '+';
  addFolderBtn.title = 'New category';

  if (isCategoriesExpanded) {
    addFolderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!isUserPremium()) {
          showUpgradeModal();
          return;
      }
      const name = prompt('New category name:');
      if (name?.trim()) createCategory(name);
    });
  } else {
    addFolderBtn.style.visibility = 'hidden';
    addFolderBtn.style.pointerEvents = 'none';
  }

  categoriesHeader.addEventListener('click', (e) => {
    if (!e.target.closest('.new-note-btn-small')) {
      isCategoriesExpanded = !isCategoriesExpanded;
      localStorage.setItem('kryptNote_categoriesExpanded', isCategoriesExpanded.toString());
      renderSidebarCategories();
      renderSidebarNotes(); 
    }
  });

  categoriesHeader.appendChild(title);
  categoriesHeader.appendChild(addFolderBtn);
  catContainer.appendChild(categoriesHeader);

  // 2. FOLDERS LIST
  if (isCategoriesExpanded) {
    const foldersSection = document.createElement('div');
    foldersSection.className = 'folders-section';

    const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH;
    const workIdentifier = DEFAULT_CATEGORY_IDS.WORK; 

    // Calculate Counts
    const categoryMap = state.files.reduce((acc, file) => {
        const catId = file.categoryId;
        acc[catId] = (acc[catId] || 0) + 1;
        return acc;
    }, {});
    
    const getNoteCount = (cat) => {
        const pbId = cat.id;
        const localId = cat.localId;
        let count = categoryMap[pbId] || 0;
        if (localId && localId !== pbId) {
            count += categoryMap[localId] || 0;
        }
        return count;
    };
    
    // Sort Categories
    const trashCategory = state.categories.find(c => c.localId === trashIdentifier || c.id === trashIdentifier);
    let sortedCategories = state.categories
        .filter(c => c.localId !== trashIdentifier && (pb.authStore.isValid ? c.id !== trashCategory?.id : c.id !== trashIdentifier))
        .filter((category, index, self) => index === self.findIndex((c) => c.id === category.id))
        .sort((a,b) => a.sortOrder - b.sortOrder);
    
    if (trashCategory) sortedCategories.push(trashCategory);
    
    sortedCategories.forEach(c => {
        const identifier = c.localId || c.id;
        const isActive = identifier === state.activeCategoryId;
        const isTrash = identifier === trashIdentifier;
        const isWork = identifier === workIdentifier; 
        const isDeletable = !isTrash && !isWork; 
        
        const folderItem = createFolderItem(c.name, identifier, isActive, c.iconName, getNoteCount(c), isDeletable, isTrash);
        
        // === BUG FIX: Use 'mousedown' here too ===
        folderItem.addEventListener('mousedown', async e => {
            if (e.target.closest('.more-btn')) return; 
            
            // Save current note before switching category views
            if (state.activeId) {
                await saveVersionIfChanged();
            }

            selectCategory(identifier);
            renderSidebarCategories();
            renderSidebarNotes();
        });
        foldersSection.appendChild(folderItem);
    });

    catContainer.appendChild(foldersSection);
    
    const divider = document.createElement('div');
    divider.className = 'folders-divider'; 
    catContainer.appendChild(divider);
  }
}


/**
 * MASTER WRAPPER: Renders everything.
 * Kept for backward compatibility and full refreshes (init, import).
 */
function renderFiles() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  renderSidebarCategories();
  renderSidebarNotes();
}


function showCategoryMenu(btn, id, name, isDeletable, isTrash) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
        console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
        menu.remove();
        
        const newName = prompt(`Rename category "${name}" to:`, name);
        if (!newName?.trim() || newName.trim() === name) { return; }

        const trimmedName = newName.trim();

        // VALIDATION: Return early if name is too long
        if (trimmedName.length > MAX_FILENAME_LENGTH) {
            showToast(`Name is too long (Max ${MAX_FILENAME_LENGTH} characters).`, 4000);
            return;
        }

        const category = state.categories.find(c => c.id === id || c.localId === id);
        if (!category) { return; }
        
        const oldName = category.name;
        category.name = trimmedName; // Optimistic UI Update
        
        if (id === state.activeCategoryId) {
           const activeCategoryTitle = document.querySelector('.categories-title');
           if(activeCategoryTitle) activeCategoryTitle.textContent = `${trimmedName} Notes`;
        }
        finalizeUIUpdate();

        if (pb.authStore.isValid && derivedKey) {
            // Check if it's a real synced category
            if (category.id && !category.id.startsWith('cat_temp_') && !category.id.startsWith('cat_guest_')) {
                try {
                    // Metadata Encryption: Encrypt the category name before sending to server
                    const encryptedName = await packEncrypt(trimmedName, derivedKey);

                    await pb.collection('categories').update(category.id, { 
                        name: encryptedName,
                        lastEditor: SESSION_ID 
                    }, { requestKey: null }); 
                    
                    showToast(`Category renamed`); 
                }
                catch (e) { 
                    if (e.status !== 0) {
                        category.name = oldName; // Revert local state on error
                        showToast('Category rename failed'); 
                        finalizeUIUpdate(); 
                    }
                }
            }
        } else {
             // Guest Mode Persistence
             guestStorage.saveData({ categories: state.categories, files: state.files });
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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

// Rename handler
menu.querySelector('.ctx-rename').onclick = async () => {
    console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
    
    const newName = prompt('New name:', name);
    if (!newName?.trim()) { menu.remove(); return; }

    const trimmedName = newName.trim();

    // VALIDATION: Return early if name is too long
    if (trimmedName.length > MAX_FILENAME_LENGTH) {
        showToast(`Note name is too long (Max ${MAX_FILENAME_LENGTH} characters).`, 4000);
        menu.remove();
        return;
    }

    const file = state.files.find(f => f.id === id);
    if (!file) { menu.remove(); return; }

    if (file.name !== trimmedName) {
        const oldName = file.name;
        file.name = trimmedName; // Optimistic UI update

        if (pb.authStore.isValid && derivedKey) {
            try { 
                // Metadata Encryption: Encrypt the name before sending to PocketBase
                const encryptedName = await packEncrypt(trimmedName, derivedKey);

                await pb.collection('files').update(id, { 
                    name: encryptedName,
                    lastEditor: SESSION_ID 
                }, { requestKey: null }); 
                
                showToast(`Note renamed`); 
            }
            catch (e) { 
                if (e.status !== 0) {
                    file.name = oldName; // Revert local state on server failure
                    showToast('Rename failed'); 
                    finalizeUIUpdate();
                }
            }
        } else {
            // Guest Mode: LocalStorage persistence
            guestStorage.saveData({ categories: state.categories, files: state.files });
        }
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  const f = state.files.find(x => x.id === state.activeId);
  const emptyOverlay = document.getElementById('emptyState');
  const isPremium = isUserPremium(); 
  
  // ==========================================================
  // 1. HANDLE EMPTY STATE (No note selected / Empty Category)
  // ==========================================================
  if (!f) {
    destroyTiptap(); 
    setToolbarVisibility(false); // Hide toolbar entirely
    
    if (emptyOverlay) {
        const isTrash = state.activeCategoryId === DEFAULT_CATEGORY_IDS.TRASH;
        const title = document.getElementById('emptyTitle');
        const msg = document.getElementById('emptyMessage');
        const btn = document.getElementById('emptyStateBtn');
        const icon = document.getElementById('emptyIcon');

        if (isTrash) {
            title.textContent = "Your Trash is Empty";
            msg.textContent = "Notes you delete will appear here. You can restore them or clear the trash permanently.";
            btn.textContent = "Go to Work Notes";
            // Trash Icon
            icon.innerHTML = '<polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>';
            btn.onclick = () => selectCategory(DEFAULT_CATEGORY_IDS.WORK);
        } else {
            // Find current category name for the message
            const cat = state.categories.find(c => c.localId === state.activeCategoryId || c.id === state.activeCategoryId);
            const catName = cat ? cat.name : "Category";
            
            title.textContent = `${catName} is Empty`;
            msg.textContent = "There are no notes in this category. Create one to get started!";
            btn.textContent = "Create New Note";
            // Plus/Document Icon
            icon.innerHTML = '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline><line x1="12" y1="18" x2="12" y2="12"></line><line x1="9" y1="15" x2="15" y2="15"></line>';
            btn.onclick = () => createFile();
        }
        emptyOverlay.classList.remove('hidden');
    }

    const textarea = document.getElementById('textEditor');
    if (textarea) textarea.value = '';
    originalContent = '';
    return;
  }

  // ==========================================================
  // 2. NOTE SELECTED: Clean UI and Setup Mode
  // ==========================================================
  if (emptyOverlay) emptyOverlay.classList.add('hidden');
  setToolbarVisibility(true);

  const newContent = f.content !== null ? f.content : '';
  const isContentRich = f.editor === 'rich' || (newContent && newContent.trim().startsWith('{"type":"doc"'));
  const isError = f._hasFetchError === true;

  // A. LOCKED CONTENT CHECK (Premium content for Free user)
  if (isContentRich && !isPremium && !isError) {
      originalContent = newContent; 
      const lockedVersion = {
          id: f.id, 
          content: newContent, 
          created: f.updated, 
          editor: 'rich', 
          _cachedPreview: f._cachedPreview
      };
      enterPreviewMode(lockedVersion, true); // true = shows "Upgrade" banner
      return; 
  }

  // B. DETERMINE EDITOR MODE
  if (isPremium) {
    if (f.editor) {
      isRichMode = (f.editor === 'rich');
    } else {
      isRichMode = localStorage.getItem('kryptNote_editorMode') === 'rich'; 
    }
  } else {
    isRichMode = false; // Forced for Guests/Free
  }
  
  applyEditorMode(); 
  updateEditorModeUI();

  // ==========================================================
  // 3. LOAD CONTENT INTO SPECIFIC EDITOR
  // ==========================================================
  if (isRichMode) {
    ensureTiptap(); 
    
    // Disable update events during content injection to prevent save loop
    const originalOnUpdate = tiptapEditor.options.onUpdate;
    tiptapEditor.options.onUpdate = undefined;
    tiptapEditor.setOptions({ editable: !isError }); 

    try {
      if (!newContent) {
        tiptapEditor.commands.setContent('<p></p>');
      } else {
        try {
          tiptapEditor.commands.setContent(JSON.parse(newContent));
        } catch (e) {
          // Fallback if rich-flagged content is actually plain text
          tiptapEditor.commands.setContent(newContent); 
        }
      }
    } finally {
      // Re-enable update events
      setTimeout(() => { if(tiptapEditor) tiptapEditor.options.onUpdate = originalOnUpdate; }, 100);
    }
  } else {
    destroyTiptap(); 
    const textarea = document.getElementById('textEditor');
    if (textarea) {
      textarea.value = newContent;
      textarea.disabled = isError; 
      textarea.placeholder = isError ? "Connection error. Click note to retry." : "Write your note...";
    }
  }
  
  originalContent = newContent;
}

function openSidebarTab(tabName) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabName);
  });
  
  document.querySelectorAll('.tab-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === tabName);
  });
  
  const file = state.files.find(f => f.id === state.activeId);
  
  if (tabName === 'note-info') {
    updateSidebarInfo(file);
  } 
  else if (tabName === 'version-history') {
    if (!file) {
      const vList = document.getElementById('versionList');
      if (vList) vList.innerHTML = '<li class="muted">No note selected.</li>';
      return;
    }

    // UNIFIED TAB SWITCH LOGIC (Same as selectFile)
    if (file.versionsMetadataCache) {
        renderVersionList(file, file.versionsMetadataCache);
    } else if (pb.authStore.isValid && !file.id.startsWith('temp_')) {
        updateVersionHistory(file);
    } else {
        renderVersionList(file, []);
    }
    
    updateVersionFooter(); 
  }
}
function toggleAppLoading(show, message = "Syncing Vault...") {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const loader = document.getElementById('appLoader');
  const msgEl = document.getElementById('loaderMessage');
  if (!loader) return;
  
  if (show) {
    if (msgEl) msgEl.textContent = message;
    loader.classList.remove('hidden');
    loader.style.visibility = "visible";
  } else {
    loader.classList.add('hidden');
    // Wait for the opacity transition to finish before hiding visibility
    setTimeout(() => {
        if (loader.classList.contains('hidden')) {
            loader.style.visibility = "hidden";
        }
    }, 200);
  }
}

function updateSidebarInfo(file = null) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const infoFileNameDisplay = document.getElementById('infoFileName');
  const infoFileId = document.getElementById('infoFileId');
  const infoCreated = document.getElementById('infoCreated');
  const infoModified = document.getElementById('infoModified');
  
  const encryptionOffline = document.getElementById('encryptionOffline');
  const encryptionOnline = document.getElementById('encryptionOnline');
  const encryptionEmpty = document.getElementById('encryptionEmpty');
  
  const infoDownload = document.getElementById('infoDownload');
  const infoShare = document.getElementById('infoShare');
  
  // Helper to reset encryption display
  const resetEncryptionUI = () => {
    if (encryptionOffline) encryptionOffline.style.display = 'none';
    if (encryptionOnline) encryptionOnline.style.display = 'none';
    if (encryptionEmpty) encryptionEmpty.style.display = 'none';
  };

  // --- CASE 1: NO FILE SELECTED ---
  if (!file) {
    if (infoFileNameDisplay) infoFileNameDisplay.textContent = '—';
    if (infoFileId) infoFileId.textContent = '—';
    if (infoCreated) infoCreated.textContent = '—';
    if (infoModified) infoModified.textContent = '—';

    if (infoDownload) { infoDownload.disabled = true; infoDownload.onclick = null; }
    if (infoShare) { infoShare.disabled = true; infoShare.onclick = null; }
    
    resetEncryptionUI();
    if (encryptionEmpty) encryptionEmpty.style.display = 'inline'; // Show the dash
    return;
  }

  // --- CASE 2: FILE SELECTED ---
  if (infoFileNameDisplay) infoFileNameDisplay.textContent = file.name;
  if (infoFileId) infoFileId.textContent = file.id;
  if (infoCreated) infoCreated.textContent = formatDate(file.created);
  if (infoModified) infoModified.textContent = formatDate(file.updated);

  // Enable buttons
  if (infoDownload) {
    infoDownload.disabled = false;
    infoDownload.onclick = () => downloadNote(file);
  }
  if (infoShare) {
    infoShare.disabled = false;
    infoShare.onclick = () => openShareModal(file.id);
  }

  // Toggle correct Encryption Badge
  resetEncryptionUI();
  const isLoggedIn = pb.authStore.isValid && derivedKey;
  
  if (isLoggedIn) {
    if (encryptionOnline) encryptionOnline.style.display = 'flex';
  } else {
    if (encryptionOffline) encryptionOffline.style.display = 'flex';
  }
}


function updateOriginalContent() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  if (isRichMode && tiptapEditor) {
      originalContent = JSON.stringify(tiptapEditor.getJSON());
  } else {
      originalContent = document.getElementById('textEditor').value;
  }
}

async function updateVersionHistory(file = null) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const versionList = document.getElementById('versionList');
  if (!versionList) return;

  if (versionHistoryController) {
    versionHistoryController.abort();
    versionHistoryController = null; 
  }
  
  if (!file || !file.id) {
    versionList.innerHTML = '<li class="muted">No note selected.</li>';
    versionList.classList.remove('loading');
    delete versionList.dataset.currentFileId;
    return;
  }

  // 1. New note handling
  if (file.id.startsWith('temp_')) {
    versionList.innerHTML = `
      <li class="version-current selected">
        <strong>Current version</strong>
        <small>${formatDate(file.updated)}</small>
      </li>
      <li class="muted" style="padding:12px;">History will be available after saving.</li>
    `;
    return;
  }

  // 2. Badge UI (Keep existing logic)
  const titleElement = document.querySelector('#version-history h4');
  const isPremium = isUserPremium(); 
  if (titleElement) {
    const badgeHTML = !pb.authStore.isValid ? 'Guest (3 Days)' : (isPremium ? 'Pro (Unlimited)' : 'Free (7 Days)');
    const badgeClass = !pb.authStore.isValid ? 'badge-guest' : (isPremium ? 'badge-premium' : 'badge-free');
    const iconName = isPremium ? 'icon-crown' : 'icon-history';
    titleElement.innerHTML = `<svg class="btn-icon"><use href="#${iconName}"/></svg><div class="version-title-group"><span>History</span><span class="version-badge ${badgeClass}">${badgeHTML}</span></div>`;
  }

  // 3. Loading State
  versionList.innerHTML = '<li class="muted" style="padding:12px;">Loading history...</li>';
  versionList.classList.add('loading');
  versionList.dataset.currentFileId = file.id;

  if (pb.authStore.isValid && derivedKey) {
    versionHistoryController = new AbortController();
    try {
      // --- CHANGED: Fetch Metadata Only ---
      const metadataList = await getVersionMetadata(pb, file.id, versionHistoryController.signal);
      
      // We no longer cache full content in file.versionsCache to save RAM
      // We only cache the metadata list
      file.versionsMetadataCache = metadataList; 
      
      renderVersionList(file, metadataList);
    } catch (e) {
      if (e.name !== 'AbortError') versionList.innerHTML = '<li class="muted">History unavailable</li>';
    } finally {
      versionList.classList.remove('loading');
    }
  } else {
    // Guest Mode: Load from local memory (already loaded)
    const guestVersions = file.versions || [];
    renderVersionList(file, guestVersions);
  }
}

function renderVersionList(file, versionsMetadata) {
   console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]); 
  const versionList = document.getElementById('versionList');
  if (!versionList) return;
  
  versionList.classList.remove('loading');
  versionList.dataset.currentFileId = file.id;

  // 1. Header (Current Version)
  // Optimization: Calculate current date once
  const currentFormatted = formatDate(file.updated);
  
  let html = `
    <li class="version-current">
      <strong>Current version</strong>
      <small>${currentFormatted}</small>
    </li>
  `; 

  // 2. Body
  if (!versionsMetadata || versionsMetadata.length === 0) {
    html += `<li class="muted">No previous versions saved yet.</li>`;
  } else {
    // Deduplication Set
    const seenIds = new Set();
    
    // Performance: Use a DocumentFragment string builder approach
    // We iterate the array ONLY ONCE
    for (let i = 0; i < versionsMetadata.length; i++) {
        const v = versionsMetadata[i];
        
        // Skip duplicates
        if (seenIds.has(v.id)) continue;
        seenIds.add(v.id);

        // === PERFORMANCE CACHE ===
        // If we calculated this string before, reuse it.
        // This makes re-renders (like when clicking items) instant.
        if (!v._formattedDate) {
            v._formattedDate = formatDate(v.created);
        }

        const loadingClass = v.id.startsWith('temp_version_') ? ' version-loading' : '';
        const loadingIndicator = v.id.startsWith('temp_version_') ? ' <span class="loading-dots">Saving...</span>' : '';
        
        let previewSnippet = v._cachedPreview;
        if (!previewSnippet && v.content) previewSnippet = getPreviewText(v.content);
        if (!previewSnippet) previewSnippet = "Click to load preview...";
        if (previewSnippet.length > 50) previewSnippet = previewSnippet.substring(0, 50) + "...";

        const metaInfo = v.editor === 'rich' ? 'Rich Text' : 'Plain Text';
        
        // Use v._formattedDate (Cached)
        html += `
          <li class="version-item${loadingClass}" data-version-id="${v.id}">
            <div class="v-row">
              <strong>${v._formattedDate}${loadingIndicator}</strong>
              <span class="v-meta">${metaInfo}</span>
            </div>
            <small class="v-preview">${previewSnippet}</small>
          </li>
        `;
    }
  }
  
  // Single DOM write
  versionList.innerHTML = html;

  // 3. Listeners (Delegation would be faster, but keeping existing logic for safety)
  versionList.querySelector('.version-current')?.addEventListener('click', () => {
    if (activeVersionController) activeVersionController.abort();
    exitPreviewMode();
    loadActiveToEditor();
    highlightSelectedVersion(null);
  });

  const items = versionList.querySelectorAll('.version-item');
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    item.addEventListener('click', async () => {
      const versionId = item.dataset.versionId;
      
      if (item.classList.contains('version-loading')) return;
      if (previewMode && previewVersion && previewVersion.id === versionId) return;
      if (item.classList.contains('is-fetching')) return;

      // Abort previous fetches
      if (activeVersionController) {
          activeVersionController.abort();
          const prevItem = versionList.querySelector('.version-item.is-fetching');
          if (prevItem) {
              prevItem.classList.remove('is-fetching');
              const prevTxt = prevItem.querySelector('.v-preview');
              if(prevTxt) prevTxt.textContent = "Click to load preview..."; 
          }
      }

      activeVersionController = new AbortController();
      const currentSignal = activeVersionController.signal; 

      const previewEl = item.querySelector('.v-preview');
      previewEl.textContent = "Downloading...";
      item.classList.add('is-fetching');
      
      try {
        let fullVersion = null;

        if (pb.authStore.isValid) {
            fullVersion = await loadVersionDetails(pb, derivedKey, versionId, currentSignal);
        } else {
            const f = state.files.find(file => file.id === state.activeId);
            fullVersion = f?.versions?.find(v => v.id === versionId);
        }

        if (currentSignal.aborted) return;

        if (fullVersion) {
            enterPreviewMode(fullVersion);
            highlightSelectedVersion(versionId);
            previewEl.textContent = fullVersion._cachedPreview || 'Loaded';
        }

      } catch (err) {
        if (err.name === 'AbortError' || currentSignal.aborted) return;
        showToast("Failed to load version");
        previewEl.textContent = "Error loading content";
      } finally {
        if (!currentSignal.aborted) {
            item.classList.remove('is-fetching');
            activeVersionController = null;
        }
      }
    });
  }

  if (previewMode && previewVersion) highlightSelectedVersion(previewVersion.id);
  else highlightSelectedVersion(null);
}


// Helper function to handle toolbar visibility
function setToolbarVisibility(visible) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  document.querySelectorAll('.toolbar-container').forEach(el => {
    el.style.display = visible ? '' : 'none';
  });
}

function setupEditorSwitching() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  const dropdownGroups = [
      { trigger: 'editorModeTriggerPlain', menu: 'editorModeDropdownPlain' },
      { trigger: 'editorModeTriggerRich', menu: 'editorModeDropdownRich' },
      { trigger: 'toolsMenuBtn', menu: 'toolsDropdown' }
  ];
  dropdownGroups.forEach(group => {
      const btn = document.getElementById(group.trigger);
      const menu = document.getElementById(group.menu);
      if (btn && menu) {
          btn.addEventListener('click', (e) => {
              e.stopPropagation();
              dropdownGroups.forEach(g => {
                  const otherMenu = document.getElementById(g.menu);
                  if (otherMenu && otherMenu !== menu) otherMenu.classList.add('hidden');
              });
              menu.classList.toggle('hidden');
          });
      }
  });
  window.addEventListener('click', () => {
      dropdownGroups.forEach(group => {
          const menu = document.getElementById(group.menu);
          if (menu) menu.classList.add('hidden');
      });
  });

  const options = document.querySelectorAll('.mode-option');
  const textarea = document.getElementById('textEditor');

  options.forEach(opt => {
    opt.addEventListener('click', async () => {
      const targetMode = opt.getAttribute('data-mode');

      // === SWITCHING TO RICH ===
      if (targetMode === 'rich') {
        if (!isUserPremium()) { showRichPreviewModal(); return; }
        if (isRichMode) return; 

        await saveVersionIfChanged(); // Save plain version first

        const raw = textarea.value;
        
        isRichMode = true;
        applyEditorMode(); // Shows rich wrapper
        updateEditorModeUI();

        ensureTiptap(); // <--- CREATE
        
        // Load content
        try {
           const json = JSON.parse(raw);
           if (json.type === 'doc') tiptapEditor.commands.setContent(json);
           else throw new Error();
        } catch(e) {
           const lines = raw.split('\n');
           tiptapEditor.commands.setContent({
               type: 'doc',
               content: lines.map(line => ({
                   type: 'paragraph',
                   content: line ? [{ type: 'text', text: line }] : [] 
               }))
           });
        }

        const newJson = JSON.stringify(tiptapEditor.getJSON());
        handleAutoSave(newJson);
        originalContent = newJson; 
      }
      
      // === SWITCHING TO PLAIN ===
      else if (targetMode === 'plain') {
        if (!isRichMode) return; 
        if(!confirm("Switching to Plain Text will remove all formatting. Continue?")) return;

        await saveVersionIfChanged(); // Save rich version first

        // Extract text before destruction
        // Note: ensureTiptap() isn't needed here because we are already in rich mode
        const cleanText = tiptapEditor ? tiptapEditor.getText({ blockSeparator: "\n" }) : "";
        
        destroyTiptap(); // <--- DESTROY

        isRichMode = false;
        applyEditorMode(); // Shows plain wrapper
        updateEditorModeUI();
        
        textarea.value = cleanText;
        handleAutoSave(cleanText);
        originalContent = cleanText; 
      }
    });
  });
}

async function saveVersionIfChanged() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const file = state.files.find(f => f.id === state.activeId);
  if (!file || !file._isLoaded) return;

  let currentContent = '';

  // 1. Get Current Content
  if (isRichMode && tiptapEditor) {
    if (tiptapEditor.isEmpty) { 
        currentContent = JSON.stringify(tiptapEditor.getJSON());
    } else {
        currentContent = JSON.stringify(tiptapEditor.getJSON());
    }
  } else {
    const textarea = document.getElementById('textEditor');
    currentContent = textarea ? textarea.value : '';
  }

  // 2. Deduplication Check
  if (currentContent === originalContent) return;
  if (isSavingVersion) return;

  // 3. ROBUST EMPTY CHECK
  const isRichContentEmpty = (str) => {
    try {
      if (!str || !str.startsWith('{')) return false;
      const json = JSON.parse(str);
      if (!json.content || json.content.length === 0) return true;
      if (json.content.length === 1 && ['paragraph', 'heading'].includes(json.content[0].type)) {
         const children = json.content[0].content;
         if (!children || children.length === 0) return true;
         const hasMeaningfulContent = children.some(child => {
             if (child.type !== 'text') return true;
             return child.text && child.text.trim() !== '';
         });
         return !hasMeaningfulContent;
      }
      return false;
    } catch (e) { return false; }
  };

  const isPlainEmpty = !originalContent || originalContent.trim() === '';
  const isRichEmpty = isRichContentEmpty(originalContent);

  if (isPlainEmpty || isRichEmpty) {
      originalContent = currentContent; 
      return; 
  }

  isSavingVersion = true;
  const tempId = `temp_version_${Date.now()}`;

  try {
    const backupContent = originalContent; 
    const actualEditorMode = backupContent.trim().startsWith('{"type":"doc"') ? 'rich' : 'plain';
    const previewTxt = getPreviewText(backupContent);

    // 4. Create Metadata Object (Initially with tempId)
    const metaData = {
        id: tempId,
        created: new Date().toISOString(),
        editor: actualEditorMode,
        _cachedPreview: previewTxt,
        content: !pb.authStore.isValid ? backupContent : undefined 
    };
    
    // 5. Update UI Cache (This makes "Saving..." appear)
    if (!file.versionsMetadataCache) file.versionsMetadataCache = [];
    file.versionsMetadataCache.unshift(metaData);
    
    if (document.getElementById('version-history')?.classList.contains('active')) {
      renderVersionList(file, file.versionsMetadataCache);
    }
    
    // 6. Persistence
    if (pb.authStore.isValid && derivedKey) {
      // SERVER LOGIC
      createVersionSnapshot(pb, derivedKey, file.id, backupContent, actualEditorMode)
        .then(result => {
          const idx = file.versionsMetadataCache.findIndex(v => v.id === tempId);
          if (idx !== -1) {
              file.versionsMetadataCache[idx].id = result.id;
              file.versionsMetadataCache[idx].created = result.created;
          }
          finalizeUIUpdate();
        })
        .catch(e => {
          console.error("Version upload failed", e);
          file.versionsMetadataCache = file.versionsMetadataCache.filter(v => v.id !== tempId);
          finalizeUIUpdate();
        });
    } else {
      // === GUEST MODE LOGIC ===
      const finalGuestId = `ver_${Date.now()}`;
      
      // Update the reference directly (updates the object in versionsMetadataCache too)
      metaData.id = finalGuestId; 
      
      if (!file.versions) file.versions = [];
      file.versions.unshift(metaData); 
      
      try {
        guestStorage.saveData({ categories: state.categories, files: state.files });
        finalizeUIUpdate();
      } catch (e) {
        // === STORAGE FULL HANDLING ===
        console.warn("Guest Version Save Skipped (Storage Full)");

        // 1. Remove from Data Array
        if (file.versions) file.versions.shift();
        
        // 2. Remove from UI Cache
        // Note: metaData.id is now finalGuestId, so we filter by that AND tempId
        file.versionsMetadataCache = file.versionsMetadataCache.filter(v => v.id !== finalGuestId && v.id !== tempId);
        
        // 3. Force UI Update to remove the spinner
        finalizeUIUpdate();
      }
    }

    originalContent = currentContent;
    
  } catch (e) {
    console.error('Version save critical error:', e);
    // Safety cleanup
    if (file && file.versionsMetadataCache) {
      file.versionsMetadataCache = file.versionsMetadataCache.filter(v => v.id !== tempId);
    }
    finalizeUIUpdate();
  } finally {
    isSavingVersion = false;
  }
}

function enterPreviewMode(version, isLocked = false) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  if (originalBeforePreview === '') {
    // Capture state before we switch (so we can switch back cleanly)
    originalBeforePreview = isRichMode && tiptapEditor 
      ? JSON.stringify(tiptapEditor.getJSON())
      : document.getElementById('textEditor')?.value || '';
    originalEditorMode = isRichMode;
  }

  const versionIsRich = version.content.trim().startsWith('{"type":"doc"') || version.editor === 'rich';

  setToolbarVisibility(false);

  const plainWrap = document.getElementById('plainWrapper');
  const richWrap = document.getElementById('richWrapper');

  if (versionIsRich) {
    plainWrap.classList.add('hidden');
    richWrap.classList.remove('hidden');
    
    ensureTiptap(); 
    
    try {
      tiptapEditor.commands.setContent(JSON.parse(version.content));
    } catch(e) {
      tiptapEditor.commands.setContent(version.content);
    }
    
    tiptapEditor.setOptions({ editable: false });
    document.querySelector('.ProseMirror')?.classList.add('preview-mode');
  } else {
    // Handle Plain Text preview (rare in this specific Upgrade scenario, but safe to keep)
    if (isRichMode) destroyTiptap();
    richWrap.classList.add('hidden');
    plainWrap.classList.remove('hidden');
    
    const textarea = document.getElementById('textEditor');
    textarea.value = version.content;
    textarea.disabled = true;
    textarea.classList.add('preview-mode');
  }

  // === PASS isLocked TO BANNER ===
  createPreviewBanner(version.created, isLocked);
  
  previewMode = true;
  previewVersion = version;
}

function exitPreviewMode() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  // 1. Restore original mode state
  const targetModeRich = originalEditorMode; 
  isRichMode = targetModeRich;

  // 2. Global UI Cleanup
  document.getElementById('previewBanner')?.remove();
  setToolbarVisibility(true);
  
  // 3. Clean up Plain Editor
  const textarea = document.getElementById('textEditor');
  if (textarea) {
    textarea.disabled = false;
    textarea.classList.remove('preview-mode');
  }

  // 4. Handle Tiptap Lifecycle based on target mode
  if (targetModeRich) {
      // Returning to Rich Mode
      ensureTiptap(); // <--- Restore Instance
      
      tiptapEditor.setOptions({ editable: true });
      const proseMirrorEl = document.querySelector('.ProseMirror');
      if (proseMirrorEl) {
          proseMirrorEl.classList.remove('preview-mode');
          proseMirrorEl.setAttribute('contenteditable', 'true');
      }

      // Restore Content
      try {
        tiptapEditor.commands.setContent(JSON.parse(originalBeforePreview));
      } catch(e) {
        tiptapEditor.commands.setContent(originalBeforePreview);
      }

  } else {
      // Returning to Plain Mode
      destroyTiptap(); // <--- Kill if it was used for preview
      
      if (textarea) {
        textarea.value = originalBeforePreview;
      }
  }

  // 6. Final UI Sync
  applyEditorMode();
  updateEditorModeUI();

  // 7. Reset State
  previewMode = false;
  previewVersion = null;
  originalBeforePreview = '';
  originalEditorMode = null;
}

function toggleEditorLoading(show) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  const loader = document.getElementById('editorLoader');
  const globalLoader = document.getElementById('appLoader');

  // PRIORITY CHECK: If the whole page is already behind a spinner, 
  // don't show the local one inside the editor.
  if (show && globalLoader && !globalLoader.classList.contains('hidden')) {
    return; 
  }

  if (loader) loader.classList.toggle('hidden', !show);
}

async function selectFile(id) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  if (previewMode) exitPreviewMode();

  const file = state.files.find(f => f.id === id);
  if (!file) return;

  state.activeId = id;
  document.querySelectorAll('.file-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === id);
  });

  if (!file._isLoaded && !file.id.startsWith('temp_')) {
      // toggleEditorLoading will now check if Global Loader is visible
      toggleEditorLoading(true);
      
      try {
          await loadNoteDetails(id);
      } finally {
          toggleEditorLoading(false);
      }
  }

  if (state.activeId !== id) return;

  loadActiveToEditor();
  updateSidebarInfo(file);
  finalizeUIUpdate();
}

function updateFilePreviewDOM(fileId, text, isError = false) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const previewEl = document.querySelector(`.file-item[data-id="${fileId}"] .file-preview`);
  if (!previewEl) return;

  const file = state.files.find(f => f.id === fileId);
  
  // PRIORITY GUARD: Don't downgrade "Saving" to "Queued" visually
  let finalHtml = text;
  if (text === 'Queued' && file && file._isSaving) {
    finalHtml = "Saving...";
  }

  previewEl.textContent = finalHtml;
  
  if (isError) {
    previewEl.style.color = '#ef4444'; 
    previewEl.style.fontWeight = '600';
  } else if (finalHtml === 'Saving...' || finalHtml === 'Queued') {
    previewEl.style.color = 'var(--accent1)'; 
    previewEl.style.fontWeight = 'normal';
  } else {
    previewEl.style.color = ''; 
    previewEl.style.fontWeight = '';
  }
}
function createPreviewBanner(date, isLocked = false) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  document.getElementById('previewBanner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'previewBanner';
  banner.className = 'preview-banner';

  if (isLocked) {
    // === LOCKED STATE (Free User / Rich Note) ===
    banner.classList.add('locked-banner'); // Optional: for extra CSS styling
    banner.innerHTML = `
      <div class="banner-text">
        <span style="margin-right:8px">🔒</span> 
        <strong>Read Only:</strong> This is a Rich Text note. Upgrade to edit formatting.
      </div>
      <div class="banner-actions">
        <button id="upgradeLockBtn" class="st-btn-primary small">Upgrade Now</button>
      </div>
    `;
    
    // Wire up the Upgrade button
    banner.querySelector('#upgradeLockBtn').onclick = () => {
       window.location.href = 'Pricing.html'; 
    };

  } else {
    // === HISTORY STATE (Standard Preview) ===
    banner.innerHTML = `
      <div class="banner-text">Previewing version from ${formatDate(date)} (Read Only)</div>
      <div class="banner-actions">
        <button id="restoreBtn">Restore This Version</button>
        <button id="cancelBtn">Exit Preview</button>
      </div>
    `;

    // Wire up Restore/Cancel
    banner.querySelector('#restoreBtn').onclick = handleRestore;
    banner.querySelector('#cancelBtn').onclick = () => {
      exitPreviewMode();
      highlightSelectedVersion(null);
    };
  }

  // Insert banner
  const activeWrapper = document.querySelector('.editor-mode-wrapper:not(.hidden)');
  const editorArea = activeWrapper?.querySelector('.editor-left');
  if (activeWrapper && editorArea) {
    activeWrapper.insertBefore(banner, editorArea);
  }
}

async function handleRestore() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const file = state.files.find(f => f.id === state.activeId);
  if (!file || isSavingVersion) return;

  const versionToRestore = previewVersion; 
  if (!versionToRestore) return;

  isSavingVersion = true;

  try {
    const contentToRestore = versionToRestore.content;
    const restorePreview = versionToRestore._cachedPreview;
    
    // 1. Detect the mode of the version we are restoring
    const restoredMode = versionToRestore.editor || (contentToRestore.trim().startsWith('{"type":"doc"') ? 'rich' : 'plain');
    
    // 2. Backup Logic
    const tempBackupId = `temp_version_${Date.now()}`;
    const backupVersion = {
        id: tempBackupId,
        created: new Date().toISOString(),
        content: file.content, // Temp storage for UI
        editor: file.editor || (isRichMode ? 'rich' : 'plain'),
        _cachedPreview: file._cachedPreview || getPreviewText(file.content)
    };

    // 3. Update the local state metadata immediately
    if (!file.versionsMetadataCache) file.versionsMetadataCache = [];
    file.versionsMetadataCache.unshift(backupVersion);

    // Apply Content to State
    file.content = contentToRestore;
    file.updated = new Date().toISOString();
    file.editor = restoredMode; 
    file._cachedPreview = restorePreview;

    // 4. MANUAL EXIT PREVIEW 
    previewMode = false;
    previewVersion = null;
    originalBeforePreview = ''; 
    document.getElementById('previewBanner')?.remove();
    setToolbarVisibility(true);
    
    const textarea = document.getElementById('textEditor');
    if (textarea) {
        textarea.disabled = false;
        textarea.classList.remove('preview-mode');
    }
    
    // 5. Apply the Restored Mode & Lifecycle
    isRichMode = (restoredMode === 'rich');
    
    if (isRichMode) {
        ensureTiptap(); 
        tiptapEditor.setOptions({ editable: true });
        document.querySelector('.ProseMirror')?.classList.remove('preview-mode');
        
        try { 
            tiptapEditor.commands.setContent(JSON.parse(contentToRestore)); 
        } catch(e) { 
            tiptapEditor.commands.setContent(contentToRestore); 
        }
    } else {
        destroyTiptap();
        document.getElementById('textEditor').value = contentToRestore;
    }

    applyEditorMode();
    updateEditorModeUI();
    
    originalContent = contentToRestore;

    // 6. Background Sync
    await saveFile(file);
    
    if (pb.authStore.isValid && derivedKey) {
        createVersionSnapshot(pb, derivedKey, file.id, backupVersion.content, backupVersion.editor)
            .then(result => {
                // 🔥 FIX: Re-find the LIVE file object in state.
                // (The 'file' var might be stale if Realtime sync replaced the object during await)
                const liveFile = state.files.find(f => f.id === file.id);
                
                if (liveFile && liveFile.versionsMetadataCache) {
                    const idx = liveFile.versionsMetadataCache.findIndex(v => v.id === tempBackupId);
                    if (idx !== -1) {
                        // Update the ID and Timestamp on the LIVE object
                        liveFile.versionsMetadataCache[idx].id = result.id;
                        liveFile.versionsMetadataCache[idx].created = result.created;
                        
                        // Optimization: Clear content from cache to free RAM (we fetch on demand)
                        liveFile.versionsMetadataCache[idx].content = undefined; 
                    }
                }
                finalizeUIUpdate();
            })
            .catch(e => {
                console.error("Backup snapshot failed:", e);
                // Clean up on failure
                const liveFile = state.files.find(f => f.id === file.id);
                if(liveFile && liveFile.versionsMetadataCache) {
                    liveFile.versionsMetadataCache = liveFile.versionsMetadataCache.filter(v => v.id !== tempBackupId);
                    finalizeUIUpdate();
                }
            });
    } else {
        // Guest Logic
        const finalGuestId = `ver_${Date.now()}`;
        backupVersion.id = finalGuestId;
        if (!file.versions) file.versions = [];
        file.versions.unshift({...backupVersion});
        guestStorage.saveData({ categories: state.categories, files: state.files });
        finalizeUIUpdate();
    }

    showToast(`Restored version from ${formatDate(versionToRestore.created)}`);
    finalizeUIUpdate();

  } catch (e) {
    console.error("Restore failed:", e);
    showToast("Restore failed");
  } finally {
    isSavingVersion = false;
  }
}


function showToast(message, duration = 2500) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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

// NEW: Cache premium status to avoid constant Date object creation
let memoizedIsPremium = null; 

function isUserPremium() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  // If we already have a verified status from the server, use it
  if (memoizedIsPremium !== null) return memoizedIsPremium;
  
  if (!pb.authStore.isValid || !pb.authStore.model) {
    memoizedIsPremium = false;
    return false;
  }
  
  const user = pb.authStore.model;
  if (!user.plan_expires) {
    memoizedIsPremium = false;
    return false;
  }
  
  const expiry = new Date(user.plan_expires);
  memoizedIsPremium = expiry > new Date();
  return memoizedIsPremium;
}



function highlightSelectedVersion(versionId) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
  // Fast: uses the pre-built formatter
  return sharedDateFormatter.format(new Date(dateString));
}

function downloadNote(file) {
  const blob = new Blob([file.content], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${file.name}.txt`;
  a.click();
}




document.getElementById('textEditor')?.addEventListener('blur', async () => {
  await saveVersionIfChanged();
});



function finalizeUIUpdate() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  if (isFinalizingUI) {
      uiUpdateQueued = true; 
      return;
  }
  
  clearTimeout(finalizeUIUpdateTimeout);

  finalizeUIUpdateTimeout = setTimeout(() => {
    if (isFinalizingUI) { uiUpdateQueued = true; return; }
    
    isFinalizingUI = true;
    uiUpdateQueued = false;

    try {
      const file = state.files.find(f => f.id === state.activeId);
      
      // STABLE SORT: Newest first
      state.files.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
      
      renderSidebarCategories();
      renderSidebarNotes();
      updateSidebarInfo(file);

      // HISTORY RENDERING (Works for both PB and Guest)
      const historyPanel = document.getElementById('version-history');
      if (historyPanel && historyPanel.classList.contains('active')) {
          if (file) {
              // Priority: Metadata cache (unified list) -> PB remote cache -> Guest versions array
              const historyData = file.versionsMetadataCache || file.versions || [];
              renderVersionList(file, historyData);
          } else {
              const vList = document.getElementById('versionList');
              if (vList) vList.innerHTML = '<li class="muted">No note selected.</li>';
          }
      }
      
      updateVersionFooter();

    } catch(e) {
      console.error("UI Update failed:", e);
    } finally {
      isFinalizingUI = false;
      if (uiUpdateQueued) finalizeUIUpdate();
    }
  }, 16); 
}


// NEW: Save version on page unload (optional)
window.addEventListener('beforeunload', async (event) => {
  if (document.getElementById('textEditor').value !== originalContent) {
    await saveVersionIfChanged();
  }
});

// Toolbar Buttons
['undo','redo'].forEach(id => document.getElementById(id+'Btn')?.addEventListener('click', () => document.execCommand(id)));

document.getElementById('copyBtn')?.addEventListener('click', () => { 
  const el = document.activeElement; 
  if (el?.tagName === 'TEXTAREA' || el?.tagName === 'INPUT') el.select(); 
  document.execCommand('copy'); 
});

// REMOVED 'paste', kept 'cut'
document.getElementById('cutBtn')?.addEventListener('click', () => document.execCommand('cut'));

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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const user = pb.authStore.model;
  const isLoggedIn = pb.authStore.isValid;
  
  // Force a fresh check of the premium status from the current model
  memoizedIsPremium = null;
  const isPremium = isUserPremium(); 

  const rawName = user?.name || user?.email?.split('@')[0] || 'Guest User';
  const firstLetter = rawName.charAt(0).toUpperCase();
  
  let statusText = isLoggedIn ? (isPremium ? 'Premium Plan' : 'Free Plan') : 'Guest';
  let statusClass = isLoggedIn ? (isPremium ? 'premium' : 'free') : 'guest';

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

  // Update UI Locks
  const upgradeBtn = document.getElementById('upgradeBtn');
  if (upgradeBtn) {
    upgradeBtn.style.display = (isLoggedIn && !isPremium) ? 'flex' : 'none';
  }

  // Ensure toolbars reflect current premium status (unlocking the Super Editor)
  document.body.classList.toggle('is-premium', isPremium);

  showMenu(); 
  updateVersionFooter();
}

function updateVersionFooter() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
  // UI Elements
  const btn = document.getElementById('submitSignup');
  const nameInput = document.getElementById('signupName');
  const emailInput = document.getElementById('signupEmail');
  const passInput = document.getElementById('signupPassword');
  const confirmInput = document.getElementById('signupPasswordConfirm');

  // 1. Capture Values & Normalize
  const n = nameInput.value.trim();
  const e = emailInput.value.trim().toLowerCase(); 
  const p = passInput.value; 
  const pc = confirmInput.value;

  // 2. Basic Validation
  if (!n || !e || !p || !pc) {
    return alert('Please fill in all fields.');
  }

  if (n.length > 100) return alert('Username is too long. Max 100 characters.');
  if (e.length > 150) return alert('Email is too long. Max 150 characters.');
  if (p.length > 128) return alert('Password is too long. Max 128 characters.');

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

  // 3. START LOADING STATE
  // Store original text or default to "Create Account" to be safe
  const originalText = "Create Account"; 
  btn.disabled = true; 
  btn.textContent = "Creating Account..."; 
  btn.style.cursor = "wait";
  btn.style.opacity = "0.7";

  try {
    // 4. Attempt Signup
    await signup(n, e, p);

    // === FIX: RESET BUTTON ON SUCCESS ===
    // This ensures that if you logout later, the button is back to normal
    btn.disabled = false;
    btn.textContent = originalText;
    btn.style.cursor = "";
    btn.style.opacity = "";
    
    // Clear form inputs
    nameInput.value = '';
    emailInput.value = '';
    passInput.value = '';
    confirmInput.value = '';
    
  } catch (err) {
    // 5. HANDLE ERRORS
    alert(err.message);
    
    // Reset UI on Error
    btn.disabled = false;
    btn.textContent = originalText;
    btn.style.cursor = "";
    btn.style.opacity = "";
    
    if (err.message.toLowerCase().includes("email")) {
        emailInput.select();
    }
  }
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


function updateEditorModeUI() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  applyEditorMode(); 

  const labelText = isRichMode ? "Super Editor" : "Plain Text";
  const iconHref = isRichMode ? "#icon-text-rich" : "#icon-text-plain";

  // 1. Update Labels
  document.querySelectorAll('.current-mode-label').forEach(el => el.textContent = labelText);

  // 2. NEW: Update Trigger Icons
  document.querySelectorAll('.mode-icon-trigger use').forEach(el => {
      el.setAttribute('href', iconHref);
  });

  // 3. Update Checkmarks in dropdown
  const allOptions = document.querySelectorAll('.mode-option');
  allOptions.forEach(btn => {
    const mode = btn.getAttribute('data-mode');
    btn.classList.toggle('selected', (isRichMode && mode === 'rich') || (!isRichMode && mode === 'plain'));
  });

  localStorage.setItem('kryptNote_editorMode', isRichMode ? 'rich' : 'plain');
  
  if (isUserPremium()) {
    document.body.classList.add('is-premium');
  } else {
    document.body.classList.remove('is-premium');
  }
}

function applyEditorMode() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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

// Add a property to the function itself to track if it has run
function setupTiptapButtons() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);

  // 🔥 FIX: Guard clause to ensure listeners are added ONLY ONCE
  if (setupTiptapButtons.isInitialized) return;
  setupTiptapButtons.isInitialized = true;

  // 1. Specialized Handler for History (Undo/Redo)
  const setupHistoryBtn = (id, action) => {
    const btn = document.getElementById(id);
    if (!btn) return;

    btn.addEventListener('mousedown', (e) => {
      e.preventDefault(); // STOP focus loss
      e.stopPropagation(); // Stop bubbling
      
      // Force focus back to editor immediately
      if (tiptapEditor) {
         tiptapEditor.view.focus();
         if (action === 'undo') tiptapEditor.commands.undo();
         else tiptapEditor.commands.redo();
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
      if (tiptapEditor) callback(tiptapEditor.chain().focus()); 
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
  
  // Color Picker
  const colorInput = document.getElementById('ttColor');
  if (colorInput) {
      colorInput.addEventListener('mousedown', (e) => {
          e.preventDefault(); 
          setTimeout(() => { colorInput.click(); }, 10);
      });

      colorInput.addEventListener('input', (e) => {
          if(tiptapEditor) tiptapEditor.chain().focus().setColor(e.target.value).run();
      });
  }
  
  // Link
  document.getElementById('ttLink')?.addEventListener('mousedown', (e) => {
    e.preventDefault();
    if (!tiptapEditor) return;
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
        if (url && tiptapEditor) {
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
              if (!tiptapEditor) return;

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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const file = state.files.find(f => f.id === state.activeId);
  if (!file) return;

  if (file.content !== newContent) {
      // 1. Update Content
      file.content = newContent;
      file.editor = isRichMode ? 'rich' : 'plain';
      
      // 2. INSTANT SORT UPDATE: Move to top immediately in the local UI
      file._localSortTime = Date.now(); 
      file.updated = new Date().toISOString();

      // 3. Generate preview
      file._cachedPreview = getPreviewText(newContent);
      
      // 4. Trigger UI Refresh so it moves to top instantly
      finalizeUIUpdate();

      // 5. Debounce the actual server/disk save
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => saveFile(file), 800);
      
      updateSidebarInfo(file);
  }
}

function openShareModal(fileId) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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

// Prevent closing tab if there are unsaved changes or errors
window.addEventListener('beforeunload', (e) => {
  // Check if ANY file has a save error or is currently in the middle of saving
  const hasUnsavedWork = state.files.some(f => f._saveError || f._isSaving);
  
  if (hasUnsavedWork) {
    e.preventDefault();
    // Setting returnValue triggers the browser's native "Leave site?" dialog
    e.returnValue = 'You have unsaved changes.'; 
  }
});

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
/**
 * OPTIMIZED: Fetch only metadata (ID, Created, Editor) to populate the list.
 * Does NOT fetch the encrypted blob or decrypt content.
 */
async function getVersionMetadata(pb, fileId, signal) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  try {
    // 1. Server Fetch: Select specific fields to reduce payload size
    return await pb.collection('versions').getFullList({
      filter: `file = "${fileId}"`,
      sort: '-created',
      fields: 'id,created,editor,updated', // <--- CRITICAL: Exclude encryptedBlob, iv, authTag
      signal: signal, 
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.error("Failed to load version list", err);
    return [];
  }
}

/**
 * NEW: Fetch a SINGLE version's full data and decrypt it.
 * Called only when user clicks a version item.
 */
// Updated to accept 'signal'
async function loadVersionDetails(pb, derivedKey, versionId, signal) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  try {
    // PASS SIGNAL TO POCKETBASE
    const r = await pb.collection('versions').getOne(versionId, { signal: signal });
    
    let content = '';
    try {
      content = await decryptBlob(
        { iv: b64ToArray(r.iv), authTag: b64ToArray(r.authTag), ciphertext: b64ToArray(r.encryptedBlob) },
        derivedKey
      );
    } catch (e) { content = '[Decryption error]'; }

    return {
      id: r.id,
      created: r.created,
      content: content,
      editor: r.editor || (content.trim().startsWith('{"type":"doc"') ? 'rich' : 'plain'),
      _cachedPreview: getPreviewText(content), 
      lastEditor: r.lastEditor
    };
  } catch (err) {
    throw err;
  }
}
/**
 * NEW: Fetches only metadata for notes.
 * Instant startup, no encrypted blobs downloaded yet.
 */
async function getNoteMetadata() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  if (!pb.authStore.isValid) return [];
  
  try {
    return await pb.collection('files').getFullList({
      filter: `user = "${pb.authStore.model.id}"`,
      sort: '-updated',
      fields: 'id,name,updated,created,category,editor' // Added editor field
    });
  } catch (e) {
    console.error("Failed to load note metadata", e);
    return [];
  }
}

/**
 * NEW: Fetches and decrypts a specific note's content.
 * Called only when a note is selected.
 */
async function loadNoteDetails(noteId) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const file = state.files.find(f => f.id === noteId);
  
  if (!file) return null;
  // If loaded or local temp file, return
  if (file._isLoaded || file.id.startsWith('temp_')) return file;
  if (!pb.authStore.isValid || !derivedKey) return file;

  // Reuse existing promise
  if (file._loadingPromise) return file._loadingPromise;

  file._loadingPromise = (async () => {
      try {
        const r = await pb.collection('files').getOne(noteId);
        
        let plaintext = '';
        if (r.iv && r.authTag && r.encryptedBlob) {
          plaintext = await decryptBlob(
            { iv: b64ToArray(r.iv), authTag: b64ToArray(r.authTag), ciphertext: b64ToArray(r.encryptedBlob) },
            derivedKey
          );
        }

        file.content = plaintext;
        file._isLoaded = true; // Mark as success
        file._hasFetchError = false; // Clear error flag
        file._cachedPreview = getPreviewText(plaintext);
        
        return file;
      } catch (e) {
        if (!e.isAbort) {
            console.error("Failed to load note content", e);
            file.content = "[Error: Could not load content]";
            
            // === FIX START ===
            file._hasFetchError = true; // Flag for Editor UI to disable typing
            file._isLoaded = false;     // Critical: Keeps it "unloaded" so clicking again triggers a retry
            // === FIX END ===
        }
        return file;
      } finally {
        file._loadingPromise = null;
        if(state.activeId !== noteId) finalizeUIUpdate();
      }
  })();

  return file._loadingPromise;
}



async function loadUserFiles() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  if (pb.authStore.isValid && derivedKey) {
    try {
      // 1. Load and Decrypt Categories
      let serverCats = await pb.collection('categories').getFullList({ sort: 'sortOrder, created' });
      
      if (serverCats.length === 0) {
        serverCats = await createDefaultCategories();
      }

      const decryptedCats = [];
      for (let c of serverCats) {
        decryptedCats.push({
          ...c,
          name: await packDecrypt(c.name, derivedKey),
          localId: (c.iconName === 'icon-work') ? DEFAULT_CATEGORY_IDS.WORK : 
                   (c.iconName === 'icon-delete') ? DEFAULT_CATEGORY_IDS.TRASH : c.id
        });
      }
      state.categories = decryptedCats;

      // 2. Load and Decrypt File Metadata
      const records = await getNoteMetadata();
      const decryptedFiles = [];
      
      for (let r of records) {
        decryptedFiles.push({
          id: r.id, 
          name: await packDecrypt(r.name, derivedKey), 
          content: null, 
          created: r.created, 
          updated: r.updated, 
          _localSortTime: new Date(r.updated).getTime(),
          categoryId: r.category,
          editor: r.editor || 'plain',
          _isLoaded: false, 
          _cachedPreview: null 
        });
      }
      state.files = decryptedFiles;

    } catch (e) { 
      console.error("Failed to load or decrypt user data:", e); 
    }
  } else {
    // Guest Mode (Stored in plaintext local storage)
    let localData = guestStorage.loadData() || guestStorage.initData();
    state.categories = localData.categories;
    state.files = localData.files.map(f => ({
      ...f, 
      _isLoaded: true,
      _localSortTime: new Date(f.updated).getTime()
    })); 
  }

  // 3. Post-load initialization
  if (state.files.length === 0) {
    await createFile();
  }
  
  if (!state.activeCategoryId) {
    state.activeCategoryId = DEFAULT_CATEGORY_IDS.WORK;
  }
  
  await selectCategory(state.activeCategoryId, true); 
}

function getPreviewText(content) {
  // console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]); // Optional debug
  if (!content) return '';

  try {
    // Optimization: check start char to avoid try/catch overhead on plain text
    const trimmed = content.trim();
    if (trimmed.startsWith('{"')) {
      const json = JSON.parse(content);
      if (json.type === 'doc' && Array.isArray(json.content)) {
        let text = '';
        // Optimization: Only look at the first 5 blocks
        for (const node of json.content.slice(0, 5)) {
            if (node.content && Array.isArray(node.content)) {
                // Simple extraction without recursion for speed
                text += node.content.map(c => c.text || '').join(' ') + ' ';
            }
            // Stop early if we have enough text for a preview
            if (text.length > 150) break;
        }
        return text.trim();
      }
    }
  } catch (e) {
    // Not JSON, fall through
  }
  
  // FIX: Trim FIRST to remove leading newlines/spaces, then slice
  return content.trim().substring(0, 150);
}

function destroyTiptap() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  if (tiptapEditor) {
    tiptapEditor.destroy(); 
    tiptapEditor = null;    
  }
  
  // Clean the DOM container to ensure no leftover ProseMirror elements
  const container = document.getElementById('tiptapEditor');
  if (container) container.innerHTML = '';
  
  // Reset toolbar buttons
  document.querySelectorAll('.rich-btn-item').forEach(btn => btn.classList.remove('is-active'));
}

function ensureTiptap() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  // 1. If already exists, do nothing (Lazy Check)
  if (tiptapEditor) return;

  // 2. Create Instance
  tiptapEditor = new Editor({
    element: document.getElementById('tiptapEditor'),
    extensions: [
      StarterKit,
      TextStyle, 
      Color, 
      Link.configure({ openOnClick: false }),
      Image, 
      Placeholder.configure({ placeholder: 'Write your note...' }),
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
    ],
    content: '', // Start empty, content is loaded by caller
    onUpdate: ({ editor }) => {
      updateTiptapToolbar(editor);
      const json = JSON.stringify(editor.getJSON());
      handleAutoSave(json);
    },
    onSelectionUpdate: ({ editor }) => updateTiptapToolbar(editor),
    onBlur: async () => {
        // Only save if we are still in rich mode (editor hasn't been destroyed during blur)
        if(tiptapEditor) await saveVersionIfChanged();
    }
  });
  
  // 3. Ensure buttons are wired up (Safe to call multiple times due to internal guard)
  setupTiptapButtons();
}
function renderSidebarNotes() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const { noteContainer } = ensureSidebarStructure();
  if (!noteContainer) return;

  noteContainer.innerHTML = '';

  const activeCategory = state.categories.find(c => c.localId === state.activeCategoryId || c.id === state.activeCategoryId);
  const notesHeader = document.createElement('div');
  notesHeader.className = 'notes-header-row' + (isCategoriesExpanded ? '' : ' notes-header-collapsed');
  
  const notesTitle = document.createElement('span');
  notesTitle.className = 'categories-title';
  notesTitle.textContent = activeCategory ? `${activeCategory.name} Notes` : 'Your Notes'; 

  const newNoteBtnSmall = document.createElement('button');
  newNoteBtnSmall.className = 'new-note-btn-small';
  newNoteBtnSmall.textContent = '+';
  newNoteBtnSmall.addEventListener('click', (e) => { e.stopPropagation(); createFile(); });

  notesHeader.appendChild(notesTitle);
  notesHeader.appendChild(newNoteBtnSmall);
  noteContainer.appendChild(notesHeader);
  
  const filteredFiles = state.files
    .filter(f => f.categoryId === (activeCategory?.id || state.activeCategoryId) || f.categoryId === activeCategory?.localId)
    .sort((a, b) => (b._localSortTime || 0) - (a._localSortTime || 0));

  filteredFiles.forEach(f => {
    const d = document.createElement('div');
    d.className = 'file-item' + (f.id === state.activeId ? ' active' : '');
    d.dataset.id = f.id;

    let previewText = '';
    let isError = false;
    let isStatus = false;

    // --- PRIORITY LOGIC FIXED ---
    if (!f._isLoaded) {
        previewText = f._loadingPromise ? 'Decrypting...' : 'Click to load...';
    } 
    else if (f._saveError) {
        previewText = 'Save Failed';
        isError = true;
    }
    // Check SAVING before QUEUED to prevent flip-flopping on the same note
    else if (f._isSaving) {
        previewText = 'Saving...';
        isStatus = true;
    }
    else if (f._isQueued) {
        previewText = 'Queued';
        isStatus = true;
    }
    else {
        const rawText = f._cachedPreview || getPreviewText(f.content?.trim() || '');
        if (!rawText) previewText = '[Empty note]';
        else {
            const firstLine = rawText.split('\n')[0];
            previewText = firstLine.length > 35 ? firstLine.substring(0, 35) + '...' : firstLine;
        }
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = 'file-content';
    
    const nameSpan = document.createElement('span');
    nameSpan.className = 'file-name';
    nameSpan.textContent = f.name || 'Untitled';

    const previewSpan = document.createElement('span');
    previewSpan.className = 'file-preview';
    previewSpan.textContent = previewText;

    if (isError) {
        previewSpan.style.color = '#ef4444';
        previewSpan.style.fontWeight = '600';
    } else if (isStatus) {
        previewSpan.style.color = 'var(--accent1)';
    }

    contentDiv.appendChild(nameSpan);
    contentDiv.appendChild(previewSpan);

    const moreBtn = document.createElement('button');
    moreBtn.className = 'more-btn';
    moreBtn.textContent = '⋯';

    d.appendChild(contentDiv);
    d.appendChild(moreBtn);

    d.addEventListener('mousedown', async e => {
      if (e.target.closest('.more-btn')) return;
      if (state.activeId && state.activeId !== f.id) await saveVersionIfChanged(); 
      selectFile(f.id);
    });

    moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      showFileMenu(moreBtn, f.id, f.name);
    });

    noteContainer.appendChild(d);
  });
}

// Init
initPocketBase();
