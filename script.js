import PocketBase from 'https://cdn.jsdelivr.net/npm/pocketbase/dist/pocketbase.es.mjs';
import { 
  deriveMasterKey, generateDataKey, wrapDataKey, unwrapDataKey, 
  exportKeyToString, storeDataKeyInSession, loadDataKeyFromSession, 
  encryptBlob, decryptBlob, randomSalt, arrayToB64, b64ToArray 
} from './crypto.js';
import { initSettings } from './settings.js'; 
import { createVersionSnapshot, getVersions } from './versions.js';
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
let isCategoriesExpanded = localStorage.getItem('kryptNote_categoriesExpanded') === 'true'; // Default to collapsed
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
          if (e.action === 'create' && recentlySavedLocally.has(record.id)) {
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
}

async function clearTrash() {
  if (!confirm('Are you sure you want to permanently delete ALL notes in the Trash? This action cannot be undone.')) {
    return;
  }
  
  const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH; // 'trash'
  
  // 1. Resolve BOTH IDs (Server ID & Local ID)
  // This matches the logic used to display the files, ensuring what you see is what gets deleted.
  let trashPbId = null;
  let trashLocalId = trashIdentifier;
  
  const trashCat = state.categories.find(c => c.localId === trashIdentifier || c.id === trashIdentifier);
  
  if (trashCat) {
      trashPbId = trashCat.id;             // The permanent ID (e.g. "abc123...")
      if (trashCat.localId) trashLocalId = trashCat.localId; // The local ID (e.g. "trash")
  }
  
  // 2. Filter files that match EITHER ID
  const filesToDelete = state.files.filter(f => 
      f.categoryId === trashPbId || f.categoryId === trashLocalId
  );
  
  if (filesToDelete.length === 0) {
      showToast('Trash is already empty.', 2000);
      return;
  }
  
  // 3. Batch Delete from Server
  if (pb.authStore.isValid) {
    try {
        const batch = pb.createBatch();
        
        for (const file of filesToDelete) {
            // Only attempt server delete for synced files (not temp_ ones)
            if (!file.id.startsWith('temp_')) {
                batch.collection('files').delete(file.id);
            }
        }
        
        await batch.send();
        
    } catch (e) {
        console.error('Batch delete failed:', e);
        // Suppress generic autocancel errors, show others
        if (e.status !== 0) {
            showToast('Failed to clear some notes from server.', 3000);
        }
    }
  }

  // 4. Local State Cleanup
  const deletedIds = new Set(filesToDelete.map(f => f.id));
  state.files = state.files.filter(f => !deletedIds.has(f.id));
  
  // Guest storage update
  if (!pb.authStore.isValid) {
    guestStorage.saveData({ categories: state.categories, files: state.files });
  }

  // 5. Handle active file selection
  const currentActiveId = state.activeId; 
  if (currentActiveId && deletedIds.has(currentActiveId)) {
      state.activeId = null;
      document.getElementById('textEditor').value = '';
      updateOriginalContent(); 
  }

  // Refresh Trash View
  if (state.activeCategoryId === trashIdentifier || state.activeCategoryId === trashPbId) {
      // Pass 'false' to avoid auto-selecting a file, just refresh the empty list
      selectCategory(trashIdentifier, false); 
  }
  
  showToast(`${filesToDelete.length} notes permanently deleted.`, 3000);
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

// Show for both logged-in users AND guest users when categories are expanded
if (isCategoriesExpanded) {
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
    // Save the preference to localStorage (use string 'true' or 'false')
    localStorage.setItem('kryptNote_categoriesExpanded', isCategoriesExpanded.toString());
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
  
  // SIMPLE FIX: Position the menu
  let top = r.bottom + 4;
  
  // Check if menu would go off-screen
  if (top + menu.offsetHeight > window.innerHeight) {
    // Move it above the button instead
    top = r.top - menu.offsetHeight - 4;
  }
  
  menu.style.top = top + 'px';
  menu.style.left = r.left + 'px';
  
  if (r.left + menu.offsetWidth > window.innerWidth) {
      menu.style.left = r.right - menu.offsetWidth + 'px'; 
  }

  // --- Event Listeners ---
  
  // 1. Clear Trash (Only for Trash Category)
  if (isTrash) {
    menu.querySelector('.ctx-clear-trash').onclick = () => {
      // CRITICAL FIX: Remove menu immediately upon action start
      menu.remove();
      clearTrash();
    };
  } 
  
  // 2. Rename Category (For Work and Custom Categories)
  if (!isTrash) {
    menu.querySelector('.ctx-rename').onclick = async () => {
        // CRITICAL FIX: Remove menu immediately upon action start
        menu.remove();
        
        const newName = prompt(`Rename category "${name}" to:`, name);
        if (!newName?.trim() || newName.trim() === name) { return; }

        const trimmedName = newName.trim();
        const category = state.categories.find(c => c.id === id || c.localId === id);
        if (!category) { return; }
        
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
            // Guest mode or renaming the default 'Work' category
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
    };
  }

  // 3. Delete Category (Only for Custom Categories)
  if (isDeletable) {
    menu.querySelector('.ctx-delete-category').onclick = async () => {
        
        if (!confirm(`Are you sure you want to delete category "${name}"? All notes in it will be moved to Trash.`)) {
            return;
        }

        // CRITICAL FIX: Remove menu immediately upon action start
        menu.remove();
        
        const categoryToDelete = state.categories.find(c => c.id === id || c.localId === id);
        if (!categoryToDelete) { return; }
        
        // CRITICAL: Determine the ID used by files for the category being deleted
        const categoryToDeleteId = pb.authStore.isValid ? categoryToDelete.id : categoryToDelete.localId || categoryToDelete.id;

        const filesToMove = state.files.filter(f => f.categoryId === categoryToDeleteId);
        
        const trashIdentifier = DEFAULT_CATEGORY_IDS.TRASH;
        const trashCategory = state.categories.find(c => c.localId === trashIdentifier || c.id === trashIdentifier);
        const trashCategoryId = pb.authStore.isValid ? trashCategory?.id : trashIdentifier;
        
        if (!trashCategoryId) {
            showToast('Cannot delete: Trash category not found.', 4000);
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

  menu.querySelector('.ctx-delete').onclick = () => {
    deleteFile(id); // deleteFile now handles the soft/hard delete logic internally
    menu.remove();
  };
}

function loadActiveToEditor() {
  const f = state.files.find(x => x.id === state.activeId);
  const editor = document.getElementById('textEditor');
  
  const newContent = f ? f.content : '';
  
  // Only update the editor if the value has actually changed.
  if (editor.value !== newContent) {
    editor.value = newContent;
  }
  
  // CRITICAL FIX: Ensure originalContent is set based on the editor's actual value
  // This is the content that *should* be in the file, preventing an immediate save on blur/next tick.
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
  // CRITICAL FIX: Ensure originalContent is set based on the editor's current value
  // after loadActiveToEditor has set it, making it the perfect match for the active file.
  originalContent = document.getElementById('textEditor').value;
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
      
      // CRITICAL FIX: Robust sort with fallback for identical timestamps
      state.files.sort((a, b) => {
        const timeA = new Date(a.updated).getTime();
        const timeB = new Date(b.updated).getTime();

        if (timeA !== timeB) {
          return timeB - timeA; // Sort newest first
        }
        
        // Secondary sort by name (ascending) for identical timestamps
        return a.name.localeCompare(b.name);
      });
      
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
  }, 0); // Changed to 0ms delay for immediate post-load execution
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
