/**
 * Module: client file lifecycle manager.
 *
 * Responsibilities:
 * - Load and parse local and remote assets used by sitches.
 * - Track dynamic vs static sources and manage rehosting.
 * - Resolve Sitrec object references to fetch URLs when loading assets/sitches.
 * - Drive save/load/version UI flows for user sitches.
 */
import {
    areArrayBuffersEqual,
    cleanCSVText,
    disableAllInput,
    enableAllInput,
    ExpandKeyframes,
    getDateTimeFilename,
    getFileExtension,
    isHttpOrHttps,
    updateDocumentTitle,
    versionString
} from "./utils";
import {CNodeArray} from "./nodes/CNodeArray";
import {fileSystemFetch} from "./fileSystemFetch";
import JSZip from "jszip";
import {
    CTrackFile,
    CTrackFileJSON,
    CTrackFileKML,
    CTrackFileMISB,
    CTrackFileSonde,
    CTrackFileSRT,
    CTrackFileSTANAG,
    parseXml
} from "./KMLUtils";
import {CRehoster} from "./CRehoster";
import {CManager} from "./CManager";
import {
    CustomManager,
    getEffectiveUserID,
    Globals,
    guiMenus,
    NodeMan,
    setNewSitchObject,
    setRenderOne,
    Sit,
    Synth3DManager,
    TrackManager,
    withTestUser
} from "./Globals";
import {fromArrayBuffer as geotiffFromArrayBuffer} from 'geotiff';
import {DragDropHandler} from "./DragDropHandler";
import {parseAirdataCSV} from "./ParseAirdataCSV";
import {parseKLVFile, parseMISB1CSV} from "./MISBUtils";
// Modern CSV parser
import csv from "./utils/CSVParser";
import {asyncCheckLogin} from "./login";
import {waitForExportFrameSettled} from "./ExportFrameSettler";
import {par} from "./par";
import {assert} from "./assert";
import {textSitchToObject} from "./RegisterSitches";
import {addOptionToGUIMenu, removeOptionFromGUIMenu} from "./lil-gui-extras";
import {
    extractPBACSV,
    isCustom1,
    isFR24CSV,
    isPBAFile,
    parseCustom1CSV,
    parseCustomFLLCSV,
    parseFR24CSV
} from "./ParseCustom1CSV";
import {findColumn, stripDuplicateTimes} from "./ParseUtils";
import {isConsole, isLocal, isServerless, SITREC_APP, SITREC_DOMAIN, SITREC_SERVER} from "./configUtils";
import {TSParser} from "./TSParser";
import {NITFParser} from "./NITFParser";
import {showError, showErrorOnce} from "./showError";
import {asyncOperationRegistry} from "./AsyncOperationRegistry";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {projectedBoundsToWGS84} from "./proj4Loader";
import {isAudioOnlyFormat} from "./AudioFormats";
import {saveAs} from "file-saver";
import {EventManager} from "./CEventManager";
import {CTLEData} from "./TLEUtils";
import {extractFeaturesFromFile, isFeaturesCSV} from "./ParseFeaturesCSV";
import {createImageFromArrayBuffer} from "./FileUtils";
import {CNode3DObject, ModelFiles} from "./nodes/CNode3DObject";
import {LoadingManager} from "./CLoadingManager";
import {convertTiffBufferToPngImage} from "./TIFFUtils";
import {extractFlightClubInfo, flightClubToCSVStrings, isFlightClubJSON} from "./ParseFlightClubJSON";
import {CSitchBrowser} from "./CSitchBrowser";
import {ViewMan} from "./CViewManager";
import {isResolvableSitrecReference, resolveURLForFetch, toCanonicalSitrecRef} from "./SitrecObjectResolver";
import {getEnv, getEnvBool} from "./envUtils";
import {isSupportedModelFile} from "./ModelLoader";
import {
    createDesktopDirectoryHandle,
    createDesktopFileHandle,
    getDesktopFileSystemBridge,
    isDesktopFileSystemAvailable,
} from "./DesktopFileSystem";
import {promptForText} from "./TextPrompt";
import {t} from "./i18n";
import {parseMethods} from "./CFileManagerParse";

const trackFileClasses = [
    CTrackFileKML,
    CTrackFileSTANAG,
    CTrackFileSRT,
    CTrackFileJSON,
    CTrackFileMISB,
    CTrackFileSonde,  // Last: handles text files, content-detected to avoid false positives
];

