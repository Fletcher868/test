import PocketBase from 'https://cdn.jsdelivr.net/npm/pocketbase/dist/pocketbase.es.mjs';
import { 
  deriveMasterKey, generateDataKey, wrapDataKey, unwrapDataKey, 
  exportKeyToString, storeDataKeyInSession, loadDataKeyFromSession, 
  encryptBlob, decryptBlob, randomSalt, arrayToB64, b64ToArray ,
  generateShareKey, exportKeyToUrl
} from './crypto.js';

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
const SESSION_ID = crypto.randomUUID();
let isRichMode = localStorage.getItem('kryptNote_editorMode') === 'rich'; // Load preference
let previewMode = false;        
let previewVersion = null;      
// Auto-save
let saveTimeout = null;
let originalBeforePreview = ''; 
const PB_URL = 'https://repeatedly-pleasant-elk.ngrok-free.app/';
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
  pb = new PocketBase(PB_URL);

  initTiptap();
  setupEditorSwitching();

  // 1. Network Sync (Fresh Auth & Data)
  if (pb.authStore.isValid) {
    try {
      await pb.collection('users').authRefresh();
      memoizedIsPremium = null; 

      // Proceed to heavy decryption
      await restoreEncryptionKeyAndLoad();
      
    } catch (err) {
      console.warn("Session expired:", err);
      logout();
    }
  } else {
    loadUserFiles();
    updateProfileState();
  }

  initSettings(pb, state, derivedKey, loadUserFiles, saveFile, renderFiles, loadActiveToEditor);
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
  if (previewMode) {
    exitPreviewMode();
    highlightSelectedVersion(null);
  }

  try {
    const authData = await pb.collection('users').authWithPassword(email, password);
    const user = authData.record;

    // --- INSTANT UI UPDATE ---
    memoizedIsPremium = null;
    updateProfileState(); 
    document.getElementById('profileDropdown').classList.add('hidden');
    // -------------------------

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
    
    await loadUserFiles();
    setupRealtimeSubscription(); 
    setupExport(pb, derivedKey, showToast);

    showToast('Logged in! Notes decrypted.');
    return true;
  } catch (e) {
    alert('Login failed: ' + e.message);
    return false;
  }
}

async function signup(name, email, password) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  if (previewMode) {
    exitPreviewMode();
  }
  
  if (pb) {
    pb.realtime.unsubscribe('files');
    pb.realtime.unsubscribe('categories');
    console.log('Realtime subscription stopped.');
  }
  
  pb.authStore.clear();
  sessionStorage.removeItem('dataKey');
  derivedKey = null;
  
  state = { files: [], activeId: null, categories: [], activeCategoryId: DEFAULT_CATEGORY_IDS.WORK };
  previewMode = false;
  previewVersion = null;
  originalBeforePreview = '';
  originalContent = '';

  const editor = document.getElementById('textEditor');
  if (editor) editor.value = '';

  if (tiptapEditor) {
      tiptapEditor.commands.setContent('');
  }
  
  loadUserFiles();
  updateProfileState();
  updateVersionFooter();
  showMenu();
  setupExport(pb, derivedKey, showToast);
}

