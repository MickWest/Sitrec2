/**
 * Save, local-folder persistence, working-folder IO and rehost methods for CFileManager.
 *
 * Installed on CFileManager.prototype via Object.assign (see CFileManager.js).
 * Covers server sitch saves, Save As, Save Local (File System Access + desktop bridge),
 * overwrite-confirmation dialogs, working-folder reconnect, and the rehost flow that
 * uploads dynamic assets for either S3 or the local working folder.
 */

import {areArrayBuffersEqual, disableAllInput, enableAllInput, getDateTimeFilename, getFileExtension, isHttpOrHttps, updateDocumentTitle} from "./utils";
import {CustomManager, Globals, NodeMan, Sit, withTestUser} from "./Globals";
import {SITREC_SERVER} from "./configUtils";
import {par} from "./par";
import {assert} from "./assert";
import {addOptionToGUIMenu} from "./lil-gui-extras";
import {getEnvBool} from "./envUtils";
import {isResolvableSitrecReference} from "./SitrecObjectResolver";
import {createDesktopDirectoryHandle, getDesktopFileSystemBridge} from "./DesktopFileSystem";
import {t} from "./i18n";
import {
    isAbortLikeError,
    loadFromIDB,
    saveToIDB,
    showLocalFolderAccessUnsupportedMessage,
    supportsDirectoryPicker,
} from "./CFileManagerUtils";

