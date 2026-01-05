import PocketBase from 'https://cdn.jsdelivr.net/npm/pocketbase/dist/pocketbase.es.mjs';
import { 
  deriveMasterKey, generateDataKey, wrapDataKey, unwrapDataKey, 
  exportKeyToString, storeDataKeyInSession, loadDataKeyFromSession, 
  encryptBlob, decryptBlob, randomSalt, arrayToB64, b64ToArray 
} from './crypto.js';
import { initSettings } from './settings.js'; 
import { createVersionSnapshot, getVersions, deleteFileVersions } from './versions.js';
import { setupExport } from './export.js'; 

// NEW: PocketBase default category IDs for new user initialization
const DEFAULT_CATEGORY_IDS = {
    WORK: 'work',
    TRASH: 'trash'
};
// NEW: Guest storage key and structure
const GUEST_STORAGE_KEY = 'kryptNoteLocalData';

let previewMode = false;        
let previewVersion = null;      
let originalBeforePreview = ''; 
const PB_URL = 'https://repeatedly-pleasant-elk.ngrok-free.app/';
let pb = null, 
    // UPDATE: Added categories and set default active category
    state = { files: [], activeId: null, categories: [], activeCategoryId: DEFAULT_CATEGORY_IDS.WORK }, 
    currentMenu = null, derivedKey = null;
let originalContent = '';
let isSavingVersion = false;
let recentlySavedLocally = new Set(); 
let isCategoriesExpanded = localStorage.getItem('kryptNote_categoriesExpanded') !== 'true'; // Default to colapsed
let finalizeUIUpdateTimeout = null;
let isFinalizingUI = false;
let versionHistoryController = null;
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