// ── IndexedDB helpers for persisting working folder handle ──────────────
function openSitrecIDB() {
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

async function saveToIDB(key, value) {
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

async function loadFromIDB(key) {
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

function isAbortLikeError(error) {
    if (!error) return false;
    if (error.name === "AbortError") return true;
    if (typeof error === "string" && error.includes("Cancelled")) return true;
    return false;
}

function sanitizeSitchName(rawName) {
    if (typeof rawName !== "string") {
        return "";
    }

    let validSitchName = rawName.replace(/[\/\\<>\x00-\x1f]+/g, "_");
    validSitchName = validSitchName.trim();
    validSitchName = validSitchName.replace(/^[\.\s]+|[\.\s]+$/g, "");
    return validSitchName;
}

function supportsDirectoryPicker() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

function supportsOpenFilePicker() {
    return typeof window !== "undefined" && typeof window.showOpenFilePicker === "function";
}

function showLocalFolderAccessUnsupportedMessage() {
    const message = "Local folder access is not supported in this browser.\n\nPlease use Chrome or Microsoft Edge for Local Folder save/load features.";
    showErrorOnce("local-folder-access-unsupported", message);
    console.warn(message);
}


/**
 * The file manager is a singleton that manages all the files.
 * It is a subclass of CManager, which is a simple class that manages a list of objects.
 * The FileManager adds the ability to load files from URLs, and to parse them.
 * It also adds the ability to rehost files, needed for the Celestrack proxy, TLEs,
 * KMLs, and other data files that are dragged in.
 */
export class CFileManager extends CManager {
    /**
     * Creates the FileManager instance.
     * Initializes the raw files array, rehoster, and sets up the GUI if not in console mode.
     */
    constructor() {
        super()
        this.rawFiles = [];
        this.rehostedStarlink = false;
        this.directoryHandle = null;
        this.localSitchEntry = null;
        this._pendingHandle = null;
        this._pendingSitchFilename = null;
        this._localSitchContextActive = false;
        // Only true when the currently active sitch has a valid local overwrite target.
        this.localSaveTargetArmed = false;
        // Last successful save intent. Used by Cmd/Ctrl+S to repeat expected behavior.
        this.lastSaveAction = null;
        // Deduplicate "select working folder" prompts when multiple local assets resolve at once.
        this._pendingLocalFolderAcquirePromise = null;
        // Throttle repeated local-import error dialogs during a single failed load burst.
        this._localImportErrorLastKey = null;
        this._localImportErrorLastMs = 0;
        // Session cache for local rehost path resolution.
        // Maps normalizedPreferredPath -> {path, reusedExisting} so we skip re-reading
        // large files (e.g. 500MB video) on every save after the first.
        this._localRehostPathCache = new Map();

        this.rehoster = new CRehoster();

        if (!isConsole) {
            this.guiFolder = guiMenus.file;
            this.guiFolder.add(this, "newSitch").name(t("file.newSitch.label")).perm().tooltip(t("file.newSitch.tooltip"));


            // the Save and Load buttons should only be available for the custom sitch


            if ((getEnvBool("SAVE_TO_SERVER", process.env.SAVE_TO_SERVER) || getEnvBool("SAVE_TO_S3", process.env.SAVE_TO_S3)) && !isServerless) {

                let serverName = SITREC_DOMAIN;
                if (getEnvBool("SAVE_TO_S3", process.env.SAVE_TO_S3)) {
                    serverName = getEnv("S3_BUCKET", process.env.S3_BUCKET) + ".s3"
                }

                this.guiServer = this.guiFolder.addFolder("Server (" + serverName + ") "+getEffectiveUserID()).perm().open();

                // Server-side rehosting only for logged-in users
                if (getEffectiveUserID() > 0) {

                    this.addServerButtons();

                    // this.guiFolder.add(this, "rehostFile").name("Rehost File").perm().tooltip("Rehost a file from your local system. DEPRECATED");
                } else {
                    this.loginButton = this.guiServer.add(this, "loginServer").name(t("file.savingDisabled")).setLabelColor("#FF8080");
                    // Still add Browse button for non-logged-in users so featured sitches remain discoverable.
                    this.ensureBrowseButton(t("file.server.browseFeatured"));
                    this.guiServer.close();
                }
            }

            if (getEnvBool("SAVE_TO_LOCAL", process.env.SAVE_TO_LOCAL)) {
                const useDesktopLocalUi = this.isDesktopLocalFsAvailable();
                // Local save/load is always available for the custom sitch, regardless of login status
                this.guiLocal = this.guiFolder.addFolder("Local").perm().open();
                this._localStatus = {value: useDesktopLocalUi ? t("file.local.noFileSelected") : t("file.local.noFolderSelected")};
                this._localStatusController = this.guiLocal.add(this._localStatus, "value")
                    .name(t("file.local.status"))
                    .listen()
                    .disable()
                    .tooltip(useDesktopLocalUi
                        ? t("file.local.statusDesktop")
                        : t("file.local.statusFolder"));
                this._saveLocalController = this.guiLocal.add(this, "saveLocal").name(t("file.local.saveLocal.label")).perm()
                    .tooltip(useDesktopLocalUi
                        ? t("file.local.saveLocal.tooltipDesktop")
                        : t("file.local.saveLocal.tooltipFolder"));
                this._saveLocalAsController = this.guiLocal.add(this, "saveLocalAs").name(t("file.local.saveLocalAs.label")).perm()
                    .tooltip(useDesktopLocalUi
                        ? t("file.local.saveLocalAs.tooltipDesktop")
                        : t("file.local.saveLocalAs.tooltipFolder"));
                this._openLocalSitchController = this.guiLocal.add(this, "openLocalSitch").name(t("file.local.openLocal.label")).perm()
                    .tooltip(useDesktopLocalUi
                        ? t("file.local.openLocal.tooltipDesktop")
                        : t("file.local.openLocal.tooltipFolder"));

                if (!useDesktopLocalUi) {
                    this._openLocalFolderController = this.guiLocal.add(this, "openDirectory").name(t("file.local.selectFolder.label")).perm()
                        .tooltip(t("file.local.selectFolder.tooltip"));
                    this._reconnectController = this.guiLocal.add(this, "reconnectWorkingFolder")
                        .name(t("file.local.reconnectFolder.label")).perm()
                        .tooltip(t("file.local.reconnectFolder.tooltip"));
                    // Hide only this controller row (not the shared folder children container).
                    this._saveLocalController.domElement.style.display = "none";
                    this._saveLocalAsController.domElement.style.display = "none";
                    this._openLocalSitchController.domElement.style.display = "none";
                    this._reconnectController.domElement.style.display = "none";
                }

                // Try to restore a previously saved working folder
                this.restoreWorkingFolder();
            }


            this.guiFolder.add(this, "importFile").name(t("file.importFile.label")).perm().tooltip(t("file.importFile.tooltip"));

            //this.guiFolder.add(this, "resetOrigin").name("Reset Origin").perm();

            if (isLocal) {
                guiMenus.debug.add(NodeMan, "recalculateAllRootFirst").name(t("file.debug.recalculateAll")).perm();
                guiMenus.debug.add(this, "dumpNodes").name(t("file.debug.dumpNodes")).perm();
                guiMenus.debug.add(this, "dumpNodesBackwards").name(t("file.debug.dumpNodesBackwards")).perm();
                guiMenus.debug.add(this, "dumpRoots").name(t("file.debug.dumpRoots")).perm();
            }

            this.setupResourcesMenu();
        }
    }

    /**
     * Show a user-visible error dialog for local save failures.
     * @param {string} actionLabel
     * @param {Error|*} error
     */
    showLocalSaveError(actionLabel, error) {
        if (isAbortLikeError(error)) return;

        const errorName = error?.name || "Error";
        const errorCode = error?.code;
        const errorMessage = error?.message || String(error);
        let message = `${actionLabel} failed:\n${errorName}${errorCode !== undefined ? ` (code: ${errorCode})` : ""}: ${errorMessage}`;
        const isDesktopLocalFs = this.isDesktopLocalFsAvailable();

        if (errorName === "NotFoundError") {
            message += isDesktopLocalFs
                ? "\n\nThe current local file or its parent folder is no longer available.\nUse Open Local Sitch or Save Local As, then retry."
                : "\n\nThe selected local folder or file is no longer available.\nSelect Local Sitch Folder again, then retry.";
            // Folder handle is no longer usable (e.g. folder deleted/moved). Clear local target state.
            this.directoryHandle = null;
            this._pendingHandle = null;
            this._pendingSitchFilename = null;
            this.localSitchEntry = null;
            this.clearLocalSitchContext();
            this.localSaveTargetArmed = false;
            this.updateLocalGUI();
            this.persistWorkingFolder();
        } else if (errorName === "NotAllowedError" || errorName === "SecurityError") {
            message += isDesktopLocalFs
                ? "\n\nLocal file access may have changed.\nUse Open Local Sitch or Save Local As."
                : "\n\nLocal folder permission may have changed.\nUse Reconnect Folder or Select Local Sitch Folder.";
        }

        showError(message, error);
    }

    isDesktopLocalFsAvailable() {
        return isDesktopFileSystemAvailable();
    }

    clearLocalSitchContext() {
        this._localSitchContextActive = false;
        this._localRehostPathCache.clear();
    }

    markLocalSitchContextActive() {
        this._localSitchContextActive = true;
    }

    async hydrateDesktopWorkingFolder(directoryPath, sitchPath = null) {
        const desktopFs = getDesktopFileSystemBridge();
        if (!desktopFs) return false;

        const workingDirectoryPath = directoryPath || (sitchPath ? await desktopFs.dirname(sitchPath) : null);
        if (!workingDirectoryPath) return false;

        const directoryInfo = await desktopFs.stat(workingDirectoryPath);
        if (!directoryInfo.exists || directoryInfo.kind !== "directory") {
            return false;
        }

        this.directoryHandle = createDesktopDirectoryHandle(workingDirectoryPath);
        this._pendingHandle = null;
        this._pendingSitchFilename = null;

        if (sitchPath) {
            const sitchInfo = await desktopFs.stat(sitchPath);
            if (sitchInfo.exists && sitchInfo.kind === "file") {
                this.localSitchEntry = createDesktopFileHandle(sitchPath);
            } else {
                this.localSitchEntry = null;
            }
        }

        return true;
    }

    getLocalSitchNameFromFilename(filename) {
        if (typeof filename !== "string" || filename.trim() === "") {
            return "Local";
        }

        return filename.replace(/\.json$/i, "") || "Local";
    }

    getSuggestedLocalSitchFilename() {
        const currentLocalName = this.localSitchEntry?.name
            ? this.getLocalSitchNameFromFilename(this.localSitchEntry.name)
            : null;
        const baseName = sanitizeSitchName(Sit.sitchName || currentLocalName || "Local") || "Local";
        return `${baseName}.json`;
    }

    async getDesktopLocalSaveTarget(defaultFileName = this.getSuggestedLocalSitchFilename()) {
        const desktopFs = getDesktopFileSystemBridge();
        if (!desktopFs) {
            return null;
        }

        let defaultPath;
        if (this.localSitchEntry?.path) {
            const currentDirectoryPath = await desktopFs.dirname(this.localSitchEntry.path);
            defaultPath = await desktopFs.resolvePath(currentDirectoryPath, defaultFileName);
        } else if (this.directoryHandle?.path) {
            defaultPath = await desktopFs.resolvePath(this.directoryHandle.path, defaultFileName);
        }

        const selection = await desktopFs.saveFile({
            defaultPath,
            filters: [
                {
                    name: "Sitrec Files",
                    extensions: ["json"],
                },
            ],
            suggestedName: defaultFileName,
            title: "Save Sitrec Sitch",
        });

        if (!selection) {
            return null;
        }

        const directoryPath = await desktopFs.dirname(selection.path);
        return {
            directoryHandle: createDesktopDirectoryHandle(directoryPath),
            fileHandle: createDesktopFileHandle(selection.path),
        };
    }

    async saveLocalDesktopToTarget(targetFileHandle, targetDirectoryHandle, {recordAction = true, actionName = "local"} = {}) {
        const previousSitchName = Sit.sitchName;
        const nextSitchName = this.getLocalSitchNameFromFilename(targetFileHandle?.name);
        Sit.sitchName = nextSitchName;

        try {
            await this.saveSitchNamed(nextSitchName, true, targetDirectoryHandle, targetFileHandle);
            if (recordAction) {
                this.lastSaveAction = actionName;
            }
            this.updateLocalGUI();
            return true;
        } catch (error) {
            Sit.sitchName = previousSitchName;
            if (!isAbortLikeError(error)) {
                console.warn(`${actionName === "localAs" ? "Save Local As" : "Save Local"} failed:`, error);
                this.showLocalSaveError(actionName === "localAs" ? "Save Local As" : "Save Local", error);
            }
            return false;
        }
    }

    /**
     * True when a path looks like a local-working-folder reference embedded in a local sitch.
     * This detection is independent of whether a working folder is currently selected.
     * @param {string} filename
     * @returns {boolean}
     */
    isLikelyImportedLocalAssetPath(filename) {
        if (typeof filename !== "string" || filename.length === 0) return false;
        if (isHttpOrHttps(filename) || isResolvableSitrecReference(filename)) return false;
        if (filename.startsWith("/")) return false;

        const normalized = this.normalizeWorkingFolderRelativePath(filename);
        if (!normalized) return false;

        // Local saves currently write copied assets under local/... .
        return normalized.startsWith("local/");
    }

    /**
     * Show a user-facing message that local-folder selection is required to load an imported local sitch.
     * @param {string} assetPath
     */
    showLocalFolderRequiredForImportedAsset(assetPath) {
        const normalized = this.normalizeWorkingFolderRelativePath(assetPath) || assetPath;
        if (this.isDesktopLocalFsAvailable()) {
            this.showLocalImportError(
                "local-file-required",
                `This sitch references a local file path:\n${normalized}\n\n` +
                "Open the sitch directly from the folder that contains its local assets, or choose that folder when prompted."
            );
            return;
        }

        this.showLocalImportError(
            "local-folder-required",
            `This sitch references a local file path:\n${normalized}\n\n` +
            "To load it, select the folder that contains this sitch and its local assets:\n" +
            "File -> Local -> Select Local Sitch Folder"
        );
    }

    /**
     * Show a user-facing message that the selected folder does not contain a required local asset.
     * @param {string} assetPath
     * @param {Error|*} [error]
     */
    showMissingLocalAssetInSelectedFolder(assetPath, error = null) {
        const normalized = this.normalizeWorkingFolderRelativePath(assetPath) || assetPath;
        const folderName = this.directoryHandle?.name || this._pendingHandle?.name || "selected folder";
        if (this.isDesktopLocalFsAvailable()) {
            this.showLocalImportError(
                "missing-local-asset",
                `Could not find local asset:\n${normalized}\n\n` +
                `The folder containing the current local sitch file ("${folderName}") does not contain this file.\n` +
                "Open the original sitch file from the correct folder and try again.",
                error
            );
            return;
        }

        this.showLocalImportError(
            "missing-local-asset",
            `Could not find local asset:\n${normalized}\n\n` +
            `The current Local Sitch Folder ("${folderName}") does not contain this file.\n` +
            "Select the correct folder and try loading the sitch again:\n" +
            "File -> Local -> Select Local Sitch Folder",
            error
        );
    }

    /**
     * Show local-import related errors with brief burst-throttling.
     * This allows the same error to appear again on later attempts, while avoiding modal spam
     * from multiple assets failing at once in a single load.
     * @param {string} key
     * @param {string} message
     * @param {Error|*} [error]
     */
    showLocalImportError(key, message, error = null) {
        const now = Date.now();
        const isDuplicateBurst = this._localImportErrorLastKey === key && (now - this._localImportErrorLastMs) < 1000;
        if (isDuplicateBurst) return;

        this._localImportErrorLastKey = key;
        this._localImportErrorLastMs = now;
        showError(message, error);
    }

    /**
     * Best-effort attempt to ensure a working folder is available for imported local sitch assets.
     * If no folder is selected, prompts the user to pick one.
     * @param {string} assetPath
     * @returns {Promise<boolean>}
     */
    async ensureWorkingFolderForImportedLocalAsset(assetPath) {
        if (this.directoryHandle) return true;

        // Reuse in-flight prompt when multiple assets resolve concurrently.
        if (this._pendingLocalFolderAcquirePromise) {
            return this._pendingLocalFolderAcquirePromise;
        }

        this._pendingLocalFolderAcquirePromise = (async () => {
            // If a previously remembered folder exists, try reconnecting first.
            if (this._pendingHandle && !this.directoryHandle) {
                try {
                    const permission = await this._pendingHandle.queryPermission({mode: "readwrite"});
                    if (permission === "granted") {
                        this.directoryHandle = this._pendingHandle;
                        this._pendingHandle = null;
                        this._pendingSitchFilename = null;
                        this.updateLocalGUI();
                        await this.persistWorkingFolder();
                        return true;
                    }
                } catch (error) {
                    console.warn("Failed to auto-reconnect pending working folder:", error);
                }
            }

            if (this.isDesktopLocalFsAvailable()) {
                const normalized = this.normalizeWorkingFolderRelativePath(assetPath) || assetPath;
                const wantsSelection = confirm(
                    `This imported sitch references local file "${normalized}", but no Local Sitch Folder is selected.\n\n` +
                    "Select that folder now?"
                );
                if (!wantsSelection) {
                    this.showLocalFolderRequiredForImportedAsset(normalized);
                    return false;
                }

                if (await this.pickWorkingFolderForLocalSave()) {
                    return true;
                }

                this.showLocalFolderRequiredForImportedAsset(normalized);
                return false;
            }

            if (!supportsDirectoryPicker()) {
                showLocalFolderAccessUnsupportedMessage();
                this.showLocalFolderRequiredForImportedAsset(assetPath);
                return false;
            }

            const normalized = this.normalizeWorkingFolderRelativePath(assetPath) || assetPath;
            const wantsSelection = confirm(
                `This imported sitch references local file "${normalized}", but no Local Sitch Folder is selected.\n\n` +
                "Select that folder now?"
            );
            if (!wantsSelection) {
                this.showLocalFolderRequiredForImportedAsset(normalized);
                return false;
            }

            await this.openDirectory();
            if (this.directoryHandle) {
                return true;
            }

            this.showLocalFolderRequiredForImportedAsset(normalized);
            return false;
        })().finally(() => {
            this._pendingLocalFolderAcquirePromise = null;
        });

        return this._pendingLocalFolderAcquirePromise;
    }

    hasServerBackedSaves() {
        return (getEnvBool("SAVE_TO_SERVER", process.env.SAVE_TO_SERVER) || getEnvBool("SAVE_TO_S3", process.env.SAVE_TO_S3)) && !isServerless;
    }

    ensureSitchBrowser() {
        if (!this.hasServerBackedSaves()) return null;
        if (!this.sitchBrowser) {
            this.sitchBrowser = new CSitchBrowser(this);
            if (Globals.sitchBrowserWillOpen) {
                this.sitchBrowser.pendingOpen = true;
            }
        }
        return this.sitchBrowser;
    }

    ensureBrowseButton(tooltipText) {
        const sitchBrowser = this.ensureSitchBrowser();
        if (!sitchBrowser) return null;
        if (!this.openBrowseController) {
            this.openBrowseController = this.guiServer.add(this, "openBrowseDialog").name(t("file.server.open")).perm();
        }
        this.openBrowseController.tooltip(tooltipText);
        return this.openBrowseController;
    }

    /**
     * Debug: Dumps the root nodes to the console.
     */
    dumpRoots() {
        console.log("");
        console.log(NodeMan.dumpNodes(true));
    }

    /**
     * Debug: Dumps all nodes to the console.
     */
    dumpNodes() {
        console.log("");
        console.log(NodeMan.dumpNodes());
    }

    /**
     * Debug: Dumps all nodes to the console in reverse order.
     */
    dumpNodesBackwards() {
        console.log("");
        console.log(NodeMan.dumpNodesBackwards());
    }

    /**
     * Resets the origin to the current camera position.
     * Updates Sit.lat and Sit.lon, recalculates ECEF positions,
     * and reloads the situation to apply changes.
     */
    resetOrigin() {
        // First, reset the origin to the current camera position
        // This updates Sit.lat and Sit.lon and recalculates ECEF positions
        // resetGlobalOrigin();


        const lookCamera = NodeMan.get("lookCamera").camera;
        const pos = lookCamera.position;

        const LLA = ECEFToLLAVD_radii(pos);

        // Now serialize the sitch to capture the new origin (Sit.lat, Sit.lon)
        // and then deserialize it in memory to reload everything with the new origin
        const sitchString = CustomManager.getCustomSitchString();

        const sitchObject = textSitchToObject(sitchString);

        console.log("Resetting Origin to " + LLA.x + ", " + LLA.y + ", " + 0);
        sitchObject.lat = LLA.x;
        sitchObject.lon = LLA.y;


        // Create a new CSituation object from the parsed sitch object
        // This effectively "reloads" the sitch with the new origin
        setNewSitchObject(sitchObject);
        
        console.log(`Reset Origin initiated: Sit.lat=${Sit.lat}, Sit.lon=${Sit.lon}`);
    }

    /**
     * Updates the UI based on the current sitch type (Custom or Standard).
     * Shows/hides Local and Server save folders accordingly.
     */
    sitchChanged() {
    }

    /**
     * Visually activate one storage folder and deactivate the other.
     * The inactive folder is closed and its title greyed out.
     * @param {"server"|"local"} which - which folder the user just used
     */
    activateStorageFolder(which) {
        if (which === "server" && this.guiServer) {
            this.guiServer.open();
            this.guiServer.domElement.style.color = "";
            if (this.guiLocal) {
                this.guiLocal.close();
                this.guiLocal.setLabelColor("#888");
            }
        } else if (which === "local" && this.guiLocal) {
            this.guiLocal.open();
            this.guiLocal.domElement.style.color = "";
            if (this.guiServer) {
                this.guiServer.close();
                this.guiServer.setLabelColor("#888");
            }
        }
    }

    /**
     * Initiates the server login process.
     * Updates the UI upon successful login.
     */
    loginServer() {
        // asyncCheckLogin().then(() => {
        //     if (Globals.userID > 0) {
        //         this.guiServer.remove(this.loginButton);
        //         this.addServerButtons();
        //     }
        // })

        this.loginAttempt(() => {
            this.loginButton.hide();
            this.addServerButtons()}
        );

    }

    /**
     * Adds server-related buttons (Save, Save As, Open, Delete) to the GUI.
     * Also fetches and populates the list of user's saved sitches from the server.
     */
    addServerButtons() {
        if (!this.hasServerBackedSaves())
            return;

        // During batch screenshotting, skip rebuilding server menus to preserve dropdown order
        if (Globals.screenshotting)
            return;

        this.guiServer.add(this, "saveSitchFromMenu").name(t("file.server.save.label")).perm().tooltip(t("file.server.save.tooltip"));
        this.guiServer.add(this, "saveSitchAs").name(t("file.server.saveAs.label")).perm().tooltip(t("file.server.saveAs.tooltip"));

        this.guiServer.open();

        this.ensureBrowseButton(t("file.server.browseAll"));

        this.versionsList = ["-"];
        this.versionsData = [];
        this.versionName = "-";
        this.guiVersions = this.guiServer.add(this, "versionName", this.versionsList).name(t("file.server.versions.label")).perm().onChange((value) => {
            this.loadVersion(value);
        }).moveAfter(t("file.server.open"))
            .tooltip(t("file.server.versions.tooltip"));

        this.refreshUserSaves();

    }

    refreshUserSaves() {
        // Skip if the sitch browser is about to open — it will fetch and share the data
        if (this.sitchBrowser && this.sitchBrowser.pendingOpen) return;

        fetch(withTestUser(SITREC_SERVER + "getsitches.php?get=myfiles"), {mode: 'cors'}).then(response => {
            if (response.status !== 200) {
                throw new Error(`Server returned status ${response.status}`);
            }
            return response.text();
        }).then(data => {
            const files = JSON.parse(data);
            files.sort((a, b) => {
                return new Date(b[1]) - new Date(a[1]);
            });

            this.userSaves = files.map((file) => {
                return String(file[0]);
            })
            this.userSaves.unshift("-");

            this.refreshVersions();
        }).catch(error => {
            console.error("Could not fetch user files from server (non-critical):", error.message);
        })
    }

    openBrowseDialog() {
        this.activateStorageFolder("server");
        if (this.sitchBrowser) {
            this.sitchBrowser.open();
        }
    }

    captureViewportScreenshot(targetWidth = 1280) {
        const scale = 1; // don't use retina for thumbnails
        ViewMan.computeEffectiveVisibility();

        const nonOverlays = [];
        const overlays = [];
        ViewMan.iterate((id, view) => {
            if (view._effectivelyVisible) {
                if (view.overlayView) {
                    overlays.push(view);
                } else {
                    nonOverlays.push(view);
                }
            }
        });

        // Build capture bounds from currently visible base views.
        // Keep at least the full manager viewport, but expand if any view spills outside.
        let minX = 0;
        let minY = 0;
        let maxX = ViewMan.widthPx * scale;
        let maxY = ViewMan.heightPx * scale;
        for (const view of nonOverlays) {
            if (!view.canvas) continue;
            const x = view.leftPx * scale;
            const y = (view.topPx - ViewMan.topPx) * scale;
            const w = view.widthPx * scale;
            const h = view.heightPx * scale;
            minX = Math.min(minX, x);
            minY = Math.min(minY, y);
            maxX = Math.max(maxX, x + w);
            maxY = Math.max(maxY, y + h);
        }

        const srcWidth = Math.max(1, Math.ceil(maxX - minX));
        const srcHeight = Math.max(1, Math.ceil(maxY - minY));
        const targetHeight = Math.round(targetWidth * srcHeight / srcWidth);

        // Composite all visible views into a full-size canvas (same as viewport video export)
        const fullCanvas = document.createElement("canvas");
        fullCanvas.width = srcWidth;
        fullCanvas.height = srcHeight;
        const fullCtx = fullCanvas.getContext("2d");
        fullCtx.fillStyle = "#000000";
        fullCtx.fillRect(0, 0, srcWidth, srcHeight);

        // Re-render each view so WebGL buffers are fresh (preserveDrawingBuffer is not set)
        const frame = Math.floor(par.frame);
        for (const view of nonOverlays) {
            view.renderCanvas(frame);
            if (view.canvas) {
                const x = view.leftPx * scale - minX;
                const y = (view.topPx - ViewMan.topPx) * scale - minY;
                fullCtx.drawImage(view.canvas, x, y, view.widthPx * scale, view.heightPx * scale);
            }
        }
        for (const view of overlays) {
            const alpha = view.transparency !== undefined ? view.transparency : 1;
            if (alpha <= 0 || !view.canvas) continue;
            // Hidden overlay canvases can retain stale pixels (e.g. old LOADING text).
            // Skip canvases hidden by style to match on-screen output.
            if (view.canvas.style.display === "none" || view.canvas.style.visibility === "hidden") continue;
            view.renderCanvas(frame);
            const parentView = view.overlayView;
            const x = parentView.leftPx * scale - minX;
            const y = (parentView.topPx - ViewMan.topPx) * scale - minY;
            fullCtx.globalAlpha = alpha;
            fullCtx.drawImage(view.canvas, x, y, parentView.widthPx * scale, parentView.heightPx * scale);
            fullCtx.globalAlpha = 1;
        }

        // Scale down to target size
        const thumbCanvas = document.createElement("canvas");
        thumbCanvas.width = targetWidth;
        thumbCanvas.height = targetHeight;
        const thumbCtx = thumbCanvas.getContext("2d");
        thumbCtx.drawImage(fullCanvas, 0, 0, targetWidth, targetHeight);

        return new Promise(resolve => {
            thumbCanvas.toBlob(blob => resolve(blob), "image/jpeg", 0.65);
        });
    }

    bumpScreenshotVersion(sitchName) {
        return fetch(withTestUser(SITREC_SERVER + "metadata.php"), {
            method: "POST", mode: "cors",
            headers: {"Content-Type": "application/json"},
            body: JSON.stringify({bumpScreenshotVersions: [sitchName]}),
        }).catch(err => console.warn("Failed to bump screenshot version:", err));
    }

    async refreshScreenshots(sitchNames) {
        // Skip sitches labeled as Deleted
        if (this.sitchBrowser) {
            sitchNames = sitchNames.filter(n => !this.sitchBrowser._sitchHasLabel(n, "Deleted"));
        }
        const total = sitchNames.length;
        if (total === 0) {
            alert("No sitches to refresh (all are labeled Deleted).");
            return;
        }
        if (!confirm(`Refresh thumbnails for ${total} sitch(es)?\n\nThis will load each one, render it, and upload a new screenshot.\n\nContinue?`)) {
            return;
        }

        // Refreshing the current user's screenshots, so clear any stale source user override
        this.sourceUserID = null;
        console.log(`Refreshing screenshots for ${total} sitches...`);
        Globals.screenshotting = true;
        const results = {done: [], failed: []};

        const originalConsoleError = console.error;
        let capturedError = null;
        console.error = function (...args) {
            originalConsoleError.apply(console, args);
            if (!capturedError) capturedError = args.join(' ');
        };

        for (let i = 0; i < sitchNames.length; i++) {
            const sitchName = sitchNames[i];
            let latestVersion = "(unknown)";
            capturedError = null;
            console.log(`\n[${i + 1}/${total}] Loading: ${sitchName}`);

            try {
                const versions = await this.getVersions(sitchName);
                if (!versions || versions.length === 0) throw new Error("No versions found");
                latestVersion = versions[versions.length - 1].url;

                const response = await fetch(latestVersion);
                const data = await response.arrayBuffer();
                const decoder = new TextDecoder('utf-8');
                let sitchObject = textSitchToObject(decoder.decode(data));

                if (sitchObject.terrainUI) {
                    sitchObject.terrainUI.mapType = "Local";
                    sitchObject.terrainUI.elevationType = "Local";
                } else if (sitchObject.terrain) {
                    sitchObject.terrain.mapType = "Local";
                    sitchObject.terrain.elevationType = "Local";
                }

                setNewSitchObject(sitchObject);

                await new Promise(resolve => {
                    const check = () => {
                        if (Globals.newSitchObject === undefined) resolve();
                        else setTimeout(check, 100);
                    };
                    check();
                });

                const targetFrame = Math.floor(par.frame);
                const savedPaused = par.paused;
                const renderAtTargetFrame = async () => {
                    par.frame = targetFrame;

                    // Keep requesting the exact target frame so video decode/cache converges
                    // even when playback is paused during screenshot generation.
                    for (const entry of Object.values(NodeMan.list)) {
                        const node = entry.data;
                        if (node.videoData && typeof node.videoData.getImage === "function") {
                            node.videoData.getImage(targetFrame);
                        }
                    }

                    setRenderOne(true);
                    await new Promise(resolve => requestAnimationFrame(resolve));
                };

                par.paused = true;
                par.frame = targetFrame;
                setRenderOne(true);

                try {
                    // Wait for all pending async operations (terrain tiles, 3D tiles, video, etc.)
                    await waitForExportFrameSettled({
                        frame: targetFrame,
                        maxWaitMs: 60000,
                        renderFrame: renderAtTargetFrame,
                        logPrefix: "Screenshot refresh",
                    });

                    if (capturedError) throw new Error(`console.error during load: ${capturedError}`);

                    const blob = await this.captureViewportScreenshot();
                    if (!blob) throw new Error("Screenshot capture returned null");
                    const buffer = await blob.arrayBuffer();
                    const url = await this.rehoster.rehostFile(sitchName, buffer, "screenshot.jpg", {skipHash: true});
                    await this.bumpScreenshotVersion(sitchName);
                    console.log(`  Screenshot saved: ${url}`);
                    results.done.push(sitchName);
                } finally {
                    par.paused = savedPaused;
                    setRenderOne(true);
                }

            } catch (error) {
                console.error(`  FAILED: ${sitchName} - ${error.message}`);
                results.failed.push(sitchName);
            }
        }

        console.error = originalConsoleError;
        Globals.screenshotting = false;
        const failedMsg = results.failed.length > 0 ? `\nFailed: ${results.failed.join(', ')}` : '';
        console.log(`\nScreenshot refresh complete. Done: ${results.done.length}, Failed: ${results.failed.length}`);
        alert(`Screenshot refresh complete!\n\nRefreshed: ${results.done.length}\nFailed: ${results.failed.length}${failedMsg}`);
    }

    /**
     * Adds a file entry to the manager. Overrides parent for debugging purposes.
     * @param {string} id - Unique identifier for the file entry
     * @param {*} data - The parsed file data
     * @param {ArrayBuffer} original - The original raw file data
     */
    add(id, data, original) {
        super.add(id, data, original);
    }

    /**
     * Resets the application to a new blank "custom" situation.
     * Reloads the page with ?action=new to create a fresh sitch.
     */
    newSitch() {
        this.clearLocalSitchContext();
        this.localSaveTargetArmed = false;
        // we just jump to the "custom" sitch, which is a blank sitch
        // that the user can modify and save
        // doing it as a URL to ensure a clean slate
        window.location = SITREC_APP + "?action=new";
    }

    /**
     * Fetches all saved versions of a sitch from the server.
     * @param {string} name - The name of the sitch to get versions for
     * @returns {Promise<Array<{version: string, ref: string, url?: string}>>}
     * Array of version objects normalized to always include `ref`.
     * `url` is retained for backwards compatibility with older server responses.
     */
    getVersions(name) {
        let url = SITREC_SERVER + "getsitches.php?get=versions&name=" + name;
        if (this.sourceUserID) {
            url += "&userid=" + this.sourceUserID;
        }
        return fetch(withTestUser(url), {mode: 'cors'}).then(response => {
            if (response.status !== 200) {
                throw new Error(`Server returned status ${response.status}`);
            }
            return response.text();
        }).then(data => {
//            console.log("versions: " + data)
            this.versions = JSON.parse(data).map(version => ({
                ...version,
                ref: version.ref || version.url
            })); // will give an array of local files
            if (this.versions.length > 0) {
                console.log("Parsed Versions ref \n" + this.versions[0].ref)
            }


            // this.userVersions = this.versions.map((version) => {
            //     return version.version;
            // });
            //
            // // add a "-" to the start of the userVersions array, so we can have a blank entry
            // this.userVersions.unshift("-");
            //
            // // update this.guiVersions
            //
            // // I think this is not having an effect as we reload the page with the new URL
            // // so we need to build this later, when the page has reloaded
            //
            // this.guiVersions.options = this.userVersions;
            // this.guiVersions.setValue(this.userVersions[0]); // set the first value as the default
            // this.guiVersions.updateDisplay(); // update the display to show the new options
            //

            return this.versions;
        }).catch(error => {
            console.error("Error fetching versions from server:", error);
            throw error; // re-throw so the caller can handle it
        })
    }

    /**
     * Deletes a saved sitch from the server after user confirmation.
     * Updates the GUI dropdowns to remove the deleted entry.
     * @param {string} value - The name of the sitch to delete
     */
    deleteSitch(value) {
        // get confirmation from the user
        if (!confirm("Are you sure you want to delete " + value + " from the server?")) {
            return;
        }


        console.log("Staring to deletet " + value + " from the server");
        this.rehoster.deleteFilePromise(value).then(() => {
            console.log("Deleted " + value)
            this.deleteName = "-";
            if (this.loadName === value) {
                this.loadName = "-";
            }
            if (this.loadNameAlphabetical === value) {
                this.loadNameAlphabetical = "-";
            }
            // the remove calls will also update the GUI
            // to account for the "-" selection
            if (this.guiLoad) removeOptionFromGUIMenu(this.guiLoad, value);
            if (this.guiLoadAlphabetical) removeOptionFromGUIMenu(this.guiLoadAlphabetical, value);
            if (this.guiDelete) removeOptionFromGUIMenu(this.guiDelete, value);
        });

    }

    /**
     * Loads the most recent version of a saved sitch from the server.
     * Fetches the sitch file, parses it, and initializes a new situation with it.
     * @param {string} name - The name of the sitch to load
     * @param {string|null} [sourceUserID=null] - Optional owner user ID for cross-user shared sitches.
     * If provided, version listing and latest-resolution are performed against that owner's folder.
     */
    loadSavedFile(name, sourceUserID = null) {
        this.clearLocalSitchContext();
        this.localSaveTargetArmed = false;
        this.loadName = name;
        // If a sourceUserID is provided (e.g. loading a featured sitch), use it;
        // otherwise clear any stale override (e.g. from a ?custom=S3-URL at page load)
        this.sourceUserID = sourceUserID;
        console.log("Load Local File")
        console.log(this.loadName);

        if (this.loadName === "-") {
            this.updateVersionsDropdown([]);
            return;
        }

        this.getVersions(this.loadName).then((versions) => {
            this.updateVersionsDropdown(versions);

            if (!versions || versions.length === 0) {
                console.error("No versions found for " + name);
                return;
            }

            const latestVersion = versions[versions.length - 1];
            const latestRef = latestVersion.ref || latestVersion.url;
            console.log("Loading " + name + " version " + latestRef)

            this.loadURL = latestRef;
            resolveURLForFetch(latestRef).then(fetchUrl => fetch(fetchUrl)).then(response => response.arrayBuffer()).then(data => {
                console.log("Loaded " + name + " version " + latestRef)

                const decoder = new TextDecoder('utf-8');
                const decodedString = decoder.decode(data);

                let sitchObject = textSitchToObject(decodedString);

                setNewSitchObject(sitchObject);
            })
        })
    }

    /**
     * Rebuilds the versions dropdown from server data.
     *
     * Each version entry may include both `ref` and `url`; display labels are derived from `version`.
     *
     * @param {Array<{version: string, ref?: string, url?: string}>} versions
     * @returns {void}
     */
    updateVersionsDropdown(versions) {
        if (!this.guiVersions) return;
        
        while (this.versionsList.length > 1) {
            removeOptionFromGUIMenu(this.guiVersions, this.versionsList[this.versionsList.length - 1]);
            this.versionsList.pop();
        }
        
        this.versionsData = versions;
        
        for (let i = versions.length - 1; i >= 0; i--) {
            const v = versions[i];
            const versionFile = v.version;
            const dateMatch = versionFile.match(/(\d{4}-\d{2}-\d{2})_(\d{2})-(\d{2})-(\d{2})/);
            let displayName;
            if (dateMatch) {
                displayName = `${dateMatch[1]} ${dateMatch[2]}:${dateMatch[3]}:${dateMatch[4]}`;
            } else {
                displayName = versionFile.replace(/\.sitch\.js$/, '');
            }
            if (i === versions.length - 1) {
                displayName += " (latest)";
            }
            this.versionsList.push(displayName);
            addOptionToGUIMenu(this.guiVersions, displayName, displayName);
        }
        
        this.setVersionFromLoadURL();
    }
    
    /**
     * Selects the active dropdown entry based on the current `loadURL`.
     *
     * Comparison uses canonicalized refs (`sitrec://...`) so legacy URLs, raw keys, and canonical refs
     * all map to the same version entry.
     *
     * @returns {void}
     */
    setVersionFromLoadURL() {
        if (!this.guiVersions || !this.loadURL || !this.versionsData.length) {
            this.versionName = "-";
            this.guiVersions?.updateDisplay();
            return;
        }
        
        const decodedLoadURL = decodeURIComponent(toCanonicalSitrecRef(this.loadURL));
        for (let i = 0; i < this.versionsData.length; i++) {
            const decodedVersionURL = decodeURIComponent(toCanonicalSitrecRef(this.versionsData[i].ref || this.versionsData[i].url));
            if (decodedVersionURL === decodedLoadURL) {
                const versionIndex = this.versionsData.length - 1 - i;
                this.versionName = this.versionsList[versionIndex + 1];
                this.guiVersions.updateDisplay();
                return;
            }
        }
        
        this.versionName = "-";
        this.guiVersions.updateDisplay();
    }

    /**
     * Loads a specific saved version selected from the versions dropdown.
     *
     * If the entry is an object reference, it is resolved to a temporary fetch URL before loading.
     *
     * @param {string} displayName - Dropdown label from `versionsList`.
     * @returns {void}
     */
    loadVersion(displayName) {
        if (displayName === "-" || !this.versionsData.length) return;
        this.activateStorageFolder("server");
        this.clearLocalSitchContext();
        this.localSaveTargetArmed = false;
        
        const index = this.versionsList.indexOf(displayName);
        if (index <= 0) return;
        
        const versionIndex = this.versionsData.length - index;
        const versionData = this.versionsData[versionIndex];
        
        if (!versionData) return;
        
        const versionRef = versionData.ref || versionData.url;
        console.log("Loading version: " + versionData.version + " from " + versionRef);
        
        this.loadURL = versionRef;
        resolveURLForFetch(versionRef).then(fetchUrl => fetch(fetchUrl)).then(response => response.arrayBuffer()).then(data => {
            console.log("Loaded version " + versionData.version)

            const decoder = new TextDecoder('utf-8');
            const decodedString = decoder.decode(data);

            let sitchObject = textSitchToObject(decodedString);

            setNewSitchObject(sitchObject);
        })
    }

    /**
     * Prompts the user to enter a name for the sitch via a browser dialog.
     * @returns {Promise<void>} Resolves when user enters a valid name (sets Sit.sitchName), rejects if cancelled
     */
    inputSitchName() {
        return promptForText({
            confirmLabel: "Save",
            defaultValue: Sit.sitchName ?? "",
            message: "Enter a name for the sitch",
            title: "Save Sitch",
            validate: (rawName) => sanitizeSitchName(rawName) === ""
                ? "Enter a valid sitch name."
                : "",
        }).then((sitchName) => {
            if (sitchName === null) {
                throw "Sitch Name Cancelled";
            }

            Sit.sitchName = sanitizeSitchName(sitchName);
            console.log("Sitch name set to " + Sit.sitchName);
        });
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

    refreshVersions() {
        // During early startup, Sit may not be initialized yet.
        if (!Sit?.sitchName) return Promise.resolve();
        return this.getVersions(Sit.sitchName).then((versions) => {
            this.updateVersionsDropdown(versions);
        }).catch((error) => {
            console.warn("Failed to refresh versions:", error);
        });
    }

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
    }

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
    }

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

    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

    /**
     * Update the Local GUI section to reflect current working folder state.
     */
    updateLocalGUI() {
        if (!this.guiLocal) return;
        if (this.isDesktopLocalFsAvailable()) {
            this.guiLocal.title(t("file.local.title"));

            if (this._localStatusController && this._localStatus) {
                this._localStatus.value = this.localSitchEntry
                    ? t("file.local.currentFile", {name: this.localSitchEntry.name})
                    : t("file.local.noFileSelected");
                this._localStatusController.updateDisplay();
            }

            if (this._openLocalSitchController) {
                this._openLocalSitchController
                    .name(t("file.local.openLocal.labelShort"))
                    .tooltip(this.localSitchEntry
                        ? t("file.local.openLocal.tooltipCurrent", {name: this.localSitchEntry.name})
                        : t("file.local.openLocal.tooltipDesktop"));
            }

            if (this._saveLocalController) {
                this._saveLocalController
                    .name(t("file.local.saveLocal.label"))
                    .tooltip(this.localSaveTargetArmed && this.localSitchEntry
                        ? t("file.local.saveLocal.tooltipSaveBack", {name: this.localSitchEntry.name})
                        : t("file.local.saveLocal.tooltipSaveTo"));
            }

            if (this._saveLocalAsController) {
                this._saveLocalAsController
                    .name(t("file.local.saveLocalAs.label"))
                    .tooltip(t("file.local.saveLocalAs.tooltipNewPath"));
            }

            return;
        }

        const hasWorkingFolder = !!this.directoryHandle;

        // Update folder title to show working folder name
        if (hasWorkingFolder) {
            this.guiLocal.title(t("file.local.titleWithFolder", {name: this.directoryHandle.name}));
        } else if (this._pendingHandle) {
            this.guiLocal.title(t("file.local.titleReconnect", {name: this._pendingHandle.name}));
        } else {
            this.guiLocal.title(t("file.local.title"));
        }

        // Show/hide reconnect button
        if (this._reconnectController) {
            const show = !!this._pendingHandle && !this.directoryHandle;
            // Toggle only the reconnect row.
            this._reconnectController.domElement.style.display = show ? "" : "none";
        }

        if (this._localStatusController && this._localStatus) {
            const folderName = this.directoryHandle?.name || this._pendingHandle?.name || "None";
            let state;
            if (this.directoryHandle) {
                state = t("file.local.stateReady");
            } else if (this._pendingHandle) {
                state = t("file.local.stateReconnect");
            } else {
                state = t("file.local.stateNoFolder");
            }

            const targetName = this.localSaveTargetArmed && this.localSitchEntry
                ? this.localSitchEntry.name
                : "none";
            this._localStatus.value = t("file.local.statusLine", {state, folder: folderName, target: targetName});
            this._localStatusController.updateDisplay();
        }

        if (this._openLocalFolderController) {
            this._openLocalFolderController.name(t("file.local.selectFolder.label"));
        }

        if (this._openLocalSitchController) {
            this._openLocalSitchController.domElement.style.display = hasWorkingFolder ? "" : "none";
            if (hasWorkingFolder) {
                this._openLocalSitchController.tooltip(t("file.local.openLocal.tooltipFromFolder", {folder: this.directoryHandle.name}));
            } else {
                this._openLocalSitchController.tooltip(t("file.local.openLocal.tooltipFolder"));
            }
        }

        if (this._saveLocalController) {
            this._saveLocalController.domElement.style.display = hasWorkingFolder ? "" : "none";
            if (hasWorkingFolder) {
                this._saveLocalController
                    .name(t("file.local.saveLocal.label"))
                    .tooltip(this.localSaveTargetArmed && this.localSitchEntry
                        ? t("file.local.saveLocal.tooltipSaveBackInFolder", {name: this.localSitchEntry.name, folder: this.directoryHandle.name})
                        : t("file.local.saveLocal.tooltipSaveInto", {folder: this.directoryHandle.name}));
            } else if (this.localSitchEntry && this.localSaveTargetArmed) {
                this._saveLocalController
                    .name(t("file.local.saveLocal.label"))
                    .tooltip(t("file.local.saveLocal.tooltipSaveBack", {name: this.localSitchEntry.name}));
            } else {
                this._saveLocalController
                    .name(t("file.local.saveLocal.label"))
                    .tooltip(t("file.local.saveLocal.tooltipPrompt"));
            }
        }

        if (this._saveLocalAsController) {
            this._saveLocalAsController.domElement.style.display = hasWorkingFolder ? "" : "none";
            if (hasWorkingFolder) {
                this._saveLocalAsController.tooltip(t("file.local.saveLocalAs.tooltipInFolder"));
            } else {
                this._saveLocalAsController.tooltip(t("file.local.saveLocalAs.tooltipFolder"));
            }
        }
    }

    /**
     * Checks if a file needs to be rehosted. A file is unhosted if it's a dynamic link without a static URL.
     * @param {string} id - The file identifier to check
     * @returns {boolean} True if the file needs rehosting
     */
    isUnhosted(id) {
        const f = this.list[id];
        assert(f, `Checking unhosted on missing file, id =${id}`);
        return (f.dynamicLink && !f.staticURL);
    }

    /**
     * Initiates login to Metabunk Xenforo (if not logged in)
     * Opens login window and sets up focus listener to detect completion.
     * @param {Function} [callback] - Function to call after successful login
     * @param {Object} [button] - GUI button to update after login
     * @param {string} [rename="Permalink"] - New name for the button after login
     * @param {string} [color="#FFFFFF"] - New color for the button label after login
     */
    loginAttempt(callback, button, rename = "Permalink", color="#FFFFFF") {
        asyncCheckLogin().then(() => {

            // if we are alreayd logged in, then don't need to open the login window
            if (getEffectiveUserID() > 0) {
                if (button !== undefined) {
                    button.name(rename).setLabelColor(color)
                }
                if (callback !== undefined)
                    callback();
                return ;
            }


// open the login URL in a new window
// the redirect takes that tab to a lightweight success page in this current SitRec instance
            const forumOrigin = (Globals.env && Globals.env.SITREC_FORUM_ORIGIN)
                ? Globals.env.SITREC_FORUM_ORIGIN
                : window.location.origin;
            const redirectUrl = new URL("sitrecServer/successfullyLoggedIn.html", SITREC_APP).toString();
            const loginUrl = new URL("/login", forumOrigin);
            loginUrl.searchParams.set("_xfRedirect", redirectUrl);
            window.open(loginUrl.toString(), "_blank");

// When the current window regains focus, we'll check if we are logged in
// and if we are, we'll make the permalink
            window.addEventListener('focus', () => {
                asyncCheckLogin().then(() => {
                    console.log("After Ridirect, Logged in as " + getEffectiveUserID())
                    if (getEffectiveUserID() > 0) {
                        // just change the button text
                        if (button !== undefined) {
                            console.log("Changing button name to " + rename)
                            button.name(rename).setLabelColor(color)
                        }
                        if (callback !== undefined) {
                            console.log("Calling callback after login")
                            callback();
                        }
                    }
                });
            });

        })
    }


    /**
     * Create an Export GUI button inside a per-object subfolder, lazily creating folders as needed.
     *
     * Behavior and side effects:
     * - Ensures a top-level "Export" folder exists on the file manager GUI (this.exportFolder).
     * - Ensures the provided object has an attached subfolder (object.exportSubFolder) named by folderName.
     * - Adds a button/controller that triggers object[functionName] when clicked and labels it with exportType.
     * - Returns the created controller so callers can further customize or keep a reference if desired.
     *
     * Notes:
     * - Reuses existing folders if already created, so repeated calls are idempotent w.r.t. folder creation.
     * (i.e. multiple calls for the same object and folderName will not create duplicate folders.)
     * - The object is decorated with an exportSubFolder property for later cleanup via removeExportButton().
     *
     * @param {object} object - The target object that owns the export action method.
     * @param {string} functionName - The exportType of the method on object to invoke when the button is pressed.
     * @param {string} exportType - The visible label for the button in the GUI.
     * @param {string} folderName - The label for the object's subfolder within the top-level Export folder.
     * @returns {*} The GUI controller created by .add(object, functionName).
     */
    makeExportButton(object, functionName, exportType, folderName) {
        if (this.exportFolder === undefined) {
            this.exportFolder = this.guiFolder.addFolder("Export").perm().close();
        }

        // Some common folder names
        if (folderName === "LOSTraverseSelectTrack")
            folderName = "Traversal of the Lines of Sight";

        if (folderName === "JetLOSCameraCenter")
            folderName = "Lines of Sight"


        // we need a subfolder with the title <folderName>
        // decorate the object with an exportSubFolder property
        if (object.exportSubFolder === undefined) {
            object.exportSubFolder = this.exportFolder.addFolder(folderName).perm().close()
                .tooltip("Export options for " + folderName);

        }

        let tooltip = exportType ? exportType : "";

        // see if the function provides a description
        const inspect = object[functionName](true);

        // some legacy sitches (GoFast) have some empty arrays
        // or otherwise not exportable
        if (inspect === null) {
            return null;
        }

        assert(inspect !== undefined, `makeExportButton: Expected inspect info from ${functionName} on ${folderName}`);
        tooltip += inspect.desc;

        if (inspect.csv) {
            const csv = inspect.csv;
            const header = csv.split("\n")[0];
            const row = csv.split("\n")[1];

            tooltip += "\n\nHeader and Example Row:\n" + header;
            tooltip += "\n" + row;
        }

        if (inspect.json) {
            const jsonExample = JSON.stringify(inspect.json, null, 2).substring(0, 200) + "...";
            tooltip += "\nExample JSON: " + jsonExample;
        }

        return object.exportSubFolder.add(object, functionName).name(inspect.desc)
            .tooltip(tooltip);

    }

    /**
     * Removes all export buttons and the subfolder for an object from the Export GUI.
     * @param {Object} object - The object whose export buttons should be removed
     */
    removeExportButton(object) {
        if (this.exportFolder !== undefined) {
            if (object.exportButtons !== undefined) {
                for (let i = 0; i < object.exportButtons.length; i++) {
                    object.exportButtons[i].destroy();
                }
                object.exportButtons = undefined;
            }
            if (object.exportSubFolder !== undefined) {
                object.exportSubFolder.destroy();
                object.exportSubFolder = undefined;
            }
        }
    }

    /**
     * Selects a working folder for local save/load operations.
     * Does not auto-load any sitch file.
     * @async
     */
    async openDirectory() {
        this.activateStorageFolder("local");
        if (this.isDesktopLocalFsAvailable()) {
            try {
                const desktopFs = getDesktopFileSystemBridge();
                const selection = await desktopFs.chooseFolder({
                    defaultPath: this.directoryHandle?.path || undefined,
                });
                if (!selection) {
                    return;
                }

                this.directoryHandle = createDesktopDirectoryHandle(selection.path);
                this._pendingHandle = null;
                this._pendingSitchFilename = null;
                this.localSitchEntry = null;
                this.localSaveTargetArmed = false;
                this.clearLocalSitchContext();
                this.lastLocalSitchBuffer = undefined;
                this.localSitchBuffer = undefined;

                await this.persistWorkingFolder();
                this.updateLocalGUI();
                return;
            } catch (err) {
                if (!isAbortLikeError(err)) {
                    console.warn("openDirectory() desktop error", err.name, err.message);
                }
                return;
            }
        }

        if (!supportsDirectoryPicker()) {
            showLocalFolderAccessUnsupportedMessage();
            return;
        }
        try {
            // Prompt for the directory with readwrite access
            this.directoryHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
            this._pendingHandle = null;
            this._pendingSitchFilename = null;
            // Selecting a folder alone should not imply a current sitch file target.
            this.localSitchEntry = null;
            this.localSaveTargetArmed = false;
            this.lastLocalSitchBuffer = undefined;
            this.localSitchBuffer = undefined;

            // Persist the working folder for future sessions
            await this.persistWorkingFolder();
            this.updateLocalGUI();

        } catch (err) {
            if (!isAbortLikeError(err)) {
                console.warn("openDirectory() error", err.name, err.message);
            }
        }
    }

    /**
     * Opens a sitch file from the current working folder.
     * Useful when a folder contains multiple local sitches.
     * @async
     */
    async openLocalSitch() {
        this.activateStorageFolder("local");
        if (this.isDesktopLocalFsAvailable()) {
            try {
                const desktopFs = getDesktopFileSystemBridge();
                const selection = await desktopFs.openFile({
                    defaultPath: this.directoryHandle?.path || this.localSitchEntry?.path || undefined,
                    filters: [
                        {
                            name: "Sitrec Files",
                            extensions: ["json", "js"],
                        },
                    ],
                });

                if (!selection) {
                    return;
                }

                await this.hydrateDesktopWorkingFolder(null, selection.path);
                console.log("User selected desktop local sitch:", this.localSitchEntry?.name);
                await this.persistWorkingFolder();
                this.updateLocalGUI();
                await this.checkForNewLocalSitch();
            } catch (err) {
                if (!isAbortLikeError(err)) {
                    console.warn("openLocalSitch() desktop error", err.name, err.message);
                }
            }
            return;
        }

        if (!supportsOpenFilePicker()) {
            showLocalFolderAccessUnsupportedMessage();
            return;
        }
        if (!this.directoryHandle && this._pendingHandle) {
            await this.reconnectWorkingFolder({loadSitch: false});
            if (!this.directoryHandle) {
                return;
            }
        }

        if (!this.directoryHandle) {
            console.warn("No working folder selected. Use 'Select Local Sitch Folder' first.");
            return;
        }

        if (!(await this.ensureWorkingFolderWriteAccess())) {
            return;
        }

        try {
            const [fileHandle] = await window.showOpenFilePicker({
                startIn: this.directoryHandle,
                multiple: false,
                types: [
                    {
                        description: "JSON or JS files",
                        accept: {
                            "application/json": [".json"],
                            "text/javascript": [".js"]
                        }
                    }
                ]
            });

            this.localSitchEntry = fileHandle;
            console.log("User selected local sitch:", this.localSitchEntry.name);
            await this.persistWorkingFolder();
            this.updateLocalGUI();
            await this.checkForNewLocalSitch();
        } catch (err) {
            if (!isAbortLikeError(err)) {
                console.warn("openLocalSitch() error", err.name, err.message);
            }
        }
    }


    /**
     * Checks if the local sitch file has changed since last load and parses it if so.
     * Used to detect external edits to the sitch file.
     * @async
     */
    async checkForNewLocalSitch() {
        if (!this.localSitchEntry) {
            return;
        }

        // load the local sitch and see if it has changed
        const file = await this.localSitchEntry.getFile();
        this.localSitchBuffer = await file.arrayBuffer();
//        console.log("CHECKING CONTENTS OF Local Sitch " + file.name);

        if (this.lastLocalSitchBuffer === undefined ||
            !areArrayBuffersEqual(this.lastLocalSitchBuffer, this.localSitchBuffer)) {
            this.localSaveTargetArmed = true;
            this.markLocalSitchContextActive();
            this.lastLocalSitchBuffer = this.localSitchBuffer;
            this.parseResult(file.name, this.localSitchBuffer);
            this.updateLocalGUI();
        }

        // This was for when we were continually loading the local sitch
        // and seeing if it changed, but it's not needed now
        // as we only load it once
    //    setTimeout(() => this.checkForNewLocalSitch(), 500);
    }


    /**
     * Opens a file selector dialog and processes each selected file.
     * Supports multiple file selection for various file types (video, audio, images, data files).
     * @param {Function} processFile - Callback function to process each selected File object
     */
    selectAndLoadLocalFile(processFile) {
        // Create an input element
        const inputElement = document.createElement('input');

        // Set its type to 'file'
        inputElement.type = 'file';
        
        // Allow multiple file types including videos, audio and images for better mobile support
        inputElement.accept = 'video/*,audio/*,image/*,.kml,.kmz,.csv,.json,.geojson,.sitch,.txt,.xml,.srt,.ts,.m2ts,.mts,.zip,.mp3,.m4a,.aac,.wav,.ogg,.flac,.webm,.aif,.aiff,.caf';
        
        // Allow multiple files
        inputElement.multiple = true;

        // Listen for changes on the input element
        inputElement.addEventListener('change', (event) => {
            const files = event.target.files;
            if (files && files.length > 0) {
                // Process each selected file
                for (let i = 0; i < files.length; i++) {
                    processFile(files[i]);
                }
            }

            // Remove the input element after use
            inputElement.remove();

        });
        
        // Add to body to ensure proper interaction on iOS
        document.body.appendChild(inputElement);

        // Trigger a click event on the input element
        inputElement.click();

    }

    // Direct file rehosting is deprecated
    // files are now rehosted as needed when they are used in the sitch
    // rehostFile() {
    //     this.selectAndLoadLocalFile( (file) => {
    //         const reader = new FileReader();
    //
    //         // Listen for the 'load' event on the FileReader
    //         reader.addEventListener('load', () => {
    //
    //             this.rehoster.rehostFile(file.name, reader.result).then(rehostResult => {
    //                 console.log("Imported File Rehosted as " + rehostResult);
    //                 // display an alert with the new URL so the user can copy it
    //                 //alert(rehostResult);
    //                 createCustomModalWithCopy(rehostResult)();
    //
    //             });
    //
    //         });
    //
    //         // Read the file as an array buffer (binary data)
    //         reader.readAsArrayBuffer(file);
    //     })
    // }

    /**
     * GUI menu handler for importing files. Opens file selector and processes files via DragDropHandler.
     */
    importFile() {
        this.selectAndLoadLocalFile( (file) => {
            DragDropHandler.uploadDroppedFile(file)
        })
    }


    /**
     * Private map of currently loading promises to prevent duplicate loads.
     * Keyed by filename.
     */
    #loadingPromises = new Map();

    /**
     * Loads and parses an asset file, adding it to the manager.
     * Handles caching, deduplication of concurrent requests, and URL resolution.
     * For programmatic loading where the caller handles the result (does NOT call handleParsedFile).
     * 
     * Filename prefixes:
     * - "!" prefix marks as dynamic link (needs rehosting on save)
     * - "data/" prefix is stripped automatically
     *
     * Resolver-aware sources:
     * - Canonical object refs: `sitrec://<userId>/...`
     * - Raw object keys: `<userId>/...`
     * - Legacy S3 URLs containing Sitrec keys
     * 
     * @param {string} filename - Path, URL, or local filename to load
     * @param {string} [id] - Unique identifier for storage (defaults to filename)
     * @returns {Promise<{filename: string, parsed: *, dataType: string}>} Parsed asset data
     */
    loadAsset(filename, id) {

        assert(filename, "Filename is undefined or null");

        // if it starts with data/ then strip that off
        if (filename.startsWith("data/")) {
            filename = filename.substring(5);
        }

        var dynamicLink = false;
        if (filename.startsWith("!")) {
            filename = filename.substring(1);
            dynamicLink = true;
        }

        // If we don't have an id, then the id used will be the filename
        // so see if already loaded
        if (id === undefined) {
            if (this.exists(filename)) {
                return Promise.resolve(this.get(filename));
            }
            id = filename; // Fallback to use filename as id if id is undefined
        }

        // If the asset is already loaded, return it immediately
        if (this.exists(id)) {
            return Promise.resolve({filename: filename, parsed: this.list[id].data});
        }

        // Check if this file is already being loaded (by filename)
        // If so, return the existing promise to avoid duplicate loading
        const loadingKey = `${filename}`;
        if (this.#loadingPromises.has(loadingKey)) {
            console.log(`Asset ${filename} is already being loaded, reusing existing promise`);
            return this.#loadingPromises.get(loadingKey).then(parsedAsset => {
                if (parsedAsset === null) return null;
                // If the requested ID is different from the one being loaded,
                // we'll need to add a new entry with the requested ID
                if (parsedAsset.id !== id && !this.exists(id)) {
                    this.add(id, this.list[parsedAsset.id].data, this.list[parsedAsset.id].original);
                    this.list[id].dynamicLink = this.list[parsedAsset.id].dynamicLink;
                    this.list[id].staticURL = this.list[parsedAsset.id].staticURL;
                    this.list[id].dataType = this.list[parsedAsset.id].dataType;
                    this.list[id].filename = filename;
                }
                return {filename: filename, parsed: this.list[id].data};
            });
        }

        // Check if this file has already been loaded with a different ID
        var existingId = null;
        this.iterate((key, parsed) => {
            const f = this.list[key];
            if (f.filename === filename) {
                existingId = key;
                console.log(`File ${filename} already loaded with ID ${key}, requested with ID ${id}`);
            }
        });
        
        // If the file exists with a different ID, create a new entry with the requested ID
        if (existingId) {
            this.add(id, this.list[existingId].data, this.list[existingId].original);
            this.list[id].dynamicLink = this.list[existingId].dynamicLink;
            this.list[id].staticURL = this.list[existingId].staticURL;
            this.list[id].dataType = this.list[existingId].dataType;
            this.list[id].filename = filename;
            return Promise.resolve({filename: filename, parsed: this.list[id].data});
        }


        // // if we are going to try to load it,
        // assert(!this.exists(id), "Asset " + id + " already exists");

        let loadingPromise;
        const loadingId = `asset-${id}-${Date.now()}`;
        LoadingManager.registerLoading(loadingId, filename, "Asset");

        const loadViaDefaultAssetResolution = (sourceFilename) => {
            let resolvedFilename = sourceFilename;

            // if not a local file, then it's a URL
            // either a dynamic link (like to the current Starlink TLE) or a static link
            // so fetch it and parse it

            // Sitrec references (sitrec://, raw object key, legacy S3 URL) are resolved via object.php.
            const isResolvableRef = isResolvableSitrecReference(resolvedFilename);
            var isUrl = isHttpOrHttps(resolvedFilename);
            if (!isUrl && !isResolvableRef) {
                // legacy sitches have videos specified as: "../sitrec-videos/public/2 - Gimbal-WMV2PRORES-CROP-428x428.mp4"
                // and in that case it's relative to SITREC_APP wihtout the data folder
                if (resolvedFilename.startsWith("../sitrec-videos/")) {
                    resolvedFilename = SITREC_APP + resolvedFilename;
                } else {
                    // if it's not a url, then redirect to the data folder
                    resolvedFilename = SITREC_APP + "data/" + resolvedFilename;
                }
            } else if (isUrl) {
                // if it's a URL, we need to check if it's got a "localhost" in it
                // Regardless of whether we are on local or not
                // add the SITREC_DOMAIN to the start of the URL
                // this is a patch to keep older localhost files compatible with the deployed
                // and with the new local.metabunk.org
                if (resolvedFilename.startsWith("https://localhost/")) {
                    resolvedFilename = SITREC_DOMAIN + "/" + resolvedFilename.slice(18);
                    console.log("Redirecting debug local URL to " + resolvedFilename);
                }

                // same for https://local.metabunk.org/
                if (!isLocal && resolvedFilename.startsWith("https://local.metabunk.org/")) {
                    resolvedFilename = SITREC_DOMAIN + "/" + resolvedFilename.slice(27);
                    console.log("Redirecting debug local URL to " + resolvedFilename);
                }

                // and the specified LOCALHOST env var
                if (!isLocal && resolvedFilename.startsWith(getEnv("LOCALHOST", process.env.LOCALHOST))) {
                    resolvedFilename = SITREC_DOMAIN + "/" + resolvedFilename.slice(getEnv("LOCALHOST", process.env.LOCALHOST).length);
                    console.log("Redirecting debug local URL to " + resolvedFilename);
                }
            }

            Globals.parsing++;

            var bufferPromise = null;
            let fetchOperationId = null; // Track for cleanup
            if (!isUrl && !isResolvableRef && isConsole) {
                // read the asset from the local filesystem if this is not running inside a browser
                bufferPromise = import("node:fs")
                    .then(fs => {
                        return fs.promises.readFile(resolvedFilename);
                    });
            } else {
                // URL-encode the path components (especially filenames with spaces)
                // Split URL into base and query string if present
                // Create AbortController for this fetch and register it
                const fetchController = new AbortController();
                fetchOperationId = asyncOperationRegistry.registerAbortable(
                    fetchController,
                    "fetch",
                    `loadAsset: ${resolvedFilename}`
                );
                const originalFetchSource = resolvedFilename;

                bufferPromise = Promise.resolve(resolvedFilename)
                    .then(fetchSource => {
                        if (isResolvableSitrecReference(fetchSource)) {
                            return resolveURLForFetch(fetchSource);
                        }
                        return fetchSource;
                    })
                    .then(fetchSource => {
                        const [urlBase, queryString] = fetchSource.split("?");
                        const encodedUrlBase = urlBase;
                        const encodedFilename = queryString ? `${encodedUrlBase}?${queryString}` : encodedUrlBase;
                        const versionExtension = (encodedFilename.includes("?") ? "&" : "?") + "v=1" + versionString;

                        // Sitrec object refs and S3 URLs are already immutable/versioned.
                        const isDirectObjectFetch = isResolvableSitrecReference(originalFetchSource);
                        let isS3Url = false;
                        try {
                            const parsedUrl = new URL(encodedFilename);
                            isS3Url = parsedUrl.hostname.endsWith('.amazonaws.com');
                        } catch (e) {
                            // relative URL or invalid — not S3
                        }
                        const fetchUrl = (isDirectObjectFetch || isS3Url) ? encodedFilename : encodedFilename + versionExtension;

                        // Use custom fetch wrapper that supports File System Access API
                        return fileSystemFetch(fetchUrl, {signal: fetchController.signal})
                            .then(response => {
                                if (!response.ok) {
                                    throw new Error("Network response was not ok");
                                }
                                return response.arrayBuffer();
                            });
                    })
                    .finally(() => {
                        // CRITICAL: Unregister the fetch operation when complete (success or error)
                        if (fetchOperationId !== null) {
                            asyncOperationRegistry.unregister(fetchOperationId);
                        }
                    });
            }

            Globals.pendingActions++;

            if (resolvedFilename.toLowerCase().endsWith(".ts")) {
                return bufferPromise
                    .then(arrayBuffer => {
                        console.log(`Special handling for .TS file load: ${resolvedFilename} (id: ${id})`);
                        Globals.parsing--;
                        Globals.pendingActions--;
                        LoadingManager.completeLoading(loadingId);
                        return this.parseResult(id, arrayBuffer, resolvedFilename);
                    })
                    .catch(error => {
                        Globals.parsing--;
                        console.log(`There was a problem loading .TS file ${resolvedFilename}: ${error.message}`);
                        Globals.pendingActions--;
                        LoadingManager.completeLoading(loadingId);
                        this.#loadingPromises.delete(loadingKey);
                        throw error;
                    });
            }

            let original = null;
            return bufferPromise
                .then(arrayBuffer => {
                    // always store the original
                    original = arrayBuffer;
                    return this.parseAsset(resolvedFilename, id, arrayBuffer);
                })
                .then(parsedAsset => {
                    // if an array is returned, we just assume it's the first one
                    // because we are adding by id here, not by filename
                    // so if it's a zipped asset, it should only be one
                    if (Array.isArray(parsedAsset)) {
                        assert(parsedAsset.length === 1, "Zipped IDed asset contains multiple files");
                        parsedAsset = parsedAsset[0];
                    }

                    // Skip files that failed to parse (e.g. corrupt KLV)
                    if (parsedAsset.parsed === null) {
                        Globals.parsing--;
                        Globals.pendingActions--;
                        LoadingManager.completeLoading(loadingId);
                        return null;
                    }

                    // We now have a full parsed asset in a {filename: filename, parsed: parsed} structure
                    this.add(id, parsedAsset.parsed, original);
                    this.list[id].dynamicLink = dynamicLink;
                    this.list[id].staticURL = null;
                    this.list[id].dataType = parsedAsset.dataType;
                    if (isHttpOrHttps(resolvedFilename) && !dynamicLink) {
                        // if it's a URL, and it's not a dynamic link, then we can store the URL as the static URL
                        // indicating we don't want to rehost this later.
                        this.list[id].staticURL = resolvedFilename;
                    }
                    this.list[id].filename = resolvedFilename;
                    if (id === "starLink") {
                        console.log("Flagging initial starlink file");
                        this.list[id].isTLE = true;
                    }

                    Globals.parsing--;
                    Globals.pendingActions--;
                    LoadingManager.completeLoading(loadingId);

                    parsedAsset.id = id;
                    return parsedAsset;
                })
                .catch(error => {
                    Globals.parsing--;
                    console.log(`There was a problem loading ${resolvedFilename}: ${error.message}`);
                    Globals.pendingActions--;
                    LoadingManager.completeLoading(loadingId);

                    this.#loadingPromises.delete(loadingKey);
                    throw error;
                });
        };

        const isImportedLocalPath = this.isLikelyImportedLocalAssetPath(filename);
        const isWorkingFolderPath = this.isLikelyWorkingFolderAssetPath(filename);
        const normalizedWorkingFolderPath = this.normalizeWorkingFolderRelativePath(filename);
        const canFallbackToBundledAsset = Boolean(
            isWorkingFolderPath &&
            normalizedWorkingFolderPath &&
            !isImportedLocalPath &&
            !normalizedWorkingFolderPath.startsWith("local/")
        );

        if (isWorkingFolderPath || isImportedLocalPath) {
            const localReadPromise = (isWorkingFolderPath
                ? Promise.resolve(true)
                : this.ensureWorkingFolderForImportedLocalAsset(filename))
                .then(canReadLocalAsset => {
                    if (!canReadLocalAsset) {
                        throw new Error(`Local folder not selected for "${filename}"`);
                    }
                    return this.readWorkingFolderFile(filename);
                });

            loadingPromise = localReadPromise
                .then(arrayBuffer => {
                    // Pre-populate the rehost path cache so the first save
                    // doesn't need to re-read this file to verify it's unchanged.
                    if (normalizedWorkingFolderPath) {
                        this._localRehostPathCache.set(normalizedWorkingFolderPath,
                            {path: normalizedWorkingFolderPath, reusedExisting: true});
                    }
                    LoadingManager.completeLoading(loadingId);
                    return this.parseResult(filename, arrayBuffer, null);
                })
                .catch(error => {
                    if (error?.name === "NotFoundError" && canFallbackToBundledAsset) {
                        console.log(`Local asset ${filename} not found in working folder, falling back to bundled asset resolution`);
                        return loadViaDefaultAssetResolution(filename);
                    }

                    if (error?.name === "NotFoundError") {
                        this.showMissingLocalAssetInSelectedFolder(filename, error);
                    } else if (!this.directoryHandle && isImportedLocalPath) {
                        this.showLocalFolderRequiredForImportedAsset(filename);
                    }

                    LoadingManager.completeLoading(loadingId);
                    throw error;
                });
        } else {
            loadingPromise = loadViaDefaultAssetResolution(filename);
        }

        // Register the loading promise with the async operation registry
        asyncOperationRegistry.registerPromise(
            loadingPromise,
            'file-load',
            `${id}: ${filename}`
        );
        
        // Store the loading promise in the map and return it
        this.#loadingPromises.set(loadingKey, loadingPromise);
        
        // Add a finally handler to clean up the loading promise map
        loadingPromise.finally(() => {
            this.#loadingPromises.delete(loadingKey);
        });
        
        return loadingPromise;
    }


    // Sticky flag: when the user chooses "Merge All" in the TLE dialog,
    // subsequent TLE imports in the same session skip the dialog and auto-merge.
    _tleMergeAll = false;
    // Set after the first "replace" in a batch so remaining files merge instead
    // of each one replacing the previous.
    _tleReplacedInBatch = false;
    // Shared promise so concurrent TLE imports wait for the first dialog result
    // instead of each showing their own dialog.
    _tleDialogPromise = null;


    /**
     * Set up the File > Export > Resources submenu under the existing Export folder.
     * Call once after guiMenus.file is available.
     */
    setupResourcesMenu() {
        if (!guiMenus.file) return;

        // Ensure the Export folder exists (same lazy creation as makeExportButton)
        if (this.exportFolder === undefined) {
            this.exportFolder = this.guiFolder.addFolder("Export").perm().close();
        }

        this._resourcesFolder = this.exportFolder.addFolder("Resources").close()
            .tooltip("Download raw data for any loaded file");

        // Rebuild the resources list whenever files finish parsing.
        EventManager.addEventListener("filesParsed", () => {
            this._rebuildResourcesList();
        });
        // Also rebuild when the folder is opened (catches files loaded before
        // the event listener was set up, e.g. initial sitch assets).
        this._resourcesFolder.$title.addEventListener('mousedown', () => {
            // Defer so lil-gui's handler runs first and _closed is updated.
            setTimeout(() => {
                if (!this._resourcesFolder._closed) {
                    this._rebuildResourcesList();
                }
            }, 0);
        });
    }

    /**
     * Rebuild the contents of the Resources folder from current FileManager.list.
     */
    _rebuildResourcesList() {
        const folder = this._resourcesFolder;
        if (!folder) return;

        // Remove all existing children (controllers and sub-folders).
        // destroy() mutates the parent arrays, so use while-loop on first element.
        while (folder.controllers.length > 0) {
            folder.controllers[0].destroy();
        }
        while (folder.folders.length > 0) {
            folder.folders[0].destroy();
        }

        let count = 0;
        for (const id in this.list) {
            const entry = this.list[id];
            // Need either original buffer or string data to be downloadable
            if (!entry.original && !(typeof entry.data === 'string')) continue;
            // Skip archive containers -- the extracted content is listed separately
            if (entry.dataType === "archive") continue;
            // Skip synthetic/internal entries with no meaningful filename
            const displayName = entry.filename || id;
            if (!displayName || displayName.length === 0) continue;

            const actions = {};
            const actionKey = 'dl_' + count;
            actions[actionKey] = () => {
                const baseName = displayName.split('/').pop() || 'resource.bin';
                if (typeof entry.data === 'string') {
                    // String data (e.g. TLE text) -- prefer over original which may be a zip
                    saveAs(new Blob([entry.data]), baseName);
                } else if (entry.original) {
                    saveAs(new Blob([entry.original]), baseName);
                }
            };
            let shortName = displayName.split('/').pop() || displayName;
            if (shortName.length > 35) shortName = shortName.substring(0, 32) + '...';
            const typeStr = entry.dataType ? ` (${entry.dataType})` : '';
            folder.add(actions, actionKey)
                .name(shortName + typeStr)
                .tooltip(`Download: ${displayName}`);
            count++;
        }

        if (count === 0) {
            const empty = {};
            empty.noFiles = () => {};
            folder.add(empty, 'noFiles').name('(no downloadable files)').disable();
        }
    }


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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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
    }

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

            if (fileEntry.dataType === "videoImage" && NodeMan.exists("video")) {
                const videoNode = NodeMan.get("video");
                const videoItem = videoNode.videos?.find(v => v.imageFileID === key);
                if (videoItem) {
                    videoItem.localStaticURL = chosenPath;
                }
            }
        }
    }

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
            }
        })
        return Promise.all(rehostPromises);
    }

    /**
     * Disposes all file entries and clears the raw files array.
     * Called when resetting or reloading the application.
     */
    disposeAll() {
        this.rawFiles = [];
        super.disposeAll()
    }

}

