// ============================================================
// DATA LAYER
// ============================================================
const STORAGE_KEY = 'mpwt_doc_system';
const SESSION_KEY = 'docuflow_session';
const AUTH_API_BASE_KEY = 'docuflow_auth_api_base';
const DEFAULT_AUTH_API_BASE = 'https://script.google.com/macros/s/AKfycbx5tl1vMimhPVe06-lhAAgHX9w-UBPuRI9nReApK4Yj47lYg3smC3go5ZD0swXe3Hpm/exec';
// During development use your locally hosted backend. Replace with your production URL when ready.
const BACKEND_URL = 'http://localhost:3000/';
const APP_API_KEY = 'myicddepartment';
// If you want documents exported automatically to another Google Sheet, set the ID here.
// Example: const EXPORT_SPREADSHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz';
const EXPORT_SPREADSHEET_ID = '1j-gXA3IxV9CNiTtbB7Uvk-vCheyB71Du4Ggz_oF_S4w';
let currentUser = null;
let adminUsersCache = null;
let adminPendingUsersCache = null;
// In-memory selection state for documents (holds ids)
const selectedDocIds = new Set();
let selectionMode = false;
// Background sync state
let bgSyncTimer = null;
let bgSyncInProgress = false;
const BG_SYNC_DELAY = 1200; // ms
// Sync status and retry configuration
let syncState = 'idle'; // 'idle' | 'syncing' | 'online' | 'offline'
let lastSyncAt = null; // timestamp
const BG_MAX_RETRIES = 5;
const BG_RETRY_BASE_MS = 2000; // initial backoff

function isValidGASUrl(url) {
    return typeof url === 'string' && /^https:\/\/script\.google\.com\/macros\/s\/[^\/]+\/exec(?:\?.*)?$/.test(url.trim());
}

function normalizeGASUrl(url) {
    return String(url || '').trim().replace(/\s+$/g, '').replace(/\/+$|\?+$/g, '');
}

function getAuthApiBase() {
    const customBase = String(localStorage.getItem(AUTH_API_BASE_KEY) || '').trim();
    const defaultBase = String(DEFAULT_AUTH_API_BASE || '').trim();
    const normalizedCustom = normalizeGASUrl(customBase);
    if (isValidGASUrl(normalizedCustom)) return normalizedCustom;
    const normalizedDefault = normalizeGASUrl(defaultBase);
    if (isValidGASUrl(normalizedDefault)) return normalizedDefault;
    return '';
}

function normalizeDriveUrl(url) {
    if (!url || typeof url !== 'string') return url;
    const trimmed = url.trim();
    // Inline image fallbacks are already browser-ready URLs.  Their Base64
    // payload can look like a Drive file ID, so never try to normalize them.
    if (/^data:/i.test(trimmed) || /^blob:/i.test(trimmed)) return trimmed;
    const match = trimmed.match(/[-\w]{25,}/);
    if (match && match[0]) {
        // Return a direct view/download URL suitable for <img src>
        return `https://drive.google.com/uc?export=view&id=${match[0]}`;
    }
    return trimmed;
}

function normalizeDrivePreviewUrl(url) {
    if (!url || typeof url !== 'string') return url;
    const trimmed = url.trim();
    const match = trimmed.match(/[-\w]{25,}/);
    if (match && match[0]) {
        return `https://drive.google.com/file/d/${match[0]}/preview`;
    }
    return trimmed;
}

async function authApiRequest(action, payload = {}) {
    const url = getAuthApiBase();
    if (!url) {
        return { res: { ok: false, status: 0 }, data: { success: false, error: 'Set your Google Apps Script Web App URL first.' } };
    }

    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
        body: JSON.stringify({ action, ...payload })
    });
    const text = await res.text();
    let data;
    try {
        data = JSON.parse(text);
    } catch (_err) {
        data = { success: false, error: 'Invalid auth server response' };
    }
    return { res, data };
}

function ensureSyncStatusElement() {
    // Try to create or reuse a small sync status element in the header
    let el = $('syncStatus');
    if (!el) {
        const host = $('pageTitle') || $('userBadge') || document.body;
        if (!host) return null;
        el = document.createElement('span');
        el.id = 'syncStatus';
        el.style.marginLeft = '12px';
        el.style.fontSize = '0.9rem';
        el.style.color = 'var(--gray-600)';
        el.style.padding = '4px 8px';
        el.style.borderRadius = '6px';
        el.style.background = 'transparent';
        // append to host if it's an element that can contain children
        try { host.appendChild(el); } catch (e) { document.body.appendChild(el); }
    }
    return el;
}

function updateSyncStatusUI() {
    const el = ensureSyncStatusElement();
    if (!el) return;
    const state = syncState || 'idle';
    let text = '';
    if (state === 'syncing') text = 'Syncing...';
    else if (state === 'online') text = 'Online';
    else if (state === 'offline') text = 'Offline';
    else text = 'Idle';
    if (lastSyncAt) {
        const d = new Date(lastSyncAt);
        const timestr = d.toLocaleString();
        text += ` · Last: ${timestr}`;
    }
    el.textContent = text;
}

function getDocs() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        const docs = raw ? JSON.parse(raw) : [];
        if (Array.isArray(docs) && docs.length > 0) {
            documents = docs.map(doc => ({
                ...doc,
                entryDate: normalizeDateString(doc.entryDate || doc.dateOfEntry || '')
            }));
            if (renumberAllDocsSequentially()) {
                saveDocs(documents);
            }
            return documents;
        }
        return docs;
    } catch {
        return [];
    }
}

function saveDocs(docs) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(docs));
    // schedule background sync to push changes to backend (debounced)
    try { scheduleBackgroundSync(); } catch (e) { console.warn('scheduleBackgroundSync failed', e); }
}

function scheduleBackgroundSync() {
    if (bgSyncTimer) clearTimeout(bgSyncTimer);
    bgSyncTimer = setTimeout(() => { runBackgroundSync().catch(err => console.warn('bg sync error', err)); }, BG_SYNC_DELAY);
}

async function runBackgroundSync() {
    bgSyncTimer = null;
    if (bgSyncInProgress) return;
    // only attempt background sync when user is signed in
    if (!currentUser || !currentUser.token) return;
    bgSyncInProgress = true;
    try {
        // Attempt background sync with retries and exponential backoff
        syncState = 'syncing';
        updateSyncStatusUI();
        let attempt = 0;
        let success = false;
        let lastErr = null;
        while (attempt < BG_MAX_RETRIES && !success) {
            attempt++;
            try {
                const res = await saveDocsToBackend(documents);
                if (res && res.success) {
                    success = true;
                    lastSyncAt = Date.now();
                    syncState = 'online';
                    updateSyncStatusUI();
                    break;
                } else {
                    lastErr = res && res.error ? res.error : 'Unknown error';
                    console.warn('Background sync attempt', attempt, 'failed:', lastErr);
                }
            } catch (e) {
                lastErr = e && e.message ? e.message : e;
                console.warn('Background sync attempt', attempt, 'exception:', lastErr);
            }
            // Backoff before next attempt
            const delay = BG_RETRY_BASE_MS * Math.pow(2, attempt - 1);
            await new Promise(r => setTimeout(r, delay));
        }
        if (!success) {
            syncState = 'offline';
            updateSyncStatusUI();
            console.warn('Background sync ultimately failed after retries', lastErr);
            // Schedule another attempt later to avoid permanent failure
            try { bgSyncTimer = setTimeout(() => { runBackgroundSync().catch(e=>console.warn('bg retry error',e)); }, BG_RETRY_BASE_MS * 4); } catch (e) {}
        }
    } catch (err) {
        console.warn('Background sync failed', err);
    } finally {
        bgSyncInProgress = false;
    }
}