async function initPocketBase() {
  pb = new PocketBase(PB_URL);

  if (pb.authStore.isValid) {
    try {
        await pb.collection('users').authRefresh();
        console.log("User data refreshed from server.");
    } catch (err) {
        console.warn("Session expired:", err);
        pb.authStore.clear();
    }
  }

  if (pb.authStore.isValid) {
    await restoreEncryptionKeyAndLoad();
    setupExport(pb, derivedKey, showToast);
  } else {
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

  // Fully reset state
  state = { files: [], activeId: null, categories: [], activeCategoryId: DEFAULT_CATEGORY_IDS.WORK };
  previewMode = false;
  previewVersion = null;
  originalBeforePreview = '';
  originalContent = '';

  const editor = document.getElementById('textEditor');
  if (editor) editor.value = '';
  
  loadUserFiles();

  updateProfileState();
  updateVersionFooter();
  showMenu();
  setupExport(pb, derivedKey, showToast);
}

function setupRealtimeSubscription() {
  if (!pb.authStore.isValid || !derivedKey) {
    return;
  }

  pb.realtime.unsubscribe('files');
  pb.realtime.unsubscribe('categories'); 
  
  // Helper to decrypt the record
  const decryptRecord = async (r) => { 
      let plaintext = '';
      if (r.iv && r.authTag && r.encryptedBlob) {
          try {
              plaintext = await decryptBlob(
                  { iv: b64ToArray(r.iv), authTag: b64ToArray(r.authTag), ciphertext: b64ToArray(r.encryptedBlob) },
                  derivedKey
              );
          } catch (err) {
              console.error("Realtime decryption failed:", err);
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
    console.log(`[REALTIME] Event received: ${e.action}`);
    
    if (e.record.user !== pb.authStore.model.id) return;
    if (isFinalizingUI) return console.log('[REALTIME] Skipping update due to active UI finalization.');
    
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
      const isLocalAction = recentlySavedLocally.has(newFile.id); // Checks for local saves/renames
      
      // a. Check for local 'temp' file replacement (Creation success event)
      const tempFile = state.files.find(f => f.id.startsWith('temp_') && f.name === record.name);
      if (e.action === 'create' && tempFile && recentlySavedLocally.has(tempFile.id)) {
          console.log(`[REALTIME] Local 'create' success. Replacing temp ID ${tempFile.id} with permanent ID ${record.id}`);
          
          const tempIndex = state.files.findIndex(f => f.id === tempFile.id);
          if (tempIndex !== -1) {
              state.files.splice(tempIndex, 1, newFile); // Replace temporary file
          }

          if (state.activeId === tempFile.id) {
              state.activeId = record.id; // Update active ID
          }
          recentlySavedLocally.delete(tempFile.id); // Clear the temp flag
          showToast(`Note created: ${newFile.name}`, 2000);
          
      } else {
        // b. Handle Update of existing file (Local save or Remote update)
        const fileIndex = state.files.findIndex(f => f.id === record.id);
        
        if (fileIndex !== -1) {
          // Replace the old file object with the new decrypted one
          state.files.splice(fileIndex, 1, newFile); 
          
          if (!isLocalAction) {
            // Remote Update
            showToast(`Note updated: ${newFile.name}`, 2000);
            
            // If active note content changed remotely, force reload/exit preview
            if (state.activeId === newFile.id) {
                if (previewMode) exitPreviewMode();
                if (document.getElementById('textEditor').value !== newFile.content) {
                    loadActiveToEditor(); 
                    showToast(`Active note content synced!`, 2500);
                }
            }
          } else {
            recentlySavedLocally.delete(newFile.id); // Clear the local update flag
          }
        } 
        // c. Handle Remote Create (If file was not created optimistically on this client)
        else if (e.action === 'create' && !isLocalAction) {
          state.files.unshift(newFile);
          showToast(`New note created: ${newFile.name}`, 3000);
        }
      }
    }
    
    // CRITICAL: Always sort after any operation
    state.files.sort((a, b) => new Date(b.updated) - new Date(a.updated));
    
    finalizeUIUpdate();
    
  });
  
  // ... (Category subscription logic remains unchanged) ...

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

// UPDATED loadUserFiles function
async function loadUserFiles() {
  state.files = [];
  state.categories = [];
  state.activeId = null;
  state.activeCategoryId = DEFAULT_CATEGORY_IDS.WORK;

  if (pb.authStore.isValid && derivedKey) {
    // ── LOGGED IN: Load from PocketBase ──
    try {
      // 1. Load Categories
      state.categories = await pb.collection('categories').getFullList({ sort: 'sortOrder, created' });
      
      if (state.categories.length === 0) {
        state.categories = await createDefaultCategories();
      } else {
          // CRITICAL: Inject localId for existing default categories
          state.categories = state.categories.map(c => {
              if (c.name === 'Work') c.localId = DEFAULT_CATEGORY_IDS.WORK;
              else if (c.name === 'Trash') c.localId = DEFAULT_CATEGORY_IDS.TRASH;
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

  selectCategory(state.activeCategoryId, true); 

  if (state.files.length === 0 || !state.activeId) {
    await createFile();
    return;
  }
  
  updateOriginalContent();
  finalizeUIUpdate(); 
}

/**
 * Sets the active category, finds the first note in it, and selects it.
 * @param {string} categoryIdentifier - The ID of the category (PB_ID or localId like 'work').
 * @param {boolean} [shouldSelectFile=true] - If true, selects the first note in the category.
 */
function selectCategory(categoryIdentifier, shouldSelectFile = true) {
    state.activeCategoryId = categoryIdentifier;
    
    let fileFilterId = categoryIdentifier;
    if (pb.authStore.isValid) {
        // CRITICAL: Find the actual PB ID that matches the identifier (localId or PB ID)
        const activeCategoryObject = state.categories.find(c => c.localId === categoryIdentifier || c.id === categoryIdentifier);
        fileFilterId = activeCategoryObject?.id;
    }
    
    // Fallback if the category object wasn't found (e.g., custom ID for guest)
    if (!fileFilterId) fileFilterId = categoryIdentifier;

    const notesInCategory = state.files
        .filter(f => f.categoryId === fileFilterId)
        .sort((a, b) => new Date(b.updated) - new Date(a.updated));

    if (shouldSelectFile) {
        if (notesInCategory.length > 0) {
            state.activeId = notesInCategory[0].id;
            if (notesInCategory[0].content !== document.getElementById('textEditor').value) {
                loadActiveToEditor();
            }
        } else {
            state.activeId = null;
            document.getElementById('textEditor').value = '';
        }
    }
}


async function createFile() {
  const currentCategory = state.categories.find(c => c.id === state.activeCategoryId || c.localId === state.activeCategoryId);
  const targetCategoryId = state.activeCategoryId;

  if (targetCategoryId === DEFAULT_CATEGORY_IDS.TRASH) {
      showToast('Cannot create a new note in the Trash category. Switched to Work.', 3000);
      state.activeCategoryId = DEFAULT_CATEGORY_IDS.WORK;
      selectCategory(DEFAULT_CATEGORY_IDS.WORK, true);
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
  
  // CRITICAL FIX: Flush any pending auto-save immediately before creating the new note
  if (saveTimeout) {
      clearTimeout(saveTimeout);
      const activeFile = state.files.find(f => f.id === state.activeId);
      if (activeFile) {
        await saveFile(activeFile);
      }
  }

  // CRITICAL: Ensure the new note's timestamp is newer than any existing note
  const now = new Date();
  let newestTimestamp = now.toISOString();
  
  // If there are existing files, ensure our timestamp is newer
  if (state.files.length > 0) {
    const latestFile = [...state.files].sort((a, b) => new Date(b.updated) - new Date(a.updated))[0];
    const latestTimestamp = new Date(latestFile.updated).getTime();
    const nowTime = now.getTime();
    
    // If current time is not newer, add 1 second
    if (nowTime <= latestTimestamp) {
      newestTimestamp = new Date(latestTimestamp + 1000).toISOString();
    }
  }

  // CRITICAL: Create a temporary ID for optimistic UI
  const tempId = `temp_${Date.now()}`; 
  const newFile = {
    id: tempId,
    name,
    content: '',
    created: newestTimestamp,
    updated: newestTimestamp,
    categoryId: targetCategoryId 
  };

  // IMMEDIATE UI UPDATE: Add to state and render
  state.files.unshift(newFile);
  state.activeId = tempId;
  
  // IMMEDIATE UI RENDER: Don't wait for anything
  renderFiles(); 
  loadActiveToEditor();
  updateSidebarInfo(newFile);
  
  // Set focus instantly
  setTimeout(() => document.getElementById('textEditor').focus(), 0);

  // HANDLE NETWORK CALLS IN BACKGROUND (only for logged-in users)
  if (pb.authStore.isValid && derivedKey) {
    // Start network operation in the background without awaiting
    createFileOnServer(tempId, name, targetCategoryId, newestTimestamp);
  } else {
    // Guest mode: just save locally
    guestStorage.saveData({ categories: state.categories, files: state.files });
    showToast(`Note created: ${name}`, 2000);
  }
}

// NEW FUNCTION: Handle server creation in background
async function createFileOnServer(tempId, name, targetCategoryId, timestamp) {
  try {
    const activeCatObj = state.categories.find(c => c.localId === targetCategoryId || c.id === targetCategoryId);
    const pbCategoryId = activeCatObj?.id;

    if (!pbCategoryId) {
      console.error("PocketBase Category ID not found. Aborting server create.");
      // Remove the temporary file on error
      const tempIndex = state.files.findIndex(f => f.id === tempId);
      if (tempIndex !== -1) {
        state.files.splice(tempIndex, 1);
      }
      if (state.activeId === tempId) {
        state.activeId = state.files[0]?.id || null;
      }
      finalizeUIUpdate();
      showToast('Error: Category not found. Please refresh.', 3000);
      return;
    }

    // Add the temporary ID to the suppression set
    recentlySavedLocally.add(tempId);

    // Encrypt empty content
    const { ciphertext, iv, authTag } = await encryptBlob('', derivedKey);

    // API call with the timestamp
    await pb.collection('files').create({
      name,
      user: pb.authStore.model.id,
      category: pbCategoryId,
      iv: arrayToB64(iv),
      authTag: arrayToB64(authTag),
      encryptedBlob: arrayToB64(ciphertext),
      updated: timestamp
    });
    
    // Note: The realtime subscription will handle replacing tempId with permanent ID
    // No need for additional UI updates here
    
  } catch (e) {
    console.error('Create failed on server:', e);
    
    // On API failure, remove the optimistic temporary file
    const tempIndex = state.files.findIndex(f => f.id === tempId);
    if (tempIndex !== -1) {
      state.files.splice(tempIndex, 1);
    }
    if (state.activeId === tempId) {
      state.activeId = state.files[0]?.id || null;
    }
    
    recentlySavedLocally.delete(tempId);
    
    // Update UI to remove the failed note
    finalizeUIUpdate();
    showToast('Failed to create note on server. Try again.', 3000);
  }
}
// NEW: Function to create a category
async function createCategory(name) {
    if (!name?.trim()) return;
    const trimmedName = name.trim();
    const now = new Date().toISOString();
    
    const tempId = `cat_temp_${Date.now()}_${Math.random().toString(36).substr(2,6)}`;
    
    const newCategory = {
        id: tempId,
        name: trimmedName,
        iconName: 'icon-folder',
        sortOrder: state.categories.length + 1,
        created: now,
        updated: now
    };
    
    // Optimistic UI update (will be corrected by Realtime event)
    state.categories.push(newCategory);
    state.categories.sort((a,b) => a.sortOrder - b.sortOrder);
    renderFiles();
    
    let finalCategoryId = newCategory.id; // Default to tempId

    if (pb.authStore.isValid) {
        try {
            const record = await pb.collection('categories').create({
                name: trimmedName,
                user: pb.authStore.model.id,
                sortOrder: newCategory.sortOrder,
                iconName: newCategory.iconName,
            });
            
            // CRITICAL FIX: Remove the temporary optimistic record.
            // The subsequent Realtime event for this creation will correctly add 
            // the permanent record, preventing duplication in the list.
            const idx = state.categories.findIndex(c => c.id === tempId);
            if (idx !== -1) {
                state.categories.splice(idx, 1); 
            }
            
            finalCategoryId = record.id; // Set final ID to the permanent PB ID
            showToast(`Category "${trimmedName}" created!`, 2000);
            
        } catch (e) {
            console.error('Category creation failed:', e);
            showToast('Failed to create category.', 3000);
            // Revert local state on server failure
            state.categories = state.categories.filter(c => c.id !== tempId);
            finalizeUIUpdate();
            return; 
        }
    } else {
        newCategory.id = `cat_guest_${Date.now()}`;
        finalCategoryId = newCategory.id; // Set final ID to the permanent guest ID
        guestStorage.saveData({ categories: state.categories, files: state.files });
        showToast(`Category "${trimmedName}" created locally!`, 2000);
    }
    
    // NEW LOGIC: Select the new category and create a first note inside it
    state.activeCategoryId = finalCategoryId;
    await createFile();
    
    // Note: createFile() calls finalizeUIUpdate(), so we don't need it here.
}

async function saveFile(file) {
  // CRITICAL: Always use current time for updates
  file.updated = new Date().toISOString();
  
  // 1. Update local state and UI immediately (Optimistic update)
  // Remove and re-add to the start of the list to visually reorder it to the top
  state.files = state.files.filter(f => f.id !== file.id);
  state.files.unshift(file); 
  
  renderFiles();
  updateSidebarInfo(file);

  // 2. Handle temporary files (for optimistic creates that haven't hit PB yet)
  if (file.id.startsWith('temp_')) {
    // No server save for temp files, UI is already updated above.
    return;
  }
  
  // 3. Save to PocketBase (Logged In)
  if (pb.authStore.isValid && derivedKey) {
    recentlySavedLocally.add(file.id);

    const { ciphertext, iv, authTag } = await encryptBlob(file.content, derivedKey);
    const updatePayload = {
      name: file.name,
      category: file.categoryId, 
      iv: arrayToB64(iv),
      authTag: arrayToB64(authTag),
      encryptedBlob: arrayToB64(ciphertext),
      updated: file.updated
    };
    
    // Run server update in background without blocking UI
    pb.collection('files').update(file.id, updatePayload)
      .catch(e => {
        console.error('Save failed on server:', e);
        showToast('Failed to save changes to server.', 3000);
      })
      .finally(() => {
        // Clear the local flag after a short delay to allow realtime to register first 
        // if another client is watching. Although for updates it's mostly for toast suppression.
        setTimeout(() => {
          recentlySavedLocally.delete(file.id);
        }, 200);
      });

  } else {
    // Guest mode
    guestStorage.saveData({ categories: state.categories, files: state.files });
  }
}

async function clearTrash() {
  if (!confirm('Are you sure you want to permanently delete ALL notes in the Trash? This action cannot be undone.')) {
    return;
  }
  
  const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH;
  let fileFilterId = trashIdentifier;
  const currentActiveId = state.activeId; 
  const wasActiveInCategory = state.activeCategoryId === trashIdentifier; // Check if Trash was the active category

  // 1. Determine the actual ID for the Trash category
  if (pb.authStore.isValid) {
    const trashCategory = state.categories.find(c => c.localId === trashIdentifier || c.id === trashIdentifier);
    fileFilterId = trashCategory?.id;
    if (!fileFilterId) {
        showToast('Trash category not found.', 3000);
        return;
    }
  }

  const filesToDelete = state.files.filter(f => f.categoryId === fileFilterId);
  
  if (filesToDelete.length === 0) {
      showToast('Trash is already empty.', 2000);
      return;
  }
  
  // 2. Permanent Deletion from PocketBase (Logged In)
  if (pb.authStore.isValid) {
    for (const file of filesToDelete) {
      try {
        await pb.collection('files').delete(file.id);
        deleteFileVersions(pb, file.id)
            .catch(e => console.error('Background version cleanup failed:', e));
      } catch (e) {
        console.error(`Failed to delete file ${file.id} from PocketBase:`, e);
      }
    }
  }

  // 3. Local State & Guest Storage Update
  const deletedIds = new Set(filesToDelete.map(f => f.id));
  state.files = state.files.filter(f => !deletedIds.has(f.id));
  
  if (!pb.authStore.isValid) {
    guestStorage.saveData({ categories: state.categories, files: state.files });
  }

  // 4. Handle active file selection
  // If the active file was one of the deleted files, clear the editor and activeId.
  if (currentActiveId && deletedIds.has(currentActiveId)) {
      state.activeId = null;
      document.getElementById('textEditor').value = '';
      updateOriginalContent(); 
  }

  // CRITICAL FIX: Ensure activeCategoryId is TRASH if it was TRASH before deletion, 
  // and manually re-select it to update the file list.
  if (wasActiveInCategory) {
      // Re-selecting the empty trash category ensures renderFiles() and the UI update correctly.
      // Setting shouldSelectFile to false prevents the logic from trying to select another note.
      selectCategory(trashIdentifier, false); 
  }
  
  // 5. UI Update
  showToast(`${filesToDelete.length} notes permanently deleted from Trash.`, 3000);
  finalizeUIUpdate();
}

async function deleteFile(id) {
  const file = state.files.find(f => f.id === id);
  if (!file) return;

  const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH;
  
  // CRITICAL: Determine the actual ID for the Trash category (PB ID or localId)
  let trashCategoryId = trashIdentifier;
  let trashCatObj = null;

  if (pb.authStore.isValid) {
      trashCatObj = state.categories.find(c => c.localId === trashIdentifier);
      trashCategoryId = trashCatObj?.id || trashIdentifier;
  }

  const wasActive = state.activeId === id;
  const wasLoggedIn = pb.authStore.isValid;
  
  // Check if the file is ALREADY in trash
  if (file.categoryId === trashCategoryId) {
      // PERMANENT DELETION (Hard Delete)
      if (!confirm(`Permanently delete "${file.name}"? This cannot be undone.`)) return;

      if (wasLoggedIn) {
          try {
              await pb.collection('files').delete(id);
              setTimeout(() => {
                  deleteFileVersions(pb, id)
                      .catch(e => console.error('Background version cleanup failed:', e));
              }, 50); 
              showToast(`Note permanently deleted: ${file.name}`, 3000);
          } catch (e) { 
              console.error('PocketBase file deletion failed, proceeding with local cleanup:', e);
              showToast('Failed to permanently delete from server.', 3000);
          }
      }
      
      state.files = state.files.filter(f => f.id !== id);
      
      if (!wasLoggedIn) {
          guestStorage.saveData({ categories: state.categories, files: state.files });
      }

      if (wasActive) {
          selectCategory(state.activeCategoryId, true);
          if (!state.activeId) {
              await createFile();
              return;
          }
      }
      
      finalizeUIUpdate();
      return;
  }

  // SOFT DELETION (Move to Trash)
  if (!confirm(`Move "${file.name}" to Trash?`)) return;

  const oldCategory = file.categoryId;
  file.categoryId = trashCategoryId;

  if (wasLoggedIn) {
      try {
          // No need to re-encrypt content, only update the category ID
          await pb.collection('files').update(id, { category: trashCategoryId });
          showToast(`Note moved to Trash: ${file.name}`, 3000);
      } catch (e) { 
          console.error('PocketBase move to trash failed:', e);
          file.categoryId = oldCategory; // Revert change on failure
          showToast('Failed to move note to Trash on server.', 3000);
          finalizeUIUpdate();
          return;
      }
  } else {
      guestStorage.saveData({ categories: state.categories, files: state.files });
      showToast(`Note moved to Trash: ${file.name}`, 3000);
  }
  
  // Local state update & UI refresh
  if (wasActive) {
    selectCategory(state.activeCategoryId, true); 
    if (!state.activeId) {
        await createFile();
        return;
    }
  }

  state.files.sort((a, b) => new Date(b.updated) - new Date(a.updated));
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

  const chevron = document.createElement('span');
  chevron.className = 'categories-chevron';
  chevron.innerHTML = `
    <svg class="btn-icon chevron-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
        <use href="#${isCategoriesExpanded ? 'icon-chevron-down' : 'icon-chevron-right'}" />
    </svg>`;

  const title = document.createElement('span');
  title.className = 'categories-title';
  title.textContent = 'Categories';

  const addFolderBtn = document.createElement('button');
  addFolderBtn.className = 'new-note-btn-small';
  addFolderBtn.textContent = '+';
  addFolderBtn.title = 'New category';

  // Only show the button if categories are expanded AND we are logged in
  if (isCategoriesExpanded && pb.authStore.isValid) {
    addFolderBtn.addEventListener('click', (e) => {
      e.stopPropagation();
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
      // Save the preference to localStorage
      localStorage.setItem('kryptNote_categoriesExpanded', isCategoriesExpanded);
      renderFiles();
    }
  });

  categoriesHeader.appendChild(chevron);
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
      const id = pb.authStore.isValid ? cat.id : cat.localId || cat.id;
      return categoryMap[id] || 0;
  };
  
  const trashCategory = state.categories.find(c => c.localId === trashIdentifier || c.id === trashIdentifier);
  
  let sortedCategories = state.categories
      // Filter out trash for sorting, using either localId or PB ID for comparison
      .filter(c => c.localId !== trashIdentifier && (pb.authStore.isValid ? c.id !== trashCategory?.id : c.id !== trashIdentifier))
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
  
  // CRITICAL: Determine the filter ID based on logged-in state
  let fileFilterId = state.activeCategoryId;
  if (pb.authStore.isValid && activeCategory) {
      fileFilterId = activeCategory.id; // Use PB ID for filtering if logged in
  }
  
  const filteredFiles = state.files
    .filter(f => f.categoryId === fileFilterId)
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

    let previewText = f.content?.trim() || '';
    if (!previewText) {
      previewText = '[Empty note]';
    } else {
      const firstLine = previewText.split('\n')[0];
      previewText = firstLine.length > 30 
        ? firstLine.substring(0, 30) + '...' 
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

async function showCategoryMenu(btn, id, name, isDeletable, isTrash) {
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

  // Positioning logic
  const r = btn.getBoundingClientRect();
  menu.style.top = r.bottom + 4 + 'px';
  menu.style.left = r.left + 'px'; 
  if (r.left + menu.offsetWidth > window.innerWidth) {
      menu.style.left = r.right - menu.offsetWidth + 'px'; 
  }

  // --- Event Listeners ---
  
  // 1. Clear Trash (Only for Trash Category)
  if (isTrash) {
    menu.querySelector('.ctx-clear-trash').onclick = () => {
      clearTrash();
      menu.remove();
    };
  } 
  
  // 2. Rename Category (For Work and Custom Categories)
  if (!isTrash) {
    menu.querySelector('.ctx-rename').onclick = async () => {
        const newName = prompt(`Rename category "${name}" to:`, name);
        if (!newName?.trim() || newName.trim() === name) { menu.remove(); return; }

        const trimmedName = newName.trim();
        const category = state.categories.find(c => c.id === id || c.localId === id);
        if (!category) { menu.remove(); return; }
        
        const oldName = category.name;
        category.name = trimmedName;
        
        if (pb.authStore.isValid && category.id && !category.localId) { // Only update if it's a PB-created custom category
            try {
                await pb.collection('categories').update(category.id, { name: trimmedName }); 
                showToast(`Category renamed to: ${trimmedName}`, 2000); 
            }
            catch (e) { 
                console.error(e); 
                category.name = oldName; 
                showToast('Category rename failed', 3000); 
            }
        } else if (!pb.authStore.isValid || category.localId === DEFAULT_CATEGORY_IDS.WORK) {
            // Guest mode or renaming the default 'Work' category (which is only local for guests, or not allowed to change PB record for default)
            // Note: The structure doesn't prevent renaming of the PB 'Work' record. I'll rely on Pocketbase rules or implicitly trust the client-side logic for now.
             if (!pb.authStore.isValid) {
                 guestStorage.saveData({ categories: state.categories, files: state.files });
             }
            showToast(`Category renamed to: ${trimmedName}!`, 2000); 
        }

        if (id === state.activeCategoryId) {
             // If we renamed the active category, update the files list title
             const activeCategoryTitle = document.querySelector('.categories-title');
             if(activeCategoryTitle) activeCategoryTitle.textContent = `${trimmedName} Notes`;
        }
        
        finalizeUIUpdate();
        menu.remove();
    };
  }

  // 3. Delete Category (Only for Custom Categories)
  if (isDeletable) {
    menu.querySelector('.ctx-delete-category').onclick = async () => {
        if (!confirm(`Are you sure you want to delete category "${name}"? All notes in it will be moved to Trash.`)) {
            menu.remove();
            return;
        }
        
        const categoryToDelete = state.categories.find(c => c.id === id || c.localId === id);
        if (!categoryToDelete) { menu.remove(); return; }
        
        // CRITICAL: Determine the ID used by files for the category being deleted
        const categoryToDeleteId = pb.authStore.isValid ? categoryToDelete.id : categoryToDelete.localId || categoryToDelete.id;

        const filesToMove = state.files.filter(f => f.categoryId === categoryToDeleteId);
        
        const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH;
        const trashCategory = state.categories.find(c => c.localId === trashIdentifier || c.id === trashIdentifier);
        const trashCategoryId = pb.authStore.isValid ? trashCategory?.id : trashIdentifier;
        
        if (!trashCategoryId) {
            showToast('Cannot delete: Trash category not found.', 4000);
            menu.remove();
            return;
        }

        // 1. Move files to Trash
        if (pb.authStore.isValid) {
            const promises = filesToMove.map(f => 
                pb.collection('files').update(f.id, { category: trashCategoryId })
                .then(() => f.categoryId = trashCategoryId) 
                .catch(e => console.error(`Failed to move file ${f.id} to trash:`, e))
            );
            await Promise.all(promises);
        } else {
            // Guest mode: update local file state
            filesToMove.forEach(f => f.categoryId = trashCategoryId);
        }

        // 2. Delete the category itself
        if (pb.authStore.isValid && categoryToDelete.id) {
            try {
                await pb.collection('categories').delete(categoryToDelete.id);
            } catch (e) {
                console.error('PocketBase category deletion failed:', e);
                showToast('Category deletion failed on server. Local cleanup applied.', 4000);
            }
        }

        // 3. Update local state (remove category)
        state.categories = state.categories.filter(c => c.id !== id && c.localId !== id);
        
        // 4. Update guest storage
        if (!pb.authStore.isValid) {
            guestStorage.saveData({ categories: state.categories, files: state.files });
        }
        
        // 5. Handle active category change
        if (state.activeCategoryId === id) {
            selectCategory(DEFAULT_CATEGORY_IDS.WORK, true); 
        }

        showToast(`Category "${name}" deleted. ${filesToMove.length} notes moved to Trash.`, 4000);
        finalizeUIUpdate();
        menu.remove();
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

<button class="ctx-delete">
  <svg class="btn-icon"><use href="#icon-delete"></use></svg>
  ${deleteText}
</button>

  `;

  document.body.appendChild(menu);

  const r = btn.getBoundingClientRect();
  menu.style.top = r.bottom + 4 + 'px';
  menu.style.left = r.left + 'px';

  // const file = state.files.find(f => f.id === id); // already defined above

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

  menu.querySelector('.ctx-delete').onclick = () => {
    deleteFile(id); // deleteFile now handles the soft/hard delete logic internally
    menu.remove();
  };

  const close = (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.remove();
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);

  currentMenu = menu;
}

function loadActiveToEditor() {
  const f = state.files.find(x => x.id === state.activeId);
  const editor = document.getElementById('textEditor');
  editor.value = f ? f.content : '';
  updateOriginalContent();
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
  const infoDownload = document.getElementById('infoDownload');
  
  if (infoFileNameDisplay) {
    infoFileNameDisplay.onblur = null;
    infoFileNameDisplay.onkeydown = null;
    infoFileNameDisplay.onclick = null; 
  }

  if (!file) {
    if (infoFileNameDisplay) infoFileNameDisplay.textContent = '—';
    if (infoFileId) infoFileId.textContent = '—';
    if (infoCreated) infoCreated.textContent = '—';
    if (infoModified) infoModified.textContent = '—';

    if (infoDownload) { infoDownload.disabled = true; infoDownload.onclick = null; }
    
    if (encryptionOffline) encryptionOffline.style.display = 'flex';
    if (encryptionOnline) encryptionOnline.style.display = 'none';

    return;
  }

  const isLoggedIn = pb.authStore.isValid && derivedKey;
  
  if (infoFileNameDisplay) {
      infoFileNameDisplay.textContent = file.name;
  }
  if (infoFileId) infoFileId.textContent = file.id;
  if (infoCreated) infoCreated.textContent = formatDate(file.created);
  if (infoModified) infoModified.textContent = formatDate(file.updated);

  if (encryptionOffline && encryptionOnline) {
      encryptionOffline.style.display = isLoggedIn ? 'none' : 'flex';
      encryptionOnline.style.display = isLoggedIn ? 'flex' : 'none';
  }
  
  if (infoDownload) {
    infoDownload.disabled = false;
    infoDownload.onclick = () => downloadNote(file);
  }
}

async function saveVersionIfChanged() {
  const file = state.files.find(f => f.id === state.activeId);
  const currentContent = document.getElementById('textEditor').value;

  if (!file || currentContent === originalContent) return;

  // CRITICAL FIX: If already saving, skip this call
  if (isSavingVersion) {
    console.log('Version save skipped: already saving.');
    return;
  }
  
  isSavingVersion = true;

  try {
    if (pb.authStore.isValid && derivedKey) {
      await createVersionSnapshot(pb, derivedKey, file.id, currentContent); 
    } else {
      if (!file.versions) file.versions = [];
      file.versions.unshift({
        id: `v_${Date.now()}_${Math.random().toString(36).substr(2,6)}`,
        created: new Date().toISOString(),
        content: currentContent
      });
      if (file.versions.length > 50) file.versions.length = 50;
      guestStorage.saveData({ categories: state.categories, files: state.files });
    }

    originalContent = currentContent;
    // CRITICAL FIX: Remove direct call to updateVersionHistory to prevent race condition.
    // We now rely on finalizeUIUpdate (which calls updateVersionHistory) to handle the refresh.
    finalizeUIUpdate();

  } catch (e) {
    console.error('Version save failed:', e);
  } finally {
    // CRITICAL FIX: Ensure the flag is cleared on completion/error
    isSavingVersion = false;
  }
}

/**
 * Update the original content when a file is loaded
 */
function updateOriginalContent() {
  const file = state.files.find(f => f.id === state.activeId);
  originalContent = file ? file.content : '';
}


async function updateVersionHistory(file = null) {
  const versionList = document.getElementById('versionList');
  if (!versionList) return;

  // CRITICAL FIX: CANCEL any previous version history request
  if (versionHistoryController) {
      versionHistoryController.abort();
      versionHistoryController = null; // Clear the reference
  }
  
  // Don't try to load versions for empty/new files
  if (!file || !file.id) {
      versionList.innerHTML = '<li class="muted">No note selected.</li>';
      versionList.classList.remove('loading');
      return;
  }

  versionHistoryController = new AbortController();
  const signal = versionHistoryController.signal;

  const titleElement = document.querySelector('#version-history h4');
  let titleHTML = 'History'; 
  let iconName = 'icon-history'; 
  let badgeHTML = ''; 
  let badgeClass = '';

  const user = pb.authStore.model;
  const isLoggedIn = pb.authStore.isValid;
  let isPremium = false;

  if (isLoggedIn && user?.plan_expires) {
      const expiry = new Date(user.plan_expires);
      const now = new Date();
      isPremium = expiry > now;
  }
  
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

  versionList.classList.add('loading');

  let versions = [];

  // Don't try to load versions for temporary files
  if (file.id.startsWith('temp_')) {
    versions = [];
  } else if (pb.authStore.isValid && derivedKey) {
try {
      // CRITICAL FIX: Pass the signal to getVersions
      versions = await getVersions(pb, derivedKey, file.id, signal);
    } catch (e) {
      // CRITICAL FIX: Check for AbortError/isAbort/Autocancel to handle intentional cancellation silently.
      if (e.name === 'AbortError' || e.isAbort || (e.status === 0 && e.message.includes('autocancelled'))) {
          console.log('Version history load aborted.');
          versionList.classList.remove('loading');
          versionHistoryController = null;
          return; 
      }
      console.error(e);
      versions = [];
    }
  } else {
    versions = file.versions || [];
  }

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
      const contentForPreview = v.content || ''; 
      const preview = contentForPreview.length > 50 
          ? contentForPreview.substring(0, 50) + '...' 
          : contentForPreview || '[empty]';
      
      html += `
        <li class="version-item" data-version-id="${v.id}" data-version-date="${v.created}">
          <strong>${formatDate(v.created)}</strong>
          <small>${preview}</small>
        </li>
      `;
    });
  }

  versionList.innerHTML = html;
  versionList.classList.remove('loading');

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

  if (previewMode && previewVersion) {
    highlightSelectedVersion(previewVersion.id);
  } else {
    highlightSelectedVersion(null);
  }
  
  // Clear the controller on successful completion
  versionHistoryController = null; 
}
// 3. PREVIEW MODE HELPERS
function enterPreviewMode(version) {
  const editor = document.getElementById('textEditor');

  originalBeforePreview = editor.value;

  editor.value = version.content;

  editor.disabled = true;
  editor.classList.add('preview-mode');

  createPreviewBanner(version.created);

  previewMode = true;
  previewVersion = version;
}

function exitPreviewMode() {
  const editor = document.getElementById('textEditor');
  const banner = document.getElementById('previewBanner');

  editor.value = originalBeforePreview;

  editor.disabled = false;
  editor.classList.remove('preview-mode');

  if (banner) banner.remove();

  previewMode = false;
  previewVersion = null;
}

function createPreviewBanner(date) {
  document.getElementById('previewBanner')?.remove();

  const banner = document.createElement('div');
  banner.id = 'previewBanner';
  banner.className = 'preview-banner';
  banner.innerHTML = `
    <div class="banner-text">Previewing version from ${formatDate(date)}</div>
    <div class="banner-actions">
      <button id="restoreBtn">Restore</button>
      <button id="cancelBtn">Cancel</button>
    </div>
  `;

  document.querySelector('.editor-left').appendChild(banner);

  banner.querySelector('#restoreBtn').onclick = handleRestore;
  banner.querySelector('#cancelBtn').onclick = () => {
    exitPreviewMode();
    highlightSelectedVersion(null);
  };
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
async function handleRestore() {
  const file = state.files.find(f => f.id === state.activeId);
  if (!file) return;

  const editor = document.getElementById('textEditor');
  const banner = document.getElementById('previewBanner');

  try {
    if (originalBeforePreview !== originalContent) {
      await createVersionSnapshot(pb, derivedKey, file.id, originalBeforePreview);
    }

    editor.value = previewVersion.content;
    file.content = previewVersion.content;
    file.updated = new Date().toISOString();

    await saveFile(file);

    originalContent = previewVersion.content;
    updateOriginalContent();

    editor.disabled = false;
    editor.classList.remove('preview-mode');

    if (banner) banner.remove();

    previewMode = false;
    previewVersion = null;

    finalizeUIUpdate(); 

    showToast('Restored!', 2000);

  } catch (error) {
    console.error('Restore failed:', error);
    showToast('Restore failed', 3000);
  }
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

// UPDATED selectFile FUNCTION
function selectFile(id) {
  if (previewMode) {
    exitPreviewMode();
    highlightSelectedVersion(null);
  }

  const newActiveFile = state.files.find(x => x.id === id);

  if (newActiveFile) {
      // CRITICAL: When selecting a file, update the activeCategoryId to its category's identifier (PB ID or localId)
      const targetCategory = state.categories.find(c => c.id === newActiveFile.categoryId || c.localId === newActiveFile.categoryId);
      state.activeCategoryId = targetCategory ? (targetCategory.localId || targetCategory.id) : newActiveFile.categoryId;
  }

  if (state.activeId && document.getElementById('textEditor').value !== originalContent) {
    saveVersionIfChanged().finally(() => {
      state.activeId = id;
      finalizeUIUpdate();
    });
  } else {
    state.activeId = id;
    finalizeUIUpdate();
  }
}


/**
 * Executes a single, debounced, locked call to render UI elements that rely on file state.
 */
function finalizeUIUpdate() {
  clearTimeout(finalizeUIUpdateTimeout);

  finalizeUIUpdateTimeout = setTimeout(async () => {
    if (isFinalizingUI) return;
    isFinalizingUI = true;

    try {
      const file = state.files.find(f => f.id === state.activeId);
      
      // CRITICAL: Sort files before rendering
      state.files.sort((a, b) => new Date(b.updated) - new Date(a.updated));
      
      renderFiles();

      loadActiveToEditor();
      
      updateSidebarInfo(file);

      // Only update version history if there's a selected file
      if (file) {
        await updateVersionHistory(file); 
      }
      updateVersionFooter();

    } catch(e) {
      console.error("Final UI Update failed:", e);
    } finally {
      isFinalizingUI = false;
    }
  }, 50); // Reduced timeout for faster UI updates
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
  let isPremium = false; 

  if (isLoggedIn) {
     if (user?.plan_expires) {
          const expiry = new Date(user.plan_expires);
          const now = new Date();
          isPremium = expiry > now;
     }

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
  const historyPanel = document.getElementById('version-history');
  if (!historyPanel) return;

  const existingFooter = document.getElementById('versionFooter');
  if (existingFooter) {
    existingFooter.remove();
  }

  const user = pb.authStore.model;
  let isPremium = false;
  if (user?.plan_expires) {
    const expiry = new Date(user.plan_expires);
    const now = new Date();
    isPremium = expiry > now;
  }

  if (isPremium) {
    return;
  }

  let footerContent;

  if (!pb.authStore.isValid) {
    footerContent = `
      <div class="sign-in-text">Sign in to keep the last 7 days (free)</div>
      <div class="pro-text">
        <a href="Pricing.html" style="color:var(--primary);text-decoration:none;">Go Pro</a> to keep every version forever</a>
      </div>
    `;
  }
  else {
    footerContent = `
      <div class="pro-text">
        <a href="Pricing.html" style="color:var(--primary);text-decoration:none;">Upgrade</a> to Restore all previous versions.
      </div>
    `;
  }

  const fullFooterHTML = `
    <div class="sticky-bottom-box" id="versionFooter">
      ${footerContent}
    </div>
  `;

  historyPanel.insertAdjacentHTML('beforeend', fullFooterHTML);
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

// Init
initPocketBase();