function setupRealtimeSubscription() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  if (!pb.authStore.isValid || !derivedKey) return;

  pb.realtime.unsubscribe('files');
  pb.realtime.unsubscribe('categories'); 
  pb.realtime.unsubscribe('versions');
  
  const decryptRecord = async (r) => { 
      let plaintext = '';
      if (r.iv && r.authTag && r.encryptedBlob) {
          try {
              plaintext = await decryptBlob(
                  { iv: b64ToArray(r.iv), authTag: b64ToArray(r.authTag), ciphertext: b64ToArray(r.encryptedBlob) },
                  derivedKey
              );
          } catch (decErr) { plaintext = '[ERROR: Decryption Failed]'; }
      }
      return { 
          id: r.id, name: r.name, content: plaintext, created: r.created, updated: r.updated, 
          categoryId: r.category, editor: r.editor, lastEditor: r.lastEditor, _isLoaded: true
      };
  };

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
      const newFile = await decryptRecord(e.record);
      newFile._cachedPreview = getPreviewText(newFile.content?.trim());
      
      const index = state.files.findIndex(f => f.id === newFile.id);
      if (index !== -1) {
          state.files[index] = { ...state.files[index], ...newFile };
          // If editing this note, update editor immediately
          if (state.activeId === newFile.id) {
              loadActiveToEditor();
              // Invalidate version cache to force fresh fetch on remote change
              state.files[index].versionsMetadataCache = null;
              updateVersionHistory(state.files[index]);
          }
          showToast(`Note updated remotely`);
      } else {
          state.files.unshift(newFile);
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
          const index = state.categories.findIndex(c => c.id === e.record.id);
          if (index !== -1) state.categories[index] = e.record;
          else state.categories.push(e.record);
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

      // Update the unified metadata cache
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



/**
 * Sets the active category, finds the first note in it, and selects it.
 */
function selectCategory(categoryIdentifier, shouldSelectFile = true) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
    state.activeCategoryId = categoryIdentifier;
    
    // 1. Resolve IDs (PocketBase UUID vs Local String ID)
    let pbCategoryId = categoryIdentifier; 
    let localCategoryIdentifier = categoryIdentifier; 

    if (pb.authStore.isValid) {
        const activeCategoryObject = state.categories.find(c => c.localId === categoryIdentifier || c.id === categoryIdentifier);
        if (activeCategoryObject) {
            pbCategoryId = activeCategoryObject.id;
            localCategoryIdentifier = activeCategoryObject.localId || activeCategoryObject.id;
        }
    }
    
    // 2. Filter notes belonging to this category
    const notesInCategory = state.files
        .filter(f => f.categoryId === pbCategoryId || f.categoryId === localCategoryIdentifier) 
        .sort((a, b) => new Date(b.updated) - new Date(a.updated));

    // 3. Handle selection of the first note in the category
    if (shouldSelectFile) {
        if (notesInCategory.length > 0) {
            // Re-use selectFile to handle: visual selection, decryption, 
            // editor loading, Note Info tab, and Version History tab.
            selectFile(notesInCategory[0].id);
        } else {
            // No notes in category: Clear everything
            state.activeId = null;
            document.getElementById('textEditor').value = '';
            if (tiptapEditor) tiptapEditor.commands.setContent('<p></p>');
            
            // Explicitly clear sidebar tabs
            updateSidebarInfo(null);
            const vList = document.getElementById('versionList');
            if (vList) vList.innerHTML = '<li class="muted">No note selected.</li>';
        }
    }

    // 4. Update the sidebar list UI
    finalizeUIUpdate();
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

  // 1. Generate unique name
  const today = new Date().toISOString().slice(0, 10);
  const baseName = `Note ${today}`;
  const sameDay = state.files.filter(f => f.name?.startsWith(baseName));
  const nextNum = sameDay.length ? Math.max(...sameDay.map(f => {
    const m = f.name.match(/_(\d+)$/);
    return m ? +m[1] : 0;
  })) + 1 : 0;
  const name = nextNum === 0 ? baseName : `${baseName}_${nextNum}`;

  // 2. STRICT TIMESTAMP LOGIC:
  // Find the timestamp of the newest note currently in the list
  let newestExistingTime = 0;
  if (state.files.length > 0) {
      newestExistingTime = Math.max(...state.files.map(f => new Date(f.updated).getTime()));
  }
  
  // Ensure the new note is at least 1ms newer than the newest existing note
  const now = Date.now();
  const safeNewTime = new Date(Math.max(now, newestExistingTime + 1)).toISOString();

  const tempId = `temp_${Date.now()}`;

  // 3. Optimistic local file object
  const newFile = {
    id: tempId,
    name,
    content: '',
    created: safeNewTime,
    updated: safeNewTime, // This ensures it stays at the top
    categoryId: targetCategoryId,
    _isLoaded: true,
    _cachedPreview: '[Empty note]',
    _contentLastPreviewed: ''
  };

  // 4. Immediate state and UI update
  state.files.unshift(newFile);
  state.activeId = tempId;

  loadActiveToEditor();
  originalContent = '';
  
  // Trigger immediate sort and render
  finalizeUIUpdate();

  // 5. Background Persistence
  if (pb.authStore.isValid && derivedKey) {
    createFileOnServer(tempId, name, targetCategoryId);
  } else {
    guestStorage.saveData({ categories: state.categories, files: state.files });
  }
}

async function createFileOnServer(tempId, name, targetCategoryId) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  try {
    const activeCatObj = state.categories.find(c => c.id === targetCategoryId || c.localId === targetCategoryId);
    const pbCategoryId = activeCatObj?.id;

    const { ciphertext, iv, authTag } = await encryptBlob('', derivedKey);

    const result = await pb.collection('files').create({
      name,
      user: pb.authStore.model.id,
      category: pbCategoryId,
      iv: arrayToB64(iv),
      authTag: arrayToB64(authTag),
      encryptedBlob: arrayToB64(ciphertext),
      lastEditor: SESSION_ID
    }, { requestKey: null });

    const tempFile = state.files.find(f => f.id === tempId);
    if (tempFile) {
      tempFile.id = result.id;
      // We keep the optimistic "updated" time if the server time is somehow older
      // to prevent the note from jumping down after the server response.
      const serverTime = new Date(result.updated).getTime();
      const localTime = new Date(tempFile.updated).getTime();
      
      if (serverTime > localTime) {
          tempFile.updated = result.updated;
      }
      
      tempFile.created = result.created;
      
      if (state.activeId === tempId) {
        state.activeId = result.id;
      }
    }
    
    finalizeUIUpdate();
    
  } catch (e) {
    if (e.status === 0 || e.isAbort) return;
    state.files = state.files.filter(f => f.id !== tempId);
    if (state.activeId === tempId) state.activeId = null;
    finalizeUIUpdate();
  }
}