function getSession() {
    try {
        const raw = localStorage.getItem(SESSION_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

function saveSession(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function clearSession() {
    localStorage.removeItem(SESSION_KEY);
    currentUser = null;
}

async function fetchUsersFromBackend() {
    if (!currentUser || !currentUser.role || currentUser.role !== 'admin') return [];
    try {
        const result = await callBackend('getUsers', {});
        if (result && result.success && Array.isArray(result.users)) {
            return result.users;
        }
    } catch (e) {
        console.warn('fetchUsersFromBackend failed', e);
    }
    return [];
}

async function fetchCurrentUserProfile() {
    if (!currentUser || !currentUser.email) return null;
    try {
        const result = await callBackend('getUserProfile', { email: currentUser.email });
        if (result && result.success && result.user) {
            // normalize avatar/profile picture link from backend
            if (result.user.profilePictureUrl) {
                result.user.profilePictureUrl = normalizeDriveUrl(result.user.profilePictureUrl);
                if (!result.user.avatarUrl) {
                    result.user.avatarUrl = result.user.profilePictureUrl;
                }
            }
            if (result.user.avatarUrl) {
                result.user.avatarUrl = normalizeDriveUrl(result.user.avatarUrl);
            }
            currentUser = { ...currentUser, ...result.user };
            saveSession({ email: currentUser.email, token: currentUser.token, name: currentUser.name, role: currentUser.role });
            return result.user;
        }
    } catch (e) {
        console.warn('fetchCurrentUserProfile failed', e);
    }
    return null;
}

async function uploadProfilePicture(email, dataUrl) {
    if (!email || !dataUrl) return { success: false, error: 'Missing email or image data' };
    const bytes = String(dataUrl).split(',')[1] || '';
    const filePayload = {
        bytes,
        name: `avatar_${String(email).replace(/[^a-zA-Z0-9_-]/g, '_')}.jpg`,
        mimeType: 'image/jpeg',
        size: Math.round((dataUrl.length - dataUrl.indexOf(',') - 1) * 3 / 4)
    };

    const tryAction = async (action) => {
        try {
            // Drive can take longer than the normal API request timeout,
            // particularly for the first upload to a folder.
            const result = await callBackend(action, { email, file: filePayload }, 60000);
            return result;
        } catch (err) {
            return { success: false, error: String(err) };
        }
    };

    let result = await tryAction('updateProfilePicture');
    if (!result || !result.success) {
        if (result && (result.profilePictureUrl || result.avatarUrl)) {
            return { ...result, success: true };
        }
        if (result && typeof result.error === 'string' && result.error.toLowerCase().includes('unknown action')) {
            console.warn('updateProfilePicture unsupported, retrying saveUserAvatar fallback');
            result = await tryAction('saveUserAvatar');
        }
        if (!result || !result.success) {
            console.warn('Profile upload retry fallback result:', result);
            if (result && (result.profilePictureUrl || result.avatarUrl)) {
                return { ...result, success: true };
            }
        }
    }
    return result || { success: false, error: 'Upload failed' };
}

async function callBackend(action, data = {}, timeoutMs = 15000) {
    const gasUrl = getAuthApiBase();
    const payload = { action, appKey: APP_API_KEY, ...data };

    // Route all actions through the Google Apps Script Web App
    if (gasUrl) {
        try {
            const controller = new AbortController();
            const timeoutId  = setTimeout(() => controller.abort(), timeoutMs);
            const response   = await fetch(gasUrl, {
                method:  'POST',
                headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                body:    JSON.stringify(payload),
                signal:  controller.signal
            });
            clearTimeout(timeoutId);
            const text = await response.text();
            let result;
            try { result = JSON.parse(text); } catch (_) { result = { success: false, error: 'Invalid GAS response' }; }
            if (result && typeof result === 'object') return result;
        } catch (e) {
            console.warn('GAS callBackend failed for', action, ':', e.message);
        }
    }

    // Local fallback when GAS URL is not configured or unreachable
    if (action === 'getDocs') {
        return { success: false, error: 'GAS URL not configured — set DEFAULT_AUTH_API_BASE first.' };
    }
    switch (action) {
        case 'saveDocs':
        case 'saveDocsSimple':
            return handleLocalSaveDocs(payload);
        case 'exportDocsToSheet':
            return { success: true }; // silently skip if no GAS URL
        case 'getUsers':
            return { success: true, users: getAllUsers() };
        default:
            return { success: false, error: 'Unknown action: ' + action };
    }
}


// ============================================================
// LOCAL STORAGE BACKEND HANDLERS
// ============================================================

const USERS_DB_KEY = 'docuflow_users_db';
const PENDING_USERS_KEY = 'docuflow_pending_users';

function getAllUsers() {
    try {
        const raw = localStorage.getItem(USERS_DB_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function saveAllUsers(users) {
    localStorage.setItem(USERS_DB_KEY, JSON.stringify(users));
}

function getPendingUsers() {
    try {
        const raw = localStorage.getItem(PENDING_USERS_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function savePendingUsers(users) {
    localStorage.setItem(PENDING_USERS_KEY, JSON.stringify(users));
}

function hashPassword(password) {
    // Simple hash for demo - NOT secure for production
    let hash = 0;
    for (let i = 0; i < password.length; i++) {
        const char = password.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return hash.toString();
}

// Resize image file to a smaller dataURL to avoid localStorage quota issues
async function resizeImageFile(file, maxSize = 256, quality = 0.8) {
    return new Promise((resolve, reject) => {
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => {
            const img = new Image();
            img.onload = () => {
                try {
                    let { width, height } = img;
                    const scale = Math.min(1, maxSize / Math.max(width, height));
                    width = Math.round(width * scale);
                    height = Math.round(height * scale);
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;
                    const ctx = canvas.getContext('2d');
                    // draw with white background if original has no alpha and output jpeg
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, width, height);
                    ctx.drawImage(img, 0, 0, width, height);
                    // prefer jpeg for smaller size unless original needs transparency
                    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
                    const dataUrl = canvas.toDataURL(type, quality);
                    resolve(dataUrl);
                } catch (err) {
                    // fallback to original data if resizing fails
                    resolve(reader.result);
                }
            };
            img.onerror = () => resolve(reader.result);
            img.src = reader.result;
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
    });
}

// -----------------------------
// IndexedDB blob store (avatars, pdfs)
// -----------------------------
const BLOB_DB_NAME = 'docuflow_blobs_v1';
const BLOB_STORE = 'blobs';
let useIndexedDB = true;
let blobDb = null; // IDBDatabase
const blobUrlCache = {}; // map ref -> objectURL

function openBlobDB() {
    return new Promise((resolve, reject) => {
        if (!window.indexedDB) {
            useIndexedDB = false;
            return resolve(null);
        }
        const req = indexedDB.open(BLOB_DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(BLOB_STORE)) {
                db.createObjectStore(BLOB_STORE, { keyPath: 'key' });
            }
        };
        req.onsuccess = (e) => {
            blobDb = e.target.result;
            resolve(blobDb);
        };
        req.onerror = (e) => {
            console.error('IndexedDB open error', e);
            useIndexedDB = false;
            resolve(null);
        };
    });
}

async function ensureBlobDB() {
    if (blobDb || !useIndexedDB) return;
    await openBlobDB();
}

function idbPut(obj) {
    return new Promise(async (resolve, reject) => {
        await ensureBlobDB();
        if (!blobDb) return resolve(false);
        const tx = blobDb.transaction([BLOB_STORE], 'readwrite');
        const store = tx.objectStore(BLOB_STORE);
        const req = store.put(obj);
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => { console.error('idb put error', e); resolve(false); };
    });
}

function idbGet(key) {
    return new Promise(async (resolve, reject) => {
        await ensureBlobDB();
        if (!blobDb) return resolve(null);
        const tx = blobDb.transaction([BLOB_STORE], 'readonly');
        const store = tx.objectStore(BLOB_STORE);
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = (e) => { console.error('idb get error', e); resolve(null); };
    });
}

function idbDelete(key) {
    return new Promise(async (resolve, reject) => {
        await ensureBlobDB();
        if (!blobDb) return resolve(false);
        const tx = blobDb.transaction([BLOB_STORE], 'readwrite');
        const store = tx.objectStore(BLOB_STORE);
        const req = store.delete(key);
        req.onsuccess = () => resolve(true);
        req.onerror = (e) => { console.error('idb delete error', e); resolve(false); };
    });
}

async function saveBlobRef(key, data) {
    // data can be Blob or dataURL
    if (!key || !data) return false;
    await ensureBlobDB();
    if (!blobDb) {
        // fallback: store dataURL in localStorage under special key
        try { localStorage.setItem(`blob_fallback_${key}`, data); return true; } catch (e) { console.error('fallback blob save failed', e); return false; }
    }
    let blob = null;
    if (data instanceof Blob) blob = data;
    else if (typeof data === 'string' && data.startsWith('data:')) {
        try {
            const res = await fetch(data);
            blob = await res.blob();
        } catch (e) {
            console.error('convert dataurl to blob failed', e);
            return false;
        }
    } else {
        return false;
    }
    const record = { key, blob, createdAt: Date.now() };
    return await idbPut(record);
}

async function getBlobUrl(ref) {
    if (!ref) return null;
    // return cached object URL if exists
    if (blobUrlCache[ref]) return blobUrlCache[ref];
    await ensureBlobDB();
    if (!blobDb) {
        // fallback to localStorage dataURL
        const data = localStorage.getItem(`blob_fallback_${ref}`);
        if (data) return data;
        return null;
    }
    const rec = await idbGet(ref);
    if (!rec || !rec.blob) return null;
    const url = URL.createObjectURL(rec.blob);
    blobUrlCache[ref] = url;
    return url;
}

async function deleteBlobRef(ref) {
    if (!ref) return false;
    await ensureBlobDB();
    if (!blobDb) {
        try { localStorage.removeItem(`blob_fallback_${ref}`); } catch (e) {}
        return true;
    }
    // revoke cached URL if present
    if (blobUrlCache[ref]) { try { URL.revokeObjectURL(blobUrlCache[ref]); } catch (e) {} delete blobUrlCache[ref]; }
    return await idbDelete(ref);
}

// initialize DB (best-effort)
openBlobDB();

// Convenience wrappers for document/pdf storage
async function saveDocumentBlob(ref, blobOrDataUrl) {
    return await saveBlobRef(ref, blobOrDataUrl);
}

async function getDocumentBlobUrl(ref) {
    return await getBlobUrl(ref);
}

async function deleteDocumentBlob(ref) {
    return await deleteBlobRef(ref);
}

function handleLocalRegister(payload) {
    const name = String(payload.name || '').trim();
    const email = String(payload.email || '').trim().toLowerCase();
    const password = String(payload.password || '').trim();
    
    if (!name || !email || !password) {
        return { success: false, error: 'Name, email, and password required' };
    }
    
    const users = getAllUsers();
    const pending = getPendingUsers();
    
    // Check if already registered
    if (users.some(u => u.email === email) || pending.some(u => u.email === email)) {
        return { success: false, error: 'Email already registered' };
    }
    
    // Add to pending
    pending.push({
        name,
        email,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
        status: 'pending'
    });
    
    savePendingUsers(pending);
    toast('Account created! Waiting for admin approval.', 'success');
    
    return { 
        success: true, 
        message: 'Registration submitted. Await admin approval.' 
    };
}

function handleLocalLogin(payload) {
    const email = String(payload.email || '').trim().toLowerCase();
    const password = String(payload.password || '').trim();
    
    if (!email || !password) {
        return { success: false, error: 'Email and password required' };
    }
    
    const users = getAllUsers();
    const user = users.find(u => u.email === email);
    
    if (!user) {
        return { success: false, error: 'Invalid email or password' };
    }
    
    if (user.status !== 'active') {
        return { success: false, error: 'Account not active. Wait for admin approval.' };
    }
    
    if (user.passwordHash !== hashPassword(password)) {
        return { success: false, error: 'Invalid email or password' };
    }
    
    // Generate simple token
    const token = Math.random().toString(36).substr(2, 9);
    user.token = token;
    user.lastLogin = new Date().toISOString();
    
    saveAllUsers(users);
    
    return {
        success: true,
        user: {
            email: user.email,
            name: user.name,
            role: user.role || 'user',
            status: user.status,
            token
            ,position: user.position || ''
            ,phone: user.phone || ''
            ,birthday: user.birthday || ''
            ,avatarUrl: user.avatarUrl || ''
            ,avatarRef: user.avatarRef || ''
        }
    };
}

function handleLocalVerifySession(payload) {
    const email = String(payload.email || '').trim().toLowerCase();
    const token = String(payload.token || '').trim();
    
    if (!email || !token) {
        return { success: false, error: 'Email and token required' };
    }
    
    const users = getAllUsers();
    const user = users.find(u => u.email === email && u.token === token);
    
    if (!user) {
        return { success: false, error: 'Invalid session' };
    }
    
    if (user.status !== 'active') {
        return { success: false, error: 'Account not active' };
    }
    
    return {
        success: true,
        user: {
            email: user.email,
            name: user.name,
            role: user.role || 'user',
            status: user.status,
            token
            ,position: user.position || ''
            ,phone: user.phone || ''
            ,birthday: user.birthday || ''
            ,avatarUrl: user.avatarUrl || ''
            ,avatarRef: user.avatarRef || ''
        }
    };
}

function handleLocalGetDocs(payload) {
    const verify = handleLocalVerifySession(payload);
    if (!verify.success) {
        return verify;
    }

    // Use the shared storage key so local-only mode still presents a single
    // authoritative document set across accounts on the same machine.
    try {
        const docs = getDocs();
        return { success: true, docs };
    } catch (e) {
        return { success: true, docs: [] };
    }
}

function handleLocalSaveDocs(payload) {
    const verify = handleLocalVerifySession(payload);
    if (!verify.success) {
        return verify;
    }
    
    const docs = Array.isArray(payload.docs) ? payload.docs : [];
    // Persist into the shared local storage so subsequent logins/browsers see the same data
    try {
        saveDocs(docs);
    } catch (e) {
        // fallback to writing under the per-email key if saveDocs fails
        try { localStorage.setItem(`docs_${payload.email}`, JSON.stringify(docs)); } catch (err) { console.warn('local fallback save failed', err); }
    }
    return { success: true };
}

function handleLocalSaveDocsSimple(payload) {
    const verify = handleLocalVerifySession(payload);
    if (!verify.success) return verify;
    try {
        const docs = Array.isArray(payload.docs) ? payload.docs : [];
        // Store a simple per-email sheet-like entry for inspection
        const key = `docs_simple_${payload.email}`;
        localStorage.setItem(key, JSON.stringify(docs));
        return { success: true };
    } catch (e) {
        return { success: false, error: e && e.message ? e.message : 'Failed to save simple docs' };
    }
}

async function loadDocs() {
    if (currentUser) {
        // Pull all workflow records from Google Sheets (central cloud source)
        try {
            const result = await gasPost({ action: 'getAllWorkflows' });
            if (result && result.success && Array.isArray(result.records)) {
                // Convert GAS records to local document format
                const docs = result.records.map(r => ({
                    id:          r.referenceNumber || generateId(),
                    no:          '',
                    title:       r.documentTitle || '',
                    ref:         r.referenceNumber || '',
                    origin:      r.originSource || '',
                    entryDate:   normalizeDateString(r.dateOfEntry || ''),
                    inCharge:    r.inChargeOf || '',
                    description: r.descriptionSummary || '',
                    workProcess: r.workProcess || '',
                    leaderName:  r.leaderName || '',
                    workflowData: r.workflowData || {},
                    createdAt:   r.lastUpdated || Date.now(),
                    createdBy:   r.updatedBy || '',
                    pdfFileUrl:  normalizeDriveUrl(r.pdfFileUrl || ''),
                    pictureFileUrl: normalizeDriveUrl(r.pictureFileUrl || '')
                }));
                documents = docs;
                renumberAllDocsSequentially();
                try { saveDocs(documents); } catch (e) { console.warn('saveDocs after loadDocs failed', e); }
                lastSyncAt = Date.now();
                syncState = 'online';
                updateSyncStatusUI();
                return docs;
            }
        } catch (e) {
            console.warn('loadDocs from GAS failed:', e);
        }
        syncState = 'offline';
        updateSyncStatusUI();
    }
    return getDocs();
}

// Load documents from the backend without requiring a user session.
async function loadDocsNoAuth() {
    try {
        const result = await callBackend('getDocsNoAuth', {});
        if (result && result.success && Array.isArray(result.docs)) {
            documents = result.docs.map(d => ({
                ...d,
                entryDate: normalizeDateString(d.entryDate || d.dateOfEntry || '')
            }));
            renumberAllDocsSequentially();
            try { saveDocs(documents); } catch (e) { console.warn('saveDocs after loadDocsNoAuth failed', e); }
            lastSyncAt = Date.now();
            syncState = 'online';
            updateSyncStatusUI();
            return documents;
        }
        // fallback: local docs
        syncState = 'offline';
        updateSyncStatusUI();
        return getDocs();
    } catch (e) {
        console.warn('loadDocsNoAuth failed', e);
        syncState = 'offline';
        updateSyncStatusUI();
        return getDocs();
    }
}

async function saveDocsToBackend(docs, options = {}) {
    // options: { exportSubset: Array } - if provided, only export that subset to the configured spreadsheet
    if (!currentUser) return saveDocs(docs);
    // mark syncing state
    syncState = 'syncing';
    updateSyncStatusUI();
    const result = await callBackend('saveDocs', { email: currentUser.email, token: currentUser.token, docs });
    if (!result || !result.success) {
        // update status and keep local copy
        syncState = 'offline';
        updateSyncStatusUI();
        return saveDocs(docs);
    }

    // update sync metadata
    lastSyncAt = Date.now();
    syncState = 'online';
    updateSyncStatusUI();

    // Persist a simplified per-row representation (Title / Ref | Origin | Entry Date | Status | Workflow | Actions)
    try {
        const simpleRes = await callBackend('saveDocsSimple', { email: currentUser.email, token: currentUser.token, docs });
        if (!simpleRes || !simpleRes.success) {
            console.warn('saveDocsSimple returned error:', simpleRes && simpleRes.error);
            // If backend responded but doesn't support this action, fall back to local handler
            if (simpleRes && simpleRes.error && typeof simpleRes.error === 'string' && simpleRes.error.includes('Unknown action')) {
                try {
                    const localRes = handleLocalSaveDocsSimple({ email: currentUser.email, docs });
                    if (!localRes || !localRes.success) console.warn('Local saveDocsSimple fallback failed', localRes && localRes.error);
                } catch (e) { console.warn('Local saveDocsSimple fallback exception', e); }
            }
        }
    } catch (err) {
        console.warn('saveDocsSimple failed:', err && err.message ? err.message : err);
    }
    // Automatic export to configured spreadsheet (if set)
    try {
        if (typeof EXPORT_SPREADSHEET_ID === 'string' && EXPORT_SPREADSHEET_ID.trim()) {
            // Determine which docs to export: use options.exportSubset if provided, else export the full docs list
            const toExport = (options && Array.isArray(options.exportSubset) && options.exportSubset.length) ? options.exportSubset : docs;
            // Build a simplified docs payload including id/ref to support robust upserts
            const simplified = Array.isArray(toExport) ? toExport.map(d => ({
                id: d.id || '',
                ref: d.ref || '',
                no: d.no || d.No || '',
                title: d.title || '',
                origin: d.origin || '',
                entryDate: d.entryDate || '',
                inCharge: d.inCharge || d.inChargeOf || d['In Charge Of'] || '',
                // include workflow flows so exportDocsToSheet can write them into Flow1..Flow6 (columns H..M)
                flow1: d.flow1 || getStepStatus(d, 'admin') || '',
                flow2: d.flow2 || getStepStatus(d, 'review') || getStepStatus(d, 'dg') || '',
                flow3: d.flow3 || getStepStatus(d, 'cabinet') || '',
                flow4: d.flow4 || getStepStatus(d, 'minister') || '',
                flow5: d.flow5 || '',
                flow6: d.flow6 || getStepStatus(d, 'archive') || '',
                assignTo: d.assignTo || d.assignToAdmin || '',
                status: computeOverallStatus(d) || 'pending'
            })) : [];

            const expPayload = {
                email: currentUser.email,
                token: currentUser.token,
                targetSpreadsheetId: EXPORT_SPREADSHEET_ID.trim(),
                sheetName: 'Documents',
                docs: simplified
            };
            // pass through fullSync flag when caller requests a full synchronization (delete+renumber)
            if (options && options.fullSync) expPayload.fullSync = true;

            const expRes = await callBackend('exportDocsToSheet', expPayload);

            if (expRes && expRes.success) {
                // silent success
            } else {
                const errMsg = expRes && expRes.error ? String(expRes.error) : 'Unknown error';
                console.warn('exportDocsToSheet failed:', errMsg);
            }
        }
    } catch (e) {
        console.warn('Automatic export failed', e && e.message ? e.message : e);
    }
    return result;
}

async function loginUser(email, password) {
    try {
        const { res, data } = await authApiRequest('login', { email, password });
        if (!res.ok || !data.success) {
            return { success: false, error: data.error || 'Login failed' };
        }

        const user = data.user || {};
        const loginResult = {
            success: true,
            user: {
                email: user.email || String(email).trim().toLowerCase(),
                name: user.email || String(email).trim().toLowerCase(),
                role: user.role || 'user',
                token: 'gas-session',
                status: 'active'
            }
        };

        currentUser = loginResult.user;
        saveSession({ email: currentUser.email, token: currentUser.token, name: currentUser.name, role: currentUser.role });
        await fetchCurrentUserProfile();
        try {
            const serverDocs = await loadDocs();
            if (Array.isArray(serverDocs)) {
                documents = serverDocs;
                try { saveDocs(documents); } catch (e) { console.warn('saveDocs after login failed', e); }
            }
        } catch (e) {
            console.warn('Failed to refresh documents after login', e);
        }
        try { setAuthState(); } catch (e) {}
        try { renderAllDocs(); } catch (e) {}
        return { success: true };
    } catch (_err) {
        return { success: false, error: 'Unable to reach authentication service.' };
    }
}


async function registerUser(name, email, password) {
    try {
        const { res, data } = await authApiRequest('register', { name, email, password, role: 'user' });
        if (!res.ok || !data.success) {
            return { success: false, error: data.error || 'Registration failed' };
        }
        return { success: true, user: data.user };
    } catch (_err) {
        return { success: false, error: 'Unable to reach authentication service.' };
    }
}

async function verifySession() {
    const session = getSession();
    if (!session) return false;

    currentUser = {
        email: session.email || 'user@example.com',
        name: session.name || session.email || 'User',
        role: session.role || 'user',
        token: session.token || 'gas-session',
        status: 'active'
    };

    if (getAuthApiBase()) {
        try {
            const profile = await fetchCurrentUserProfile();
            if (profile) {
                currentUser = { ...currentUser, ...profile };
            }
        } catch (e) {
            console.warn('verifySession fetchCurrentUserProfile failed', e);
        }
    }

    saveSession({
        email: currentUser.email,
        token: currentUser.token,
        name: currentUser.name,
        role: currentUser.role
    });
    return true;
}

function setAuthState() {
    const userBadge = $('userBadge');
    const userName = $('loggedInUserName');
    const userAvatar = $('userAvatar');
    const userMenu = $('userMenu');
    const accountNav = $('accountNavLink');
    const adminNav = $('adminNavLink');
    const isAdmin = currentUser && currentUser.role === 'admin';
    if (adminNav) {
        adminNav.style.display = isAdmin ? 'block' : 'none';
    }

    if (accountNav) {
        accountNav.style.display = currentUser ? 'block' : 'none';
    }

    if (currentUser) {
        userName.textContent = currentUser.name || currentUser.email || 'User';
        // set userAvatar to image if available
        if (currentUser.avatarRef) {
            setAvatarElement(userAvatar, null, '');
            getBlobUrl(currentUser.avatarRef).then(url => { if (url) setAvatarElement(userAvatar, url, ''); }).catch(() => { setAvatarElement(userAvatar, null, (currentUser.name || 'U').slice(0,1)); });
        } else if (currentUser.avatarUrl) {
            setAvatarElement(userAvatar, normalizeDriveUrl(currentUser.avatarUrl), '');
        } else {
            setAvatarElement(userAvatar, null, (currentUser.name || 'U').slice(0,1));
        }
        userBadge.classList.add('logged-in');
        if (userMenu) { userMenu.classList.remove('show'); userMenu.setAttribute('aria-hidden', 'true'); }
        // populate menu profile details (show only position under the name)
        const menuUserName = $('menuUserName');
        const menuUserPosition = $('menuUserPosition');
        const menuAvatar = $('menuAvatar');
        if (menuUserName) menuUserName.textContent = currentUser.name || currentUser.email || 'User';
        if (menuUserPosition) menuUserPosition.textContent = currentUser.position || '—';
        if (menuAvatar) {
            if (currentUser.avatarRef) {
                setAvatarElement(menuAvatar, null, '');
                getBlobUrl(currentUser.avatarRef).then(url => { if (url) setAvatarElement(menuAvatar, url, ''); }).catch(() => { setAvatarElement(menuAvatar, null, (currentUser.name || 'U').slice(0,1)); });
            } else if (currentUser.avatarUrl) {
                setAvatarElement(menuAvatar, normalizeDriveUrl(currentUser.avatarUrl), '');
            } else {
                setAvatarElement(menuAvatar, null, (currentUser.name || 'U').slice(0,1));
            }
        }
    } else {
        userName.textContent = 'Guest';
        userAvatar.textContent = 'G';
        userBadge.classList.remove('logged-in');
        if (userMenu) { userMenu.classList.remove('show'); userMenu.setAttribute('aria-hidden', 'true'); }
        // clear menu profile details (only position shown under name)
        const menuUserName = $('menuUserName');
        const menuUserPosition = $('menuUserPosition');
        const menuAvatar = $('menuAvatar');
        if (menuUserName) menuUserName.textContent = 'Guest';
        if (menuUserPosition) menuUserPosition.textContent = '';
        if (menuAvatar) { setAvatarElement(menuAvatar, null, 'G'); }
    }
}
async function loadAccountInfoPage() {
    const accountName = $('accountName');
    const accountEmail = $('accountEmail');
    const accountPosition = $('accountPosition');
    const accountPhone = $('accountPhone');
    const accountBirthday = $('accountBirthday');
    const profilePhotoPreview = $('profilePhotoPreview');
    const profilePhotoInitial = $('profilePhotoInitial');

    if (!currentUser) {
        toast('Please sign in to access account information.', 'error');
        return navigateTo('dashboard');
    }

    if (getAuthApiBase()) {
        await fetchCurrentUserProfile();
    }

    const user = currentUser;

    if (accountName) accountName.value = user.name || currentUser.name || '';
    if (accountEmail) accountEmail.value = user.email || '';
    if (accountPosition) accountPosition.value = user.position || '';
    if (accountPhone) accountPhone.value = user.phone || '';
    if (accountBirthday) accountBirthday.value = user.birthday || '';
    if (profilePhotoPreview) {
        // If user has avatarRef stored in IndexedDB, load it asynchronously
        if (profilePhotoData) {
            profilePhotoPreview.style.backgroundImage = `url('${profilePhotoData}')`;
            profilePhotoPreview.textContent = '';
        } else if (user.avatarRef) {
            profilePhotoPreview.style.backgroundImage = 'none';
            getBlobUrl(user.avatarRef).then(url => {
                if (url) {
                    profilePhotoPreview.style.backgroundImage = `url('${url}')`;
                    profilePhotoPreview.textContent = '';
                } else {
                    profilePhotoPreview.style.backgroundImage = 'none';
                    if (profilePhotoInitial) profilePhotoInitial.textContent = (user.name || currentUser.name || 'U').slice(0,1).toUpperCase();
                }
            }).catch(() => {
                profilePhotoPreview.style.backgroundImage = 'none';
                if (profilePhotoInitial) profilePhotoInitial.textContent = (user.name || currentUser.name || 'U').slice(0,1).toUpperCase();
            });
        } else if (user.avatarUrl) {
            // legacy inline dataURL fallback
            profilePhotoPreview.style.backgroundImage = `url('${normalizeDriveUrl(user.avatarUrl)}')`;
            profilePhotoPreview.textContent = '';
        } else {
            profilePhotoPreview.style.backgroundImage = 'none';
            if (profilePhotoInitial) profilePhotoInitial.textContent = (user.name || currentUser.name || 'U').slice(0,1).toUpperCase();
        }
    }
}

async function saveAccountInfo(event) {
    if (event) event.preventDefault();
    const accountName = $('accountName');
    const accountPosition = $('accountPosition');
    const accountPhone = $('accountPhone');
    const accountBirthday = $('accountBirthday');
    const accountCurrentPassword = $('accountCurrentPassword');
    const accountNewPassword = $('accountNewPassword');
    const accountConfirmPassword = $('accountConfirmPassword');
    const profilePhotoPreview = $('profilePhotoPreview');

    if (!currentUser || !accountName) {
        return toast('Unable to save account information.', 'error');
    }
    if (!accountName.value.trim()) {
        return toast('Full name is required.', 'error');
    }

    if (getAuthApiBase()) {
        await fetchCurrentUserProfile();
    }

    const users = getAllUsers();
    const normalizedEmail = String(currentUser.email || '').trim().toLowerCase();
    let idx = users.findIndex(u => String(u.email || '').trim().toLowerCase() === normalizedEmail);
    if (idx === -1) {
        users.push({
            email: normalizedEmail,
            name: currentUser.name || '',
            role: currentUser.role || 'user',
            status: currentUser.status || 'active',
            position: currentUser.position || '',
            phone: currentUser.phone || '',
            birthday: currentUser.birthday || '',
            avatarUrl: currentUser.avatarUrl || '',
            avatarRef: currentUser.avatarRef || '',
            createdAt: new Date().toISOString(),
            approvedAt: currentUser.approvedAt || new Date().toISOString()
        });
        idx = users.length - 1;
    }

    const currentPass = accountCurrentPassword ? accountCurrentPassword.value : '';
    const newPass = accountNewPassword ? accountNewPassword.value : '';
    const confirmPass = accountConfirmPassword ? accountConfirmPassword.value : '';

    if (newPass || confirmPass) {
        if (!currentPass) return toast('Enter your current password to change it.', 'error');
        if (hashPassword(currentPass) !== users[idx].passwordHash) return toast('Current password is incorrect.', 'error');
        if (newPass !== confirmPass) return toast('New passwords do not match.', 'error');
        users[idx].passwordHash = hashPassword(newPass);
    }

    const updatedProfile = {
        email: currentUser.email,
        name: accountName.value.trim(),
        position: accountPosition ? accountPosition.value.trim() : '',
        phone: accountPhone ? accountPhone.value.trim() : '',
        birthday: accountBirthday ? accountBirthday.value : '',
        avatarUrl: currentUser.avatarUrl || '',
        approvedAt: currentUser.approvedAt || new Date().toISOString()
    };

            if (profilePhotoData) {
        try {
            const result = await uploadProfilePicture(currentUser.email, profilePhotoData);
            console.log('DEBUG profile upload response:', result);
            if (result && result.success) {
                const incoming = result.writtenProfilePictureUrl || result.profilePictureUrl || result.avatarUrl || '';
                const normalized = incoming ? normalizeDriveUrl(incoming) : '';
                if (normalized) {
                    updatedProfile.avatarUrl = normalized;
                    updatedProfile.profilePictureUrl = normalized;
                    delete currentUser.avatarRef;
                    currentUser.avatarUrl = normalized;
                    currentUser.profilePictureUrl = normalized;
                    // The image is now persisted remotely. Avoid uploading it
                    // again when the user later saves another account field.
                    profilePhotoData = null;
                }
            } else {
                console.warn('profile upload failed', result && result.error);
                const msg = result && result.error ? result.error : 'Upload failed';
                toast(`Profile image upload failed: ${msg}. Saving other changes.`, 'warning');
            }
        } catch (e) {
            console.error('Error uploading avatar', e);
            toast('Unable to upload profile image. Saving other changes.', 'warning');
        }
    }

    let backendSaved = false;
    if (getAuthApiBase()) {
        try {
            const payload = {
                ...updatedProfile
            };
            if (newPass || confirmPass) {
                if (!currentPass) return toast('Enter your current password to change it.', 'error');
                payload.currentPassword = currentPass;
                payload.newPassword = newPass;
            }
            const result = await callBackend('updateUserProfile', payload);
            console.log('DEBUG updateUserProfile response:', result);
            try { if (result && result.user && result.user.avatarUrl) toast('DEBUG: profile.avatarUrl: ' + result.user.avatarUrl, 'info'); } catch (e) {}
            if (result && result.success && result.user) {
                currentUser = { ...currentUser, ...result.user };
                backendSaved = true;
            } else {
                console.warn('updateUserProfile failed', result && result.error);
                toast(result && result.error ? result.error : 'Unable to save profile online. Saving locally instead.', 'warning');
            }
        } catch (e) {
            console.error('Error saving profile online', e);
            toast('Unable to save profile online. Saving locally instead.', 'warning');
        }
    }

    if (!backendSaved) {
        users[idx].name = updatedProfile.name;
        users[idx].position = updatedProfile.position;
        users[idx].phone = updatedProfile.phone;
        users[idx].birthday = updatedProfile.birthday;
        users[idx].avatarUrl = updatedProfile.avatarUrl;
        delete users[idx].avatarRef;
        if (newPass || confirmPass) {
            users[idx].passwordHash = hashPassword(newPass);
        }
        try {
            saveAllUsers(users);
        } catch (err) {
            console.error('Failed to save users to localStorage:', err);
            const isQuota = err && (err.name === 'QuotaExceededError' || err.code === 22 || (err.message && err.message.toLowerCase().includes('quota')));
            if (isQuota) {
                // as a last resort, remove avatarRef and retry
                if (users[idx] && users[idx].avatarRef) {
                    try { await deleteBlobRef(users[idx].avatarRef); } catch (e) { /* ignore */ }
                    delete users[idx].avatarRef;
                }
                try {
                    saveAllUsers(users);
                    toast('Storage was full. Avatar removed and other changes saved.', 'warning');
                } catch (err2) {
                    toast('Unable to save account data due to storage limits.', 'error');
                    console.error('Retry failed:', err2);
                }
            } else {
                toast('Unable to save account information.', 'error');
            }
        }
    }

    if (!backendSaved) {
        currentUser = { ...currentUser, ...users[idx] };
    }
    saveSession({ email: currentUser.email, token: currentUser.token, name: currentUser.name, role: currentUser.role });
    setAuthState();
    if (accountCurrentPassword) accountCurrentPassword.value = '';
    if (accountNewPassword) accountNewPassword.value = '';
    if (accountConfirmPassword) accountConfirmPassword.value = '';
    toast('Account information updated.', 'success');
}

function showAuthOverlay(mode = 'login') {
    const loginForm = $('loginForm');
    const registerForm = $('registerForm');
    const loginTab = $('authLoginTab');
    const registerTab = $('authRegisterTab');
    if (mode === 'register') {
        loginForm.classList.remove('active');
        registerForm.classList.add('active');
        loginTab.classList.remove('active');
        registerTab.classList.add('active');
    } else {
        registerForm.classList.remove('active');
        loginForm.classList.add('active');
        registerTab.classList.remove('active');
        loginTab.classList.add('active');
    }
    $('authOverlay').style.display = 'flex';
}

function hideAuthOverlay() {
    $('authOverlay').style.display = 'none';
}

function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).substr(2, 5);
}

// Ensure documents have a stable sequential number (No) for human-readable tracking
function getNextDocNo() {
    let max = 0;
    documents.forEach(d => {
        const n = parseInt(d.no || d.No || 0, 10);
        if (!isNaN(n) && n > max) max = n;
    });
    return max + 1;
}

// Renumber all documents sequentially starting at 1. Sort by entryDate asc, then createdAt asc.
function renumberAllDocsSequentially() {
    if (!Array.isArray(documents) || documents.length === 0) return false;
    // Ensure each doc has an id
    documents.forEach(d => { if (!d.id) d.id = generateId(); });

    const ordered = [...documents].sort((a, b) => {
        const ae = a.entryDate || '';
        const be = b.entryDate || '';
        const cmp = ae.localeCompare(be);
        if (cmp !== 0) return cmp;
        const ac = a.createdAt || 0;
        const bc = b.createdAt || 0;
        return (ac - bc);
    });

    let changed = false;
    ordered.forEach((doc, index) => {
        const newNo = index + 1;
        const currentNo = parseInt(doc.no || doc.No || 0, 10);
        if (currentNo !== newNo) changed = true;
        doc.no = newNo;
        if (doc.No && parseInt(doc.No, 10) !== newNo) doc.No = newNo;
    });

    // Keep the in-memory array in the same sequential order we display it.
    documents = ordered;

    if (changed) saveDocs(documents);
    return changed;
}

function todayStr() {
    return new Date().toISOString().split('T')[0];
}

function parseDateValue(input) {
    if (!input && input !== 0) return null;
    if (input instanceof Date) return isNaN(input.getTime()) ? null : input;
    const value = String(input).trim();
    if (!value) return null;

    // Parse pure date-only strings as local dates to avoid timezone shifting.
    const dateOnlyMatch = value.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
    if (dateOnlyMatch) {
        const year = Number(dateOnlyMatch[1]);
        const month = Number(dateOnlyMatch[2]) - 1;
        const day = Number(dateOnlyMatch[3]);
        const localDate = new Date(year, month, day);
        return isNaN(localDate.getTime()) ? null : localDate;
    }

    // If value contains a time portion or a full ISO timestamp, parse normally.
    const dt = new Date(value);
    return isNaN(dt.getTime()) ? null : dt;
}

function normalizeDateString(input) {
    const dt = parseDateValue(input);
    if (!dt) return '';
    const yyyy = dt.getFullYear();
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const dd = String(dt.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function formatDate(d) {
    const dt = parseDateValue(d);
    if (!dt) return '—';
    return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDateFull(d) {
    const dt = parseDateValue(d);
    if (!dt) return '—';
    return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) +
        ' ' + dt.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

// Format YYYY-MM-DD or Date -> DD/MM/YYYY
function formatDateDMY(input) {
    if (!input) return '—';
    const dt = parseDateValue(input);
    if (!dt) return '—';
    const dd = String(dt.getDate()).padStart(2, '0');
    const mm = String(dt.getMonth() + 1).padStart(2, '0');
    const yyyy = dt.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
}

function getStatusLabel(status) {
    const map = {
        'pending': 'On Hold',
        'in-progress': 'In Progress',
        'on-hold': 'On Hold',
        'rejected': 'Rejected',
        'completed': 'Completed',
        'decision': 'Final Decision'
    };
    return map[status] || status;
}

function getStatusBadge(status) {
    const cls = status === 'pending' ? 'pending' :
        status === 'in-progress' ? 'in-progress' :
        status === 'on-hold' ? 'pending' :
        status === 'rejected' ? 'rejected' :
        status === 'completed' ? 'completed' : 'decision';
    return `<span class="status-badge ${cls}"><span class="dot"></span> ${getStatusLabel(status)}</span>`;
}

const WORKFLOW_STEPS = [
    { key: 'admin', label: 'Director of Admin Department', icon: 'fa-user-tie' },
    { key: 'review', label: 'Review Committee', icon: 'fa-search' },
    { key: 'dg', label: 'Director General of Admin', icon: 'fa-user-cog' },
    { key: 'cabinet', label: 'Cabinet of the Minister', icon: 'fa-users' },
    { key: 'minister', label: 'Final Decision of the Minister', icon: 'fa-gavel' },
    { key: 'archive', label: 'Archiving', icon: 'fa-archive' }
];

function getStepStatus(doc, key) {
    // Prefer workflowData JSON stored per document (new format)
    try {
        if (doc && doc.workflowData && typeof doc.workflowData === 'object') {
            const step = doc.workflowData[key];
            if (step && step.status) {
                return normalizeWorkflowStatus(step.status);
            }
        }
    } catch (e) {
        // ignore parse issues
    }

    // Fallback to legacy flat wf* fields on the doc (older format)
    const map = {
        admin: doc.wfAdminStatus || doc.wfAdmin || 'pending',
        review: doc.wfReviewStatus || doc.wfReview || 'pending',
        dg: doc.wfDGStatus || doc.wfDG || 'pending',
        cabinet: doc.wfCabinetStatus || doc.wfCabinet || 'pending',
        minister: doc.wfMinisterStatus || doc.wfMinister || 'pending',
        archive: doc.wfArchiveStatus || doc.wfArchive || 'pending'
    };
    return normalizeWorkflowStatus(map[key] || 'pending');
}

function normalizeWorkflowStatus(raw) {
    if (raw === undefined || raw === null) return 'pending';
    const s = String(raw).trim().toLowerCase();
    if (s === 'completed' || s === 'approved' || s === 'done') return 'completed';
    if (s === 'in progress' || s === 'in-progress' || s === 'inprogress') return 'in-progress';
    if (s === 'none' || s === 'pending' || s === 'on hold' || s === 'on-hold') return 'pending';
    if (s === 'rejected') return 'rejected';
    if (s === 'decision' || s === 'final decision' || s === 'approved-decision') return 'decision';
    if (['pending','in-progress','completed','rejected','decision'].includes(s)) return s;
    return 'pending';
}

function displayStepStatus(doc, key) {
    // Determine steps for this document's work process (fallback to global workflow steps)
    const steps = (doc && doc.workProcess && WF_PROCESSES[doc.workProcess]) ? WF_PROCESSES[doc.workProcess].map(s => s.key) : WORKFLOW_STEPS.map(s => s.key);

    // Collect normalized stored statuses for each step
    const stored = steps.map(k => getStepStatus(doc, k));

    // If this specific step has an explicit stored value (not pending), respect it
    const explicit = getStepStatus(doc, key);
    if (explicit && explicit !== 'pending') return explicit;

    // Derive active step: prefer first 'in-progress' or 'decision' if present, else first non-completed
    const inProgressIndex = stored.findIndex(s => s === 'in-progress' || s === 'decision');
    let activeIndex = inProgressIndex;
    if (activeIndex === -1) {
        activeIndex = stored.findIndex(s => s !== 'completed');
    }
    if (activeIndex === -1) {
        // all completed
        return 'completed';
    }

    const idx = steps.indexOf(key);
    if (idx < activeIndex) return 'completed';
    if (idx === activeIndex) return 'in-progress';
    return 'pending';
}

function getStepNotes(doc, key) {
    const map = {
        admin: doc.wfAdminNotes || '',
        review: doc.wfReviewNotes || '',
        dg: doc.wfDGNotes || '',
        cabinet: doc.wfCabinetNotes || '',
        minister: doc.wfMinisterNotes || '',
        archive: doc.wfArchiveNotes || ''
    };
    return map[key] || '';
}

function getMinisterDecision(doc) {
    return doc.wfMinisterDecision || '';
}

function getWorkflowStepsForDocument(doc) {
    if (doc && doc.workProcess && WF_PROCESSES[doc.workProcess]) {
        return WF_PROCESSES[doc.workProcess];
    }
    return WORKFLOW_STEPS;
}

function computeOverallStatus(doc) {
    // The process-step values are the source of truth.  Do not use the
    // separately saved document-status dropdown here: it can become stale
    // after an individual workflow step is changed.
    const statuses = getWorkflowStepsForDocument(doc).map(step => displayStepStatus(doc, step.key));
    if (!statuses.length) return 'pending';
    if (statuses.some(s => s === 'rejected')) return 'rejected';
    if (statuses.every(s => s === 'completed')) return 'completed';
    if (statuses.some(s => s === 'decision')) return 'decision';
    if (statuses.some(s => s === 'in-progress')) return 'in-progress';
    if (statuses.some(s => s === 'pending')) return 'pending';
    return 'pending';
}

function getStepOrderIndex(key) {
    return WORKFLOW_STEPS.map(s => s.key).indexOf(key);
}

// Seed data removed: generateSeedDocuments() was intentionally removed to disable
// the auto seed/sample documents feature. If you need to re-enable sample data
// in future, consider adding a controlled import or admin-only action.

// ============================================================
// STATE
// ============================================================
let documents = [];
let currentPage = 'dashboard';
let editingId = null;
// temporary holder for resized profile photo dataURL
let profilePhotoData = null;
// index of user being viewed in admin -> user-view
let viewingUserIndex = null;
// temporary holder for selected PDF file for document modal
let currentDocPdfFile = null;
let currentDocImgFile = null;
// if true, remove existing pdfRef when saving (user clicked Remove)
let currentDocPdfRemove = false;

// ============================================================
// DOM REFS
// ============================================================
const $ = id => document.getElementById(id);
const sidebar = $('sidebar');
const overlay = $('sidebarOverlay');
const menuToggle = $('menuToggle');
const pageTitle = $('pageTitle');
const pageContent = $('pageContent');
const currentDateEl = $('currentDate');

// Helper to set avatar element (img or initials)
function setAvatarElement(el, url, initials) {
    if (!el) return;
    // clear inline background if any
    el.style.backgroundImage = '';
    if (url) {
        // insert an <img> to show the full profile picture
        el.textContent = '';
        // avoid duplicating img
        const existing = el.querySelector && el.querySelector('img');
        if (existing) {
            if (existing.src !== url) existing.src = url;
        } else {
            el.innerHTML = `<img src="${url}" alt="avatar" />`;
        }
    } else {
        // remove img if any
        const existing = el.querySelector && el.querySelector('img');
        if (existing) existing.remove();
        el.textContent = initials ? initials.slice(0,1).toUpperCase() : '';
    }
}

// Pages
const pageEls = {
    dashboard: $('page-dashboard'),
    documents: $('page-documents'),
    workflow: $('page-workflow'),
    reports: $('page-reports'),
    admin: $('page-admin'),
    account: $('page-account'),
    'user-view': $('page-user-view')
};

// Stats
const statTotal = $('statTotal');
const statInProgress = $('statInProgress');
const statPending = $('statPending');
const statRejected = $('statRejected');
const statCompleted = $('statCompleted');
const statDecision = $('statDecision');

// Modals
const docModal = $('docModal');
const viewModal = $('viewModal');
const closeDocModal = $('closeDocModal');
const cancelDocModal = $('cancelDocModal');
const closeViewModal = $('closeViewModal');
const closeViewModalBtn = $('closeViewModalBtn');
const editFromView = $('editFromView');

// Form
const docForm = $('docForm');
const editDocId = $('editDocId');
const docTitle = $('docTitle');
const docRef = $('docRef');
const docOrigin = $('docOrigin');
const docEntryDate = $('docEntryDate');
const docInCharge = $('docInCharge');
const docDescription = $('docDescription');
const docStatus = $('docStatus');
const workflowStepsForm = $('workflowStepsForm');
const saveDocBtn = $('saveDocument');
const docPdfInput = $('pdfFileInput');
const docPdfButton = $('pdfFileButton');
const docPdfName = $('pdfFileStatus');
const docPdfRemove = $('pdfFileRemove');
const docImgInput = $('imgFileInput');
const docImgButton = $('imgFileButton');
const docImgName = $('imgFileStatus');
const pdfFileLinkArea = $('pdfFileLinkArea');
const imgFileLinkArea = $('imgFileLinkArea');
const pdfFilePreviewArea = $('pdfFilePreviewArea');
const imgFilePreviewArea = $('imgFilePreviewArea');
// Auth
const authOverlay = $('authOverlay');
const authLoginTab = $('authLoginTab');
const authRegisterTab = $('authRegisterTab');
const loginForm = $('loginForm');
const registerForm = $('registerForm');
const loginEmail = $('loginEmail');
const loginPassword = $('loginPassword');
const registerName = $('registerName');
const registerEmail = $('registerEmail');
const registerPassword = $('registerPassword');
const menuLogout = $('menuLogout');

// Filters
const filterStatus = $('filterStatus');
const filterOrigin = $('filterOrigin');
const searchDocs = $('searchDocs');
const clearFilters = $('clearFilters');
const syncDocsBtn = $('syncDocsBtn');

// ============================================================
// RENDER FUNCTIONS
// ============================================================

function renderStats() {
    const total = documents.length;
    const inProgress = documents.filter(d => computeOverallStatus(d) === 'in-progress').length;
    const pending = documents.filter(d => computeOverallStatus(d) === 'pending').length;
    const rejected = documents.filter(d => computeOverallStatus(d) === 'rejected').length;
    const completed = documents.filter(d => computeOverallStatus(d) === 'completed').length;
    const decision = documents.filter(d => computeOverallStatus(d) === 'decision').length;
    statTotal.textContent = total;
    statInProgress.textContent = inProgress;
    statPending.textContent = pending;
    if (statRejected) statRejected.textContent = rejected;
    statCompleted.textContent = completed;
    statDecision.textContent = decision;
}

function renderDocTable(docs, containerId) {
    const container = $(containerId);
    if (!container) return;
    if (docs.length === 0) {
        container.innerHTML = `
            <div class="empty-state">
                <i class="fas fa-inbox"></i>
                <h4>No documents found</h4>
                <p style="color:var(--gray-400);font-size:0.9rem;">Create a new document to get started.</p>
            </div>
        `;
        return;
    }
    // Render documents sorted by No ascending (1 at top). Non-numeric or missing No appear at the bottom.
    const sorted = [...docs].sort((a, b) => {
        const na = parseInt(a.no || a.No || 0, 10);
        const nb = parseInt(b.no || b.No || 0, 10);
        if (isNaN(na) && isNaN(nb)) return 0;
        if (isNaN(na)) return 1;
        if (isNaN(nb)) return -1;
        return na - nb;
    });

    // Build table with a selection checkbox column
    let html = `
    <div class="doc-table-toolbar" style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;">
        <div class="left-actions"></div>
        <div class="right-actions"></div>
    </div>
    <table class="doc-table ${selectionMode ? 'is-selecting' : ''}">
        <thead><tr>
            <th class="selection-column" style="width:40px;text-align:center;"></th>
            <th class="document-number-column" style="text-align:center;">No</th>
            <th>Title / Ref</th>
            <th>Origin</th>
            <th>Entry Date</th>
            <th>In Charge Of</th>
            <th>Status</th>
            <th>Workflow</th>
            <th style="text-align:right;">Actions</th>
        </tr></thead><tbody>`;
    sorted.forEach(d => {
        const status = computeOverallStatus(d);
        const steps = (d && d.workProcess && WF_PROCESSES[d.workProcess]) ? WF_PROCESSES[d.workProcess].map(s => s.key) : WORKFLOW_STEPS.map(s => s.key);
        let stepHtml = '<div class="workflow-steps-mini">';
        steps.forEach((k, i) => {
            const s = displayStepStatus(d, k);
            let cls = 'step-dot';
            let label = '○';
            if (s === 'completed' || s === 'in-progress' || s === 'decision') {
                cls += ' done';
                label = '✓';
            } else if (s === 'rejected') {
                cls += ' rejected';
                label = '✕';
            }
            stepHtml += `<span class="${cls}">${label}</span>`;
            if (i < steps.length - 1) {
                const nextStatus = displayStepStatus(d, steps[i + 1]);
                let lineCls = 'step-line';
                if (s === 'rejected') {
                    lineCls = 'step-line rejected';
                } else if (nextStatus === 'in-progress' || nextStatus === 'completed' || nextStatus === 'decision') {
                    lineCls = 'step-line done';
                }
                stepHtml += `<span class="${lineCls}"></span>`;
            }
        });
        stepHtml += '</div>';

        const checked = selectedDocIds.has(d.id) ? 'checked' : '';
        html += `<tr>
            <td class="selection-column" style="text-align:center;">${selectionMode ? `<input type="checkbox" class="select-doc" data-id="${d.id}" ${checked} />` : ''}</td>
            <td style="text-align:center;">${escHtml(d.no || d.No || '')}</td>
            <td>
                <div class="doc-title">${escHtml(d.title || 'Untitled')}</div>
                <div class="doc-meta"><i class="fas fa-hashtag"></i> ${escHtml(d.ref || '—')}</div>
            </td>
            <td><span class="doc-origin">${escHtml(d.origin || '—')}</span></td>
            <td><span class="doc-date">${formatDate(d.entryDate)}</span></td>
            <td><span class="doc-incharge">${escHtml(d.inCharge || d.inChargeOf || d['In Charge Of'] || '—')}</span></td>
            <td>${getStatusBadge(status)}</td>
            <td>${stepHtml}</td>
            <td style="text-align:right;">
                <div class="action-btns" style="justify-content:flex-end;">
                    <button class="btn btn-primary btn-xs view-doc" data-id="${d.id}"><i class="fas fa-eye"></i></button>
                    <button class="btn btn-primary btn-xs edit-doc" data-id="${d.id}"><i class="fas fa-edit"></i></button>
                    <button class="btn btn-danger btn-xs delete-doc" data-id="${d.id}"><i class="fas fa-trash"></i></button>
                </div>
            </td>
        </tr>`;
    });
    html += '</tbody></table>';
    container.innerHTML = html;

    // Render toolbar actions depending on selection
    const toolbar = container.querySelector('.doc-table-toolbar');
    const leftActions = toolbar ? toolbar.querySelector('.left-actions') : null;
    const rightActions = toolbar ? toolbar.querySelector('.right-actions') : null;
    const selectedCount = selectedDocIds.size;
    if (toolbar) {
        if (selectedCount > 0) {
            leftActions.innerHTML = `<div style="font-size:0.95rem;color:var(--gray-700);">${selectedCount} selected</div>`;
            rightActions.innerHTML = `
                <button class="btn btn-danger btn-sm" id="deleteSelectedBtn">Delete Selected</button>
                <button class="btn btn-primary btn-sm" id="exportSelectedBtn" style="margin-left:8px;">Export Selected</button>
                <button class="btn btn-secondary btn-sm" id="clearSelectionBtn" style="margin-left:8px;">Clear Selection</button>
            `;
        } else {
            leftActions.innerHTML = '';
            rightActions.innerHTML = '';
        }
    }

    // Attach toolbar button handlers
    if (toolbar) {
        const deleteSelectedBtn = container.querySelector('#deleteSelectedBtn');
        if (deleteSelectedBtn) deleteSelectedBtn.addEventListener('click', async () => {
            if (!confirm('Delete selected documents? This cannot be undone.')) return;
            const ids = Array.from(selectedDocIds);
            documents = documents.filter(d => !ids.includes(d.id));
            clearSelection();
            // persist local cache immediately
            try { saveDocs(documents); } catch (e) { console.warn('local saveDocs failed', e); }
            try { scheduleBackgroundSync(); } catch (e) {}
            // After bulk delete, renumber and perform a full sync to update the spreadsheet (remove rows + renumber)
            renumberAllDocsSequentially();
            await saveDocsToBackend(documents, { fullSync: true });
            renderAllDocs();
            toast('Selected documents deleted.', 'info');
        });
        const exportSelectedBtn = container.querySelector('#exportSelectedBtn');
        if (exportSelectedBtn) exportSelectedBtn.addEventListener('click', async () => {
            const selected = getSelectedDocs();
            if (!selected || selected.length === 0) return toast('No documents selected.', 'error');
            toast('Exporting selected documents...', 'info');
            try {
                await saveDocsToBackend(documents, { exportSubset: selected });
                toast('Selected documents exported.', 'success');
            } catch (e) {
                toast('Export failed: ' + (e.message || e), 'error');
            }
        });
        const clearSelectionBtn = container.querySelector('#clearSelectionBtn');
        if (clearSelectionBtn) clearSelectionBtn.addEventListener('click', () => { clearSelection(); renderAllDocs(); });
    }

    // Append footer showing the last No at the bottom of the list
    try {
        const maxNo = sorted.reduce((m, x) => {
            const n = parseInt(x.no || x.No || 0, 10);
            return (!isNaN(n) && n > m) ? n : m;
        }, 0);
        const footerHtml = `\n<div class="doc-table-footer" style="margin-top:12px;padding:10px 12px;background:var(--white);border-radius:6px;border:1px solid var(--gray-100);font-size:0.9rem;color:var(--gray-600);">Last No: <strong>${maxNo || '-'}</strong></div>`;
        container.insertAdjacentHTML('beforeend', footerHtml);
    } catch (e) { /* ignore footer failures */ }

    // Attach events
    container.querySelectorAll('.view-doc').forEach(btn => {
        btn.addEventListener('click', () => viewDocument(btn.dataset.id));
    });
    container.querySelectorAll('.edit-doc').forEach(btn => {
        btn.addEventListener('click', () => openEditModal(btn.dataset.id));
    });
    container.querySelectorAll('.delete-doc').forEach(btn => {
        btn.addEventListener('click', () => deleteDocument(btn.dataset.id));
    });

    // Attach selection handlers
    const headerCheckbox = container.querySelector('.select-all-checkbox');
    if (headerCheckbox) {
        const rowCheckboxes = Array.from(container.querySelectorAll('.select-doc'));
        headerCheckbox.checked = rowCheckboxes.length > 0 && rowCheckboxes.every(cb => cb.checked);
        headerCheckbox.addEventListener('change', (e) => {
            const checked = e.target.checked;
            container.querySelectorAll('.select-doc').forEach(cb => {
                cb.checked = checked;
                const id = cb.dataset.id;
                if (checked) selectedDocIds.add(id); else selectedDocIds.delete(id);
            });
            renderAllDocs();
        });
    }
    container.querySelectorAll('.select-doc').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const id = cb.dataset.id;
            if (cb.checked) selectedDocIds.add(id); else selectedDocIds.delete(id);
            renderAllDocs();
        });
    });
}

function renderAllDocs() {
    const filtered = getFilteredDocs();
    renderDocTable(filtered, 'docTableWrapper');
    // Also update dashboard table (recent 5)
    // Dashboard shows all documents that are not completed (pending / in-progress / decision)
    const incomplete = documents.filter(d => computeOverallStatus(d) !== 'completed');
    renderDocTable(incomplete, 'dashboardTableWrapper');
    renderStats();
    populateOriginFilter();
    renderWorkflowOverview();
    renderReports();
}

// Selection helpers
function getSelectedDocs() {
    return documents.filter(d => selectedDocIds.has(d.id));
}

function clearSelection() {
    selectedDocIds.clear();
}

function getFilteredDocs() {
    let result = [...documents];
    const status = filterStatus.value;
    const origin = filterOrigin.value;
    const search = searchDocs.value.toLowerCase().trim();

    if (status !== 'all') {
        result = result.filter(d => computeOverallStatus(d) === status);
    }
    if (origin !== 'all') {
        result = result.filter(d => (d.origin || '').toLowerCase().includes(origin.toLowerCase()));
    }
    if (search) {
        result = result.filter(d =>
            (d.title || '').toLowerCase().includes(search) ||
            (d.ref || '').toLowerCase().includes(search) ||
            (d.origin || '').toLowerCase().includes(search) ||
            (d.description || '').toLowerCase().includes(search)
        );
    }
    // Sort by entry date desc
    result.sort((a, b) => (b.entryDate || '').localeCompare(a.entryDate || ''));
    return result;
}

function populateOriginFilter() {
    const origins = new Set();
    documents.forEach(d => { if (d.origin) origins.add(d.origin); });
    const sel = filterOrigin;
    const current = sel.value;
    sel.innerHTML = '<option value="all">All</option>';
    [...origins].sort().forEach(o => {
        sel.innerHTML += `<option value="${escHtml(o)}">${escHtml(o)}</option>`;
    });
    if ([...origins].includes(current)) sel.value = current;
}

function renderWorkflowOverview() {
    const container = $('workflowOverview');
    if (!container) return;
    // Respect current filters (status/origin) so overview reflects selected topic/status
    const docs = getFilteredDocs();
    // Group documents by workProcess so each process shows its own steps and counts
    const processes = Array.from(new Set(docs.map(d => d.workProcess || 'Default')));
    let html = '';
    if (processes.length === 0) {
        container.innerHTML = '<div class="empty-state"><i class="fas fa-sitemap"></i><h4>No workflow data</h4><p style="color:var(--gray-400)">No documents available for the selected filters.</p></div>';
        return;
    }

    // For each process, render a compact overview and a table for docs of that process
    processes.forEach(proc => {
        const procDocs = docs.filter(d => (d.workProcess || 'Default') === proc);
        const stepDefs = WF_PROCESSES[proc] || WORKFLOW_STEPS;
        const labels = stepDefs.map(s => s.label || s.key);
        const keys = stepDefs.map(s => s.key);

        // Step cards for this process
        html += `<div style="margin-bottom:18px;"><h4 style="margin:0 0 10px 0;font-weight:600;">${escHtml(proc || 'Default')}</h4>`;
        html += `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:12px;">`;
        keys.forEach((k, i) => {
            const total = procDocs.length;
            const completed = procDocs.filter(d => displayStepStatus(d, k) === 'completed').length;
            const inProgress = procDocs.filter(d => displayStepStatus(d, k) === 'in-progress' || displayStepStatus(d, k) === 'decision').length;
            const pending = procDocs.filter(d => displayStepStatus(d, k) === 'pending' || displayStepStatus(d, k) === 'None').length;
            const pct = total ? Math.round((completed / total) * 100) : 0;
            html += `
                <div style="background:#fff;border-radius:var(--radius);padding:14px;box-shadow:var(--shadow);border-top:4px solid var(--primary);">
                    <div style="font-weight:600;font-size:0.9rem;margin-bottom:6px;">${labels[i]}</div>
                    <div style="font-size:0.75rem;color:var(--gray-500);margin-bottom:8px;">
                        <span style="color:var(--success);">${completed} done</span> ·
                        <span style="color:var(--secondary);">${inProgress} active</span> ·
                        <span style="color:var(--gray-400);">${pending} pending</span>
                    </div>
                    <div style="background:var(--gray-200);border-radius:30px;height:8px;overflow:hidden;">
                        <div style="height:100%;width:${pct}%;background:var(--success);border-radius:30px;transition:width 0.5s;"></div>
                    </div>
                    <div style="font-size:0.7rem;color:var(--gray-500);margin-top:6px;">${pct}% completed</div>
                </div>`;
        });
        html += '</div>';

        // Table for documents in this process
        html += `<div style="background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:12px;margin-bottom:18px;overflow-x:auto;">`;
        html += `<h5 style="margin:0 0 8px 0;font-weight:600;">Documents — ${escHtml(proc || 'Default')}</h5>`;
        html += `<table class="doc-table" style="font-size:0.8rem;min-width:700px;"><thead><tr><th>Document</th>${labels.map(l=>`<th style="text-align:center;font-size:0.65rem;">${l.split(' ').slice(0,2).join(' ')}</th>`).join('')}<th>Overall</th></tr></thead><tbody>`;
        if (procDocs.length === 0) {
            html += `<tr><td colspan="${keys.length + 2}" style="text-align:center;color:var(--gray-400);padding:16px;">No documents for this process</td></tr>`;
        } else {
            procDocs.slice().sort((a,b)=> (b.entryDate||'').localeCompare(a.entryDate||'')).forEach(d => {
                const statuses = keys.map(k => displayStepStatus(d, k));
                html += `<tr><td><strong>${escHtml(d.title||'Untitled')}</strong><br/><span style="font-size:0.7rem;color:var(--gray-500);">${escHtml(d.ref||'')}</span></td>${statuses.map(s=>`<td style="text-align:center;">${getStatusBadge(s)}</td>`).join('')}<td>${getStatusBadge(computeOverallStatus(d))}</td></tr>`;
            });
        }
        html += `</tbody></table></div>`;
        html += '</div>';
    });

    container.innerHTML = html;
}

function getDocumentReportMonth(doc) {
    const rawDate = String((doc && (doc.entryDate || doc.dateOfEntry)) || '');
    const match = rawDate.match(/^(\d{4}-\d{2})/);
    if (match) return match[1];
    const parsed = parseDateValue(rawDate);
    if (!parsed) return '';
    return `${parsed.getFullYear()}-${String(parsed.getMonth() + 1).padStart(2, '0')}`;
}

function getLatestReportMonth() {
    return documents.map(getDocumentReportMonth).filter(Boolean).sort().pop() ||
        new Date().toISOString().slice(0, 7);
}

function formatReportMonth(month) {
    const match = String(month || '').match(/^(\d{4})-(\d{2})$/);
    if (!match) return 'Selected month';
    return new Date(Number(match[1]), Number(match[2]) - 1, 1)
        .toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

function escapeSpreadsheetXml(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function downloadMonthlyExcelReport(month) {
    const reportDocs = documents.filter(doc => getDocumentReportMonth(doc) === month);
    if (!reportDocs.length) {
        toast(`No documents were entered in ${formatReportMonth(month)}.`, 'warning');
        return;
    }

    const workflowColumns = [];
    const workflowKeys = new Set();
    reportDocs.forEach(doc => getWorkflowStepsForDocument(doc).forEach(step => {
        if (!workflowKeys.has(step.key)) {
            workflowKeys.add(step.key);
            workflowColumns.push(step);
        }
    }));

    const headers = [
        'No.', 'Document Title', 'Reference Number', 'Origin', 'Date of Entry',
        'In Charge Of', 'Work Process', 'Overall Status',
        ...workflowColumns.map(step => step.label)
    ];
    const rows = reportDocs
        .slice()
        .sort((a, b) => String(a.entryDate || '').localeCompare(String(b.entryDate || '')))
        .map(doc => [
            doc.no || doc.No || '',
            doc.title || '',
            doc.ref || '',
            doc.origin || '',
            formatDateDMY(doc.entryDate || doc.dateOfEntry),
            doc.inCharge || doc.inChargeOf || '',
            String(doc.workProcess || 'Default').replaceAll('_', ' '),
            getStatusLabel(computeOverallStatus(doc)),
            ...workflowColumns.map(step => {
                const applies = getWorkflowStepsForDocument(doc).some(docStep => docStep.key === step.key);
                return applies ? getStatusLabel(displayStepStatus(doc, step.key)) : '';
            })
        ]);

    const xmlRows = [headers, ...rows].map((row, rowIndex) =>
        `<Row>${row.map(value => `<Cell${rowIndex === 0 ? ' ss:StyleID="Header"' : ''}><Data ss:Type="String">${escapeSpreadsheetXml(value)}</Data></Cell>`).join('')}</Row>`
    ).join('');
    const spreadsheet = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Styles><Style ss:ID="Header"><Font ss:Bold="1"/><Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/></Style></Styles>
  <Worksheet ss:Name="Monthly Report"><Table>${xmlRows}</Table></Worksheet>
</Workbook>`;
    const blob = new Blob([spreadsheet], { type: 'application/vnd.ms-excel;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `document-workflow-report-${month}.xls`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    toast(`Excel report for ${formatReportMonth(month)} downloaded.`, 'success');
}

function wireMonthlyReportControls(container) {
    const monthInput = container.querySelector('#reportMonthFilter');
    const downloadButton = container.querySelector('#downloadMonthlyReport');
    if (monthInput) monthInput.addEventListener('change', renderReports);
    if (downloadButton) downloadButton.addEventListener('click', () => {
        downloadMonthlyExcelReport(monthInput ? monthInput.value : getLatestReportMonth());
    });
}

function renderReports() {
    const container = $('reportsContent');
    if (!container) return;
    const previousMonthInput = container.querySelector('#reportMonthFilter');
    const selectedMonth = (previousMonthInput && previousMonthInput.value) || getLatestReportMonth();
    const reportDocs = documents.filter(doc => getDocumentReportMonth(doc) === selectedMonth);
    const total = reportDocs.length;
    const reportControls = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:20px;background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:16px 20px;">
            <div><strong><i class="fas fa-calendar-alt"></i> Monthly Report</strong><div style="font-size:0.8rem;color:var(--gray-500);margin-top:3px;">Documents entered in ${escHtml(formatReportMonth(selectedMonth))}</div></div>
            <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
                <label for="reportMonthFilter" style="font-size:0.85rem;font-weight:600;">Month</label>
                <input id="reportMonthFilter" type="month" value="${selectedMonth}" aria-label="Report month" style="box-sizing:border-box;width:128px;height:29px;padding:4px 7px;border:1px solid var(--gray-300);border-radius:6px;background:#fff;font-size:0.78rem;" />
                <button class="btn btn-primary btn-sm" id="downloadMonthlyReport" type="button" ${total ? '' : 'disabled'}><i class="fas fa-file-excel"></i> Download Report</button>
            </div>
        </div>`;
    if (total === 0) {
        container.innerHTML = reportControls +
            `<div class="empty-state"><i class="fas fa-chart-bar"></i><h4>No documents for ${escHtml(formatReportMonth(selectedMonth))}</h4><p>Choose another month to view its report.</p></div>`;
        wireMonthlyReportControls(container);
        return;
    }

    // Count by origin
    const originCount = {};
    reportDocs.forEach(d => {
        const key = d.origin || 'Unknown';
        originCount[key] = (originCount[key] || 0) + 1;
    });
    const originSorted = Object.entries(originCount).sort((a, b) => b[1] - a[1]);

    // Overall status is calculated from the actual steps for each document's
    // selected work process.
    const statusCount = { pending: 0, 'in-progress': 0, completed: 0, decision: 0, rejected: 0 };
    reportDocs.forEach(d => {
        const s = computeOverallStatus(d);
        statusCount[s] = (statusCount[s] || 0) + 1;
    });

    // Count completion only against documents that use the relevant process
    // and step. This prevents, for example, Minister steps being counted as
    // pending for documents sent only to a Director.
    const processStats = Array.from(new Set(reportDocs.map(d => d.workProcess || 'Default')))
        .map(process => {
            const steps = WF_PROCESSES[process] || WORKFLOW_STEPS;
            const processDocs = reportDocs.filter(d => (d.workProcess || 'Default') === process);
            const stepStats = steps.map(step => {
                const statuses = processDocs.map(d => displayStepStatus(d, step.key));
                const done = statuses.filter(s => s === 'completed').length;
                const active = statuses.filter(s => s === 'in-progress' || s === 'decision').length;
                return {
                    label: step.label,
                    done,
                    active,
                    total: processDocs.length,
                    pct: Math.round((done / processDocs.length) * 100)
                };
            });
            const averageCompletion = stepStats.length
                ? Math.round(stepStats.reduce((sum, step) => sum + step.pct, 0) / stepStats.length)
                : 0;
            return { process, total: processDocs.length, stepStats, averageCompletion };
        })
        .filter(Boolean);

    const allStepStats = processStats.flatMap(process => process.stepStats);
    const averageCompletion = allStepStats.length
        ? Math.round(allStepStats.reduce((sum, step) => sum + step.pct, 0) / allStepStats.length)
        : 0;

    let html = reportControls + `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:24px;">
            <div style="background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:22px;">
                <h4 style="font-weight:600;font-size:0.9rem;margin-bottom:14px;"><i class="fas fa-tags"></i> By Origin</h4>
                <div style="display:flex;flex-direction:column;gap:8px;">
                    ${originSorted.slice(0, 8).map(([name, count]) => `
                        <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.85rem;border-bottom:1px solid var(--gray-100);padding-bottom:6px;">
                            <span>${escHtml(name)}</span>
                            <span style="font-weight:600;background:var(--gray-100);padding:0 12px;border-radius:30px;font-size:0.75rem;">${count}</span>
                        </div>
                    `).join('')}
                    ${originSorted.length > 8 ? `<div style="font-size:0.75rem;color:var(--gray-400);text-align:center;padding-top:4px;">+ ${originSorted.length - 8} more</div>` : ''}
                </div>
            </div>
            <div style="background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:22px;">
                <h4 style="font-weight:600;font-size:0.9rem;margin-bottom:14px;"><i class="fas fa-chart-pie"></i> By Status</h4>
                <div style="display:flex;flex-direction:column;gap:8px;">
                    ${Object.entries(statusCount).map(([status, count]) => `
                        <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.85rem;border-bottom:1px solid var(--gray-100);padding-bottom:6px;">
                            <span>${getStatusLabel(status)}</span>
                            <span style="font-weight:600;background:var(--gray-100);padding:0 12px;border-radius:30px;font-size:0.75rem;">${count}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
            <div style="background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:22px;">
                <h4 style="font-weight:600;font-size:0.9rem;margin-bottom:14px;"><i class="fas fa-sitemap"></i> By Work Process</h4>
                <div style="display:flex;flex-direction:column;gap:12px;">
                    ${processStats.map(process => {
                        return `
                            <div>
                                <div style="display:flex;justify-content:space-between;font-size:0.8rem;">
                                    <span>${escHtml(process.process.replaceAll('_', ' '))}</span>
                                    <span>${process.total} document${process.total === 1 ? '' : 's'}</span>
                                </div>
                                <div style="background:var(--gray-200);border-radius:30px;height:6px;overflow:hidden;margin-top:3px;">
                                    <div style="height:100%;width:${process.averageCompletion}%;background:var(--success);border-radius:30px;"></div>
                                </div>
                                <div style="font-size:0.7rem;color:var(--gray-500);margin-top:3px;">${process.averageCompletion}% complete</div>
                            </div>
                        `;
                    }).join('')}
                </div>
            </div>
        </div>
        <div style="margin-top:24px;background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;">
            <h4 style="font-weight:600;font-size:0.9rem;margin-bottom:14px;"><i class="fas fa-list-check"></i> Progress by Process Step</h4>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px;">
                ${processStats.map(process => `
                    <div style="border:1px solid var(--gray-100);border-radius:8px;padding:14px;">
                        <div style="font-weight:600;font-size:0.85rem;margin-bottom:10px;">${escHtml(process.process.replaceAll('_', ' '))}</div>
                        ${process.stepStats.map(step => `
                            <div style="margin-top:9px;">
                                <div style="display:flex;justify-content:space-between;gap:10px;font-size:0.78rem;">
                                    <span>${escHtml(step.label)}</span>
                                    <span>${step.done}/${step.total} complete${step.active ? ` · ${step.active} active` : ''}</span>
                                </div>
                                <div style="background:var(--gray-200);border-radius:30px;height:6px;overflow:hidden;margin-top:3px;">
                                    <div style="height:100%;width:${step.pct}%;background:var(--success);border-radius:30px;"></div>
                                </div>
                            </div>`).join('')}
                    </div>`).join('')}
            </div>
        </div>
        <div style="margin-top:24px;background:#fff;border-radius:var(--radius);box-shadow:var(--shadow);padding:20px;">
            <h4 style="font-weight:600;font-size:0.9rem;margin-bottom:10px;"><i class="fas fa-info-circle"></i> Summary</h4>
            <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;font-size:0.85rem;">
                <div><span style="color:var(--gray-500);">Total Documents</span> <strong>${total}</strong></div>
                <div><span style="color:var(--gray-500);">Avg. Completion</span> <strong>${averageCompletion}%</strong></div>
                <div><span style="color:var(--gray-500);">Fully Completed</span> <strong>${statusCount.completed}</strong></div>
                <div><span style="color:var(--gray-500);">Final Decisions</span> <strong>${statusCount.decision}</strong></div>
            </div>
        </div>
    `;
    container.innerHTML = html;
    wireMonthlyReportControls(container);
}

// Seed function removed: seedDocuments() was intentionally removed to disable
// inserting demo/sample documents. If you need to provide sample data to users
// in the future, implement a guarded import flow (e.g., admin-only action)
// instead of auto-seeding from the client script.

// ============================================================
// MODAL OPEN / CLOSE
// ============================================================
function openNewModal() {
    editingId = null;
    editDocId.value = '';
    const preservedDate = normalizeDateString((docEntryDate && docEntryDate.value) ? docEntryDate.value : todayStr()) || todayStr();
    docForm.reset();
    if (docEntryDate) docEntryDate.value = preservedDate;
    if (docInCharge) docInCharge.value = '';
    if ($('docNo')) $('docNo').value = '';
    if ($('docWorkProcess')) $('docWorkProcess').value = '';
    if ($('docLeaderName')) $('docLeaderName').value = '';
    if (docStatus) docStatus.value = 'pending';
    if ($('leaderNameGroup')) $('leaderNameGroup').style.display = 'none';
    $('docModalTitle').innerHTML = '<i class="fas fa-file-signature"></i> New Document';
    renderWorkflowStepsForm(null);
    clearUploadedFileControls();
    docModal.classList.add('open');
    setTimeout(() => docTitle.focus(), 100);
}

function openEditModal(id) {
    const doc = documents.find(d => d.id === id);
    if (!doc) return toast('Document not found', 'error');
    editingId = id;
    editDocId.value = id;
    docTitle.value = doc.title || '';
    docRef.value = doc.ref || '';
    docOrigin.value = doc.origin || '';
    const normalizedDate = normalizeDateString(doc.entryDate || doc.dateOfEntry || '');
    if (docEntryDate) docEntryDate.value = normalizedDate || '';
    if (docInCharge) docInCharge.value = doc.inCharge || doc.inChargeOf || doc['In Charge Of'] || '';
    docDescription.value = doc.description || '';
    if ($('docNo')) $('docNo').value = doc.no || doc.No || '';
    if ($('docWorkProcess') && doc.workProcess) {
        $('docWorkProcess').value = doc.workProcess;
        toggleLeaderNameField(doc.workProcess);
    }
    if ($('docLeaderName')) $('docLeaderName').value = doc.leaderName || '';
    if (docStatus) {
        docStatus.value = (doc.workflowData && doc.workflowData.overallStatus) || computeOverallStatus(doc) || 'pending';
    }
    $('docModalTitle').innerHTML = '<i class="fas fa-edit"></i> Edit Document';
    renderWorkflowStepsForm(doc);
    updateUploadedFileLinks(doc);
    docModal.classList.add('open');
    currentDocPdfFile = null;
    currentDocImgFile = null;
    if (docPdfInput) docPdfInput.value = '';
    currentDocPdfRemove = false;
    if (docPdfRemove) {
        if (doc.pdfFileUrl || doc.pdfRef || doc.pdfName) docPdfRemove.style.display = 'inline-block';
        else docPdfRemove.style.display = 'none';
    }
}

function closeModal() {
    docModal.classList.remove('open');
}

function viewDocument(id) {
    if (!currentUser) {
        toast('Please sign in to view this document.', 'error');
        showAuthOverlay('login');
        return;
    }
    const doc = documents.find(d => d.id === id);
    if (!doc) return toast('Document not found', 'error');
    const body = $('viewModalBody');
    const processKey = doc.workProcess || '';
    const wfSteps = WF_PROCESSES[processKey] || [];
    const wfData = doc.workflowData || {};
    const wfIcons = {
        director: 'fa-user-tie',
        officeInCharge: 'fa-search',
        directorDecision: 'fa-user-cog',
        dgDecision: 'fa-users',
        undersecDecision: 'fa-user-shield',
        secDecision: 'fa-gavel',
        ministerDecision: 'fa-archive'
    };

    let stepHtml = wfSteps.map((step) => {
        const d = wfData[step.key] || {};
        const status = d.status || 'None';
        const notes = d.notes || '';
        const assign = d.assign || '';
        const person = d.person || '';
        const outcome = d.outcome || '';
        const isCompleted = status === 'Completed' || status === 'Approved';
        const isActive = status === 'In Progress';
        const borderColor = isCompleted ? 'var(--success)' : (isActive ? 'var(--secondary)' : 'var(--gray-300)');
        const statusClass = isCompleted ? 'completed-text' : (isActive ? 'in-progress-text' : 'pending-text');
        return `
            <div class="workflow-step" style="border-left-color:${borderColor};">
                <div class="step-icon ${isCompleted ? 'done' : (isActive ? 'active' : 'pending-icon')}"><i class="fas ${wfIcons[step.key] || 'fa-circle'}"></i></div>
                <div class="step-content">
                    <div class="step-title">${escHtml(step.label)}</div>
                    <div class="step-status ${statusClass}">${escHtml(status)}</div>
                    ${assign ? `<div class="step-notes step-topic"><span class="step-topic-label">Assign To:</span><span class="step-topic-value">${escHtml(assign)}</span></div>` : ''}
                    ${person ? `<div class="step-notes step-topic"><span class="step-topic-label">Person In Charge:</span><span class="step-topic-value">${escHtml(person)}</span></div>` : ''}
                    ${outcome ? `<div class="step-notes step-topic"><span class="step-topic-label">Decision Outcome:</span><span class="step-topic-value">${escHtml(outcome)}</span></div>` : ''}
                    ${notes ? `<div class="step-notes step-topic"><span class="step-topic-label">Notes:</span><span class="step-topic-value">${escHtml(notes)}</span></div>` : ''}
                </div>
            </div>
        `;
    }).join('');

    if (!stepHtml) {
        stepHtml = '<p style="color:var(--gray-500);">No workflow steps available for this process.</p>';
    }

    const normalizedPdfUrl = normalizeDrivePreviewUrl(doc.pdfFileUrl || '');
    const normalizedPictureUrl = normalizeDriveUrl(doc.pictureFileUrl || '');

    body.innerHTML = `
        <div style="margin-bottom:20px;display:grid;grid-template-columns:1fr;gap:6px;">
            <div class="detail-field"><span class="label">No.</span><span class="value">${escHtml(doc.no || doc.No || '—')}</span></div>
            <div class="detail-field"><span class="label">Document Title</span><span class="value"><strong>${escHtml(doc.title || 'Untitled')}</strong></span></div>
            <div class="detail-field"><span class="label">Reference Number</span><span class="value">${escHtml(doc.ref || '—')}</span></div>
            <div class="detail-field"><span class="label">Origin / Source</span><span class="value">${escHtml(doc.origin || '—')}</span></div>
            <div class="detail-field"><span class="label">Date of Entry</span><span class="value">${formatDate(doc.entryDate)}</span></div>
            <div class="detail-field"><span class="label">In Charge Of</span><span class="value">${escHtml(doc.inCharge || doc.inChargeOf || doc['In Charge Of'] || '—')}</span></div>
            <div class="detail-field"><span class="label">Description / Summary</span><span class="value">${escHtml(doc.description || '—')}</span></div>
            <div class="detail-field"><span class="label">Work Process</span><span class="value">${escHtml(doc.workProcess || '—')}</span></div>
            <div class="detail-field"><span class="label">Leader Name</span><span class="value">${escHtml(doc.leaderName || '—')}</span></div>
            <div class="detail-field"><span class="label">Overall Status</span><span class="value">${getStatusBadge(computeOverallStatus(doc))}</span></div>
        </div>
        ${(normalizedPdfUrl || normalizedPictureUrl) ? `
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin-bottom:18px;">
            ${normalizedPdfUrl ? `
            <div style="border:1px solid var(--gray-200);border-radius:8px;overflow:hidden;background:#fff;width:100%;max-width:420px;margin:0 auto;">
                <div style="padding:8px 10px;border-bottom:1px solid var(--gray-200);display:flex;align-items:center;gap:10px;">
                    <strong style="font-size:0.9rem;">Ref. Document</strong>
                </div>
                <iframe src="${normalizedPdfUrl}" style="width:100%;aspect-ratio:1/1.414;border:0;min-height:594px;" title="PDF preview"></iframe>
            </div>` : ''}
            ${doc.pictureFileUrl ? `
            <div style="border:1px solid var(--gray-200);border-radius:8px;overflow:hidden;background:#fff;">
                <div style="padding:8px 10px;border-bottom:1px solid var(--gray-200);display:flex;align-items:center;gap:10px;">
                    <strong style="font-size:0.9rem;">Picture Preview</strong>
                </div>
                <div style="padding:10px;display:flex;justify-content:center;align-items:center;min-height:420px;">
                    <img src="${doc.pictureFileUrl}" alt="Saved attachment" style="max-width:100%;max-height:400px;object-fit:contain;border-radius:6px;" />
                </div>
            </div>` : ''}
        </div>` : ''}
        <div class="workflow-detail" style="border-top:1px solid var(--gray-200);padding-top:16px;margin-top:0;">
            <h4 style="font-weight:600;font-size:0.9rem;margin-bottom:12px;"><i class="fas fa-sitemap"></i> Workflow Progress</h4>
            ${stepHtml}
        </div>
    `;
    viewModal.classList.add('open');
    // Store current id for edit from view
    viewModal.dataset.docId = id;
    // If there is a legacy local PDF attachment, keep supporting the old blob preview path
    if (!doc.pdfFileUrl && doc.pdfRef) {
        const attEl = document.getElementById('docAttachmentArea');
        if (attEl) {
            attEl.textContent = 'Loading attachment...';
            getDocumentBlobUrl(doc.pdfRef).then(url => {
                if (!url) return attEl.textContent = (doc.pdfName || 'Attachment not available');
                // show download link and inline preview (iframe)
                attEl.innerHTML = `<a href="${url}" target="_blank" rel="noopener">${escHtml(doc.pdfName || 'View PDF')}</a>`;
                try {
                    const previewHtml = `<div style="margin-top:12px;display:flex;justify-content:center;"><iframe src="${url}" style="width:100%;max-width:420px;aspect-ratio:1/1.414;border:1px solid var(--gray-200);border-radius:6px;min-height:594px;" frameborder="0"></iframe></div>`;
                    attEl.innerHTML += previewHtml;
                } catch (e) {
                    // ignore iframe failures
                }
            }).catch(() => { attEl.textContent = (doc.pdfName || 'Attachment not available'); });
        }
    }
}

function closeViewModalFn() {
    viewModal.classList.remove('open');
}

// ============================================================
// WORKFLOW STEPS RENDER (for edit modal)
// ============================================================
// ============================================================
// WORKFLOW PROCESS DEFINITIONS
// ============================================================
const WF_PROCESSES = {
    To_Director: [
        { key: 'director',          label: 'Director',            hasAssign: true  },
        { key: 'officeInCharge',    label: 'Office In Charge',    hasPerson: true  },
        { key: 'directorDecision',  label: 'Director Decision',   isDecision: true }
    ],
    To_Director_General: [
        { key: 'director',          label: 'Director',            hasAssign: true  },
        { key: 'officeInCharge',    label: 'Office In Charge',    hasPerson: true  },
        { key: 'directorDecision',  label: 'Director Decision',   isDecision: true },
        { key: 'dgDecision',        label: 'Director General Decision', isDecision: true }
    ],
    To_Specific_Leader: [
        { key: 'director',          label: 'Director',            hasAssign: true  },
        { key: 'officeInCharge',    label: 'Office In Charge',    hasPerson: true  },
        { key: 'directorDecision',  label: 'Director Decision',   isDecision: true },
        { key: 'dgDecision',        label: 'Director General Decision', isDecision: true },
        { key: 'undersecDecision',  label: 'Under Secretary of State Decision', isDecision: true },
        { key: 'secDecision',       label: 'Secretary of State Decision', isDecision: true }
    ],
    To_Minister: [
        { key: 'director',          label: 'Director',            hasAssign: true  },
        { key: 'officeInCharge',    label: 'Office In Charge',    hasPerson: true  },
        { key: 'directorDecision',  label: 'Director Decision',   isDecision: true },
        { key: 'dgDecision',        label: 'Director General Decision', isDecision: true },
        { key: 'undersecDecision',  label: 'Under Secretary of State Decision', isDecision: true },
        { key: 'secDecision',       label: 'Secretary of State Decision', isDecision: true },
        { key: 'ministerDecision',  label: 'Minister Decision',   isDecision: true }
    ]
};

const WF_STATUSES = ['None', 'In Progress', 'Rejected', 'Approved', 'Completed'];
const ASSIGN_TO_OPTIONS = [
    'General Affair Office',
    'Monitoring and Evaluation Office',
    'Bilateral Cooperation Office',
    'Regional Cooperation Office',
    'Multilateral Cooperation and International Organization Office'
];

function renderWorkflowStepsForm(doc) {
    const container = workflowStepsForm;
    const process   = ($('docWorkProcess') ? $('docWorkProcess').value : '') || (doc && doc.workProcess) || '';
    const stepDefs  = WF_PROCESSES[process];
    const savedData = (doc && doc.workflowData) ? doc.workflowData : {};

    if (!stepDefs) {
        container.innerHTML = '<p style="color:var(--gray-400);font-size:0.9rem;">Select a Work Process above to see the approval steps.</p>';
        return;
    }

    let html = '';
    stepDefs.forEach((step, i) => {
        const saved  = savedData[step.key] || {};
        const status = saved.status || 'None';
        const notes  = saved.notes  || '';
        const assign = saved.assign || '';
        const person = saved.person || '';
        const outcome= saved.outcome || '';

        // Generate icon based on step index
        const icons = ['👤', '📋', '👨‍💼', '🤝', '👔', '💼', '📁'];
        const icon = icons[i] || '📝';

        html += `
        <div class="workflow-card" style="display:flex;gap:16px;padding:16px;margin-bottom:12px;background:#f9f9f9;border-left:4px solid #4a90a4;border-radius:4px;border:1px solid #e8e8e8;border-left-width:4px;">
            <!-- Icon Avatar -->
            <div style="flex-shrink:0;">
                <div style="width:48px;height:48px;border-radius:50%;background:#c0d8e8;display:flex;align-items:center;justify-content:center;font-size:24px;color:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
                    ${icon}
                </div>
            </div>

            <!-- Step Content -->
            <div style="flex:1;min-width:0;">
                <!-- Step Title -->
                <h3 style="margin:0 0 12px 0;font-size:0.95rem;font-weight:600;color:#1a1a1a;letter-spacing:0.3px;">${step.label}</h3>

                <!-- Status Dropdown -->
                <div style="margin-bottom:10px;max-width:180px;">
                    <select class="wf-status-select" data-step="${step.key}" style="width:100%;max-width:180px;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:0.85rem;background:#fff;color:#333;cursor:pointer;">
                        ${WF_STATUSES.map(s => `<option value="${s}" ${s === status ? 'selected' : ''}>${s}</option>`).join('')}
                    </select>
                </div>

                <!-- Conditional Fields Row -->
                <div style="display:grid;grid-template-columns:1fr;gap:10px;margin-bottom:10px;">
                    ${step.hasAssign ? `
                    <div>
                        <select class="wf-assign-input" data-step="${step.key}" style="width:100%;max-width:320px;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:0.85rem;background:#fff;">
                            <option value="">-- Assign to --</option>
                            ${ASSIGN_TO_OPTIONS.map(opt => `<option value="${escHtml(opt)}" ${opt === assign ? 'selected' : ''}>${escHtml(opt)}</option>`).join('')}
                            ${assign && !ASSIGN_TO_OPTIONS.includes(assign) ? `<option value="${escHtml(assign)}" selected>${escHtml(assign)} (Current)</option>` : ''}
                        </select>
                    </div>` : ''}

                    ${step.hasPerson ? `
                    <div>
                        <input type="text" class="wf-person-input" data-step="${step.key}" placeholder="Person In Charge" value="${escHtml(person)}" style="width:100%;max-width:320px;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:0.85rem;background:#fff;" />
                    </div>` : (step.isDecision ? `
                    <div>
                        <input type="text" class="wf-outcome-input" data-step="${step.key}" placeholder="Decision outcome..." value="${escHtml(outcome)}" style="width:100%;max-width:320px;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:0.85rem;background:#fff;" />
                    </div>` : '')}
                </div>

                <!-- Notes Field -->
                <div>
                    <input type="text" class="wf-notes-input" data-step="${step.key}" placeholder="Notes / remarks..." value="${escHtml(notes)}" style="width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:0.85rem;background:#fff;" />
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

function collectWorkflowData() {
    const process   = $('docWorkProcess') ? $('docWorkProcess').value : '';
    const stepDefs  = WF_PROCESSES[process] || [];
    const result    = {};
    stepDefs.forEach(step => {
        const statusEl  = document.querySelector(`.wf-status-select[data-step="${step.key}"]`);
        const notesEl   = document.querySelector(`.wf-notes-input[data-step="${step.key}"]`);
        const assignEl  = document.querySelector(`.wf-assign-input[data-step="${step.key}"]`);
        const personEl  = document.querySelector(`.wf-person-input[data-step="${step.key}"]`);
        const outcomeEl = document.querySelector(`.wf-outcome-input[data-step="${step.key}"]`);
        result[step.key] = {
            status:  statusEl  ? statusEl.value  : 'None',
            notes:   notesEl   ? notesEl.value   : '',
            assign:  assignEl  ? assignEl.value  : '',
            person:  personEl  ? personEl.value  : '',
            outcome: outcomeEl ? outcomeEl.value : ''
        };
    });
    if (docStatus) {
        result.overallStatus = docStatus.value || 'pending';
    }
    return result;
}

// ── GAS Workflow persistence ─────────────────────────────────
async function gasPost(payload) {
    const url = getAuthApiBase();
    if (!url || url.includes('PASTE_YOUR_WEB_APP_URL_HERE')) {
        return { success: false, error: 'GAS URL not configured' };
    }
    try {
        const res  = await fetch(url, {
            method:  'POST',
            headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
            body:    JSON.stringify(payload)
        });
        const text = await res.text();
        return JSON.parse(text);
    } catch (e) {
        return { success: false, error: e.message };
    }
}

async function saveWorkflowData(docData, uploadFiles = {}) {
    const pdfPayload = await fileToBase64(uploadFiles.pdfFile || null);
    const imgPayload = await fileToBase64(uploadFiles.imgFile || null);

    const result = await gasPost({
        action:             'saveWorkflow',
        referenceNumber:    docData.ref          || '',
        documentTitle:      docData.title        || '',
        originSource:       docData.origin       || '',
        dateOfEntry:        docData.entryDate    || '',
        inChargeOf:         docData.inCharge     || '',
        descriptionSummary: docData.description  || '',
        workProcess:        docData.workProcess  || '',
        leaderName:         docData.leaderName   || '',
        workflowData:       docData.workflowData || {},
        updatedBy:          (currentUser && currentUser.email) || '',
        pdfFile:            pdfPayload,
        imgFile:            imgPayload
    });
    if (result && result.success) {
        // Silently saved
    } else if (result && result.error) {
        console.warn('saveWorkflowData error:', result.error);
    }
    return result;
}

async function loadWorkflowData(refNum) {
    const result = await gasPost({ action: 'getWorkflow', referenceNumber: refNum });
    return (result && result.success) ? result.record : null;
}

function fileToBase64(file) {
    return new Promise((resolve, reject) => {
        if (!file) return resolve(null);
        if (file.size > 10 * 1024 * 1024) {
            return reject(new Error('File size must be 10MB or smaller.'));
        }

        const reader = new FileReader();
        reader.onload = () => {
            const result = String(reader.result || '');
            const commaIndex = result.indexOf(',');
            const base64 = commaIndex >= 0 ? result.slice(commaIndex + 1) : result;
            resolve({
                bytes: base64,
                name: file.name,
                mimeType: file.type || 'application/octet-stream',
                size: file.size
            });
        };
        reader.onerror = () => reject(new Error('Unable to read file.'));
        reader.readAsDataURL(file);
    });
}

function updateUploadedFileLinks(record = {}) {
    const pdfUrl = normalizeDrivePreviewUrl(record.pdfFileUrl || '');
    const pictureUrl = normalizeDriveUrl(record.pictureFileUrl || '');

    if (pdfFileLinkArea) {
        pdfFileLinkArea.innerHTML = pdfUrl
            ? ''
            : '<span style="color:var(--gray-500);">No PDF saved in Drive yet.</span>';
    }

    if (imgFileLinkArea) {
        imgFileLinkArea.innerHTML = pictureUrl
            ? `<a href="${pictureUrl}" target="_blank" rel="noopener noreferrer">View Saved Picture</a>`
            : '<span style="color:var(--gray-500);">No picture saved in Drive yet.</span>';
    }

    if (docPdfName) {
        docPdfName.textContent = pdfUrl ? '' : 'No file chosen';
    }

    if (docImgName) {
        docImgName.textContent = pictureUrl ? '' : 'No file chosen';
    }

    if (pdfFilePreviewArea) {
        if (pdfUrl) {
            pdfFilePreviewArea.style.display = 'block';
            pdfFilePreviewArea.innerHTML = `
                <div style="width:100%;max-width:420px;margin:0 auto;border:1px solid var(--gray-200);border-radius:8px;overflow:hidden;background:#fff;">
                    <div style="padding:8px 10px;border-bottom:1px solid var(--gray-200);display:flex;align-items:center;gap:10px;">
                        <strong style="font-size:0.9rem;">Ref. Document</strong>
                    </div>
                    <iframe src="${pdfUrl}" style="width:100%;aspect-ratio:1/1.414;border:0;min-height:594px;" title="PDF preview"></iframe>
                </div>
            `;
        } else {
            pdfFilePreviewArea.style.display = 'none';
            pdfFilePreviewArea.innerHTML = '';
        }
    }

    if (imgFilePreviewArea) {
        if (pictureUrl) {
            imgFilePreviewArea.style.display = 'block';
            imgFilePreviewArea.innerHTML = `
                <div style="padding:8px 10px;border-bottom:1px solid var(--gray-200);display:flex;align-items:center;gap:10px;">
                    <strong style="font-size:0.9rem;">Picture Preview</strong>
                </div>
                <div style="padding:10px;display:flex;justify-content:center;align-items:center;">
                    <img src="${pictureUrl}" alt="Saved attachment" style="max-width:100%;max-height:420px;object-fit:contain;border-radius:6px;" />
                </div>
            `;
        } else {
            imgFilePreviewArea.style.display = 'none';
            imgFilePreviewArea.innerHTML = '';
        }
    }
}

function clearUploadedFileControls() {
    if (docPdfInput) docPdfInput.value = '';
    if (docImgInput) docImgInput.value = '';
    if (docPdfName) docPdfName.textContent = 'No file chosen';
    if (docImgName) docImgName.textContent = 'No file chosen';
    if (pdfFileLinkArea) pdfFileLinkArea.innerHTML = '<span style="color:var(--gray-500);">No PDF saved in Drive yet.</span>';
    if (imgFileLinkArea) imgFileLinkArea.innerHTML = '<span style="color:var(--gray-500);">No picture saved in Drive yet.</span>';
    if (pdfFilePreviewArea) {
        pdfFilePreviewArea.style.display = 'none';
        pdfFilePreviewArea.innerHTML = '';
    }
    if (imgFilePreviewArea) {
        imgFilePreviewArea.style.display = 'none';
        imgFilePreviewArea.innerHTML = '';
    }
    currentDocPdfFile = null;
    currentDocImgFile = null;
    currentDocPdfRemove = false;
    if (docPdfRemove) docPdfRemove.style.display = 'none';
}

// Legacy aliases
async function syncWorkflowToGAS(docData) { return saveWorkflowData(docData); }
async function loadWorkflowFromGAS(refNum) { return loadWorkflowData(refNum); }

// ============================================================
// CRUD OPERATIONS
// ============================================================
async function saveDocumentFromForm() {
    // Validate
    if (!docTitle.value.trim()) return toast('Please enter a document title.', 'error');
    if (!docRef.value.trim()) return toast('Please enter a reference number.', 'error');
    if (!docOrigin.value.trim()) return toast('Please enter the origin / source.', 'error');
    if (!docEntryDate.value) return toast('Please select the date of entry.', 'error');
    if (!($('docWorkProcess') && $('docWorkProcess').value)) return toast('Please select a Work Process.', 'error');

    const refNum = docRef.value.trim();
    const isNew  = !editingId;
    // Use referenceNumber as the stable local id (mirrors GAS primary key)
    const id = refNum;

    const docData = {
        id,
        no:          isNew ? getNextDocNo() : (documents.find(d => d.id === id)?.no || ''),
        title:       docTitle.value.trim(),
        ref:         refNum,
        origin:      docOrigin.value.trim(),
        entryDate:   normalizeDateString(docEntryDate.value),
        inCharge:    docInCharge ? docInCharge.value.trim() : '',
        description: docDescription.value.trim(),
        workProcess: $('docWorkProcess').value,
        leaderName:  ($('docLeaderName') ? $('docLeaderName').value : '') || '',
        workflowData: collectWorkflowData(),
        createdAt:   isNew ? Date.now() : (documents.find(d => d.id === id)?.createdAt || Date.now()),
        createdBy:   currentUser ? currentUser.email : '',
        pdfFileUrl:  documents.find(d => d.id === id)?.pdfFileUrl || '',
        pictureFileUrl: documents.find(d => d.id === id)?.pictureFileUrl || '',
    };

    // Handle PDF attachment
    if (currentDocPdfFile) {
        try {
            const pdfKey = `pdf_${id}_${Date.now().toString(36)}`;
            const saved = await saveDocumentBlob(pdfKey, currentDocPdfFile);
            if (saved) {
                const prev = documents.find(d => d.id === id);
                if (prev && prev.pdfRef && prev.pdfRef !== pdfKey) {
                    try { await deleteDocumentBlob(prev.pdfRef); } catch (e) { /* ignore */ }
                }
                docData.pdfRef  = pdfKey;
                docData.pdfName = currentDocPdfFile.name;
            } else {
                toast('Failed to save PDF attachment.', 'warning');
            }
        } catch (e) {
            toast('Unable to store PDF attachment.', 'warning');
        }
    }

    if (currentDocPdfRemove && !currentDocPdfFile && !isNew) {
        try {
            const prev = documents.find(d => d.id === id);
            if (prev && prev.pdfRef) await deleteDocumentBlob(prev.pdfRef);
            delete docData.pdfRef;
            delete docData.pdfName;
        } catch (e) { /* ignore */ }
    }

    // ── Push to Google Sheets + Drive (primary cloud store) ─
    if (saveDocBtn) { saveDocBtn.disabled = true; saveDocBtn.textContent = 'Saving...'; }
    let gasResult = null;
    try {
        gasResult = await saveWorkflowData(docData, {
            pdfFile: currentDocPdfFile,
            imgFile: currentDocImgFile
        });
        if (!gasResult || !gasResult.success) {
            console.warn('GAS save failed:', gasResult && gasResult.error);
        } else {
            docData.pdfFileUrl = gasResult.pdfFileUrl || docData.pdfFileUrl || '';
            docData.pictureFileUrl = gasResult.pictureFileUrl || docData.pictureFileUrl || '';
        }
    } catch (e) {
        console.warn('GAS save error:', e.message);
    } finally {
        if (saveDocBtn) { saveDocBtn.disabled = false; saveDocBtn.innerHTML = '<i class="fas fa-save"></i> Save Document'; }
    }

    // ── Update local cache ────────────────────────────────────
    if (isNew) {
        documents.push(docData);
        toast('Document created successfully!', 'success');
    } else {
        const idx = documents.findIndex(d => d.id === id);
        if (idx !== -1) {
            documents[idx] = { ...documents[idx], ...docData };
            toast('Document updated successfully!', 'success');
        } else {
            documents.push(docData);
            toast('Document saved.', 'success');
        }
    }
    renumberAllDocsSequentially();
    try { saveDocs(documents); } catch (e) { console.warn('local saveDocs failed', e); }

    closeModal();
    renderAllDocs();
}

async function deleteDocument(id) {
    if (!confirm('Are you sure you want to delete this document?')) return;

    const doc = documents.find(d => d.id === id);
    const refNum = doc ? (doc.ref || doc.id) : id;

    if (!refNum) {
        toast('Cannot delete: Reference Number missing.', 'error');
        return;
    }

    // Delete from Google Sheets
    try {
        toast('Deleting from spreadsheet…', 'info');
        const result = await gasPost({ action: 'deleteWorkflow', referenceNumber: refNum });
        if (result && result.success) {
            toast(`Deleted from spreadsheet (tab: ${result.tab}).`, 'success');
        } else {
            toast('Spreadsheet delete failed: ' + (result && result.error ? result.error : 'Unknown error'), 'error');
            console.warn('GAS deleteWorkflow failed:', result);
        }
    } catch (e) {
        toast('Spreadsheet delete error: ' + e.message, 'error');
        console.warn('GAS delete error:', e);
    }

    // Refresh from backend so other accounts see the same data state
    try {
        documents = await loadDocs();
    } catch (e) {
        console.warn('Failed to refresh documents after delete:', e);
        documents = documents.filter(d => d.id !== id);
    }
    renumberAllDocsSequentially();
    renderAllDocs();
}

async function changeAuthUserRole() {
    if (!currentUser || currentUser.role !== 'admin') {
        toast('Admin access is required to manage roles.', 'error');
        return;
    }

    toast('Role updates are managed through the Google Sheets Users tab.', 'info');
}

async function loadAuthAccounts() {
    const container = $('authAccountsList');
    if (!container || !currentUser || currentUser.role !== 'admin') return;

    container.innerHTML = '';
}

function logout() {
    clearSession();
    setAuthState();
    // Redirect to standalone sign-in page after logout
    try {
        window.location.href = 'signin.html';
    } catch (e) {
        // Fallback to showing overlay if navigation fails
        showAuthOverlay('login');
    }
}

// ============================================================
// NAVIGATION
// ============================================================
function navigateTo(page) {
    if (page === 'admin' && (!currentUser || currentUser.role !== 'admin')) {
        page = 'dashboard';
    }
    currentPage = page;
    if (page === 'admin') {
        loadAuthAccounts().catch(() => {});
    }
    // Hide all pages
    Object.keys(pageEls).forEach(key => {
        pageEls[key].style.display = key === page ? 'block' : 'none';
    });
    // Update sidebar
    document.querySelectorAll('.sidebar-nav a').forEach(a => {
        a.classList.toggle('active', a.dataset.page === page);
    });
    // Update title
    const titles = {
        dashboard: 'Dashboard',
        documents: 'Documents',
        workflow: 'Workflow Status',
        reports: 'Reports',
        admin: 'Admin Panel',
        account: 'Account Information',
        'user-view': 'User Details'
    };
    pageTitle.innerHTML = `${titles[page] || page} <small>${page === 'dashboard' ? 'Overview' : ''}</small>`;
    // Re-render if needed
    if (page === 'dashboard' || page === 'documents') {
        renderAllDocs();
    } else if (page === 'workflow') {
        renderWorkflowOverview();
    } else if (page === 'reports') {
        renderReports();
    } else if (page === 'admin') {
        renderAdminPanel();
    } else if (page === 'account') {
        loadAccountInfoPage();
    } else if (page === 'user-view') {
        // load the admin user view page with the currently selected viewingUserIndex
        if (typeof viewingUserIndex !== 'undefined' && viewingUserIndex !== null) loadUserViewPage(viewingUserIndex);
    }
    // Close sidebar on mobile
    closeSidebar();
}

function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('open');
}

// ============================================================
// ADMIN PANEL
// ============================================================

async function renderAdminPanel() {
    let pending = getPendingUsers();
    let active = getAllUsers();
    if (currentUser && currentUser.role === 'admin') {
        const backendUsers = await fetchUsersFromBackend();
        if (Array.isArray(backendUsers) && backendUsers.length > 0) {
            active = backendUsers.filter((user) => String(user.status || 'active').toLowerCase() === 'active');
            pending = backendUsers.filter((user) => String(user.status || '').toLowerCase() === 'pending');
        }
    }
    adminPendingUsersCache = pending;
    adminUsersCache = active;

    const pendingList = document.getElementById('pendingUsersList');
    const activeList = document.getElementById('activeUsersList');
    
    // Render pending
    if (pending.length === 0) {
        pendingList.innerHTML = '';
    } else {
        pendingList.innerHTML = pending.map((user, idx) => `
            <div style="padding: 12px; border: 1px solid #eee; border-radius: 6px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <strong>${user.name}</strong><br/>
                    <small>${user.email}</small><br/>
                    <small style="color: #999;">Registered: ${new Date(user.createdAt).toLocaleDateString()}</small>
                </div>
                <div style="display: flex; gap: 10px;">
                    <select id="role_pending_${idx}" style="padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px;">
                        <option value="user">User</option>
                        <option value="admin">Admin</option>
                    </select>
                    <button class="btn btn-primary btn-sm" onclick="approvePendingUser(${idx}, document.getElementById('role_pending_${idx}').value)">Approve</button>
                </div>
            </div>
        `).join('');
    }
    
    // Render active
    if (active.length === 0) {
        activeList.innerHTML = '';
    } else {
        activeList.innerHTML = active.map((user, idx) => `
            <div style="padding: 12px; border: 1px solid #eee; border-radius: 6px; margin-bottom: 10px; display: flex; justify-content: space-between; align-items: center;">
                <div>
                    <strong>${user.name}</strong> <span style="background: ${user.role === 'admin' ? '#2196F3' : '#4CAF50'}; color: white; padding: 2px 8px; border-radius: 4px; font-size: 11px; margin-left: 8px;">${user.role}</span><br/>
                    <small>${user.email}</small><br/>
                    <small style="color: #999;">Approved: ${new Date(user.approvedAt || user.createdAt).toLocaleDateString()}</small>
                </div>
                <div style="display: flex; gap: 10px;">
                    <select id="role_active_${idx}" style="padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px;" onchange="changeUserRole(${idx}, this.value)">
                        <option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option>
                        <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
                    </select>
                    <select id="position_active_${idx}" style="padding: 6px 10px; border: 1px solid #ddd; border-radius: 4px;" onchange="changeUserPosition(${idx}, this.value)">
                        <option value="">None</option>
                        <option value="General Affair Office" ${user.position === 'General Affair Office' ? 'selected' : ''}>General Affair Office</option>
                        <option value="Monitoring and Evaluation Office" ${user.position === 'Monitoring and Evaluation Office' ? 'selected' : ''}>Monitoring and Evaluation Office</option>
                        <option value="Bilateral Cooperation Office" ${user.position === 'Bilateral Cooperation Office' ? 'selected' : ''}>Bilateral Cooperation Office</option>
                        <option value="Regional Cooperation Office" ${user.position === 'Regional Cooperation Office' ? 'selected' : ''}>Regional Cooperation Office</option>
                        <option value="Multilateral Cooperation and International Organization Office" ${user.position === 'Multilateral Cooperation and International Organization Office' ? 'selected' : ''}>Multilateral Cooperation &amp; International Organization Office</option>
                    </select>
                    <button class="btn btn-outline btn-sm" onclick="deactivateUser(${idx})" style="color: #d32f2f;">Deactivate</button>
                    <button class="btn btn-outline btn-sm" onclick="viewUserDetails(${idx})">View</button>
                    <button class="btn btn-primary btn-sm" onclick="adminResetPassword(${idx})">Reset Password</button>
                </div>
            </div>
        `).join('');
    }
}

function approvePendingUser(index, role = 'user') {
    const pending = getPendingUsers();
    if (index < 0 || index >= pending.length) return;
    
    const user = pending[index];
    user.status = 'active';
    user.approvedAt = new Date().toISOString();
    user.token = Math.random().toString(36).substr(2, 9);
    user.role = role;
    
    const active = getAllUsers();
    active.push(user);
    saveAllUsers(active);
    
    // Remove from pending
    pending.splice(index, 1);
    savePendingUsers(pending);
    
    toast(`User ${user.name} approved as ${role}!`, 'success');
    renderAdminPanel();
}

function changeUserRole(index, newRole) {
    const users = getAllUsers();
    if (index < 0 || index >= users.length) return;
    
    const user = users[index];
    user.role = newRole;
    saveAllUsers(users);
    
    toast(`User ${user.name} role changed to ${newRole}`, 'success');
}

async function changeUserPosition(index, newPosition) {
    const users = getAllUsers();
    if (index < 0 || index >= users.length) return;

    const user = users[index];
    user.position = newPosition;
    saveAllUsers(users);

    // Persist to backend for central users sheet if available
    if (currentUser && currentUser.email && currentUser.token) {
        try {
            await callBackend('setUserPosition', {
                email: currentUser.email,
                token: currentUser.token,
                targetEmail: user.email,
                position: newPosition
            });
        } catch (e) {
            console.warn('setUserPosition failed', e);
        }
    }

    toast(`User ${user.name} assigned to: ${newPosition || 'None'}`, 'success');
    renderAdminPanel();
}

function deactivateUser(index) {
    const users = getAllUsers();
    if (index < 0 || index >= users.length) return;
    
    const user = users[index];
    user.status = 'inactive';
    saveAllUsers(users);
    
    toast(`User ${user.name} deactivated`, 'info');
    renderAdminPanel();
}

function viewUserDetails(index) {
    const users = adminUsersCache || getAllUsers();
    if (index < 0 || index >= users.length) return toast('User not found', 'error');
    viewingUserIndex = index;
    navigateTo('user-view');
}

function loadUserViewPage(index) {
    const users = adminUsersCache || getAllUsers();
    if (index < 0 || index >= users.length) {
        toast('User not found', 'error');
        return navigateTo('admin');
    }
    const u = users[index];
    const elName = $('userViewName');
    const elEmail = $('userViewEmail');
    const elPosition = $('userViewPosition');
    const elRole = $('userViewRole');
    const elPhone = $('userViewPhone');
    const elBirthday = $('userViewBirthday');
    const elStatus = $('userViewStatus');
    const elCreated = $('userViewCreated');
    const elAvatar = $('userViewAvatar');
    const elInitial = $('userViewInitial');

    if (elName) elName.textContent = u.name || '—';
    if (elEmail) elEmail.textContent = u.email || '—';
    if (elPosition) elPosition.textContent = u.position || '—';
    if (elRole) elRole.textContent = u.role || '—';
    if (elPhone) elPhone.textContent = u.phone || '—';
    if (elBirthday) elBirthday.textContent = u.birthday ? formatDateDMY(u.birthday) : '—';
    if (elStatus) elStatus.textContent = u.status || 'active';
    if (elCreated) elCreated.textContent = u.createdAt ? formatDateDMY(u.createdAt.split('T')[0]) : '—';

    if (elAvatar) {
        if (u.avatarRef) {
            setAvatarElement(elAvatar, null, '');
            getBlobUrl(u.avatarRef).then(url => { if (url) setAvatarElement(elAvatar, url, ''); }).catch(() => { setAvatarElement(elAvatar, null, (u.name || 'U').slice(0,1)); });
        } else if (u.avatarUrl) {
            setAvatarElement(elAvatar, u.avatarUrl, '');
        } else {
            setAvatarElement(elAvatar, null, (u.name || 'U').slice(0,1));
        }
    }
    // wire back button
    const backBtn = $('userViewBackBtn');
    if (backBtn) backBtn.addEventListener('click', () => navigateTo('admin'));
    
    // wire reset password button
    const resetPwdBtn = $('userViewResetPwdBtn');
    if (resetPwdBtn) {
        // Remove any previous listeners to avoid duplication
        resetPwdBtn.replaceWith(resetPwdBtn.cloneNode(true));
        const newBtn = $('userViewResetPwdBtn');
        if (newBtn) {
            newBtn.addEventListener('click', async () => {
                    const users = getAllUsers();
                    if (viewingUserIndex < 0 || viewingUserIndex >= users.length) {
                        return toast('User not found', 'error');
                    }
                    const u = users[viewingUserIndex];
                    const ok = confirm(`Reset password for ${u.name} (${u.email})?`);
                    if (!ok) return;
                    const p1 = prompt('Enter new password for ' + u.email + ':');
                    if (p1 === null) return;
                    if (!p1 || p1.length < 4) {
                        return toast('Password must be at least 4 characters.', 'error');
                    }
                    const p2 = prompt('Confirm new password:');
                    if (p2 === null) return;
                    if (p1 !== p2) return toast('Passwords do not match.', 'error');

                    // If logged in and backend is available, call backend reset endpoint
                    if (currentUser && currentUser.token) {
                        try {
                            const res = await callBackend('resetPassword', { email: currentUser.email, token: currentUser.token, targetEmail: u.email, newPassword: p1 });
                            if (res && res.success) {
                                toast(`Password for ${u.name} reset successfully.`, 'success');
                                return;
                            } else {
                                toast(res && res.error ? res.error : 'Backend failed to reset password, falling back to local', 'error');
                            }
                        } catch (err) {
                            console.error('Backend reset error', err);
                        }
                    }

                    // Fallback to localStorage behavior for demo/local mode
                    u.passwordHash = hashPassword(p1);
                    try { u.token = Math.random().toString(36).substr(2,9); } catch (e) {}
                    saveAllUsers(users);
                    toast(`Password for ${u.name} reset locally.`, 'success');
                });
        }
    }
}

function adminResetPassword(index) {
    const users = adminUsersCache || getAllUsers();
    if (index < 0 || index >= users.length) return toast('User not found', 'error');
    const u = users[index];
    // Confirm admin intent
    const ok = confirm(`Reset password for ${u.name} (${u.email})?`);
    if (!ok) return;
    // Prompt for new password (twice)
    const p1 = prompt('Enter new password for ' + u.email + ':');
    if (p1 === null) return; // cancelled
    if (!p1 || p1.length < 4) { return toast('Password must be at least 4 characters.', 'error'); }
    const p2 = prompt('Confirm new password:');
    if (p2 === null) return;
    if (p1 !== p2) return toast('Passwords do not match.', 'error');
    // If logged in and backend is available, call backend reset endpoint
    (async () => {
        if (currentUser && currentUser.token) {
            try {
                const res = await callBackend('resetPassword', { email: currentUser.email, token: currentUser.token, targetEmail: u.email, newPassword: p1 });
                if (res && res.success) {
                    toast(`Password for ${u.name} reset successfully.`, 'success');
                    renderAdminPanel();
                    return;
                } else {
                    toast(res && res.error ? res.error : 'Backend failed to reset password, falling back to local', 'error');
                }
            } catch (err) {
                console.error('Backend reset error', err);
            }
        }

        // Fallback to localStorage behavior for demo/local mode
        u.passwordHash = hashPassword(p1);
        // rotate token to force re-login (optional)
        try { u.token = Math.random().toString(36).substr(2,9); } catch (e) {}
        saveAllUsers(users);
        toast(`Password for ${u.name} reset locally.`, 'success');
        renderAdminPanel();
    })();
}

function toggleSidebar() {
    sidebar.classList.toggle('open');
    overlay.classList.toggle('open');
}

// ============================================================
// TOAST
// ============================================================
function toast(message, type = 'info') {
    const container = $('toastContainer');
    const icons = {
        success: 'fas fa-check-circle',
        error: 'fas fa-exclamation-circle',
        info: 'fas fa-info-circle'
    };
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<i class="${icons[type] || icons.info}"></i> ${message}`;
    container.appendChild(toast);
    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateX(40px)';
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

// ============================================================
// ESCAPE HTML
// ============================================================
function escHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ============================================================
// EVENT LISTENERS
// ============================================================

// Navigation history stack for 'Back' button support
const _navHistory = [];
window._currentPageForNav = window._currentPageForNav || null;

function updateBackButton() {
    const btn = $('navBackBtn');
    if (!btn) return;
    btn.style.display = _navHistory.length > 0 ? 'inline-flex' : 'none';
}

function goToPage(page) {
    try {
        // push current page to history if present and different
        if (window._currentPageForNav && window._currentPageForNav !== page) _navHistory.push(window._currentPageForNav);
        window._currentPageForNav = page;
        // call existing navigateTo if implemented, otherwise fallback
        if (typeof navigateTo === 'function') navigateTo(page);
        else if (pageEls && pageEls[page]) {
            Object.values(pageEls).forEach(p => { if (p) p.style.display = 'none'; });
            pageEls[page].style.display = 'block';
        }
    } catch (e) { console.warn('goToPage error', e); }
    updateBackButton();
}

function goBack() {
    try {
        const prev = _navHistory.pop();
        if (prev) {
            window._currentPageForNav = prev;
            if (typeof navigateTo === 'function') navigateTo(prev);
            else if (pageEls && pageEls[prev]) {
                Object.values(pageEls).forEach(p => { if (p) p.style.display = 'none'; });
                pageEls[prev].style.display = 'block';
            }
        } else {
            // fallback to dashboard
            if (typeof navigateTo === 'function') navigateTo('dashboard');
            else if (pageEls && pageEls.dashboard) {
                Object.values(pageEls).forEach(p => { if (p) p.style.display = 'none'; });
                pageEls.dashboard.style.display = 'block';
            }
        }
    } catch (e) { console.warn('goBack error', e); }
    updateBackButton();
}

// Sidebar
menuToggle.addEventListener('click', toggleSidebar);
overlay.addEventListener('click', closeSidebar);
document.querySelectorAll('.sidebar-nav a[data-page]').forEach(a => {
    a.addEventListener('click', (e) => {
        e.preventDefault();
        goToPage(a.dataset.page);
        // Ensure sidebar closes on mobile after navigation
        closeSidebar();
    });
});

// Back button wiring (topbar)
const navBackBtnEl = $('navBackBtn');
if (navBackBtnEl) {
    navBackBtnEl.addEventListener('click', (e) => { e.preventDefault(); goBack(); });
    // ensure initial visibility
    updateBackButton();
}

// Seed buttons removed: disable/hide seed buttons to prevent inserting demo data
// (the seedDocuments functionality was removed above).
const seedBtn1 = $('seedDocsBtn'); if (seedBtn1) seedBtn1.style.display = 'none';
const seedBtn2 = $('seedDocsBtn2'); if (seedBtn2) seedBtn2.style.display = 'none';

// New doc nav
$('newDocNav').addEventListener('click', (e) => {
    e.preventDefault();
    openNewModal();
});
$('dashNewDoc').addEventListener('click', openNewModal);
$('docPageNew').addEventListener('click', openNewModal);
const selectDocsBtn = $('selectDocsBtn');
if (selectDocsBtn) {
    selectDocsBtn.addEventListener('click', () => {
        selectionMode = !selectionMode;
        if (!selectionMode) clearSelection();
        selectDocsBtn.innerHTML = selectionMode
            ? '<i class="fas fa-times"></i> Done'
            : '<i class="fas fa-check-square"></i> Select';
        renderAllDocs();
    });
}

// Make stat cards clickable: clicking a stat navigates to Documents page and
// applies the corresponding status filter so the user sees documents of that topic.
function attachStatCardClicks() {
    const map = {
        statTotal: 'all',
        statInProgress: 'in-progress',
        statPending: 'pending',
        statCompleted: 'completed',
        statDecision: 'decision',
        statRejected: 'rejected'
    };
    Object.keys(map).forEach(id => {
        const el = $(id);
        if (!el) return;
        el.style.cursor = 'pointer';
        el.title = 'Click to view documents';
        el.addEventListener('click', () => {
            try {
                // Visual active state on the whole stat card
                const card = el.closest && el.closest('.stat-card');
                if (card) {
                    document.querySelectorAll('.stat-card.active').forEach(c => c.classList.remove('active'));
                    card.classList.add('active');
                }

                // Animate page transition: fade/shift out, then change view and render
                if (pageContent) pageContent.classList.add('animating');
                const delay = 220; // ms matching CSS timing
                setTimeout(() => {
                    const status = map[id];
                    if (filterStatus) {
                        filterStatus.value = status;
                        if (searchDocs) searchDocs.value = '';
                        const ev = new Event('change', { bubbles: true });
                        filterStatus.dispatchEvent(ev);
                    }
                        // navigate to documents page via sidebar link if available
                        const docNav = document.querySelector('.sidebar-nav a[data-page="documents"]');
                        if (docNav) {
                            // add a short animation class to highlight the link
                            docNav.classList.add('animate');
                            // remove animate class after animation completes
                            setTimeout(() => { docNav.classList.remove('animate'); }, 700);
                            docNav.click();
                        } else {
                            if (pageEls && pageEls.documents) {
                                Object.values(pageEls).forEach(p => { if (p) p.style.display = 'none'; });
                                pageEls.documents.style.display = 'block';
                            }
                        }
                    // render filtered docs
                    try { renderAllDocs(); } catch (err) { console.warn('renderAllDocs error', err); }

                    // Show a small breadcrumb next to the page title indicating filter
                    try {
                        const pageTitleEl = $('pageTitle');
                        if (pageTitleEl) {
                            let bc = $('transitionBreadcrumb');
                            if (!bc) {
                                bc = document.createElement('span');
                                bc.id = 'transitionBreadcrumb';
                                pageTitleEl.parentNode.insertBefore(bc, pageTitleEl.nextSibling);
                            }
                            const labelMap = { all: 'All', 'in-progress': 'In Progress', 'on-hold': 'On Hold', rejected: 'Rejected', completed: 'Completed', decision: 'Final Decision' };
                            const label = labelMap[status] || status || 'All';
                            bc.textContent = `Documents · ${label}`;
                            bc.classList.add('show');
                            setTimeout(() => { bc.classList.remove('show'); }, 2400);
                        }
                    } catch (e) { /* ignore breadcrumb errors */ }

                    // Fade back in
                    if (pageContent) {
                        pageContent.classList.remove('animating');
                        pageContent.classList.add('anim-in');
                        setTimeout(() => { pageContent.classList.remove('anim-in'); }, 360);
                    }

                    // Smooth scroll to documents table after a short delay so rendering finishes
                    try {
                        setTimeout(() => {
                            const wrapper = $('docTableWrapper');
                            if (wrapper) wrapper.scrollIntoView({ behavior: 'smooth', block: 'start' });
                        }, 300);
                    } catch (e) { /* ignore scroll errors */ }
                }, delay);
            } catch (e) {
                console.error('Stat card click handler error', e);
            }
        });
    });
}
// Attach when DOM is ready (script is loaded at end of body, so run immediately)
try { attachStatCardClicks(); } catch (e) { console.warn('attachStatCardClicks failed', e); }

// Modal close
closeDocModal.addEventListener('click', closeModal);
cancelDocModal.addEventListener('click', closeModal);
docModal.addEventListener('click', (e) => { if (e.target === docModal) closeModal(); });

closeViewModal.addEventListener('click', closeViewModalFn);
closeViewModalBtn.addEventListener('click', closeViewModalFn);
viewModal.addEventListener('click', (e) => { if (e.target === viewModal) closeViewModalFn(); });

// Edit from view
editFromView.addEventListener('click', () => {
    const id = viewModal.dataset.docId;
    if (id) {
        closeViewModalFn();
        setTimeout(() => openEditModal(id), 200);
    }
});

// ── New doc form toolbar ──────────────────────────────────────
if ($('newDocFormBtn')) {
    $('newDocFormBtn').addEventListener('click', () => {
        openNewModal();
    });
}

if ($('searchRefBtn')) {
    $('searchRefBtn').addEventListener('click', async () => {
        const ref = ($('searchRefInput') ? $('searchRefInput').value : '').trim();
        if (!ref) { toast('Enter a Reference Number to search.', 'error'); return; }

        // Search local cache first
        const local = documents.find(d => (d.ref || '').trim() === ref);
        if (local) {
            openEditModal(local.id);
            return;
        }

        // Fall back to GAS
        toast('Searching Google Sheets…', 'info');
        const record = await loadWorkflowFromGAS(ref);
        if (!record) { toast('No record found for that Reference Number.', 'error'); return; }

        // Populate form directly from GAS record
        if ($('docNo'))          $('docNo').value          = record.no || '';
        if (docTitle)            docTitle.value            = record.documentTitle || '';
        if (docRef)              docRef.value              = record.referenceNumber || '';
        if (docOrigin)           docOrigin.value           = record.originSource || '';
        if (docEntryDate)        docEntryDate.value        = record.dateOfEntry || '';
        if (docInCharge)         docInCharge.value         = record.inChargeOf || '';
        if (docDescription)      docDescription.value      = record.descriptionSummary || '';
        if ($('docWorkProcess')) { $('docWorkProcess').value = record.workProcess || ''; toggleLeaderNameField(record.workProcess); }
        if ($('docLeaderName'))  $('docLeaderName').value  = record.leaderName || '';
        if (docStatus) {
            docStatus.value = (record.workflowData && record.workflowData.overallStatus) || computeOverallStatus(record) || 'pending';
        }
        renderWorkflowStepsForm({ workProcess: record.workProcess, workflowData: record.workflowData });
        updateUploadedFileLinks(record);
        $('docModalTitle').innerHTML = '<i class="fas fa-edit"></i> Edit Document';
        editingId = null; // treat as new local record until saved
        docModal.classList.add('open');
        toast('Record loaded from Google Sheets.', 'success');
    });
}

// Migrate old WorkflowData format to new columns
if ($('migrateDataBtn')) {
    $('migrateDataBtn').addEventListener('click', async () => {
        if (!confirm('This will convert all existing workflow records to the new column format.\n\nContinue?')) return;
        toast('Migrating workflow data…', 'info');
        try {
            const result = await gasPost({ action: 'migrateWorkflowData' });
            if (result.success) {
                toast('Migration complete! All workflow data has been converted.', 'success');
            } else {
                toast('Migration error: ' + (result.error || 'Unknown'), 'error');
            }
        } catch (err) {
            toast('Migration failed: ' + err.toString(), 'error');
        }
    });
}

// ── Work Process selector ─────────────────────────────────────
function toggleLeaderNameField(process) {
    const group = $('leaderNameGroup');
    const label = $('leaderNameLabel');
    if (!group) return;
    if (process === 'To_Specific_Leader') {
        group.style.display = 'block';
        if (label) label.textContent = 'Leader Name';
    } else if (process === 'To_Minister') {
        group.style.display = 'block';
        if (label) label.textContent = 'Minister / Leader Name';
    } else {
        group.style.display = 'none';
    }
}

if ($('docWorkProcess')) {
    $('docWorkProcess').addEventListener('change', function () {
        toggleLeaderNameField(this.value);
        renderWorkflowStepsForm(null);
    });
}

// Save
saveDocBtn.addEventListener('click', saveDocumentFromForm);


// Enter key in form
docForm.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        saveDocumentFromForm();
    }
});

// Filters
filterStatus.addEventListener('change', renderAllDocs);
filterOrigin.addEventListener('change', renderAllDocs);
searchDocs.addEventListener('input', renderAllDocs);
clearFilters.addEventListener('click', () => {
    filterStatus.value = 'all';
    filterOrigin.value = 'all';
    searchDocs.value = '';
    renderAllDocs();
});

// Auth events
authLoginTab.addEventListener('click', () => showAuthOverlay('login'));
authRegisterTab.addEventListener('click', () => showAuthOverlay('register'));
loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = loginEmail.value.trim();
    const password = loginPassword.value;
    const result = await loginUser(email, password);
    if (!result.success) {
        return toast(result.error || 'Login failed.', 'error');
    }
    hideAuthOverlay();
    setAuthState();
    documents = await loadDocs();
    renderAllDocs();
    goToPage('dashboard');
});
registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = registerName.value.trim();
    const email = registerEmail.value.trim();
    const password = registerPassword.value;
    const result = await registerUser(name, email, password);
    if (!result.success) {
        return toast(result.error || 'Registration failed.', 'error');
    }
    toast('Account created successfully. Please log in.', 'success');
    showAuthOverlay('login');
});
// wire new user menu logout (if present)
const menuAccountSettings = $('menuAccountSettings');
const userAvatarEl = $('userAvatar');
const userMenuEl = $('userMenu');

if (menuLogout) menuLogout.addEventListener('click', (e) => { e.preventDefault(); logout(); });

// Sync to Spreadsheet button (manual)
if (syncDocsBtn) syncDocsBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!currentUser || !currentUser.token) {
        toast('Please sign in as an admin to sync documents to the spreadsheet.', 'error');
        showAuthOverlay('login');
        return;
    }
    // optionally show loading
    toast('Syncing documents to spreadsheet...', 'info');
        try {
                // Ensure every doc has an ID and sequential No before performing a full sync
                renumberAllDocsSequentially();
                // Use saveDocsToBackend which will perform primary save and then export the specified subset (here: all documents)
                const res = await saveDocsToBackend(documents, { exportSubset: documents });
            if (res && res.success) {
                toast('Documents synced to spreadsheet successfully.', 'success');
            } else {
            // If backend responded with Unknown action (old deployment), fall back to local handler
                if (res && res.error && typeof res.error === 'string' && res.error.includes('Unknown action')) {
                    const localRes = handleLocalSaveDocsSimple({ email: currentUser.email, docs: documents });
                    if (localRes && localRes.success) {
                        toast('Documents synced locally (backend does not support saveDocsSimple).', 'success');
                    } else {
                        toast('Sync failed: ' + (localRes && localRes.error ? localRes.error : 'Unknown error'), 'error');
                    }
                } else {
                    toast('Sync failed: ' + (res && res.error ? res.error : 'Unknown error'), 'error');
                }
        }
    } catch (err) {
        console.error('Sync error', err);
        toast('Sync failed: ' + (err && err.message ? err.message : err), 'error');
    }
});

// Toggle menu on avatar click
if (userAvatarEl && userMenuEl) {
    userAvatarEl.addEventListener('click', (e) => {
        e.stopPropagation();
        userMenuEl.classList.toggle('show');
        userMenuEl.setAttribute('aria-hidden', userMenuEl.classList.contains('show') ? 'false' : 'true');
    });

    // Close when clicking outside
    document.addEventListener('click', (ev) => {
        if (!userMenuEl) return;
        if (!userMenuEl.contains(ev.target) && ev.target !== userAvatarEl) {
            userMenuEl.classList.remove('show');
            userMenuEl.setAttribute('aria-hidden', 'true');
        }
    });
}

// Open account settings page
if (menuAccountSettings) {
    menuAccountSettings.addEventListener('click', () => {
        if (userMenuEl) { userMenuEl.classList.remove('show'); userMenuEl.setAttribute('aria-hidden', 'true'); }
        goToPage('account');
    });
}

const accountBackBtn = $('accountBackBtn');
const accountForm = $('accountForm');
const profilePhotoInput = $('profilePhotoInput');
const profilePhotoPreview = $('profilePhotoPreview');

if (accountBackBtn) {
    accountBackBtn.addEventListener('click', () => goToPage('dashboard'));
}
if (accountForm) {
    accountForm.addEventListener('submit', saveAccountInfo);
}
if (profilePhotoInput && profilePhotoPreview) {
    profilePhotoInput.addEventListener('change', async (event) => {
        const file = event.target.files && event.target.files[0];
        if (!file) return;
        if (!file.type || !file.type.startsWith('image/')) {
            toast('Please choose a valid image file.', 'error');
            profilePhotoInput.value = '';
            return;
        }
        // open crop modal for the selected image file
        openCropModalWithFile(file);
    });
}
// make profile preview clickable to open file dialog for convenience
if (profilePhotoPreview && profilePhotoInput) {
    profilePhotoPreview.style.cursor = 'pointer';
    profilePhotoPreview.addEventListener('click', () => profilePhotoInput.click());
}

// Custom file chooser buttons
if (docPdfButton && docPdfInput) {
    docPdfButton.addEventListener('click', () => docPdfInput.click());
}
if (docImgButton && docImgInput) {
    docImgButton.addEventListener('click', () => docImgInput.click());
}

// Wire PDF input
if (docPdfInput && docPdfName) {
    docPdfInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) {
            currentDocPdfFile = null;
            docPdfName.textContent = 'No file chosen';
            return;
        }
        // only accept PDFs
        if (file.type !== 'application/pdf') {
            toast('Please select a PDF file.', 'error');
            docPdfInput.value = '';
            currentDocPdfFile = null;
            docPdfName.textContent = 'No file chosen';
            return;
        }
        currentDocPdfFile = file;
        docPdfName.textContent = `${file.name} (${Math.round(file.size/1024)} KB)`;
        currentDocPdfRemove = false;
        if (docPdfRemove) docPdfRemove.style.display = 'inline-block';
    });
}

if (docImgInput && docImgName) {
    docImgInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) {
            currentDocImgFile = null;
            docImgName.textContent = 'No file chosen';
            return;
        }

        const validTypes = ['image/png', 'image/jpeg', 'image/jpg'];
        if (validTypes.indexOf(file.type) === -1) {
            toast('Please select a PNG, JPG, or JPEG image.', 'error');
            docImgInput.value = '';
            currentDocImgFile = null;
            docImgName.textContent = 'No file chosen';
            return;
        }

        currentDocImgFile = file;
        docImgName.textContent = `${file.name} (${Math.round(file.size/1024)} KB)`;
    });
}

// ----------------------------
// CROPPER - client side circular crop for avatars
// ----------------------------
const cropModal = $('cropModal');
const cropCanvas = $('cropCanvas');
const cropZoom = $('cropZoom');
const cropPreview = $('cropPreview');
const closeCropModalBtn = $('closeCropModal');
const cancelCropBtn = $('cancelCropBtn');
const saveCropBtn = $('saveCropBtn');

let _cropImg = null;
let _cropScale = 1;
let _cropX = 0;
let _cropY = 0;
let _isDragging = false;
let _lastPointer = {x:0,y:0};

function openCropModalWithFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        const img = new Image();
        img.onerror = () => {
            toast('This image format could not be opened. Please choose a PNG or JPEG image.', 'error');
        };
        img.onload = () => {
            _cropImg = img;
            // initial scale so image covers canvas
            const cw = cropCanvas.width;
            const ch = cropCanvas.height;
            const scale = Math.max(cw / img.width, ch / img.height);
            _cropScale = Math.max(scale, 0.5);
            // center image
            _cropX = (cw - img.width * _cropScale) / 2;
            _cropY = (ch - img.height * _cropScale) / 2;
            cropZoom.value = _cropScale;
            drawCropCanvas();
            updateCropPreview();
            cropModal.style.display = 'block';
        };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
}

function closeCropModal() {
    cropModal.style.display = 'none';
    // reset internal state lightly
    _isDragging = false;
}

function drawCropCanvas() {
    if (!cropCanvas) return;
    const ctx = cropCanvas.getContext('2d');
    ctx.clearRect(0,0,cropCanvas.width,cropCanvas.height);
    if (!_cropImg) {
        ctx.fillStyle = '#f6f8fa';
        ctx.fillRect(0,0,cropCanvas.width,cropCanvas.height);
        return;
    }
    ctx.save();
    // draw image
    ctx.drawImage(_cropImg, _cropX, _cropY, _cropImg.width * _cropScale, _cropImg.height * _cropScale);
    ctx.restore();
    // draw dim overlay except circular area to indicate crop (optional)
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.beginPath();
    ctx.rect(0,0,cropCanvas.width,cropCanvas.height);
    // circle hole
    ctx.moveTo(cropCanvas.width/2 + cropCanvas.width/2, cropCanvas.height/2);
    ctx.arc(cropCanvas.width/2, cropCanvas.height/2, Math.min(cropCanvas.width,cropCanvas.height)/2 - 4, 0, Math.PI*2, true);
    ctx.closePath();
    ctx.fill('evenodd');
    ctx.restore();
}

function updateCropPreview() {
    if (!cropPreview) return;
    const size = 120;
    const tmp = document.createElement('canvas');
    tmp.width = size;
    tmp.height = size;
    const tctx = tmp.getContext('2d');
    tctx.clearRect(0,0,size,size);
    if (_cropImg) {
        tctx.save();
        tctx.beginPath();
        tctx.arc(size/2, size/2, size/2, 0, Math.PI*2);
        tctx.closePath();
        tctx.clip();
        const scaleFactor = size / cropCanvas.width;
        tctx.drawImage(_cropImg, _cropX * scaleFactor, _cropY * scaleFactor, _cropImg.width * _cropScale * scaleFactor, _cropImg.height * _cropScale * scaleFactor);
        tctx.restore();
    } else {
        tctx.fillStyle = '#eee';
        tctx.fillRect(0,0,size,size);
    }
    cropPreview.style.backgroundImage = `url(${tmp.toDataURL('image/png')})`;
}

// pointer events for dragging
if (cropCanvas) {
    cropCanvas.addEventListener('pointerdown', (e) => {
        cropCanvas.setPointerCapture(e.pointerId);
        _isDragging = true;
        _lastPointer = {x: e.clientX, y: e.clientY};
    });
    cropCanvas.addEventListener('pointermove', (e) => {
        if (!_isDragging || !_cropImg) return;
        const dx = e.clientX - _lastPointer.x;
        const dy = e.clientY - _lastPointer.y;
        _lastPointer = {x: e.clientX, y: e.clientY};
        _cropX += dx;
        _cropY += dy;
        drawCropCanvas();
        updateCropPreview();
    });
    cropCanvas.addEventListener('pointerup', (e) => {
        _isDragging = false;
        try { cropCanvas.releasePointerCapture(e.pointerId); } catch (err) {}
    });
    cropCanvas.addEventListener('pointercancel', () => { _isDragging = false; });
}

if (cropZoom) {
    cropZoom.addEventListener('input', (e) => {
        if (!_cropImg) return;
        const newScale = parseFloat(e.target.value);
        const oldScale = _cropScale;
        // keep the image point at canvas center stable during zoom
        const cx = cropCanvas.width / 2;
        const cy = cropCanvas.height / 2;
        const imgPointX = (cx - _cropX) / oldScale;
        const imgPointY = (cy - _cropY) / oldScale;
        _cropScale = newScale;
        _cropX = cx - imgPointX * _cropScale;
        _cropY = cy - imgPointY * _cropScale;
        drawCropCanvas();
        updateCropPreview();
    });
}

if (closeCropModalBtn) closeCropModalBtn.addEventListener('click', () => closeCropModal());
if (cancelCropBtn) cancelCropBtn.addEventListener('click', (e) => { e.preventDefault(); closeCropModal(); });

if (saveCropBtn) saveCropBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    if (!_cropImg) return;
    const outSize = 256;
    const out = document.createElement('canvas');
    out.width = outSize; out.height = outSize;
    const octx = out.getContext('2d');
    octx.clearRect(0,0,outSize,outSize);
    // circular clip
    octx.save();
    octx.beginPath();
    octx.arc(outSize/2, outSize/2, outSize/2, 0, Math.PI*2);
    octx.closePath();
    octx.clip();
    const scaleFactor = outSize / cropCanvas.width;
    octx.drawImage(_cropImg, _cropX * scaleFactor, _cropY * scaleFactor, _cropImg.width * _cropScale * scaleFactor, _cropImg.height * _cropScale * scaleFactor);
    octx.restore();
    // export compressed jpeg to save space
    const dataUrl = out.toDataURL('image/jpeg', 0.85);
    profilePhotoData = dataUrl;
    if (profilePhotoPreview) {
        profilePhotoPreview.style.backgroundImage = `url('${profilePhotoData}')`;
        profilePhotoPreview.textContent = '';
    }
    // update avatars in UI
    try { setAvatarElement($('userAvatar'), profilePhotoData, null); } catch (err) {}
    try { setAvatarElement($('menuAvatar'), profilePhotoData, null); } catch (err) {}
    // Allow the same image to be selected again after a retry or replacement.
    if (profilePhotoInput) profilePhotoInput.value = '';
    closeCropModal();
});

// Wire Remove attachment button
if (docPdfRemove) {
    docPdfRemove.addEventListener('click', (e) => {
        e.preventDefault();
        // mark for removal; clear current file selection
        currentDocPdfFile = null;
        currentDocPdfRemove = true;
        if (docPdfInput) docPdfInput.value = '';
        if (docPdfName) docPdfName.textContent = 'No file chosen';
        // hide the remove button until next time
        docPdfRemove.style.display = 'none';
        toast('Attachment will be removed when you save the document.', 'info');
    });
}

// ============================================================
// INIT
// ============================================================
async function refreshDocumentsFromBackend() {
    if (!currentUser) return;
    try {
        const latestDocs = await loadDocs();
        if (Array.isArray(latestDocs)) {
            documents = latestDocs;
            renderAllDocs();
        }
    } catch (e) {
        console.warn('refreshDocumentsFromBackend failed:', e);
    }
}

async function init() {
    // Set date
    currentDateEl.textContent = new Date().toLocaleDateString('en-US', {
        weekday: 'short',
        year: 'numeric',
        month: 'short',
        day: 'numeric'
    });

    // Set default entry date
    docEntryDate.value = todayStr();

    // Create demo admin account if it doesn't exist
    const users = getAllUsers();
    const demoExists = users.some(u => u.email === 'admin@mpwt.gov.kh');
    const icdExists = users.some(u => u.email === 'icd.mpwt@gmail.com');
    
    if (!demoExists) {
        users.push({
            name: 'Admin',
            email: 'admin@mpwt.gov.kh',
            passwordHash: hashPassword('admin123'),
            role: 'admin',
            status: 'active',
            token: 'admin_token_demo',
            createdAt: new Date().toISOString(),
            approvedAt: new Date().toISOString()
        });
    }
    
    if (!icdExists) {
        const uuid = (typeof Utilities !== 'undefined' && Utilities.getUuid) ? Utilities.getUuid() : Math.random().toString(36).substr(2, 9);
        users.push({
            name: 'ICD MPWT',
            email: 'icd.mpwt@gmail.com',
            passwordHash: hashPassword('password123'),
            role: 'admin',
            status: 'active',
            token: uuid,
            createdAt: new Date().toISOString(),
            approvedAt: new Date().toISOString()
        });
        // Note: running toast here may be noisy; keep it but it's fine in the app
        try { toast('Admin account created: icd.mpwt@gmail.com (set your own password)', 'success'); } catch (e) { /* ignore */ }
    }
    
    saveAllUsers(users);

    // Authenticate and load data
    const sessionValid = await verifySession();
    setAuthState();
    if (!sessionValid) {
        window.location.href = 'signin.html';
        return;
    }

    hideAuthOverlay();
    try { const mainApp = $('mainApp'); if (mainApp) mainApp.style.display = 'block'; } catch (e) {}
    documents = await loadDocs();

    renderAllDocs();
    goToPage('dashboard');

    // If no documents, show a welcome toast
    if (documents.length === 0) {
        // Welcome message removed
    }
}

async function startApp() {
    await init();
}

startApp();

// ============================================================
// KEYBOARD SHORTCUTS
// ============================================================
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (docModal.classList.contains('open')) closeModal();
        if (viewModal.classList.contains('open')) closeViewModalFn();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        openNewModal();
    }
});

console.log('📄 DocuFlow MPWT — Document Management System loaded with seed feature.');
console.log(`📊 ${documents.length} documents in store.`);
