import {getSitchText} from './sitchSource';
const DATABASE = 'SitrecChannelHandoff';
const POINTER = 'sitrec.channelHandoff';

async function transaction(mode, action) {
    const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(DATABASE, 1);
        request.onupgradeneeded = () => request.result.createObjectStore('handoffs');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        return await new Promise((resolve, reject) => {
            const tx = database.transaction('handoffs', mode);
            const request = action(tx.objectStore('handoffs'));
            tx.oncomplete = () => resolve(request.result);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Local handoff cancelled'));
        });
    } finally { database.close(); }
}

export async function saveChannelHandoff(sitch, context = {}) {
    const token = crypto.randomUUID();
    // This is local browser storage, never a URL or a server upload. Structured
    // cloning fails safely if a non-serializable legacy sitch is handed to us.
    const text = getSitchText(sitch);
    const value = {sitch: text ? null : sitch, text, context, createdAt: Date.now()};
    await transaction('readwrite', store => store.put(value, token));
    try { sessionStorage.setItem(POINTER, token); }
    catch (error) {
        await transaction('readwrite', store => store.delete(token));
        throw error;
    }
}

export async function takeChannelHandoff() {
    let token;
    try { token = sessionStorage.getItem(POINTER); } catch { return null; }
    if (!token) return null;
    const value = await transaction('readonly', store => store.get(token));
    await transaction('readwrite', store => store.delete(token));
    sessionStorage.removeItem(POINTER);
    if (!value || Date.now() - value.createdAt > 10 * 60 * 1000) return null;
    return value;
}