async function createCategory(name) {
    console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
    if (!name?.trim()) return;

    const trimmedName = name.trim();

    // VALIDATION: Return early if name is too long
    if (trimmedName.length > MAX_FILENAME_LENGTH) {
        showToast(`Category name is too long (Max ${MAX_FILENAME_LENGTH} characters).`, 4000);
        return;
    }

    const now = new Date().toISOString();
    const tempId = `cat_temp_${Date.now()}`; 
    
    const newCategory = {
        id: tempId,
        name: trimmedName,
        iconName: 'icon-folder',
        sortOrder: state.categories.length + 1,
        created: now,
        updated: now,
        localId: tempId,
        lastEditor: SESSION_ID
    };
    
    state.categories.push(newCategory);
    state.categories.sort((a,b) => a.sortOrder - b.sortOrder);
    finalizeUIUpdate();
    
    let finalCategoryId = newCategory.id; 

    if (pb.authStore.isValid) {
        try {
            const record = await pb.collection('categories').create({
                name: trimmedName,
                user: pb.authStore.model.id,
                sortOrder: newCategory.sortOrder,
                iconName: newCategory.iconName,
                lastEditor: SESSION_ID
            }, { requestKey: null });
            
            const index = state.categories.findIndex(c => c.id === tempId);
            if (index !== -1) {
                state.categories[index] = { ...record, localId: record.id };
            }

            finalCategoryId = record.id;
            state.activeCategoryId = finalCategoryId;
            await createFile(); 
            finalizeUIUpdate();
            
        } catch (e) {
            if (e.status !== 0) {
                console.error('Category creation failed:', e);
                showToast('Failed to create category on server.', 3000);
                state.categories = state.categories.filter(c => c.id !== tempId);
                finalizeUIUpdate();
            }
        }
    } else {
        newCategory.id = `cat_guest_${Date.now()}`;
        newCategory.localId = newCategory.id;
        guestStorage.saveData({ categories: state.categories, files: state.files });
        state.activeCategoryId = newCategory.id;
        await createFile();
        finalizeUIUpdate();
    }
}

async function saveFile(file) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  file.updated = new Date().toISOString();
  if (file.id.startsWith('temp_')) return;
  
  if (pb.authStore.isValid && derivedKey) {
    try {
        const { ciphertext, iv, authTag } = await encryptBlob(file.content, derivedKey);
        const categoryRecord = state.categories.find(c => c.localId === file.categoryId || c.id === file.categoryId);
        const pbCategoryId = categoryRecord?.id || file.categoryId;

        await pb.collection('files').update(file.id, {
          name: file.name,
          category: pbCategoryId, 
          iv: arrayToB64(iv),
          authTag: arrayToB64(authTag),
          encryptedBlob: arrayToB64(ciphertext),
          lastEditor: SESSION_ID // <--- ADDED
        });
    } catch (e) { console.error(e); }
  } else {
    guestStorage.saveData({ categories: state.categories, files: state.files });
  }
}