export const saveMethods = {

    /**
     * Fetch user save names from the server for overwrite checks.
     * Falls back to currently known names if fetch fails.
     * @returns {Promise<string[]>}
     */
    async getServerSaveNamesForOverwriteCheck() {
        const knownNames = Array.isArray(this.userSaves)
            ? this.userSaves.filter(name => name && name !== "-")
            : [];
        if (knownNames.length > 0) {
            return knownNames;
        }

        try {
            const response = await fetch(withTestUser(SITREC_SERVER + "getsitches.php?get=myfiles"), {mode: "cors"});
            if (response.status !== 200) {
                throw new Error(`Server returned status ${response.status}`);
            }
            const data = JSON.parse(await response.text());
            const names = data.map(file => String(file[0]));
            this.userSaves = ["-", ...names];
            return names;
        } catch (error) {
            console.warn("Could not fetch server save names for overwrite check:", error);
            return knownNames;
        }
    },

    /**
     * Returns true if `<sitchName>.json` already exists in the target local folder.
     * @param {FileSystemDirectoryHandle} directoryHandle
     * @param {string} sitchName
     * @returns {Promise<boolean>}
     */
    async localSitchFileExists(directoryHandle, sitchName) {
        const fileName = `${sitchName}.json`;
        try {
            await directoryHandle.getFileHandle(fileName, {create: false});
            return true;
        } catch (error) {
            if (error?.name === "NotFoundError") {
                return false;
            }
            throw error;
        }
    },

    /**
     * Ask for explicit user confirmation before a named save would overwrite
     * an existing local file or an existing server sitch name.
     * @param {Object} options
     * @param {string} options.sitchName
     * @param {boolean} [options.local=false]
     * @param {FileSystemDirectoryHandle|null} [options.directoryHandle=null]
     * @param {FileSystemFileHandle|null} [options.fileHandle=null]
     * @returns {Promise<boolean>} True if save should proceed.
     */
    async confirmOverwriteForNamedSave({sitchName, local = false, directoryHandle = null, fileHandle = null} = {}) {
        if (!sitchName) return true;

        if (local) {
            // If saving to an explicit file handle, the user has already selected that target.
            if (fileHandle) return true;
            if (!directoryHandle) return true;

            let exists = false;
            try {
                exists = await this.localSitchFileExists(directoryHandle, sitchName);
            } catch (error) {
                console.warn("Local overwrite check failed, continuing save:", error);
                return true;
            }

            if (!exists) return true;

            const fileName = `${sitchName}.json`;
            const folderName = directoryHandle.name || "selected folder";
            return confirm(
                `"${fileName}" already exists in "${folderName}".\n\n` +
                "This save will overwrite the existing file.\n\n" +
                "Continue?"
            );
        }

        const names = await this.getServerSaveNamesForOverwriteCheck();
        if (!names.includes(sitchName)) return true;

        return confirm(
            `A server sitch named "${sitchName}" already exists.\n\n` +
            "Saving with this name will create a new version and replace what opens as the latest version.\n\n" +
            "Continue?"
        );
    },

    /**
     * GUI menu handler for the "Save" button.
     * Wraps saveSitch() and suppresses errors for GUI use.
     * @returns {Promise<boolean>}
     */
    saveSitchFromMenu() {
        this.activateStorageFolder("server");
        return this.saveSitch().then(() => {
            this.lastSaveAction = "server";
            console.log("Sitch saved as " + Sit.sitchName);
            return true;
        }).catch((error) => {
            console.log("Error in saveSitchFromMenu:", error);
            return false;
        })
    },

    /**
     * Save action invoked by Cmd/Ctrl+S.
     * Repeats the last successful save intent when possible.
     * Falls back to local Save As if server saving is unavailable.
     * @returns {Promise<boolean>}
     */
    async handleSaveShortcut() {
        const canServerSave = this.hasServerBackedSaves();
        const canLocalSave = getEnvBool("SAVE_TO_LOCAL", process.env.SAVE_TO_LOCAL);

        if (this.lastSaveAction === "local" && canLocalSave) {
            return this.saveLocal({recordAction: true});
        }

        if (this.lastSaveAction === "localAs" && canLocalSave) {
            return this.saveLocalAs({recordAction: true});
        }

        if (this.lastSaveAction === "server" && canServerSave) {
            return this.saveSitchFromMenu();
        }

        if (canServerSave) {
            return this.saveSitchFromMenu();
        }

        if (canLocalSave) {
            return this.saveLocal({recordAction: true});
        }

        console.warn("No save target available for keyboard shortcut.");
        return false;
    },

    /**
     * Saves the current sitch. Prompts for a name if one isn't set.
     * Updates GUI dropdowns with the new save entry.
     * @param {boolean} [local=false] - If true, saves locally instead of to server
     * @param {FileSystemDirectoryHandle|null} [directoryHandle=null] - Target working folder for local saves
     * @param {FileSystemFileHandle|null} [fileHandle=null] - Target file for local saves
     * @returns {Promise<void>} Resolves when save completes
     */
    saveSitch(local = false, directoryHandle = null, fileHandle = null) {
        // Once the user saves, versions should reflect their own user, not the source
        if (!local) {
            this.sourceUserID = null;
        }
        if (Sit.sitchName === undefined) {
            const previousSitchName = Sit.sitchName;
            return this.inputSitchName().then(async () => {
                const sitchName = Sit.sitchName;
                const confirmed = await this.confirmOverwriteForNamedSave({
                    sitchName,
                    local,
                    directoryHandle,
                    fileHandle
                });
                if (!confirmed) {
                    Sit.sitchName = previousSitchName;
                    throw "Save Cancelled";
                }
                return this.saveSitchNamed(sitchName, local, directoryHandle, fileHandle);  // return the Promise here
            }).then(() => {
                if (!local) {
                    if (this.guiLoad) addOptionToGUIMenu(this.guiLoad, Sit.sitchName);
                    if (this.guiLoadAlphabetical) addOptionToGUIMenu(this.guiLoadAlphabetical, Sit.sitchName);
                    if (this.guiDelete) addOptionToGUIMenu(this.guiDelete, Sit.sitchName);
                    return this.refreshVersions();
                }
            }).catch((error) => {
                console.log("Save cancelled or failed during naming flow:", error);
                // propogate the error
                throw error;
            });
        } else {
            return this.saveSitchNamed(Sit.sitchName, local, directoryHandle, fileHandle).then(() => {
                console.log("Sitch saved as " + Sit.sitchName);
                if (!local) {
                    return this.refreshVersions();
                }
            }).catch((error) => {
                console.log("Error in saveSitchNamed:", error);
                throw error;
            })
        }
    },

    refreshVersions() {
        // During early startup, Sit may not be initialized yet.
        if (!Sit?.sitchName) return Promise.resolve();
        return this.getVersions(Sit.sitchName).then((versions) => {
            this.updateVersionsDropdown(versions);
        }).catch((error) => {
            console.warn("Failed to refresh versions:", error);
        });
    },

    /**
     * Saves the sitch and generates a shareable permalink.
     * Displays the permalink in a modal dialog for copying.
     * @returns {Promise<void>}
     */
    saveWithPermalink() {
        return this.saveSitch()
            .then(() => {
            // Wait until the custom link is fully set before calling getPermalink
            return CustomManager.getPermalink();
        }).catch((error) => {
            console.log("Error in saving with permalink:", error);
        });
    },

    /**
     * Saves the sitch with a new name. Clears the current name to force a rename prompt.
     * Restores the original name if cancelled.
     * @returns {Promise<void>}
     */
    saveSitchAs() {
        this.activateStorageFolder("server");
        const lastSitchName = Sit.sitchName;
        Sit.sitchName = undefined;
        return this.saveSitch()
            .then(() => {
                this.lastSaveAction = "server";
                console.log("Sitch saved under a new name.");
            })
            .catch((error) => {
                Sit.sitchName = lastSitchName; // Restore the last sitch name if we cancel
                console.log("Error or Cancel in saveSitchAs:", error);
            }).finally(() => {
                this.guiFolder.close();
            });
    },

    /**
     * Saves the sitch with a specific name. Serializes and uploads to server or creates local download.
     * @param {string} sitchName - The name to save the sitch under
     * @param {boolean} [local=false] - If true, creates a local downloadable file instead of server upload
     * @param {FileSystemDirectoryHandle|null} [directoryHandle=null] - Target working folder for local saves
     * @param {FileSystemFileHandle|null} [fileHandle=null] - Target file for local saves
     * @returns {Promise<void>} Resolves when save is complete
     */
    saveSitchNamed(sitchName, local = false, directoryHandle = null, fileHandle = null) {

        // and then save the sitch to the server where it will be versioned by data in a folder named for this sitch, for this user
        console.log("Saving sitch as " + sitchName)

        const todayDateTimeFilename = getDateTimeFilename();
        console.log("Unique date time string: " + todayDateTimeFilename)

        const oldPaused = par.paused;
        par.paused = true;
        const savingIndicatorStartMs = Date.now();
        disableAllInput("SAVING");

        // Capture the screenshot before serialization starts (viewport is still rendered)
        const screenshotPromise = (!local && getEnvBool("SAVE_TO_S3", process.env.SAVE_TO_S3))
            ? this.captureViewportScreenshot()
            : Promise.resolve(null);

        let saveSucceeded = false;
        return CustomManager.serialize(sitchName, todayDateTimeFilename, local, directoryHandle, fileHandle)
            .then(async (serializeResult) => {
                if (local) {
                    if (directoryHandle) {
                        this.directoryHandle = directoryHandle;
                    }
                    if (serializeResult?.fileHandle) {
                        this.localSitchEntry = serializeResult.fileHandle;
                    } else if (directoryHandle) {
                        try {
                            this.localSitchEntry = await directoryHandle.getFileHandle(sitchName + ".json");
                        } catch (error) {
                            console.warn("Could not refresh local sitch file handle after save:", error);
                        }
                    }
                    if (directoryHandle) {
                        try {
                            await this.persistWorkingFolder();
                        } catch (persistError) {
                            console.warn("Saved locally, but failed to persist working folder info:", persistError);
                        }
                    }
                    this.localSaveTargetArmed = true;
                }
                saveSucceeded = true;
                Globals.sitchDirty = false;
                updateDocumentTitle();
                // After sitch is saved, upload the screenshot to the same folder
                if (!local) {
                    return screenshotPromise.then(blob => {
                        if (blob) {
                            return blob.arrayBuffer().then(buffer => {
                                return this.rehoster.rehostFile(sitchName, buffer, "screenshot.jpg", {skipHash: true});
                            }).then(url => {
                                console.log("Screenshot saved: " + url);
                                return this.bumpScreenshotVersion(sitchName);
                            }).catch(err => {
                                console.warn("Failed to save screenshot (non-critical):", err);
                            });
                        }
                    });
                }
            })
            .catch((error) => {
                if (!isAbortLikeError(error)) {
                    console.warn("Save failed:", error);
                }
                throw error;
            })
            .finally(async () => {
                const elapsedMs = Date.now() - savingIndicatorStartMs;
                if (elapsedMs < 500) {
                    await new Promise(resolve => setTimeout(resolve, 500 - elapsedMs));
                }
                if (saveSucceeded) {
                    this.guiFolder.close();
                }
                par.paused = oldPaused
                enableAllInput();
            })

    },

    /**
     * Save to the working folder if available, otherwise fall back to a file picker.
     * @param {{recordAction?: boolean}} [options]
     * @returns {Promise<boolean>}
     */
    async saveLocal({recordAction = true} = {}) {
        this.activateStorageFolder("local");
        if (this.isDesktopLocalFsAvailable()) {
            if (!this.localSaveTargetArmed || !this.localSitchEntry) {
                const ok = await this.saveLocalAs({recordAction: false});
                if (ok && recordAction) {
                    this.lastSaveAction = "local";
                }
                return ok;
            }

            let targetDirectoryHandle = this.directoryHandle;
            if (!targetDirectoryHandle && this.localSitchEntry?.path) {
                const desktopFs = getDesktopFileSystemBridge();
                const directoryPath = await desktopFs.dirname(this.localSitchEntry.path);
                targetDirectoryHandle = createDesktopDirectoryHandle(directoryPath);
            }

            return this.saveLocalDesktopToTarget(this.localSitchEntry, targetDirectoryHandle, {
                actionName: "local",
                recordAction,
            });
        }

        if (!this.directoryHandle && this._pendingHandle) {
            await this.reconnectWorkingFolder({loadSitch: false});
            if (!this.directoryHandle) {
                return false;
            }
        }

        // Require a working folder for local save operations.
        if (!this.directoryHandle) {
            if (!(await this.pickWorkingFolderForLocalSave())) {
                return false;
            }
        }

        if (!(await this.ensureWorkingFolderWriteAccess())) {
            return false;
        }

        // After a New Sitch or a server-loaded sitch, Save Local should behave like Save Local As.
        const canOverwriteCurrentLocalTarget = this.localSaveTargetArmed && !!this.localSitchEntry;
        if (!canOverwriteCurrentLocalTarget) {
            const ok = await this.saveLocalAs({recordAction: false});
            if (ok && recordAction) {
                this.lastSaveAction = "local";
            }
            return ok;
        }

        const previousSitchName = Sit.sitchName;
        let assignedTemporaryName = false;
        if (Sit.sitchName === undefined) {
            // Derive name from the loaded sitch file, or default to "Local"
            if (this.localSitchEntry) {
                Sit.sitchName = this.localSitchEntry.name.replace(/\.json$/, "");
            } else {
                Sit.sitchName = "Local";
            }
            assignedTemporaryName = true;
        }

        const targetDirectoryHandle = this.directoryHandle || null;
        const targetFileHandle = targetDirectoryHandle ? null : this.localSitchEntry || null;
        try {
            await this.saveSitch(true, targetDirectoryHandle, targetFileHandle);
            if (recordAction) {
                this.lastSaveAction = "local";
            }
            this.updateLocalGUI();
            return true;
        } catch (error) {
            if (assignedTemporaryName) {
                Sit.sitchName = previousSitchName;
            }
            if (!isAbortLikeError(error)) {
                console.warn("Save Local failed:", error);
                this.showLocalSaveError("Save Local", error);
            }
            return false;
        }
    },

    /**
     * Save with a new local name in the working folder.
     * @param {{recordAction?: boolean}} [options]
     * @returns {Promise<boolean>}
     */
    async saveLocalAs({recordAction = true} = {}) {
        this.activateStorageFolder("local");
        if (this.isDesktopLocalFsAvailable()) {
            const selection = await this.getDesktopLocalSaveTarget();
            if (!selection) {
                return false;
            }

            return this.saveLocalDesktopToTarget(selection.fileHandle, selection.directoryHandle, {
                actionName: "localAs",
                recordAction,
            });
        }

        const previousSitchName = Sit.sitchName;
        if (!this.directoryHandle) {
            if (!(await this.pickWorkingFolderForLocalSave())) {
                return false;
            }
        }

        Sit.sitchName = undefined;
        try {
            await this.saveSitch(true, this.directoryHandle, null);
            if (recordAction) {
                this.lastSaveAction = "localAs";
            }
            this.updateLocalGUI();
            return true;
        } catch (error) {
            Sit.sitchName = previousSitchName;
            if (!isAbortLikeError(error)) {
                console.warn("Save Local As failed:", error);
                this.showLocalSaveError("Save Local As", error);
            }
            return false;
        }
    },

    /**
     * Persist the working folder handle and sitch filename to IndexedDB.
     */
    async persistWorkingFolder() {
        if (this.isDesktopLocalFsAvailable()) {
            try {
                const desktopFs = getDesktopFileSystemBridge();
                await desktopFs.setLocalState({
                    sitchPath: this.localSitchEntry?.path ?? null,
                    workingDirectoryPath: this.directoryHandle?.path ?? null,
                });
                console.log("Working folder persisted to desktop app state");
            } catch (err) {
                console.warn("Failed to persist desktop local state:", err);
            }
            return;
        }

        try {
            await saveToIDB('workingFolderHandle', this.directoryHandle || null);
            await saveToIDB('workingFolderSitchFile', this.localSitchEntry ? this.localSitchEntry.name : null);
            console.log("Working folder persisted to IndexedDB");
        } catch (err) {
            console.warn("Failed to persist working folder:", err);
        }
    },

    /**
     * Restore the working folder handle from IndexedDB on startup.
     * Uses queryPermission (no prompt). Shows reconnect button if permission needs re-granting.
     */
    async restoreWorkingFolder() {
        if (this.isDesktopLocalFsAvailable()) {
            try {
                const desktopFs = getDesktopFileSystemBridge();
                const localState = await desktopFs.getLocalState();
                const sitchPath = localState?.sitchPath ?? null;
                const workingDirectoryPath = localState?.workingDirectoryPath
                    ?? (sitchPath ? await desktopFs.dirname(sitchPath) : null);

                if (!workingDirectoryPath) {
                    this.updateLocalGUI();
                    return;
                }

                const restored = await this.hydrateDesktopWorkingFolder(workingDirectoryPath, sitchPath);
                if (!restored) {
                    await desktopFs.setLocalState({ sitchPath: null, workingDirectoryPath: null });
                    this.directoryHandle = null;
                    this.localSitchEntry = null;
                    this.updateLocalGUI();
                    return;
                }

                console.log("Desktop working folder restored:", this.directoryHandle.name);
                this.updateLocalGUI();
            } catch (err) {
                console.warn("Failed to restore desktop local state:", err);
            }
            return;
        }

        try {
            const handle = await loadFromIDB('workingFolderHandle');
            if (!handle) return;

            const permission = await handle.queryPermission({ mode: 'readwrite' });
            if (permission === 'granted') {
                this.directoryHandle = handle;
                const sitchFilename = await loadFromIDB('workingFolderSitchFile');
                if (sitchFilename) {
                    try {
                        this.localSitchEntry = await this.directoryHandle.getFileHandle(sitchFilename);
                    } catch (e) {
                        console.warn("Previous sitch file not found in folder:", sitchFilename);
                    }
                }
                console.log("Working folder restored:", handle.name);
            } else {
                // Stash for reconnect — requires a user gesture to re-grant
                this._pendingHandle = handle;
                this._pendingSitchFilename = await loadFromIDB('workingFolderSitchFile');
                console.log("Working folder found but needs reconnect:", handle.name);
            }
            this.updateLocalGUI();
        } catch (err) {
            console.warn("Failed to restore working folder:", err);
        }
    },

    /**
     * Re-grant access to a previously saved working folder. Must be called from a user gesture.
     * @param {{loadSitch?: boolean}} [options]
     * @returns {Promise<boolean>} True if reconnect succeeded.
     */
    async reconnectWorkingFolder({loadSitch = true} = {}) {
        this.activateStorageFolder("local");
        if (this.isDesktopLocalFsAvailable()) {
            await this.restoreWorkingFolder();
            if (loadSitch && this.localSitchEntry) {
                await this.checkForNewLocalSitch();
            }
            return !!this.directoryHandle;
        }

        if (!this._pendingHandle) return false;
        try {
            const permission = await this._pendingHandle.requestPermission({ mode: 'readwrite' });
            if (permission === 'granted') {
                this.directoryHandle = this._pendingHandle;
                const handle = this._pendingHandle;
                this._pendingHandle = null;

                if (this._pendingSitchFilename) {
                    try {
                        this.localSitchEntry = await this.directoryHandle.getFileHandle(this._pendingSitchFilename);
                        if (loadSitch) {
                            this.checkForNewLocalSitch();
                        }
                    } catch (e) {
                        console.warn("Could not find previous sitch file:", this._pendingSitchFilename);
                    } finally {
                        this._pendingSitchFilename = null;
                    }
                }

                console.log("Working folder reconnected:", handle.name);
                this.updateLocalGUI();
                try {
                    await this.persistWorkingFolder();
                } catch (persistError) {
                    console.warn("Reconnected folder, but failed to persist state:", persistError);
                }
                return true;
            }
            this.updateLocalGUI();
            return false;
        } catch (err) {
            console.warn("Reconnect failed:", err);
            return false;
        }
    },

    /**
     * Ensure readwrite access to the current working folder, if one is set.
     * If access is lost, switch to pending/reconnect state.
     * @returns {Promise<boolean>} True if save can proceed.
     */
    async ensureWorkingFolderWriteAccess() {
        if (!this.directoryHandle) {
            return true;
        }

        if (this.isDesktopLocalFsAvailable()) {
            try {
                const desktopFs = getDesktopFileSystemBridge();
                const info = await desktopFs.stat(this.directoryHandle.path);
                if (info.exists && info.kind === "directory") {
                    return true;
                }
            } catch (err) {
                console.warn("Desktop working folder check failed:", err);
            }

            this.directoryHandle = null;
            this.localSitchEntry = null;
            this.localSaveTargetArmed = false;
            this.updateLocalGUI();
            await this.persistWorkingFolder();
            return false;
        }

        try {
            let permission = await this.directoryHandle.queryPermission({ mode: 'readwrite' });
            if (permission !== 'granted') {
                permission = await this.directoryHandle.requestPermission({ mode: 'readwrite' });
            }

            if (permission === 'granted') {
                return true;
            }
        } catch (err) {
            console.warn("Working folder permission check failed:", err);
        }

        this._pendingHandle = this.directoryHandle;
        this._pendingSitchFilename = this.localSitchEntry ? this.localSitchEntry.name : null;
        this.directoryHandle = null;
        this.updateLocalGUI();
        return false;
    },

    /**
     * Prompt for a working folder to use for local saves.
     * @returns {Promise<boolean>} True if a folder was selected.
     */
    async pickWorkingFolderForLocalSave() {
        if (this.isDesktopLocalFsAvailable()) {
            try {
                const desktopFs = getDesktopFileSystemBridge();
                const selection = await desktopFs.chooseFolder({
                    defaultPath: this.directoryHandle?.path || this.localSitchEntry?.path || undefined,
                });
                if (!selection) {
                    return false;
                }

                this.directoryHandle = createDesktopDirectoryHandle(selection.path);
                this._pendingHandle = null;
                this._pendingSitchFilename = null;
                await this.persistWorkingFolder();
                this.updateLocalGUI();
                return true;
            } catch (err) {
                if (!isAbortLikeError(err)) {
                    console.warn("pickWorkingFolderForLocalSave() desktop error", err.name, err.message);
                }
                return false;
            }
        }

        if (!supportsDirectoryPicker()) {
            showLocalFolderAccessUnsupportedMessage();
            return false;
        }
        try {
            this.directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            this._pendingHandle = null;
            this._pendingSitchFilename = null;
            await this.persistWorkingFolder();
            this.updateLocalGUI();
            return true;
        } catch (err) {
            if (!isAbortLikeError(err)) {
                console.warn("pickWorkingFolderForLocalSave() error", err.name, err.message);
            }
            return false;
        }
    },


    /**
     * Returns true when a filename should be resolved from the selected local working folder.
     * This is used for local sitch assets saved as relative paths.
     * @param {string} filename
     * @returns {boolean}
     */
    isLikelyWorkingFolderAssetPath(filename) {
        if (!this.directoryHandle) return false;
        if (typeof filename !== "string" || filename.length === 0) return false;
        if (isHttpOrHttps(filename) || isResolvableSitrecReference(filename)) return false;
        if (filename.startsWith("/")) return false;
        const normalized = this.normalizeWorkingFolderRelativePath(filename);
        if (!normalized) return false;
        if (!normalized.includes("/")) return true;
        // Nested local assets are stored under a dedicated local folder prefix.
        return normalized.startsWith("local/") || this._localSitchContextActive;
    },

    /**
     * Normalize/sanitize a relative path intended for the working folder.
     * Prevents traversal and strips query fragments.
     * @param {string} path
     * @returns {string|null}
     */
    normalizeWorkingFolderRelativePath(path) {
        if (typeof path !== "string") return null;
        let normalized = path.split("?")[0].trim().replace(/\\/g, "/");
        while (normalized.startsWith("./")) {
            normalized = normalized.substring(2);
        }
        normalized = normalized.replace(/^\/+/, "");
        const parts = normalized.split("/").filter(Boolean);
        if (parts.length === 0) return null;
        if (parts.some(part => part === "." || part === "..")) return null;
        return parts.join("/");
    },

    /**
     * Resolve a FileSystemFileHandle from the working folder.
     * Supports nested relative paths and optional directory creation.
     * @param {string} relativePath
     * @param {{create?: boolean, directoryHandle?: FileSystemDirectoryHandle}} [options]
     * @returns {Promise<FileSystemFileHandle>}
     */
    async getWorkingFolderFileHandle(relativePath, {create = false, directoryHandle = this.directoryHandle} = {}) {
        assert(directoryHandle !== undefined, `No directory handle for local file ${relativePath}`);
        const normalizedPath = this.normalizeWorkingFolderRelativePath(relativePath);
        assert(normalizedPath, `Invalid local working-folder path: ${relativePath}`);

        const pathParts = normalizedPath.split("/");
        const fileName = pathParts.pop();

        let currentHandle = directoryHandle;
        for (const part of pathParts) {
            currentHandle = await currentHandle.getDirectoryHandle(part, {create});
        }
        return currentHandle.getFileHandle(fileName, {create});
    },

    /**
     * Read a file from the working folder.
     * @param {string} relativePath
     * @param {FileSystemDirectoryHandle} [directoryHandle]
     * @returns {Promise<ArrayBuffer>}
     */
    async readWorkingFolderFile(relativePath, directoryHandle = this.directoryHandle) {
        const fileHandle = await this.getWorkingFolderFileHandle(relativePath, {create: false, directoryHandle});
        const file = await fileHandle.getFile();
        return file.arrayBuffer();
    },

    /**
     * Write data to the working folder, creating intermediate directories as needed.
     * @param {string} relativePath
     * @param {ArrayBuffer|Blob|Uint8Array} data
     * @param {FileSystemDirectoryHandle} [directoryHandle]
     * @returns {Promise<string>} The normalized relative path written.
     */
    async writeWorkingFolderFile(relativePath, data, directoryHandle = this.directoryHandle) {
        const normalizedPath = this.normalizeWorkingFolderRelativePath(relativePath);
        assert(normalizedPath, `Invalid local working-folder write path: ${relativePath}`);

        const fileHandle = await this.getWorkingFolderFileHandle(normalizedPath, {create: true, directoryHandle});
        const writable = await fileHandle.createWritable();
        await writable.write(data);
        await writable.close();
        return normalizedPath;
    },

    /**
     * Sanitize a filename for writing into the local working folder.
     * @param {string} fileName
     * @param {string} [fallbackName="file.bin"]
     * @returns {string}
     */
    sanitizeLocalRehostFileName(fileName, fallbackName = "file.bin") {
        let safe = (fileName || "").split("?")[0].replace(/\\/g, "/");
        if (safe.includes("/")) {
            safe = safe.split("/").pop();
        }
        safe = safe.trim();
        if (!safe) {
            safe = fallbackName;
        }
        safe = safe.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_");
        if (safe === "." || safe === "..") {
            safe = fallbackName;
        }
        return safe;
    },

    /**
     * Suggest a subfolder for local rehosted assets.
     * @param {object} fileEntry
     * @param {string} key
     * @returns {string}
     */
    getLocalRehostSubfolder(fileEntry = {}, key = "") {
        if (fileEntry.dataType === "videoImage" || fileEntry.dataType === "groundOverlayImage" || fileEntry.dataType === "kmzImage" || fileEntry.dataType === "image") {
            return "local/media";
        }
        if (fileEntry.dataType === "trackfile" || fileEntry.isTLE || key === "starLink") {
            return "local/tracks";
        }
        if (fileEntry.dataType === "model") {
            return "local/models";
        }
        return "local/assets";
    },

    /**
     * Choose a write path that reuses existing identical files and avoids collisions.
     * If an existing file has identical content, returns that same path (no extra copy needed).
     * @param {string} preferredRelativePath
     * @param {ArrayBuffer} sourceBuffer
     * @param {FileSystemDirectoryHandle} [directoryHandle]
     * @returns {Promise<{path: string, reusedExisting: boolean}>}
     */
    async chooseLocalRehostPath(preferredRelativePath, sourceBuffer, directoryHandle = this.directoryHandle) {
        const normalizedPreferred = this.normalizeWorkingFolderRelativePath(preferredRelativePath);
        assert(normalizedPreferred, `Invalid preferred local rehost path: ${preferredRelativePath}`);

        // Fast path: if we already resolved this path earlier in the session
        // (via a previous save or load), skip the expensive file read + compare.
        const cached = this._localRehostPathCache.get(normalizedPreferred);
        if (cached) {
            return cached;
        }

        const parts = normalizedPreferred.split("/");
        const preferredName = parts.pop();
        const prefix = parts.length > 0 ? parts.join("/") + "/" : "";

        const extIndex = preferredName.lastIndexOf(".");
        const base = extIndex > 0 ? preferredName.substring(0, extIndex) : preferredName;
        const ext = extIndex > 0 ? preferredName.substring(extIndex) : "";

        let counter = 2;
        let candidateName = preferredName;
        while (true) {
            const candidatePath = prefix + candidateName;
            try {
                const existingHandle = await this.getWorkingFolderFileHandle(candidatePath, {create: false, directoryHandle});
                const existingFile = await existingHandle.getFile();
                const existingBuffer = await existingFile.arrayBuffer();

                // Reuse existing file if identical bytes (no recopy needed).
                if (areArrayBuffersEqual(existingBuffer, sourceBuffer)) {
                    const result = {path: candidatePath, reusedExisting: true};
                    this._localRehostPathCache.set(normalizedPreferred, result);
                    return result;
                }

                candidateName = `${base}-${counter}${ext}`;
                counter++;
            } catch (error) {
                if (error?.name === "NotFoundError") {
                    const result = {path: candidatePath, reusedExisting: false};
                    this._localRehostPathCache.set(normalizedPreferred, result);
                    return result;
                }
                throw error;
            }
        }
    },

    /**
     * Build a `<filename>.pts.json` sidecar buffer for a TS-extracted substream
     * carrying its MISB ST 0604 PES timing data. Returns null if the entry has
     * no PES timing (non-TS substreams, async-mode KLV without per-PES PTS, etc.).
     *
     * The sidecar persists raw `pesEntries[]` (pre-pairing) plus `videoFirstPESus`
     * — the canonical input to `parseKLVFile`'s pairing logic. We persist the
     * pre-pairing form so future parser fixes still benefit; the post-pairing
     * `pesPTSus[]` is recomputable on reload from these values + the substream
     * bytes (which round-trip exactly).
     *
     * @param {Object} fileEntry — a FileManager.list[id] entry
     * @returns {ArrayBuffer|null}
     */
    _makePesSidecarBuffer(fileEntry) {
        if (!fileEntry || !Array.isArray(fileEntry.pesEntries) || fileEntry.pesEntries.length === 0) {
            return null;
        }
        const sidecar = {
            version: 1,
            kind: "klv-pes-pts",
            videoFirstPESus: typeof fileEntry.videoFirstPESus === "number" ? fileEntry.videoFirstPESus : null,
            pesEntries: fileEntry.pesEntries,
        };
        const json = JSON.stringify(sidecar);
        return new TextEncoder().encode(json).buffer;
    },

    /**
     * Sidecar URL convention: append `.pts.txt` to the substream filename.
     *
     * The content is JSON internally, but the file extension is .txt so a
     * stray sidecar dropped on the page (or sitting next to .json sitch
     * saves in a directory listing) doesn't get routed through Sitrec's
     * .json-loader path and confused with a sitch / track file. Old saves
     * persisted these as `.pts.json`; the loader still accepts that older
     * URL and the parser still recognizes the `klv-pes-pts` kind in either
     * extension to defend against either-way confusion.
     */
    _sidecarFilename(substreamFilename) {
        return substreamFilename + ".pts.txt";
    },

    /**
     * Copy dynamic/imported assets into the working folder for local saves.
     * Local-copy paths are stored in `localStaticURL` and used only for local serialization.
     * @param {FileSystemDirectoryHandle} directoryHandle
     * @param {boolean} [rehostVideo=false]
     * @returns {Promise<void>}
     */
    async rehostDynamicLinksLocal(directoryHandle, rehostVideo = false) {
        if (!directoryHandle) return;
        const todayDateStr = new Date().toISOString().split("T")[0];

        // Local copy for dropped video content (so local saves are portable).
        if (rehostVideo && NodeMan.exists("video")) {
            const videoNode = NodeMan.get("video");
            videoNode.updateCurrentVideoEntry();

            if (videoNode.videos && videoNode.videos.length > 0) {
                for (const entry of videoNode.videos) {
                    if (entry.isImage) continue;
                    const videoDroppedData = entry.videoData?.videoDroppedData;
                    if (!videoDroppedData) continue;

                    const safeName = this.sanitizeLocalRehostFileName(entry.fileName, `video-${todayDateStr}.mp4`);
                    const existingRelativePath = this.isLikelyWorkingFolderAssetPath(entry.fileName)
                        ? this.normalizeWorkingFolderRelativePath(entry.fileName)
                        : null;
                    const preferredPath = existingRelativePath || `local/media/${safeName}`;
                    const {path: chosenPath, reusedExisting} = await this.chooseLocalRehostPath(preferredPath, videoDroppedData, directoryHandle);
                    if (!reusedExisting) {
                        await this.writeWorkingFolderFile(chosenPath, videoDroppedData, directoryHandle);
                    }
                    entry.localStaticURL = chosenPath;

                    if (entry === videoNode.videos[videoNode.currentVideoIndex]) {
                        videoNode.localStaticURL = chosenPath;
                    }
                }
            } else if (videoNode.videoData?.videoDroppedData) {
                const safeName = this.sanitizeLocalRehostFileName(videoNode.fileName, `video-${todayDateStr}.mp4`);
                const existingRelativePath = this.isLikelyWorkingFolderAssetPath(videoNode.fileName)
                    ? this.normalizeWorkingFolderRelativePath(videoNode.fileName)
                    : null;
                const preferredPath = existingRelativePath || `local/media/${safeName}`;
                const {path: chosenPath, reusedExisting} = await this.chooseLocalRehostPath(preferredPath, videoNode.videoData.videoDroppedData, directoryHandle);
                if (!reusedExisting) {
                    await this.writeWorkingFolderFile(chosenPath, videoNode.videoData.videoDroppedData, directoryHandle);
                }
                videoNode.localStaticURL = chosenPath;
            }
        }

        for (const key of Object.keys(this.list)) {
            const fileEntry = this.list[key];
            if (!fileEntry || fileEntry.skipSerialization) continue;
            if (!fileEntry.dynamicLink) continue;
            if (!fileEntry.original) continue;

            let preferredName;
            if (key === "starLink") {
                const extension = this.deriveExtension(fileEntry.filename || "starLink.txt");
                preferredName = `starLink-${todayDateStr}.${extension}`;
            } else {
                preferredName = this.sanitizeLocalRehostFileName(fileEntry.filename || key, `${key || "asset"}.bin`);
            }

            const subfolder = this.getLocalRehostSubfolder(fileEntry, key);
            const existingRelativePath = this.isLikelyWorkingFolderAssetPath(fileEntry.filename)
                ? this.normalizeWorkingFolderRelativePath(fileEntry.filename)
                : null;
            const preferredPath = existingRelativePath || `${subfolder}/${preferredName}`;
            const {path: chosenPath, reusedExisting} = await this.chooseLocalRehostPath(preferredPath, fileEntry.original, directoryHandle);
            if (!reusedExisting) {
                await this.writeWorkingFolderFile(chosenPath, fileEntry.original, directoryHandle);
            }
            fileEntry.localStaticURL = chosenPath;

            // For TS-extracted substreams: also write `<path>.pts.json` carrying
            // MISB ST 0604 PES timing. Reload reads this sidecar to reconstruct
            // pesPTSus[] without re-demuxing the (dropped) parent TS.
            const sidecarBuffer = this._makePesSidecarBuffer(fileEntry);
            if (sidecarBuffer) {
                const sidecarPath = this._sidecarFilename(chosenPath);
                await this.writeWorkingFolderFile(sidecarPath, sidecarBuffer, directoryHandle);
                fileEntry.localPesSidecarURL = sidecarPath;
            }

            if (fileEntry.dataType === "videoImage" && NodeMan.exists("video")) {
                const videoNode = NodeMan.get("video");
                const videoItem = videoNode.videos?.find(v => v.imageFileID === key);
                if (videoItem) {
                    videoItem.localStaticURL = chosenPath;
                }
            }
        }
    },

    /**
     * Uploads all dynamic (non-static) files to the server for permanent hosting.
     * Called before saving a sitch to ensure all local/temporary files have static URLs.
     * Sets staticURL on each file entry after successful upload.
     * @param {boolean} [rehostVideo=false] - If true, also rehost the video file
     * @returns {Promise<void[]>} Resolves when all rehosting is complete
     */
    rehostDynamicLinks(rehostVideo = false) {
        const rehostPromises = [];
        const todayDateStr = new Date().toISOString().split('T')[0];

        // first check for video rehosting
        if (rehostVideo) {
            if (NodeMan.exists("video")) {
                const videoNode = NodeMan.get("video")
                
                videoNode.updateCurrentVideoEntry();
                
                const videosToRehost = videoNode.videos && videoNode.videos.length > 0 
                    ? videoNode.videos 
                    : [{ fileName: videoNode.fileName, staticURL: videoNode.staticURL, videoData: videoNode.videoData }];
                
                console.log("[CFileManager.rehostDynamicLinks] Rehosting", videosToRehost.length, "video(s)");
                
                for (let i = 0; i < videosToRehost.length; i++) {
                    const entry = videosToRehost[i];
                    const vData = entry.videoData;
                    
                    if (!vData) {
                        console.log(`[CFileManager.rehostDynamicLinks] Video ${i}: no videoData, skipping`);
                        continue;
                    }
                    
                    const videoDroppedData = vData.videoDroppedData;
                    if (!videoDroppedData) {
                        console.log(`[CFileManager.rehostDynamicLinks] Video ${i}: no videoDroppedData, skipping`);
                        continue;
                    }
                    
                    if (entry.staticURL) {
                        console.log(`[CFileManager.rehostDynamicLinks] Video ${i}: already has staticURL, skipping`);
                        continue;
                    }
                    
                    let rehostFilename = entry.fileName;
                    if (rehostFilename.length > 100) {
                        const extension = getFileExtension(rehostFilename);
                        rehostFilename = rehostFilename.substring(0, 100) + "-" + todayDateStr + "." + extension;
                        console.warn(`Rehosting video ${i} with cropped filename: ${rehostFilename}`);
                    }
                    
                    console.log(`[CFileManager.rehostDynamicLinks] Starting rehost for video ${i}: ${rehostFilename}`);
                    const entryRef = entry;
                    rehostPromises.push(this.rehoster.rehostFile(rehostFilename, videoDroppedData).then((staticURL) => {
                        console.log("VIDEO REHOSTED AS PROMISED: " + staticURL)
                        entryRef.staticURL = staticURL;
                        if (entryRef === videosToRehost[videoNode.currentVideoIndex]) {
                            videoNode.staticURL = staticURL;
                        }
                    }))
                }
            }
        }


        Object.keys(this.list).forEach(key => {
            const f = this.list[key];
            
            // Skip files marked for no serialization (e.g., FEATURES files)
            if (f.skipSerialization) {
                console.log("Skipping serialization for: " + key);
                return;
            }
            
            if (f.dynamicLink && !f.staticURL) {


                var rehostFilename = f.filename;

                // If we rehost a TLE file, then need to set the rehostedStarlink flag
                // first check for the special case of a "starLink" file
                // If we get here then that can only be the dynamic proxy version
                // so calculate a filename and rehost
                if (key === "starLink") {
                    this.rehostedStarlink = true;
                    rehostFilename = key + "-" + todayDateStr + "." + this.deriveExtension(f.filename)
                    console.log("this.rehostedStarlink set as REHOSTING starLink as " + rehostFilename)
                } else {
                    // if it's just a TLE, then we are still going to rehost a TLE
                    // but it will be one dragged in
                    // but can just use the filename as normal
                    if (f.isTLE) {
                        this.rehostedStarlink = true;
                        console.log("this.rehostedStarlink set as REHOSTING TLE " + rehostFilename)
                    }
                }

                assert(rehostFilename !== undefined, "Rehost filename is undefined for key " + key);

                console.log("Dynamic Rehost: " + rehostFilename + " length=" + f.original.byteLength + " staticURL=" + f.staticURL)
                const fileKey = key;
                const fileEntry = f;
                const rehostPromise = this.rehoster.rehostFile(rehostFilename, f.original).then((staticURL) => {
                    console.log("AS PROMISED: " + staticURL)
                    fileEntry.staticURL = staticURL;

                    if (fileEntry.dataType === "videoImage" && NodeMan.exists("video")) {
                        const videoNode = NodeMan.get("video");
                        const videoEntry = videoNode.videos?.find(v => v.imageFileID === fileKey);
                        if (videoEntry) {
                            console.log(`[rehostDynamicLinks] Updated video entry staticURL for image ${fileKey}`);
                            videoEntry.staticURL = staticURL;
                            if (videoNode.imageFileID === fileKey) {
                                videoNode.staticURL = staticURL;
                            }
                        }
                    }
                }).catch((error) => {
                    console.error("Rehost failed for " + rehostFilename + ":", error);
                    throw error; // Re-throw to propagate to Promise.all
                })
                console.log("Pushing rehost promise for " + rehostFilename);
                rehostPromises.push(rehostPromise)

                // For TS-extracted substreams: rehost a `<filename>.pts.json`
                // sidecar carrying MISB ST 0604 PES timing. Load-time fetches
                // this in parallel with the substream and threads the contents
                // into parseKLVFile so pesPTSus[] is reconstructed without
                // re-demuxing the (now-dropped) parent TS.
                const sidecarBuffer = this._makePesSidecarBuffer(fileEntry);
                if (sidecarBuffer) {
                    const sidecarFilename = this._sidecarFilename(rehostFilename);
                    const sidecarPromise = this.rehoster.rehostFile(sidecarFilename, sidecarBuffer)
                        .then((sidecarURL) => {
                            console.log(`[rehostDynamicLinks] PES sidecar uploaded: ${sidecarURL}`);
                            fileEntry.pesSidecarStaticURL = sidecarURL;
                        }).catch((error) => {
                            console.error("PES sidecar rehost failed for " + sidecarFilename + ":", error);
                            throw error;
                        });
                    rehostPromises.push(sidecarPromise);
                }
            }
        })
        return Promise.all(rehostPromises);
    },
};