// Install parse-related prototype methods (parseAsset, parseResult, handleParsedFile, etc.)
Object.assign(CFileManager.prototype, parseMethods);

// Re-export detection helpers from the parsing module for backward compatibility.
export {detectTXTType, detectCSVType} from "./CFileManagerParse";


/**
 * Waits until all file parsing operations are complete (Globals.parsing === 0).
 * Also processes any queued drag/drop files before waiting.
 * Polls every 100ms until parsing is complete.
 * @async
 * @returns {Promise<void>}
 */
export async function waitForParsingToComplete() {
    DragDropHandler.checkDropQueue();
    console.log("Waiting for parsing to complete... Globals.parsing = " + Globals.parsing);
    // Use a Promise to wait
    await new Promise((resolve, reject) => {
        // Function to check the value of Globals.parsing
        function checkParsing() {
            if (Globals.parsing === 0) {
                console.log("DONE: Globals.parsing = " + Globals.parsing);
                resolve(); // Resolve the promise if Globals.parsing is 0
            } else {
                // If not 0, wait a bit and then check again
                setTimeout(checkParsing, 100); // Check every 100ms, adjust as needed
                console.log("Still Checking, Globals.parsing = " + Globals.parsing)
            }
        }

        // Start checking
        checkParsing();
    });
    console.log("Parsing complete!");
}