// Helper: Extract plain text from TipTap JSON or return string as-is
function getPreviewText(content) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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

  // 1. Identify the Trash Category System ID
  const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH; // "trash"
  const trashCat = state.categories.find(c => c.localId === trashIdentifier || c.id === trashIdentifier);
  
  // On server, we need the UUID (cat.id). On guest, we use "trash".
  const trashSystemId = pb.authStore.isValid ? trashCat?.id : trashIdentifier;

  // 2. Check if the note is already in the trash
  const isInTrash = file.categoryId === trashSystemId || file.categoryId === trashIdentifier;

  if (isInTrash) {
    // === HARD DELETE (Already in Trash) ===
    if (!confirm(`Permanently delete "${file.name}"? This cannot be undone.`)) return;

    // Optimistic UI update: Remove from local state immediately
    state.files = state.files.filter(f => f.id !== id);
    if (state.activeId === id) state.activeId = null;

    if (pb.authStore.isValid && !id.startsWith('temp_')) {
      try {
        await pb.collection('files').delete(id);
      } catch (e) {
        console.error("Failed to delete from server:", e);
        showToast("Server delete failed. Please refresh.");
      }
    }
    showToast("Permanently deleted.");
  } 
  else {
    // === SOFT DELETE (Move to Trash) ===
    const oldCategoryId = file.categoryId;
    file.categoryId = trashSystemId; // Move it
    file.updated = new Date().toISOString();

    // If the note was currently open, we might want to clear the editor
    if (state.activeId === id) {
       // Optional: keep it open, or clear it. Usually better to clear.
       state.activeId = null;
       document.getElementById('textEditor').value = '';
       if (tiptapEditor) tiptapEditor.commands.setContent('');
    }

    if (pb.authStore.isValid && !id.startsWith('temp_')) {
      try {
        await pb.collection('files').update(id, { 
          category: trashSystemId,
          lastEditor: SESSION_ID 
        });
      } catch (e) {
        console.error("Failed to move to trash:", e);
        file.categoryId = oldCategoryId; // Revert on failure
        showToast("Move to trash failed.");
      }
    }
    showToast("Moved to Trash");
  }

  // 3. Persist for Guest users
  if (!pb.authStore.isValid) {
    guestStorage.saveData({ categories: state.categories, files: state.files });
  }

  // 4. Update the sidebar list and counts
  // If we moved the active file, we need to pick a new one in the current category
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
      editor: editorMode || 'plain',
      lastEditor: SESSION_ID // <--- ADDED
    });
  } catch (err) { console.error(err); throw err; }
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

  if (!catContainer || !noteContainer) {
    list.innerHTML = ''; // Reset if structure is wrong or empty
    
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
  console.error('[EXECUTING] renderSidebarCategories'); // Uncomment for debugging
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
      
      // Update categories view
      renderSidebarCategories();
      // Update notes header (spacing/collapse state)
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
        folderItem.addEventListener('click', e => {
            if (e.target.closest('.more-btn')) return; 
            selectCategory(identifier);
            // Must update both: "Active" class changes in Categories, List changes in Notes
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
        category.name = trimmedName; 
        
        if (id === state.activeCategoryId) {
           const activeCategoryTitle = document.querySelector('.categories-title');
           if(activeCategoryTitle) activeCategoryTitle.textContent = `${trimmedName} Notes`;
        }
        finalizeUIUpdate();

        if (pb.authStore.isValid) {
            if (category.id && !category.id.startsWith('cat_temp_') && !category.id.startsWith('cat_guest_')) {
                try {
                    await pb.collection('categories').update(category.id, { 
                        name: trimmedName,
                        lastEditor: SESSION_ID 
                    }, { requestKey: null }); 
                    showToast(`Category renamed`); 
                }
                catch (e) { 
                    if (e.status !== 0) {
                        category.name = oldName; 
                        showToast('Category rename failed'); 
                        finalizeUIUpdate(); 
                    }
                }
            }
        } else {
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
        file.name = trimmedName;

        if (pb.authStore.isValid) {
          try { 
            await pb.collection('files').update(id, { 
                name: trimmedName,
                lastEditor: SESSION_ID 
            }, { requestKey: null }); 
            showToast(`Note renamed`); 
          }
          catch (e) { 
            if (e.status !== 0) {
              file.name = oldName; 
              showToast('Rename failed'); 
            }
          }
        } else {
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
  const newContent = (f && f.content !== null) ? f.content : '';

  if (isUserPremium()) {
    if (newContent.trim().startsWith('{"type":"doc"')) {
      isRichMode = true;
    } else if (newContent.trim().length > 0) {
      isRichMode = false;
    } else {
      isRichMode = localStorage.getItem('kryptNote_editorMode') === 'rich'; 
    }
  } else {
    isRichMode = false;
  }
  
  applyEditorMode(); 
  updateEditorModeUI();

  // UNLOCK PLAIN TEXT EDITOR
  const textarea = document.getElementById('textEditor');
  if (textarea) {
    textarea.value = newContent;
    textarea.disabled = false;
    textarea.placeholder = "Write or edit your text here...";
  }

  // UNLOCK & LOAD RICH TEXT EDITOR
  if (tiptapEditor) {
    tiptapEditor.setOptions({ editable: true });
    
    const originalOnUpdate = tiptapEditor.options.onUpdate;
    tiptapEditor.options.onUpdate = undefined;
    
    try {
      if (!newContent || newContent === '') {
        tiptapEditor.commands.setContent('<p></p>');
      } else {
        try {
          const json = JSON.parse(newContent);
          tiptapEditor.commands.setContent(json);
        } catch (e) {
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
      setTimeout(() => {
        tiptapEditor.options.onUpdate = originalOnUpdate;
      }, 100);
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
  } else if (tabName === 'version-history') {
    updateVersionHistory(file); 
    updateVersionFooter(); 
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const file = state.files.find(f => f.id === state.activeId);
  if (!file || !file._isLoaded) return; // Don't save if not fully loaded

  let currentContent = '';
  let versionMode = 'plain'; 
  let isEmpty = false;

  if (isRichMode && tiptapEditor) {
    isEmpty = tiptapEditor.isEmpty;
    currentContent = JSON.stringify(tiptapEditor.getJSON());
    versionMode = 'rich';
  } else {
    const rawVal = document.getElementById('textEditor').value;
    isEmpty = !rawVal || rawVal.trim().length === 0;
    currentContent = rawVal;
  }

  // If no changes or empty, stop
  if (currentContent === originalContent || isEmpty) return;
  if (isSavingVersion) return;
  
  isSavingVersion = true;

  try {
    const tempId = `temp_version_${Date.now()}`;
    const tempVersion = {
        id: tempId,
        created: new Date().toISOString(),
        content: originalContent, // Snapshot of what the note WAS before these changes
        editor: versionMode,
        _cachedPreview: getPreviewText(originalContent)
    };
    
    // UNIFY: Ensure the metadata cache exists and add the new version to the TOP
    if (!file.versionsMetadataCache) file.versionsMetadataCache = [];
    file.versionsMetadataCache.unshift(tempVersion);
    
    // Render the combined list immediately
    const historyPanel = document.getElementById('version-history');
    if (historyPanel && historyPanel.classList.contains('active')) {
      renderVersionList(file, file.versionsMetadataCache);
    }
    
if (pb.authStore.isValid && derivedKey) {
      createVersionSnapshot(pb, derivedKey, file.id, originalContent, versionMode)
        .then(result => {
          // Replace temp item with real server data
          const idx = file.versionsMetadataCache.findIndex(v => v.id === tempId);
          if (idx !== -1) {
              file.versionsMetadataCache[idx] = {
                  id: result.id, 
                  created: result.created, 
                  content: originalContent, 
                  editor: versionMode
              };
          }
          // FIX: Trigger UI update now that "Saving..." indicator can be removed
          finalizeUIUpdate(); 
        })
        .catch(err => {
          console.error('Server version save failed:', err);
          file.versionsMetadataCache = file.versionsMetadataCache.filter(v => v.id !== tempId);
          finalizeUIUpdate();
        });
    }

    originalContent = currentContent;
    
  } catch (e) {
    console.error('Version save failed:', e);
  } finally {
    isSavingVersion = false;
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

  // 1. Header: Current Version
  let html = `
    <li class="version-current">
      <strong>Current version</strong>
      <small>${formatDate(file.updated)}</small>
    </li>
  `; 

  // 2. List Items (Metadata only)
  // Note: We removed the "duplicate content filter" because we don't know the content yet.
  // This is a necessary trade-off for performance.
  
  if (!versionsMetadata || versionsMetadata.length === 0) {
    html += `<li class="muted">No previous versions saved yet.</li>`;
  } else {
    versionsMetadata.forEach(v => {
      const loadingClass = v.id.startsWith('temp_version_') ? ' version-loading' : '';
      const loadingIndicator = v.id.startsWith('temp_version_') ? ' <span class="loading-dots">Saving...</span>' : '';
      
      // Since we don't have content, we show a generic label or the editor type
      const metaInfo = v.editor === 'rich' ? 'Rich Text' : 'Plain Text';
      
      html += `
        <li class="version-item${loadingClass}" data-version-id="${v.id}">
          <div class="v-row">
            <strong>${formatDate(v.created)}${loadingIndicator}</strong>
            <span class="v-meta">${metaInfo}</span>
          </div>
          <small class="v-preview">Click to load preview...</small>
        </li>
      `;
    });
  }

  versionList.innerHTML = html;

  // 3. Attach Listeners

  // A. Current Version Click
  versionList.querySelector('.version-current')?.addEventListener('click', () => {
    exitPreviewMode();
    loadActiveToEditor();
    highlightSelectedVersion(null);
  });

  // B. History Item Click (Async Load)
  versionList.querySelectorAll('.version-item').forEach(item => {
    item.addEventListener('click', async () => {
      const versionId = item.dataset.versionId;
      
      // Prevent double clicks or clicking temp items
      if (item.classList.contains('version-loading') || item.classList.contains('is-fetching')) return;

      // Visual Feedback: Loading
      const originalText = item.querySelector('.v-preview').textContent;
      item.querySelector('.v-preview').textContent = "Downloading & Decrypting...";
      item.classList.add('is-fetching');
      
      try {
        let fullVersion = null;

        if (pb.authStore.isValid) {
            // --- SERVER FETCH ---
            fullVersion = await loadVersionDetails(pb, derivedKey, versionId);
        } else {
            // --- GUEST FETCH (Local) ---
            fullVersion = file.versions.find(v => v.id === versionId);
        }

        if (fullVersion) {
            enterPreviewMode(fullVersion);
            highlightSelectedVersion(versionId);
            // Update the preview text in the list now that we have it
            item.querySelector('.v-preview').textContent = fullVersion._cachedPreview || 'Loaded';
        }

      } catch (err) {
        showToast("Failed to load version");
        item.querySelector('.v-preview').textContent = "Error loading content";
      } finally {
        item.classList.remove('is-fetching');
      }
    });
  });

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

function enterPreviewMode(version) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const file = state.files.find(f => f.id === state.activeId);
  if (!file || isSavingVersion) return;

  const versionToRestore = previewVersion; 
  if (!versionToRestore) return;

  isSavingVersion = true;

  try {
    const contentToRestore = versionToRestore.content;
    const restorePreview = versionToRestore._cachedPreview;
    const editorMode = versionToRestore.editor || (contentToRestore.trim().startsWith('{"type":"doc"') ? 'rich' : 'plain');
    
    // 1. Create a backup of the current content before we overwrite it
    const tempBackupId = `temp_version_${Date.now()}`;
    const backupVersion = {
        id: tempBackupId,
        created: new Date().toISOString(),
        content: file.content,
        editor: isRichMode ? 'rich' : 'plain',
        _cachedPreview: file._cachedPreview || getPreviewText(file.content)
    };

    // 2. UNIFY: Add the backup to the top of the history list
    if (!file.versionsMetadataCache) file.versionsMetadataCache = [];
    file.versionsMetadataCache.unshift(backupVersion);

    // 3. Update the active file locally
    file.content = contentToRestore;
    file.updated = new Date().toISOString();
    file._cachedPreview = restorePreview;

    // 4. Exit preview and sync UI
    exitPreviewMode();
    
    if (editorMode === 'rich') {
      isRichMode = true;
      updateEditorModeUI();
      try { tiptapEditor.commands.setContent(JSON.parse(contentToRestore)); }
      catch(e) { tiptapEditor.commands.setContent(contentToRestore); }
    } else {
      isRichMode = false;
      updateEditorModeUI();
      document.getElementById('textEditor').value = contentToRestore;
    }
    
    originalContent = contentToRestore;

    // 5. Background Sync
    await saveFile(file);
    
    if (pb.authStore.isValid && derivedKey) {
        // Create the backup version on server
        createVersionSnapshot(pb, derivedKey, file.id, backupVersion.content, backupVersion.editor)
            .then(result => {
                const idx = file.versionsMetadataCache.findIndex(v => v.id === tempBackupId);
                if (idx !== -1) {
                    file.versionsMetadataCache[idx] = {
                        id: result.id, created: result.created, content: backupVersion.content, editor: backupVersion.editor
                    };
                }
                finalizeUIUpdate();
            })
            .catch(e => console.error("Backup snapshot failed:", e));
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
      
      // 1. Sort the files
      state.files.sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());
      
      // 2. Render sidebar ONLY
      renderSidebarCategories();
      renderSidebarNotes();
      
      // 3. Update info tab
      updateSidebarInfo(file);

      // 4. Refresh Version List UI (without fetching content)
// Inside finalizeUIUpdate...
const historyPanel = document.getElementById('version-history');
if (historyPanel && historyPanel.classList.contains('active')) {
    if (file && !file.id.startsWith('temp_')) {
        // Use the unified metadata cache
        const metadata = file.versionsMetadataCache || [];
        renderVersionList(file, metadata);
    } else {
        const vList = document.getElementById('versionList');
        if (vList) vList.innerHTML = file ? '<li class="version-current"><strong>Current version</strong></li><li class="muted">No history yet.</li>' : '';
    }
}
      
      updateVersionFooter();

    } catch(e) {
      console.error("UI Update failed:", e);
    } finally {
      isFinalizingUI = false;
      if (uiUpdateQueued) finalizeUIUpdate();
    }
  }, 16); // Increased delay slightly for better performance
}


// NEW: Save version on page unload (optional)
window.addEventListener('beforeunload', async (event) => {
  if (document.getElementById('textEditor').value !== originalContent) {
    await saveVersionIfChanged();
  }
});
// Toolbar Slider


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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  // 1. GENERIC DROPDOWN LOGIC (Handles Editor Mode AND Tools Menu)
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
              
              // Close ALL other dropdowns first
              dropdownGroups.forEach(g => {
                  const otherMenu = document.getElementById(g.menu);
                  if (otherMenu && otherMenu !== menu) {
                      otherMenu.classList.add('hidden');
                  }
              });

              // Toggle the specific menu
              menu.classList.toggle('hidden');
              
              // If we just opened the Tools menu, we might want to attach listeners to its items
              if (!menu.classList.contains('hidden') && group.trigger === 'toolsMenuBtn') {
                  const toolBtns = menu.querySelectorAll('button');
                  toolBtns.forEach(b => {
                      b.onclick = () => menu.classList.add('hidden');
                  });
              }
          });
      }
  });

  // 2. GLOBAL CLOSE (Clicking outside closes everything)
  window.addEventListener('click', () => {
      dropdownGroups.forEach(group => {
          const menu = document.getElementById(group.menu);
          if (menu) menu.classList.add('hidden');
      });
  });

  // 3. EDITOR MODE SPECIFIC LOGIC (Handling the Plain/Rich switch)
  const options = document.querySelectorAll('.mode-option');
  const textarea = document.getElementById('textEditor');

  options.forEach(opt => {
    opt.addEventListener('click', () => {
      const targetMode = opt.getAttribute('data-mode');

      // Close all dropdowns after selection
      dropdownGroups.forEach(group => {
        const menu = document.getElementById(group.menu);
        if (menu) menu.classList.add('hidden');
      });

      // --- CASE A: SWITCHING TO RICH ---
      if (targetMode === 'rich') {
        if (!isUserPremium()) {
           showRichPreviewModal(); 
           return; 
        }

        if (isRichMode) return; 

        const raw = textarea.value;
        
        try {
           const json = JSON.parse(raw);
           if (json.type === 'doc') {
               tiptapEditor.commands.setContent(json);
           } else {
               throw new Error("Not a doc");
           }
        } catch(e) {
           const lines = raw.split('\n');
           const docStructure = {
               type: 'doc',
               content: lines.map(line => ({
                   type: 'paragraph',
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
        if (!isRichMode) return; 

        if(!confirm("Switching to Plain Text will remove all formatting (images, colors). Continue?")) return;

        const cleanText = tiptapEditor.getText({ blockSeparator: "\n" });
        textarea.value = cleanText;

        isRichMode = false;
        updateEditorModeUI();
        textarea.dispatchEvent(new Event('input'));
      }
    });
  });
  
  updateEditorModeUI();
}

function updateEditorModeUI() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  // 1. Switch the main editor wrappers
  applyEditorMode(); 

  // 2. Update the Toolbar Button Labels (BOTH buttons)
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

function setupTiptapButtons() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
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
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  const file = state.files.find(f => f.id === state.activeId);
  if (!file) return;

  // Comparison will now work because file.content hasn't been updated yet
  if (file.content !== newContent) {
      console.log('Content changed! Updating UI...');
      
      file.content = newContent;
      file.updated = new Date().toISOString();
      
      // Update preview cache
      const plainText = getPreviewText(newContent?.trim() || '');
      file._cachedPreview = plainText;
      file._contentLastPreviewed = newContent;

      // 1. INSTANT SIDEBAR UPDATE
      const previewEl = document.querySelector(`.file-item[data-id="${file.id}"] .file-preview`);
      if (previewEl) {
          const firstLine = plainText.split('\n')[0] || '[Empty note]';
          previewEl.textContent = firstLine.length > 35 ? firstLine.substring(0, 35) + '...' : firstLine;
      }

      // 2. DEBOUNCED SERVER SAVE
      clearTimeout(saveTimeout);
      saveTimeout = setTimeout(() => saveFile(file), 800);

      // 3. RE-SORT LIST
      // We pass a flag or use a timeout to move the item to the top 
      // without re-loading the whole editor (which causes the lag/glitch)
      finalizeUIUpdate();
      
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
async function loadVersionDetails(pb, derivedKey, versionId) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  try {
    const r = await pb.collection('versions').getOne(versionId);
    
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
      _cachedPreview: getPreviewText(content), // Generate preview only now
      lastEditor: r.lastEditor
    };
  } catch (err) {
    console.error("Failed to load specific version", err);
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
      fields: 'id,name,updated,created,category' // EXCLUDE: iv, authTag, encryptedBlob
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
  
  // If already loaded or is a local temp note, return
  if (!file || file._isLoaded || file.id.startsWith('temp_')) return file;
  if (!pb.authStore.isValid || !derivedKey) return file;

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
    file._isLoaded = true; // Mark as fully fetched
    file._cachedPreview = getPreviewText(plaintext?.trim() || '');
    file._contentLastPreviewed = plaintext;

    return file;
  } catch (e) {
    console.error("Failed to load note content", e);
    file.content = "[Error: Could not load content]";
    return file;
  }
}

async function loadUserFiles() {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  
  if (pb.authStore.isValid && derivedKey) {
    try {
      let serverCats = await pb.collection('categories').getFullList({ sort: 'sortOrder, created' });
      
      if (serverCats.length === 0) {
        serverCats = await createDefaultCategories();
      } else {
          serverCats = serverCats.map(c => {
              if (c.iconName === 'icon-work') c.localId = DEFAULT_CATEGORY_IDS.WORK;
              else if (c.iconName === 'icon-delete') c.localId = DEFAULT_CATEGORY_IDS.TRASH;
              return c;
          });
      }
      state.categories = serverCats;

      const records = await getNoteMetadata();
      state.files = records.map(r => ({
        id: r.id, 
        name: r.name, 
        content: null, 
        created: r.created, 
        updated: r.updated, 
        categoryId: r.category,
        _isLoaded: false, 
        _cachedPreview: null 
      }));

    } catch (e) { 
        console.error("PocketBase Load Failed:", e); 
    }
  } else {
    let localData = guestStorage.loadData();
    if (!localData || !localData.categories) {
      localData = guestStorage.initData();
      guestStorage.saveData(localData);
    }
    state.categories = localData.categories;
    state.files = localData.files.map(f => ({...f, _isLoaded: true})); 
  }

  if (state.files.length === 0) {
    await createFile();
  }
  
  selectCategory(state.activeCategoryId, true); 
  
  if (state.activeId) {
     const file = state.files.find(f => f.id === state.activeId);
     if (file && !file.id.startsWith('temp_')) {
        await loadNoteDetails(state.activeId);
        loadActiveToEditor();
        
        // Fix: Explicitly trigger version history for the first note if tab is active
        const historyPanel = document.getElementById('version-history');
        if (historyPanel && historyPanel.classList.contains('active')) {
            updateVersionHistory(file);
        }
     }
  }

  finalizeUIUpdate(); 
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
    .sort((a, b) => new Date(b.updated).getTime() - new Date(a.updated).getTime());

  filteredFiles.forEach(f => {
    const d = document.createElement('div');
    d.className = 'file-item' + (f.id === state.activeId ? ' active' : '');
    d.dataset.id = f.id;

// PREVIEW LOGIC
    let previewText = '';
    if (!f._isLoaded) {
        previewText = 'Click to load preview...';
    } else {
        // Fix: Always prioritize the cached preview we generated during typing
        const rawText = f._cachedPreview || getPreviewText(f.content?.trim() || '');
        if (!rawText || rawText.length === 0) {
            previewText = '[Empty note]';
        } else {
            const firstLine = rawText.split('\n')[0];
            previewText = firstLine.length > 35 ? firstLine.substring(0, 35) + '...' : firstLine;
        }
    }

    const contentDiv = document.createElement('div');
    contentDiv.className = 'file-content';
    contentDiv.innerHTML = `<span class="file-name">${f.name || 'Untitled'}</span><span class="file-preview">${previewText}</span>`;

    const moreBtn = document.createElement('button');
    moreBtn.className = 'more-btn';
    moreBtn.textContent = '⋯';

    d.appendChild(contentDiv);
    d.appendChild(moreBtn);

    d.addEventListener('click', e => {
      if (!e.target.closest('.more-btn')) selectFile(f.id);
    });

    moreBtn.addEventListener('click', e => {
      e.stopPropagation();
      showFileMenu(moreBtn, f.id, f.name);
    });

    noteContainer.appendChild(d);
  });
}

async function selectFile(id) {
  console.error('[EXECUTING]', new Error().stack.split('\n')[1].trim().split(' ')[1]);
  if (previewMode) exitPreviewMode();

  // 1. INSTANT VISUAL SELECTION
  state.activeId = id;
  document.querySelectorAll('.file-item').forEach(el => {
      el.classList.toggle('active', el.dataset.id === id);
  });

  const file = state.files.find(f => f.id === id);
  if (!file) return;

  // 2. LOCK EDITOR DURING DECRYPTION
  if (tiptapEditor) tiptapEditor.setOptions({ editable: false });
  const textarea = document.getElementById('textEditor');
  if (textarea) {
    textarea.disabled = true;
  }

  // 3. ASYNC DECRYPTION
  if (!file._isLoaded && !file.id.startsWith('temp_')) {
      const itemEl = document.querySelector(`.file-item[data-id="${id}"] .file-preview`);
      if (itemEl) itemEl.textContent = "Decrypting...";
      
      await loadNoteDetails(id);
      
      if (itemEl) {
          const rawText = file._cachedPreview || getPreviewText(file.content?.trim() || '');
          const firstLine = rawText.split('\n')[0] || '[Empty note]';
          itemEl.textContent = firstLine.length > 35 ? firstLine.substring(0, 35) + '...' : firstLine;
      }
  }

  // 4. UNLOCK & LOAD EDITOR
  loadActiveToEditor();
  updateSidebarInfo(file);

  // 5. UPDATE TABS
  const historyPanel = document.getElementById('version-history');
  if (historyPanel && historyPanel.classList.contains('active')) {
      if (!file.id.startsWith('temp_')) {
          if (file.versionsMetadataCache) renderVersionList(file, file.versionsMetadataCache);
          else updateVersionHistory(file);
      }
  }
}




// Init
initPocketBase();
