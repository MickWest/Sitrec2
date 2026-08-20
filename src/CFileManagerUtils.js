/**
 * Shared module-level helpers for CFileManager, its parse/save extensions, and consumers.
 *
 * Keeps IndexedDB access, error-classification and browser-capability probes in one place
 * so that CFileManager can be split across multiple files without duplicating logic.
 */

import {showErrorOnce} from "./showError";

// ── IndexedDB helpers for persisting working folder handle ──────────────

export function openSitrecIDB() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('SitrecStorage', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('handles')) {
                db.createObjectStore('handles');
            }
        };
    });
}

export async function saveToIDB(key, value) {
    const db = await openSitrecIDB();
    const tx = db.transaction(['handles'], 'readwrite');
    const store = tx.objectStore('handles');
    await new Promise((resolve, reject) => {
        const req = store.put(value, key);
        req.onsuccess = resolve;
        req.onerror = reject;
    });
    db.close();
}

export async function loadFromIDB(key) {
    const db = await openSitrecIDB();
    const tx = db.transaction(['handles'], 'readonly');
    const store = tx.objectStore('handles');
    const value = await new Promise((resolve, reject) => {
        const req = store.get(key);
        req.onsuccess = () => resolve(req.result);
        req.onerror = reject;
    });
    db.close();
    return value;
}

export function isAbortLikeError(error) {
    if (!error) return false;
    if (error.name === "AbortError") return true;
    if (typeof error === "string" && error.includes("Cancelled")) return true;
    return false;
}

export function sanitizeSitchName(rawName) {
    if (typeof rawName !== "string") {
        return "";
    }

    let validSitchName = rawName.replace(/[\/\\<>\x00-\x1f]+/g, "_");
    validSitchName = validSitchName.trim();
    validSitchName = validSitchName.replace(/^[\.\s]+|[\.\s]+$/g, "");
    return validSitchName;
}

export function supportsDirectoryPicker() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export function supportsOpenFilePicker() {
    return typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";
}

export function showLocalFolderAccessUnsupportedMessage() {
    const message = "Local folder access is not supported in this browser.\n\nPlease use Chrome or Microsoft Edge for Local Folder save/load features.";
    showErrorOnce("local-folder-access-unsupported", message);
    console.warn(message);
}

/**
 * Walk a directory handle, collecting the files an `accept(name)` predicate keeps.
 *
 * The CHOSEN folder is always read; `recursive` governs its SUBFOLDERS only, which
 * is the rule the folder-analysis dialogs already use — "recursive" is a statement
 * about how deep to go, not about whether to read the folder the user picked.
 *
 * Each entry carries the leaf directory handle it was found in, so a caller that
 * writes anything back can put it beside the files it came from.
 *
 * @param {FileSystemDirectoryHandle} directoryHandle
 * @param {object} options
 * @param {(name: string) => boolean} [options.accept] - keep the file when true; keep all when omitted
 * @param {boolean} [options.recursive]
 * @param {string} [options.basePath] - internal, the path accumulated so far
 * @param {(entry: object) => void} [options.onFound] - progress callback, fired per kept file
 * @returns {Promise<Array<{name, relativePath, getFile, dirHandle, dirPath}>>} unsorted
 */
export async function walkDirectoryForFiles(directoryHandle,
                                            {accept = null, recursive = false, basePath = "", onFound = null} = {}) {
    const files = [];
    for await (const [name, handle] of directoryHandle.entries()) {
        const relativePath = basePath ? `${basePath}/${name}` : name;
        if (handle.kind === "file") {
            if (!accept || accept(name)) {
                const entry = {
                    name, relativePath,
                    getFile: () => handle.getFile(),
                    dirHandle: directoryHandle, dirPath: basePath,
                };
                files.push(entry);
                onFound?.(entry);
            }
        } else if (recursive && handle.kind === "directory") {
            files.push(...await walkDirectoryForFiles(handle,
                {accept, recursive, basePath: relativePath, onFound}));
        }
    }
    return files;
}
