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
import {ImageSetExporter} from "./ExportImageSet";
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
import {saveMethods} from "./CFileManagerSave";
import {
    isAbortLikeError,
    sanitizeSitchName,
    showLocalFolderAccessUnsupportedMessage,
    supportsDirectoryPicker,
    supportsOpenFilePicker,
} from "./CFileManagerUtils";


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
                    this.loginButton = this.guiServer.add(this, "loginServer").name(t("file.savingDisabled")).setLabelColor("#FF8080").perm();
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
                        : t("file.local.statusFolder"))
                    .perm();
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
            this.setupImageSetExportMenu();
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
        // Sitch teardown destroys the non-perm Resources and Orbit Image Set
        // subfolders inside the perm Export folder; rebuild them here so they
        // come back after File > Open. Both setup methods are idempotent.
        this.setupResourcesMenu();
        this.setupImageSetExportMenu();
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
        const targetHeight = Math.max(1, Math.round(targetWidth * srcHeight / srcWidth));

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
            // drawImage throws InvalidStateError if the source canvas is 0-sized,
            // which can happen for a view that has not been laid out yet.
            if (view.canvas && view.canvas.width > 0 && view.canvas.height > 0) {
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
            // Skip 0-sized canvases (drawImage throws InvalidStateError on them).
            if (view.canvas.width === 0 || view.canvas.height === 0) continue;
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
    loadAsset(filename, id, metadataOverride = null) {

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
                    // Propagate PES timing too. Both entries point at the same
                    // buffer — pesEntries is metadata about that buffer and
                    // should be reachable by either lookup key. Without this,
                    // CVideoH264Data looking up by the substream filename
                    // would miss the timing data that lives only on the
                    // deserialize's id-keyed entry.
                    const src = this.list[parsedAsset.id];
                    if (Array.isArray(src.pesEntries) && src.pesEntries.length > 0) {
                        this.list[id].pesEntries = src.pesEntries;
                    }
                    if (typeof src.videoFirstPESus === "number") {
                        this.list[id].videoFirstPESus = src.videoFirstPESus;
                    }
                    if (src.tsParentFilename) {
                        this.list[id].tsParentFilename = src.tsParentFilename;
                    }
                }
                // Late-arriving metadataOverride: when the in-flight load was
                // started without PES timing and a subsequent caller (e.g. the
                // sitch-reload deserialize) supplies pesEntries from a sidecar,
                // attach them to *every* FileManager entry pointing at this
                // buffer (the new id-keyed one and the original loader's
                // entry). Different consumers index by different keys; both
                // need the timing data.
                if (metadataOverride && Array.isArray(metadataOverride.pesEntries) && metadataOverride.pesEntries.length > 0) {
                    const candidates = [];
                    if (this.list[id]) candidates.push(this.list[id]);
                    if (parsedAsset.id !== id && this.list[parsedAsset.id]) candidates.push(this.list[parsedAsset.id]);
                    let attached = 0;
                    for (const entry of candidates) {
                        if (!Array.isArray(entry.pesEntries) || entry.pesEntries.length === 0) {
                            entry.pesEntries = metadataOverride.pesEntries;
                            if (typeof metadataOverride.videoFirstPESus === "number") {
                                entry.videoFirstPESus = metadataOverride.videoFirstPESus;
                            }
                            attached++;
                        }
                    }
                    if (attached > 0) {
                        console.log(`[loadAsset] late-attached ${metadataOverride.pesEntries.length} PES PTS entries to ${attached} dedup'd entry(ies) for ${filename}`);
                    }
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
            // Propagate PES timing too — same buffer, same metadata. Without
            // this, a working-folder reload that lands the substream under
            // one id (e.g. "video") would leave the deserialize's later
            // loadAsset(filename, "Bex-...") with an entry that has no
            // pesEntries even though the data is identical.
            const src = this.list[existingId];
            if (Array.isArray(src.pesEntries) && src.pesEntries.length > 0) {
                this.list[id].pesEntries = src.pesEntries;
            }
            if (typeof src.videoFirstPESus === "number") {
                this.list[id].videoFirstPESus = src.videoFirstPESus;
            }
            if (src.tsParentFilename) {
                this.list[id].tsParentFilename = src.tsParentFilename;
            }
            // If this caller supplied a metadataOverride (e.g. sidecar reload)
            // and neither entry has pesEntries yet, apply it now.
            if (metadataOverride && Array.isArray(metadataOverride.pesEntries) && metadataOverride.pesEntries.length > 0) {
                for (const entry of [this.list[id], this.list[existingId]]) {
                    if (!Array.isArray(entry.pesEntries) || entry.pesEntries.length === 0) {
                        entry.pesEntries = metadataOverride.pesEntries;
                        if (typeof metadataOverride.videoFirstPESus === "number") {
                            entry.videoFirstPESus = metadataOverride.videoFirstPESus;
                        }
                    }
                }
            }
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
                // Rewrite references to the canonical dev host(s) onto the current
                // origin/app path. Sitches saved on a real local.metabunk.org dev
                // install embed absolute URLs like
                //   https://local.metabunk.org/sitrec/data/models/PA28.glb
                // which won't resolve when the same sitch is loaded on a different
                // host (deployed prod, Docker sandbox at localhost:8080 serving the
                // app at "/", etc.). Use SITREC_APP (origin + app path) so the
                // rewrite lands on the correct sub-path regardless of where this
                // install serves sitrec from.
                const rewriteBases = [
                    "https://localhost/sitrec/",
                    "http://localhost/sitrec/",
                    "https://local.metabunk.org/sitrec/",
                    "http://local.metabunk.org/sitrec/",
                ];
                const localhostEnv = getEnv("LOCALHOST", process.env.LOCALHOST);
                if (localhostEnv) {
                    rewriteBases.push("https://" + localhostEnv + "/sitrec/");
                    rewriteBases.push("http://" + localhostEnv + "/sitrec/");
                }
                for (const base of rewriteBases) {
                    if (resolvedFilename.startsWith(base) && !resolvedFilename.startsWith(SITREC_APP)) {
                        const rewritten = SITREC_APP + resolvedFilename.slice(base.length);
                        console.log("Redirecting debug local URL to " + rewritten);
                        resolvedFilename = rewritten;
                        break;
                    }
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
                // Legacy backwards-compat path: a sitch saved before unified
                // substream persistence references the parent TS in loadedFiles.
                // Re-demux live to capture PES PTS fresh — substream sidecars
                // aren't available, but the live demux produces equivalent
                // pesPTSus[] data inside parseKLVFile via the streamMetadata
                // callback in TSParser.parseTSFile. Re-saving this sitch under
                // the new code will produce a sidecar-backed format that
                // doesn't need to re-fetch the (potentially huge) parent TS.
                console.warn(`[loadAsset] Legacy TS-in-loadedFiles path for ${resolvedFilename}. Re-saving will switch to substream + sidecar persistence.`);
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
                    // metadataOverride lets callers (e.g. sitch reload) supply
                    // PES timing fetched from a `.pts.json` sidecar so the KLV
                    // pairing logic in parseKLVFile reconstructs pesPTSus[]
                    // without re-demuxing the parent TS.
                    return this.parseAsset(resolvedFilename, id, arrayBuffer, metadataOverride);
                })
                .then(parsedAsset => {
                    // Multi-entry parser results: zip/KMZ (one entry per file),
                    // TS streams (recursive), and NITF (image + optional track
                    // when corner geocoding is present). The IDed loadAsset
                    // contract registers exactly one entry under the caller's
                    // `id`, so we keep the first entry and discard the rest.
                    // The drag/drop path (parseResult) handles arrays
                    // properly — it registers each child under its
                    // parser-generated filename and routes them through
                    // handleParsedFile. So drag-drop NITF gets both image and
                    // track; a hand-authored Sit.files entry pointing at a
                    // raw .ntf loses the track. No current sitch authors NITF
                    // into Sit.files (drag-drop → save bakes the post-decoded
                    // JPG + CSV via skipSerialization on the archive entry,
                    // so reload never re-runs the parser), so this is latent.
                    if (Array.isArray(parsedAsset)) {
                        assert(parsedAsset.length === 1,
                            `Multi-entry parser result on IDed load (id=${id}, filename=${resolvedFilename}); only first entry kept, others dropped`);
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
                    // Stash PES timing the parser surfaced via the wrapper (TS
                    // substream sidecar reload of h264/aac/klv assets). This
                    // matches what parseResult's substream loop does for the
                    // working-folder path; without it, the URL-fetch path
                    // drops video-side pesEntries on the floor and the H.264
                    // chunk pipeline ends up with synthetic uniform timestamps.
                    if (Array.isArray(parsedAsset.pesEntries) && parsedAsset.pesEntries.length > 0) {
                        this.list[id].pesEntries = parsedAsset.pesEntries;
                        if (typeof parsedAsset.videoFirstPESus === "number") {
                            this.list[id].videoFirstPESus = parsedAsset.videoFirstPESus;
                        }
                    }
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
                    // Cache entries are keyed on source-buffer identity (see C2 in
                    // chooseLocalRehostPath); store the buffer we just read so a
                    // same-buffer save hits, and a different buffer correctly misses.
                    if (normalizedWorkingFolderPath) {
                        this._localRehostPathCache.set(normalizedWorkingFolderPath,
                            {result: {path: normalizedWorkingFolderPath, reusedExisting: true}, sourceBuffer: arrayBuffer});
                    }
                    LoadingManager.completeLoading(loadingId);
                    return this.parseResult(filename, arrayBuffer, null, {metadataOverride}).then(result => {
                        // parseResult keys entries by filename, but loadAsset's
                        // contract (matched by the URL-fetch path above) is
                        // that callers can look up the entry by the `id` they
                        // passed in. For single-file (non-archive) results
                        // where id and filename differ — e.g. sitch reload
                        // calling loadAsset(localPath, "windGrid_GFS_10m") —
                        // promote the FileManager entry from list[filename]
                        // to list[id]. Without this, the wind node's
                        // modDeserialize lookup `FileManager.list[windFileId]`
                        // misses on local saves and the wind data silently
                        // fails to restore (S3 saves work because the URL
                        // path stores by id directly).
                        if (id && id !== filename
                            && Array.isArray(result) && result.length === 1) {
                            const entry = this.list[filename];
                            if (entry && !entry.isMultiple && this.list[id] === undefined) {
                                this.list[id] = entry;
                                delete this.list[filename];
                                // Tag the result entry with the promoted id so downstream
                                // consumers (CustomManagerSerialize, etc.) using
                                // `fileID = x.id ?? x.filename` find list[id], not the
                                // now-deleted list[filename].
                                result[0].id = id;
                            }
                        }
                        // Match the URL-fetch branch's return shape: a single-
                        // element parseResult (one substream, not a multi-stream
                        // archive) returns the bare {filename, parsed, dataType}
                        // object so callers like CVideoH264Data that expect
                        // result.parsed don't trip on the array shape and bail
                        // through their error path.
                        if (Array.isArray(result) && result.length === 1) {
                            return result[0];
                        }
                        return result;
                    });
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
     * Set up the File > Export > Image Set submenu under the existing Export folder.
     * Called from the FileManager init block and again from sitchChanged() so
     * the (non-perm) subfolder is rebuilt after sitch teardown wipes it.
     */
    setupImageSetExportMenu() {
        if (!guiMenus.file) return;
        if (this.exportFolder === undefined) {
            this.exportFolder = this.guiFolder.addFolder("Export").perm().close();
        }
        // Construct the exporter once so user-set fields (azStep, trackToOrbit,
        // etc.) survive sitch reloads; setupMenu is idempotent.
        if (!this.imageSetExporter) {
            this.imageSetExporter = new ImageSetExporter();
        }
        this.imageSetExporter.setupMenu(this.exportFolder);
    }

    /**
     * Set up the File > Export > Resources submenu under the existing Export folder.
     * Called from the FileManager init block and again from sitchChanged() so
     * the (non-perm) subfolder is rebuilt after sitch teardown wipes it.
     */
    setupResourcesMenu() {
        if (!guiMenus.file) return;

        // Ensure the Export folder exists (same lazy creation as makeExportButton)
        if (this.exportFolder === undefined) {
            this.exportFolder = this.guiFolder.addFolder("Export").perm().close();
        }

        // Drop any previous Resources subfolder before re-adding.
        if (this._resourcesFolder) {
            this._resourcesFolder.destroy();
            this._resourcesFolder = null;
        }

        this._resourcesFolder = this.exportFolder.addFolder("Resources").close()
            .tooltip("Download raw data for any loaded file");

        // Register the filesParsed listener exactly once; the handler always
        // references the latest _resourcesFolder via `this`.
        if (!this._resourcesListenerRegistered) {
            EventManager.addEventListener("filesParsed", () => {
                this._rebuildResourcesList();
            });
            this._resourcesListenerRegistered = true;
        }
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

        // Rebuild now in case files are already loaded (sitch reload path).
        this._rebuildResourcesList();
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
     * Disposes all file entries and clears the raw files array.
     * Called when resetting or reloading the application.
     */
    disposeAll() {
        this.rawFiles = [];
        super.disposeAll()
    }

}

// Install split-out prototype methods.
// See CFileManagerParse.js (parseAsset/handleParsedFile/etc) and
// CFileManagerSave.js (saveSitch/saveLocal/rehostDynamicLinks/etc).
Object.assign(CFileManager.prototype, parseMethods, saveMethods);

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
