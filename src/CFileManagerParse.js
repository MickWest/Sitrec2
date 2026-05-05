/**
 * Parsing methods for CFileManager.
 *
 * Installed as prototype methods on CFileManager via Object.assign in CFileManager.js.
 * Covers low-level buffer → typed data parsing (parseAsset), post-parse routing
 * (parseResult, handleParsedFile), ground overlay/geotiff conversion, and
 * FlightClub JSON / TLE-import handling.
 */

import {cleanCSVText, ExpandKeyframes, getFileExtension} from "./utils";
import {fromArrayBuffer as geotiffFromArrayBuffer} from "geotiff";
import JSZip from "jszip";
import {
    CTrackFile,
    CTrackFileJSON,
    CTrackFileKML,
    CTrackFileMISB,
    CTrackFileSonde,
    CTrackFileSRT,
    CTrackFileSTANAG,
    parseXml,
} from "./KMLUtils";
import {CNodeArray} from "./nodes/CNodeArray";

const trackFileClasses = [
    CTrackFileKML,
    CTrackFileSTANAG,
    CTrackFileSRT,
    CTrackFileJSON,
    CTrackFileMISB,
    CTrackFileSonde,  // Last: handles text files, content-detected to avoid false positives
];
import {
    CustomManager,
    Globals,
    NodeMan,
    setNewSitchObject,
    setRenderOne,
    Sit,
    Synth3DManager,
    TrackManager,
} from "./Globals";
import {DragDropHandler} from "./DragDropHandler";
import {parseAirdataCSV} from "./ParseAirdataCSV";
import {parseKLVFile, parseMISB1CSV} from "./MISBUtils";
import csv from "./utils/CSVParser";
import {par} from "./par";
import {assert} from "./assert";
import {textSitchToObject} from "./RegisterSitches";
import {
    extractPBACSV,
    isCustom1,
    isFR24CSV,
    isPBAFile,
    parseCustom1CSV,
    parseCustomFLLCSV,
    parseFR24CSV,
} from "./ParseCustom1CSV";
import {findColumn, stripDuplicateTimes} from "./ParseUtils";
import {SITREC_SERVER} from "./configUtils";
import {TSParser} from "./TSParser";
import {NITFParser} from "./NITFParser";
import {sniffFileType} from "./sniffFileType";
import {showError} from "./showError";
import {ECEFToLLAVD_radii} from "./LLA-ECEF-ENU";
import {projectedBoundsToWGS84} from "./proj4Loader";
import {isAudioOnlyFormat} from "./AudioFormats";
import {EventManager} from "./CEventManager";
import {CTLEData} from "./TLEUtils";
import {extractFeaturesFromFile, isFeaturesCSV} from "./ParseFeaturesCSV";
import {createImageFromArrayBuffer} from "./FileUtils";
import {CNode3DObject, ModelFiles} from "./nodes/CNode3DObject";
import {convertTiffBufferToPngImage} from "./TIFFUtils";
import {extractFlightClubInfo, flightClubToCSVStrings, isFlightClubJSON} from "./ParseFlightClubJSON";
import {isSupportedModelFile} from "./ModelLoader";
import {addOptionToGUIMenu} from "./lil-gui-extras";

/**
 * Detects the type of a TXT file based on content patterns.
 * Assumes TLE unless detected as something else.
 */
export function detectTXTType(text) {
    if (isPBAFile(text)) {
        return "PBA";
    }
    return "TLE";
}

/**
 * Detects the type of a CSV file based on header row patterns.
 * Returns "Airdata", "MISB1", "CUSTOM1", "CUSTOM_FLL", "FR24CSV",
 * "AZIMUTH", "ELEVATION", "HEADING", "FOV", "FEATURES", or "Unknown".
 */
export function detectCSVType(csvRows) {

    if (csvRows[0][0] === "time(millisecond)" && csvRows[0][1] === "datetime(utc)") {
        return "Airdata";
    }

    if (csvRows[0][1] === "Checksum" && csvRows[0][2] === "UnixTimeStamp" && csvRows[0][3] === "MissionID") {
        return "MISB_FULL";
    }

    if (csvRows[0][0] === "DPTS" && csvRows[0][1] === "Security:") {
        return "MISB1";
    }

    if (csvRows[0].includes("Sensor Latitude") || csvRows[0].includes("SensorLatitude")) {
        return "MISB1";
    }

    if (csvRows[0][0].toLowerCase() === "frame" && csvRows[0][1].toLowerCase() === "latitude" && csvRows[0][2].toLowerCase() === "longitude") {
        return "CUSTOM_FLL";
    }

    if (isCustom1(csvRows)) {
        return "CUSTOM1";
    }

    if (isFR24CSV(csvRows)) {
        return "FR24CSV";
    }

    if ((csvRows[0][0].toLowerCase() === "frame" || csvRows[0][0].toLowerCase() === "time")
        && csvRows[0][1].toLowerCase() === "az") {
        return "AZIMUTH";
    }

    if ((csvRows[0][0].toLowerCase() === "frame" || csvRows[0][0].toLowerCase() === "time")
        && csvRows[0][1].toLowerCase() === "el") {
        return "ELEVATION";
    }

    if ((csvRows[0][0].toLowerCase() === "frame" || csvRows[0][0].toLowerCase() === "time")
        && csvRows[0][1].toLowerCase() === "heading") {
        return "HEADING";
    }

    if ((csvRows[0][0].toLowerCase() === "frame" || csvRows[0][0].toLowerCase() === "time")
        && (csvRows[0][1].toLowerCase() === "fov" || csvRows[0][1].toLowerCase() === "zoom")) {
        return "FOV";
    }

    if (isFeaturesCSV(csvRows)) {
        return "FEATURES";
    }

    if (Sit.isCustom && typeof Sit.setup !== 'function' && !Sit.gimbalSetup) {
        showError("Unhandled CSV type detected.  Please add to detectCSVType() function.");
    }
    return "Unknown";
}

export const parseMethods = {

    detectTLE(filename) {
        const fileExt = getFileExtension(filename);
        return (fileExt === "txt" || fileExt === "tle" || fileExt === "2le" || fileExt === "3le");
    },

    parseResult(filename, result, newStaticURL, options = {}) {
        console.log("parseResult: Parsing " + filename);
        // metadataOverride lets the working-folder reload path (which routes
        // single-file substream loads through parseResult) supply PES timing
        // captured from a sidecar so parseKLVFile reconstructs pesPTSus[]
        // without re-demuxing a parent TS. The URL-fetch path passes
        // metadata directly to parseAsset; the working-folder path passes
        // it through here.
        const metadataOverride = options.metadataOverride || null;
        return this.parseAsset(filename, filename, result, metadataOverride)
            .then(async parsedResult => {
                let changesSerializedState = false;

                let isMultiple = false;
                if (!Array.isArray(parsedResult)) {
                    // Single-file load. If metadataOverride was supplied (sidecar
                    // reload case), attach its fields to the parsed result so
                    // the substream loop below captures pesEntries onto the
                    // FileManager entry — needed so a future re-save can emit
                    // a sidecar again, completing the round-trip durably.
                    if (parsedResult && metadataOverride && Array.isArray(metadataOverride.pesEntries)) {
                        parsedResult.pesEntries = metadataOverride.pesEntries;
                        parsedResult.videoFirstPESus = metadataOverride.videoFirstPESus;
                        // tsParentFilename isn't in the live-demux metadata but
                        // is carried in the sidecar reload's loadedFilesMetadata —
                        // pull from there if available so the entry's tsParentFilename
                        // stays accurate across save/reload cycles.
                        const lfm = this.loadedFilesMetadata?.[filename];
                        if (lfm?.tsParentFilename) {
                            parsedResult.tsParentFilename = lfm.tsParentFilename;
                        }
                    }
                    parsedResult = [parsedResult];
                } else {
                    const isConverted = parsedResult.length > 0 && parsedResult[0].nitfConverted;

                    this.remove(filename);
                    this.add(filename, result, result);
                    const archiveEntry = this.list[filename];
                    archiveEntry.filename = filename;
                    archiveEntry.dataType = "archive";

                    if (isConverted) {
                        archiveEntry.dynamicLink = false;
                        archiveEntry.skipSerialization = true;
                    } else {
                        archiveEntry.dynamicLink = true;
                        archiveEntry.staticURL = newStaticURL;
                    }

                    newStaticURL = null;
                    isMultiple = !isConverted;
                }

                let isTSArchive = false;
                for (const x of parsedResult) {
                    this.remove(x.filename);
                    // For multi-stream extracts (e.g. .ts → h264/aac/klv), prefer the
                    // substream's own raw bytes for `original` over the parent archive
                    // `result`. Using `result` would attach a full archive-sized copy
                    // to every substream entry — for a 100 MB .ts with 3 streams that
                    // wastes ~300 MB. The substream's own bytes are also what a user
                    // expects when downloading a single extracted stream.
                    const originalData = x.convertedBuffer || x.streamData || result;
                    this.add(x.filename, x.parsed, originalData);
                    const fileManagerEntry = this.list[x.filename];
                    // TS substreams are now the canonical persisted form (parent TS is
                    // dropped after demux). Mark them dynamicLink=true so the rehost
                    // loops upload them as independent assets.
                    const isTSSubstream = !!(x.pesEntries || x.tsParentFilename);
                    fileManagerEntry.dynamicLink = isTSSubstream ? true : !isMultiple;
                    fileManagerEntry.filename = x.filename;
                    fileManagerEntry.staticURL = newStaticURL;
                    fileManagerEntry.dataType = x.dataType;
                    fileManagerEntry.isMultiple = isMultiple;

                    if (isTSSubstream) {
                        // Stash the per-substream PES timing data captured during TS
                        // demux. Used at save time to emit a `<filename>.pts.json`
                        // sidecar so a reload can reconstruct pesPTSus[] without
                        // re-demuxing the (now-released) parent TS bytes.
                        if (Array.isArray(x.pesEntries)) {
                            fileManagerEntry.pesEntries = x.pesEntries;
                        }
                        if (typeof x.videoFirstPESus === "number") {
                            fileManagerEntry.videoFirstPESus = x.videoFirstPESus;
                        }
                        if (x.tsParentFilename) {
                            fileManagerEntry.tsParentFilename = x.tsParentFilename;
                            isTSArchive = true;
                        }
                    }

                    if (x.parsed && x.parsed.autoSelectAsCamera) {
                        fileManagerEntry.autoSelectAsCamera = true;
                    }

                    const parsedFile = x.parsed;
                    const parsedFilename = x.filename;

                    NodeMan.suspendRecalculate();
                    try {
                        changesSerializedState = await this.handleParsedFile(parsedFilename, parsedFile) || changesSerializedState;
                    } finally {
                        NodeMan.unsuspendRecalculate();
                    }
                }

                // For TS archives: substreams have been extracted into independent
                // FileManager entries with their own bytes and PES sidecar metadata.
                // Release the parent TS buffer (potentially hundreds of MB) and mark
                // it skipSerialization=true so neither rehost path uploads it. The
                // canonical persisted form is now the substreams + their .pts.json
                // sidecars, which is enough to round-trip pesPTSus[] without the
                // parent TS being present on reload.
                if (isTSArchive) {
                    const archiveEntry = this.list[filename];
                    if (archiveEntry) {
                        archiveEntry.original = null;
                        archiveEntry.skipSerialization = true;
                        archiveEntry.tsParentDropped = true;
                        console.log(`parseResult: dropped parent TS bytes for ${filename}; substreams persist independently`);
                    }
                }

                console.log("parseResult: DONE Parse " + filename);
                setRenderOne(true);
                EventManager.dispatchEvent("filesParsed", {filename});
                if (options.returnMeta) {
                    return {parsedResult, changesSerializedState};
                }
                return parsedResult;
            });
    },

    registerDroppedModel(modelID) {
        ModelFiles[modelID] = {file: modelID};

        NodeMan.iterate((id, node) => {
            if (node instanceof CNode3DObject && node.modelMenu) {
                addOptionToGUIMenu(node.modelMenu, modelID, modelID);
            }
        });

        return ModelFiles[modelID];
    },

    getPreferredDroppedModelTarget() {
        const editingObject = CustomManager?.getEditingObjectNode?.();
        if (editingObject instanceof CNode3DObject) {
            return editingObject;
        }

        const targetObject = NodeMan.get("targetObject", false) || NodeMan.get("traverseObject", false);
        return targetObject instanceof CNode3DObject ? targetObject : null;
    },

    applyDroppedModelToObject(objectNode, modelID) {
        if (!(objectNode instanceof CNode3DObject)) {
            return false;
        }

        objectNode.selectModel = modelID;
        objectNode.modelOrGeometry = "model";
        objectNode.modelMenu?.updateDisplay();
        objectNode.modelOrGeometryMenu?.updateDisplay();
        objectNode.rebuild();
        setRenderOne(true);

        CustomManager?.refreshEditingObjectMenu?.(objectNode.id);
        return true;
    },

    /**
     * Generate a human-readable assessment of how a new TLE set relates to the
     * existing loaded TLE set and the current simulation date.
     */
    _generateTLEAssessment(existingTLE, newTLE, currentDate) {
        const fmtDate = (d) => d.toISOString().substring(0, 10);
        const daysBetween = (a, b) => Math.round((b - a) / (1000 * 60 * 60 * 24));

        const curMs = currentDate.getTime();
        const exStart = existingTLE.startDate;
        const exEnd = existingTLE.endDate;
        const nwStart = newTLE.startDate;
        const nwEnd = newTLE.endDate;

        const lines = [];
        lines.push(`Current loaded: ${existingTLE.satData.length} satellites, ${fmtDate(exStart)} to ${fmtDate(exEnd)} (${daysBetween(exStart, exEnd)} days)`);
        lines.push(`New file: ${newTLE.satData.length} satellites, ${fmtDate(nwStart)} to ${fmtDate(nwEnd)} (${daysBetween(nwStart, nwEnd)} days)`);
        lines.push(`Simulation date: ${fmtDate(currentDate)}`);

        const exDaysBeforeCur = daysBetween(exEnd, currentDate);
        const exDaysAfterCur = daysBetween(currentDate, exStart);
        const nwDaysBeforeCur = daysBetween(nwEnd, currentDate);
        const nwDaysAfterCur = daysBetween(currentDate, nwStart);

        const exContainsCur = curMs >= exStart.getTime() && curMs <= exEnd.getTime();
        const nwContainsCur = curMs >= nwStart.getTime() && curMs <= nwEnd.getTime();

        const overlapStart = Math.max(exStart.getTime(), nwStart.getTime());
        const overlapEnd = Math.min(exEnd.getTime(), nwEnd.getTime());
        const hasOverlap = overlapStart <= overlapEnd;
        const overlapDays = hasOverlap ? daysBetween(new Date(overlapStart), new Date(overlapEnd)) : 0;

        lines.push('');

        const assessments = [];

        if (nwContainsCur) {
            assessments.push('The new TLE set spans the simulation date — it contains TLEs from just before and/or after the current time, which is ideal for accurate propagation.');
        } else if (nwEnd.getTime() <= curMs && nwDaysBeforeCur <= 30) {
            assessments.push(`The new TLE set ends ${nwDaysBeforeCur} day(s) before the simulation date. Since TLEs are best used by extrapolating forward from a recent epoch, this is still useful.`);
        } else if (nwEnd.getTime() <= curMs && nwDaysBeforeCur <= 90) {
            assessments.push(`The new TLE set ends ${nwDaysBeforeCur} days before the simulation date. This is moderately stale — propagation accuracy degrades beyond ~30 days, but may still be acceptable.`);
        } else if (nwEnd.getTime() <= curMs) {
            assessments.push(`The new TLE set ends ${nwDaysBeforeCur} days before the simulation date. This is quite old — propagation from TLEs this stale will have significant errors.`);
        } else if (nwStart.getTime() > curMs) {
            assessments.push(`The new TLE set starts ${nwDaysAfterCur} day(s) after the simulation date. Backward propagation from future TLEs is less reliable than forward propagation.`);
        }

        if (exContainsCur && !nwContainsCur) {
            assessments.push('The currently loaded set already spans the simulation date, so the new set may not improve accuracy for the current time.');
        } else if (!exContainsCur && nwContainsCur) {
            assessments.push('The new set spans the simulation date while the current set does not — merging or replacing will improve accuracy.');
        } else if (exContainsCur && nwContainsCur) {
            assessments.push('Both sets span the simulation date. Merging will add satellites not in the current set and provide additional epoch data for existing ones.');
        }

        if (hasOverlap && overlapDays > 0) {
            assessments.push(`The two sets overlap by ${overlapDays} day(s) (${fmtDate(new Date(overlapStart))} to ${fmtDate(new Date(overlapEnd))}). Satellites in common will have their historical records combined when merged.`);
        } else {
            assessments.push('The two sets do not overlap in time. Merging will give broader temporal coverage.');
        }

        const existingCount = existingTLE.satData.length;
        const newCount = newTLE.satData.length;
        if (newCount > existingCount * 1.5) {
            assessments.push(`The new set has significantly more satellites (${newCount} vs ${existingCount}).`);
        } else if (existingCount > newCount * 1.5) {
            assessments.push(`The current set has significantly more satellites (${existingCount} vs ${newCount}).`);
        }

        const newDistDays = nwContainsCur ? 0 : Math.min(
            Math.abs(daysBetween(nwEnd, currentDate)),
            Math.abs(daysBetween(nwStart, currentDate))
        );
        const tooFar = newDistDays > 100;
        let warning = null;
        if (tooFar) {
            warning = `WARNING: This TLE set is ${newDistDays} days away from the simulation date. It is NOT likely to be useful — satellite positions propagated from TLEs this far out of date will have very large errors and many satellites will fail to propagate entirely.`;
        }

        return {dataLines: lines, assessment: assessments.join(' '), warning};
    },

    showTLEChoiceDialog(filename, existingTLE, newTLEText) {
        if (Globals.regression) {
            return Promise.resolve("merge");
        }
        let newTLE = null;
        let assessment = null;
        try {
            newTLE = new CTLEData(newTLEText);
            const currentDate = new Date(Sit.startTime);
            assessment = this._generateTLEAssessment(existingTLE, newTLE, currentDate);
        } catch (e) {
            console.warn("Could not generate TLE assessment:", e);
        }

        return new Promise((resolve, reject) => {
            const overlay = document.createElement('div');
            overlay.style.cssText = `
                position: fixed; top: 0; left: 0; width: 100%; height: 100%;
                background: rgba(0,0,0,0.5); z-index: 10000;
                display: flex; align-items: center; justify-content: center;
            `;
            for (const evt of ['dblclick', 'mousedown', 'mouseup', 'click', 'wheel', 'contextmenu']) {
                overlay.addEventListener(evt, (e) => e.stopPropagation());
            }

            const modal = document.createElement('div');
            modal.style.cssText = `
                background: #2a2a2a; border-radius: 8px; padding: 20px;
                min-width: 340px; max-width: 520px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.5);
                font-family: Arial, sans-serif; color: white;
                max-height: 85vh; overflow-y: auto;
            `;

            const title = document.createElement('h3');
            title.textContent = 'Import TLE Data';
            title.style.cssText = 'margin: 0 0 10px 0; font-size: 18px; color: #fff;';

            const message = document.createElement('p');
            message.textContent = `TLE data is already loaded. How would you like to handle "${filename}"?`;
            message.style.cssText = 'margin: 0 0 15px 0; font-size: 14px; color: #ccc;';

            const btnStyle = `
                padding: 10px 20px; border: none; border-radius: 4px;
                cursor: pointer; font-size: 14px; margin: 5px; width: calc(100% - 10px);
            `;

            const makeBtn = (text, bg, action) => {
                const btn = document.createElement('button');
                btn.textContent = text;
                btn.style.cssText = btnStyle + `background: ${bg}; color: white;`;
                btn.onclick = () => { document.body.removeChild(overlay); resolve(action); };
                return btn;
            };

            modal.appendChild(title);
            modal.appendChild(message);
            modal.appendChild(makeBtn('Merge (combine satellite data)', '#1976d2', 'merge'));
            modal.appendChild(makeBtn('Merge All Files (skip dialog for remaining files)', '#0d47a1', 'mergeAll'));
            modal.appendChild(makeBtn('Replace (remove existing data)', '#388e3c', 'replace'));
            const cancelBtn = document.createElement('button');
            cancelBtn.textContent = 'Cancel';
            cancelBtn.style.cssText = btnStyle + 'background: #757575; color: white;';
            cancelBtn.onclick = () => { document.body.removeChild(overlay); reject(new Error('User cancelled')); };
            modal.appendChild(cancelBtn);

            if (assessment) {
                const divider = document.createElement('hr');
                divider.style.cssText = 'border: none; border-top: 1px solid #444; margin: 15px 0 10px 0;';
                modal.appendChild(divider);

                if (assessment.warning) {
                    const warnSection = document.createElement('div');
                    warnSection.style.cssText = 'font-size: 13px; color: #ff80a0; font-weight: bold; line-height: 1.5; margin-bottom: 10px; padding: 8px; background: rgba(255,80,120,0.1); border: 1px solid rgba(255,80,120,0.3); border-radius: 4px;';
                    warnSection.textContent = assessment.warning;
                    modal.appendChild(warnSection);
                }

                const dataSection = document.createElement('div');
                dataSection.style.cssText = 'font-size: 12px; color: #aaa; font-family: monospace; margin-bottom: 10px; line-height: 1.6;';
                dataSection.innerHTML = assessment.dataLines.map(l => l === '' ? '<br>' : l.replace(/</g, '&lt;')).join('<br>');
                modal.appendChild(dataSection);

                const assessSection = document.createElement('div');
                assessSection.style.cssText = 'font-size: 13px; color: #ccc; line-height: 1.5;';
                assessSection.textContent = assessment.assessment;
                modal.appendChild(assessSection);
            }

            overlay.appendChild(modal);
            document.body.appendChild(overlay);
        });
    },

    async handleParsedFile(filename, parsedFile, trackOptions = {}) {
        console.log("handleParsedFile: Handling parsed file " + filename);

        setRenderOne(2);

        const fileExt = getFileExtension(filename);

        if (filename.split('.').length === 1) {
            return false;
        }

        const fileManagerEntry = this.list[filename];

        assert(fileManagerEntry !== undefined, "handleParsedFile: FileManager entry not found for " + filename);
        assert(fileManagerEntry.dataType !== undefined, "handleParsedFile: FileManager entry dataType not set for " + filename);

        if (fileManagerEntry.handled) {
            console.warn("handleParsedFile: File already handled for " + filename + ", skipping");
            return false;
        }
        fileManagerEntry.handled = true;

        if (fileManagerEntry.dataType === "FEATURES") {
            extractFeaturesFromFile(parsedFile);
            fileManagerEntry.skipSerialization = true;
            return true;
        }

        if (fileManagerEntry.dataType === "flightclub") {
            await this.handleFlightClubJSON(filename, parsedFile, fileManagerEntry);
            return true;
        }

        if (fileManagerEntry.dataType === "videoImage") {
            if (NodeMan.exists("video")) {
                const videoNode = NodeMan.get("video");
                const alreadyLoaded = Globals.deserializing && videoNode.videos?.some(videoEntry =>
                    (videoEntry.imageFileID === filename || videoEntry.fileName === filename) && videoEntry.videoData
                );
                if (alreadyLoaded) {
                    console.log(`[CFileManager] Skipping video image restore for "${filename}" - already loaded`);
                    return false;
                }
                if (videoNode.pendingVideoRestore) {
                    console.log(`[CFileManager] Skipping video image restore for "${filename}" - pendingVideoRestore active`);
                    return false;
                }
            }

            const buffer = fileManagerEntry.original;
            if (buffer) {
                const ext = getFileExtension(filename).toLowerCase();
                const mimeType = ext === 'png' ? 'image/png' :
                                ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                ext === 'gif' ? 'image/gif' :
                                ext === 'webp' ? 'image/webp' : 'image/png';
                const blob = new Blob([buffer], { type: mimeType });
                const blobURL = URL.createObjectURL(blob);

                const img = new Image();
                img.onload = () => {
                    if (NodeMan.exists("video")) {
                        const videoNode = NodeMan.get("video");
                        videoNode.makeImageVideo(filename, img, false, filename);
                        videoNode.imageFileID = filename;
                        console.log(`Restored video image "${filename}" (${img.width}x${img.height})`);
                    }
                };
                img.src = blobURL;
            }
            return false;
        }

        if (fileManagerEntry.dataType === "groundOverlayImage") {
            const buffer = fileManagerEntry.original;
            if (buffer && !fileManagerEntry.blobURL) {
                const ext = getFileExtension(filename).toLowerCase();
                const mimeType = ext === 'png' ? 'image/png' :
                                ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                ext === 'gif' ? 'image/gif' :
                                ext === 'webp' ? 'image/webp' : 'image/png';
                const blob = new Blob([buffer], { type: mimeType });
                fileManagerEntry.blobURL = URL.createObjectURL(blob);
                console.log(`Created blobURL for ground overlay image "${filename}"`);
            }
            return false;
        }

        if (fileExt === "csv") {
            if (fileManagerEntry.dataType === "AZIMUTH" || fileManagerEntry.dataType === "ELEVATION" || fileManagerEntry.dataType === "HEADING" || fileManagerEntry.dataType === "FOV" || fileManagerEntry.dataType === "Unknown" || fileManagerEntry.dataType === undefined) {
                const azCol = findColumn(parsedFile, "Az", true);
                const elCol = findColumn(parsedFile, "El", true);
                const zoomCol = findColumn(parsedFile, "Zoom", true);
                const fovCol = findColumn(parsedFile, "FOV", true);
                const headingCol = findColumn(parsedFile, "Heading", true);


                if (azCol !== -1 || elCol !== -1 || zoomCol !== -1 || fovCol !== -1 || headingCol !== -1) {

                    const firstColumnHeader = parsedFile[0][0].toLowerCase();
                    parsedFile = parsedFile.slice(1);

                    if (firstColumnHeader === "time") {
                        const fps = Sit.fps;
                        const simSpeed = Sit.simSpeed ?? 1;

                        const firstTimeValue = parsedFile[0]?.[0];
                        const isISODate = typeof firstTimeValue === 'string' && firstTimeValue.match(/^\d{4}-\d{2}-\d{2}/);

                        if (isISODate) {
                            const startMS = new Date(Sit.startTime).valueOf();
                            parsedFile.forEach(row => {
                                if (row[0] !== undefined) {
                                    const dateMS = new Date(row[0]).valueOf();
                                    row[0] = Math.round((dateMS - startMS) * fps / (1000 * simSpeed));
                                }
                            });
                        } else {
                            parsedFile.forEach(row => {
                                if (row[0] !== undefined) {
                                    row[0] = Math.round(row[0] * fps);
                                }
                            });
                        }
                    }

                    const azElController = NodeMan.get("customAzElController", false);
                    if (azElController) {
                        if (azCol !== -1) {
                            azElController.setAzFile(parsedFile, azCol);
                        }

                        if (elCol !== -1) {
                            azElController.setElFile(parsedFile, elCol);
                        }
                    }

                    if (fovCol !== -1 || zoomCol !== -1) {
                        const fovSwitch = NodeMan.get("fovSwitch", false);
                        if (fovSwitch) {
                            const dataCol = fovCol !== -1 ? fovCol : zoomCol;
                            const columnName = fovCol !== -1 ? "FOV" : "Zoom";

                            const fovArray = ExpandKeyframes(parsedFile, Sit.frames, 0, dataCol, true);

                            const fovNodeId = fileManagerEntry.filename.replace(/\.[^/.]+$/, "") + "_" + columnName;

                            if (NodeMan.exists(fovNodeId)) {
                                NodeMan.unlinkDisposeRemove(fovNodeId);
                            }

                            const fovNode = new CNodeArray({id: fovNodeId, array: fovArray});

                            fovSwitch.replaceOption(fovNodeId, fovNode);
                            fovSwitch.selectOption(fovNodeId);
                        }
                    }

                    if (headingCol !== -1) {
                        const headingController = NodeMan.get("customHeadingController", false);
                        if (headingController) {
                            headingController.setHeadingFile(parsedFile, headingCol);
                            headingController.recalculate();
                        }
                    }

                    return true;
                }
            } else {
                if (!(parsedFile instanceof CTrackFile)) {
                    parsedFile = parsedFile.slice(1);
                }
            }
        }

        if (fileManagerEntry.dataType === "tle") {
            const nightSky = NodeMan.get("NightSkyNode");
            const existingTLE = nightSky.satellites.TLEData;
            const hasExisting = existingTLE && existingTLE.satData.length > 0;

            let action = trackOptions.tleAction;
            if (!action && this._tleMergeAll) {
                action = "merge";
            }
            if (!action && hasExisting && !this._tleDialogPromise) {
                this._tleMergeAll = false;
                this._tleReplacedInBatch = false;
            }
            if (!action && hasExisting) {
                try {
                    if (this._tleDialogPromise) {
                        action = await this._tleDialogPromise;
                    } else {
                        this._tleDialogPromise = this.showTLEChoiceDialog(filename, existingTLE, parsedFile);
                        action = await this._tleDialogPromise;
                        this._tleDialogPromise = null;
                    }
                } catch (e) {
                    this._tleDialogPromise = null;
                    return false;
                }
            }

            if (action === "mergeAll") {
                this._tleMergeAll = true;
                action = "merge";
            }

            if (!hasExisting) {
                this._tleMergeAll = true;
            }

            if (action === "replace" && this._tleReplacedInBatch) {
                action = "merge";
            }

            fileManagerEntry.isTLE = true;

            if (action === "merge" && hasExisting) {
                fileManagerEntry.tleMerged = true;
                nightSky.mergeTLE(parsedFile);
            } else {
                this.deleteIf(file => file.isTLE && file !== fileManagerEntry);
                nightSky.replaceTLE(parsedFile);
                this._tleReplacedInBatch = true;
            }
            return true;
        } else {
            let isATrack = false;
            let isASitch = false;

            if (parsedFile instanceof CTrackFile) {
                if (parsedFile.refineStationCoords) {
                    await parsedFile.refineStationCoords();
                }
                isATrack = parsedFile.doesContainTrack();
            } else if (fileManagerEntry.dataType === "json"
                || (fileExt === "csv" && fileManagerEntry.dataType !== "Unknown")
                || fileExt === "klv") {
                isATrack = true;
            }

            if (fileManagerEntry.dataType === "sitch") {
                isASitch = true;
            }

            if (isATrack) {
                await TrackManager.addTracks([filename], true, undefined, trackOptions);
                if (parsedFile instanceof CTrackFile) {
                    parsedFile.extractObjects();
                }
                return true;
            } else if (isASitch) {
                let copy = parsedFile.slice();
                if (copy instanceof ArrayBuffer) {
                    const decoder = new TextDecoder('utf-8');
                    const decodedString = decoder.decode(copy);
                    copy = textSitchToObject(decodedString);
                }
                setNewSitchObject(copy);
                return false;
            } else if (fileManagerEntry.dataType === "model" || fileManagerEntry.dataType === "glb" || isSupportedModelFile(filename)) {
                this.registerDroppedModel(filename);

                const targetObject = this.getPreferredDroppedModelTarget();
                if (targetObject) {
                    this.applyDroppedModelToObject(targetObject, filename);
                }

                return true;
            }

            if (parsedFile instanceof CTrackFile) {
                parsedFile.extractObjects();
                return true;
            }

            if (fileManagerEntry.dataType === "video") {
                console.log("Video data detected: " + filename);
                if (!NodeMan.exists("video")) {
                    console.warn("No video node found to load video data");
                    return false;
                }

                const videoNode = NodeMan.get("video");

                // Skip if the video node already SUCCESSFULLY loaded this file
                // via the separate videoFile/videos[] reload path. Without
                // this, sitch reload would upload the same h264/aac substream
                // twice. But a legacy sitch's loadVideoFromEntry path can fail
                // (substream URL doesn't exist on the server — only the parent
                // .ts is persisted) and then this loadedFiles dispatch needs
                // to actually do the load via uploadFile. So check both that
                // the filename matches AND that the existing videoData is in
                // a healthy state (no error, has frames or is still loading).
                const matchesByFilename =
                    videoNode.fileName === filename ||
                    (Array.isArray(videoNode.videos) && videoNode.videos.some(v => v.fileName === filename));
                const existingLoadOk = videoNode.videoData
                    && !videoNode.videoData.error
                    && (videoNode.videoData.frames > 0 || videoNode.videoData.h264Data || videoNode.videoData.videoDroppedData);
                if (matchesByFilename && existingLoadOk) {
                    console.log(`Video ${filename} already loaded via videoFile path; skipping redundant upload`);
                    return false;
                }

                if (fileExt === "h264" || fileExt === "dad") {
                    console.log("H.264 stream detected, attempting to load with specialized handler");
                    const blob = new Blob([parsedFile], { type: 'video/h264' });
                    const file = new File([blob], filename, { type: 'video/h264' });
                    videoNode.uploadFile(file, true);
                } else if (fileExt === "m4a" || fileExt === "mp3") {
                    console.log("Audio file detected: " + filename);
                    const mimeType = fileExt === "mp3" ? 'audio/mpeg' : 'audio/mp4';
                    const blob = new Blob([parsedFile], { type: mimeType });
                    const file = new File([blob], filename, { type: mimeType });
                    videoNode.uploadFile(file, true);
                } else if (fileExt === "mp4" || fileExt === "mov" || fileExt === "webm" || fileExt === "avi") {
                    console.log("Video file detected: " + filename);
                    const mimeType = `video/${fileExt === "mov" ? "quicktime" : fileExt}`;
                    const blob = new Blob([parsedFile], { type: mimeType });
                    const file = new File([blob], filename, { type: mimeType });
                    videoNode.uploadFile(file, true);
                } else if (fileExt === "m2v" || fileExt === "m1v") {
                    const codecName = fileExt === "m2v" ? "MPEG-2" : "MPEG-1";
                    showError(`${codecName} video is not supported by browser WebCodecs. ` +
                        `Re-encode to H.264 with: ffmpeg -i "${filename}" -c:v libx264 -preset fast output.mp4`);
                    console.error(`[Video] ${codecName} video stream detected (${filename}). ` +
                        `WebCodecs only supports H.264, VP8/VP9, and AV1.`);
                } else {
                    console.warn("Unknown video format for: " + filename);
                }
                return true;
            }

            if (fileManagerEntry.dataType === "kmzImage") {
                console.log("Skipping video handling for KMZ overlay image: " + filename);
                return false;
            }

            if (fileExt === "jpg" || fileExt === "jpeg" || fileExt === "png" || fileExt === "gif" || fileManagerEntry.dataType === "image") {
                const isTiff = fileExt === "tif" || fileExt === "tiff";

                if (isTiff) {
                    try {
                        const choice = await DragDropHandler.showImageChoiceDialog(filename);
                        if (choice === 'video') {
                            if (NodeMan.exists("video")) {
                                const videoNode = NodeMan.get("video");
                                const alreadyLoaded = Globals.deserializing && videoNode.videos?.some(videoEntry =>
                                    (videoEntry.imageFileID === filename || videoEntry.fileName === filename) && videoEntry.videoData
                                );
                                if (alreadyLoaded) {
                                    console.log(`[CFileManager] Skipping image->video restore for "${filename}" - already loaded`);
                                    return false;
                                }
                                fileManagerEntry.dataType = "videoImage";
                                videoNode.makeImageVideo(filename, parsedFile, true, filename);
                                videoNode.imageFileID = filename;
                                return true;
                            }
                        } else if (choice === 'overlay') {
                            await this.createGroundOverlayFromImage(filename, parsedFile);
                            return true;
                        }
                    } catch (e) {
                        console.log("Image import cancelled");
                    }
                    return false;
                }

                if (!NodeMan.exists("video")) {
                    console.warn("No video node found to load video file");
                    return false;
                }
                const videoNode = NodeMan.get("video");
                const alreadyLoaded = Globals.deserializing && videoNode.videos?.some(videoEntry =>
                    (videoEntry.imageFileID === filename || videoEntry.fileName === filename) && videoEntry.videoData
                );
                if (alreadyLoaded) {
                    console.log(`[CFileManager] Skipping image->video restore for "${filename}" - already loaded`);
                    return false;
                }
                fileManagerEntry.dataType = "videoImage";
                videoNode.makeImageVideo(filename, parsedFile, true, filename);
                videoNode.imageFileID = filename;
                return true;
            }

            if (fileManagerEntry.dataType === "geotiff") {
                const { buffer, bounds } = parsedFile;
                await this.createGroundOverlayFromGeoTIFF(filename, buffer, bounds);
                fileManagerEntry.skipSerialization = true;
                return true;
            }

            console.warn("Unhandled file type: " + fileExt + " for " + filename);
        }
        return false;
    },

    async createGroundOverlayFromGeoTIFF(filename, buffer, bounds) {
        const baseName = filename.replace(/\.[^.]+$/, '');
        const fileID = `geotiff_${baseName}_${Date.now()}`;

        const tiff = await geotiffFromArrayBuffer(buffer);
        const image = await tiff.getImage();
        const width = image.getWidth();
        const height = image.getHeight();
        const rasters = await image.readRasters();

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        const imageData = ctx.createImageData(width, height);

        const numBands = rasters.length;
        const extraSamples = image.fileDirectory.ExtraSamples;
        const hasAlpha = extraSamples && (extraSamples[0] === 1 || extraSamples[0] === 2);

        for (let i = 0; i < width * height; i++) {
            if (numBands >= 3) {
                imageData.data[i * 4] = rasters[0][i];
                imageData.data[i * 4 + 1] = rasters[1][i];
                imageData.data[i * 4 + 2] = rasters[2][i];
                imageData.data[i * 4 + 3] = (numBands >= 4 && hasAlpha) ? rasters[3][i] : 255;
            } else {
                const val = rasters[0][i];
                imageData.data[i * 4] = val;
                imageData.data[i * 4 + 1] = val;
                imageData.data[i * 4 + 2] = val;
                imageData.data[i * 4 + 3] = 255;
            }
        }
        ctx.putImageData(imageData, 0, 0);

        const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const pngBuffer = await pngBlob.arrayBuffer();
        const blobURL = URL.createObjectURL(pngBlob);

        const pngFilename = baseName + '.png';
        this.remove(fileID);
        this.add(fileID, pngBuffer, pngBuffer);
        this.list[fileID].dynamicLink = true;
        this.list[fileID].staticURL = null;
        this.list[fileID].filename = pngFilename;
        this.list[fileID].dataType = "image";

        Synth3DManager.addOverlay({
            name: NodeMan.getUniqueID(baseName, 18),
            north: bounds.north,
            south: bounds.south,
            east: bounds.east,
            west: bounds.west,
            rotation: 0,
            imageURL: blobURL,
            imageFileID: fileID,
            gotoOnCreate: true,
            lockShape: true,
        });
        CustomManager.saveGlobalSettings();
        console.log(`Created ground overlay from GeoTIFF: ${filename} (fileID: ${fileID})`);
    },

    async createGroundOverlayFromImage(filename, img) {
        const baseName = filename.replace(/\.[^.]+$/, '');

        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);

        const pngBlob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
        const blobURL = URL.createObjectURL(pngBlob);

        const lookCamera = NodeMan.get("lookCamera");
        const pos = lookCamera.p(par.frame);
        const centerLLA = ECEFToLLAVD_radii(pos);

        const offset = 0.005;

        const overlay = Synth3DManager.addOverlay({
            name: NodeMan.getUniqueID(baseName, 18),
            north: centerLLA.x + offset,
            south: centerLLA.x - offset,
            east: centerLLA.y + offset,
            west: centerLLA.y - offset,
            rotation: 0,
            imageURL: blobURL,
        });

        if (overlay) {
            overlay.setEditMode(true);
            console.log(`Created ground overlay from image: ${filename}`);
        }
    },

    async handleFlightClubJSON(filename, jsonData, fileManagerEntry) {
        console.log("Processing FlightClub JSON: " + filename);

        fileManagerEntry.skipSerialization = true;

        const csvResults = flightClubToCSVStrings(jsonData);
        const missionInfo = extractFlightClubInfo(jsonData);
        const baseName = filename.replace(/\.[^.]+$/, '');

        const trackFilenames = [];

        csvResults.forEach((result) => {
            const csvFilename = `${baseName}-${result.stageName.replace(/\s+/g, '_')}.csv`;
            const encoder = new TextEncoder();
            const csvBuffer = encoder.encode(result.csvString).buffer;

            const parsed = csv.toArrays(result.csvString);
            const misbData = parseCustom1CSV(parsed);
            const trackFile = new CTrackFileMISB(stripDuplicateTimes(misbData));
            trackFile.isRocketTrajectory = true;
            trackFile.sourceType = "flightclub";

            this.add(csvFilename, trackFile, csvBuffer);
            this.list[csvFilename].filename = csvFilename;
            this.list[csvFilename].dataType = "trackfile";
            this.list[csvFilename].dynamicLink = true;

            trackFilenames.push(csvFilename);
            console.log(`Created track file "${result.stageName}" as ${csvFilename}`);
        });

        await TrackManager.addTracks(trackFilenames, true);

        if (NodeMan.exists("notesView")) {
            const notesView = NodeMan.get("notesView");
            const existingNotes = notesView.notesText || "";
            const separator = existingNotes ? "\n\n" : "";
            notesView.notesText = existingNotes + separator + missionInfo;
            if (notesView.textArea) {
                notesView.textArea.value = notesView.notesText;
            }
            notesView.show(true);
        }

        setRenderOne();
        console.log(`FlightClub JSON processed: ${csvResults.length} tracks created`);
    },

    parseAsset(filename, id, buffer, metadata = null) {
        // Content-sniff once, up front. We trust content over filename:
        // a `.mpg` that's actually a TS stream needs the TS demuxer, not the
        // MP4 video pipeline. sniffedExt is null when no signature matched
        // (typical for text formats — those still dispatch on filename below).
        const sniffedExt = sniffFileType(buffer);

        if (filename.toLowerCase().endsWith('.ts') || sniffedExt === 'ts') {
            return TSParser.parseTSFile(filename, id, buffer, (streamFilename, streamId, streamData, streamMetadata) => {
                console.log("Detected TS Stream: " + streamFilename + " for id: " + streamId + "");
                return this.parseAsset(streamFilename, streamId, streamData, streamMetadata)
                    .then(parsedSubstream => {
                        // Tag the parsed result with the substream's raw demuxed bytes
                        // so parseResult can use these as `original` instead of the full
                        // archive buffer. Skips arrays (nested multi-stream) defensively.
                        if (parsedSubstream && !Array.isArray(parsedSubstream)) {
                            parsedSubstream.streamData = streamData;
                            // Forward MISB ST 0604 PES timing so parseResult can stash
                            // it on the FileManager entry for save-time sidecar emission.
                            // Live demux already consumed pesEntries inside parseKLVFile;
                            // we keep them here so the round-trip can reconstruct without
                            // re-demuxing the parent TS.
                            if (streamMetadata && Array.isArray(streamMetadata.pesEntries)) {
                                parsedSubstream.pesEntries = streamMetadata.pesEntries;
                                parsedSubstream.videoFirstPESus = streamMetadata.videoFirstPESus;
                                parsedSubstream.tsParentFilename = filename;
                            }
                        }
                        return parsedSubstream;
                    });
            });
        }

        const fnLower = filename.toLowerCase();
        if (fnLower.endsWith('.ntf') || fnLower.endsWith('.nitf') || fnLower.endsWith('.nsf') || NITFParser.isNITF(buffer)) {
            console.log("NITF/NSIF file detected: " + filename);
            return NITFParser.parseNITFFile(filename, id, buffer);
        }

        let isZip = false;
        if (filename.endsWith('.zip') || filename.endsWith('.kmz')) {
            isZip = true;
        }
        const byteView = new Uint8Array(buffer);
        if (byteView[0] === 0x50 && byteView[1] === 0x4B && byteView[2] === 0x03 && byteView[3] === 0x04) {
            isZip = true;
        }

        if (isZip) {
            const zip = new JSZip();
            return zip.loadAsync(buffer)
                .then(async (zipContents) => {
                    const allFiles = Object.keys(zipContents.files).filter(f => {
                        const entry = zipContents.files[f];
                        return !entry.dir && !f.includes('__MACOSX') && !f.includes('._');
                    });

                    const kmlFiles = allFiles.filter(f => f.toLowerCase().endsWith('.kml'));
                    const referencedImages = new Set();

                    if (filename.toLowerCase().endsWith('.kmz') && kmlFiles.length > 0) {
                        for (const kmlFile of kmlFiles) {
                            const kmlBuffer = await zipContents.files[kmlFile].async('arraybuffer');
                            const decoder = new TextDecoder('utf-8');
                            const kmlText = decoder.decode(kmlBuffer);
                            const hrefMatches = kmlText.matchAll(/<href>([^<]+)<\/href>/gi);
                            for (const match of hrefMatches) {
                                const href = match[1].trim();
                                if (/\.(png|jpg|jpeg|gif|webp|jp2|j2k|jpx)$/i.test(href)) {
                                    referencedImages.add(href);
                                    console.log("KMZ: Found referenced image in KML:", href);
                                }
                            }
                        }
                    }

                    const imageFiles = allFiles.filter(f => {
                        const baseName = f.split('/').pop();
                        return referencedImages.has(baseName);
                    });

                    for (const imgFile of imageFiles) {
                        const baseName = imgFile.split('/').pop();

                        if (this.kmzImageMap && this.kmzImageMap[baseName]) {
                            console.log(`KMZ: Skipping image ${baseName}, already loaded`);
                            continue;
                        }

                        const imgBuffer = await zipContents.files[imgFile].async('arraybuffer');
                        const ext = baseName.split('.').pop().toLowerCase();
                        const mimeType = ext === 'png' ? 'image/png' :
                                        ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                        ext === 'gif' ? 'image/gif' : 'image/webp';

                        const blob = new Blob([imgBuffer], { type: mimeType });
                        const blobURL = URL.createObjectURL(blob);

                        const fileID = `kmz_${filename}_${baseName}`;
                        this.remove(fileID);
                        this.add(fileID, imgBuffer, imgBuffer);
                        this.list[fileID].dynamicLink = true;
                        this.list[fileID].staticURL = null;
                        this.list[fileID].filename = baseName;
                        this.list[fileID].dataType = "kmzImage";
                        this.list[fileID].blobURL = blobURL;
                        this.list[fileID].kmzHref = baseName;

                        if (!this.kmzImageMap) this.kmzImageMap = {};
                        this.kmzImageMap[baseName] = blobURL;

                        console.log(`KMZ: Stored image ${baseName} with blobURL ${blobURL}`);
                    }

                    const nonImageFiles = allFiles.filter(f => {
                        const baseName = f.split('/').pop();
                        return !referencedImages.has(baseName);
                    });

                    const filePromises = nonImageFiles.map(zipFilename => {
                        const zipEntry = zipContents.files[zipFilename];
                        return zipEntry.async('arraybuffer')
                            .then(unzippedBuffer => {
                                let prefixedFilename = filename + "_" + zipFilename;
                                console.log("Unzipped file: " + prefixedFilename + " for id: " + id + " buffer size: " + unzippedBuffer.byteLength);
                                return this.parseAsset(prefixedFilename, id, unzippedBuffer);
                            })
                            .catch(err => {
                                console.error("Error parsing unzipped file " + zipFilename + ":", err);
                                throw err;
                            });
                    });

                    return Promise.all(filePromises);
                })
                .catch(error => {
                    console.error('Error unzipping the file:', error);
                    showError('Error unzipping the file:', error);
                });
        } else {

            // Prefer content-sniffed type when one was detected — the filename
            // extension is just a hint and may be wrong (e.g. a `.mpg` that's
            // really H.264 in MP4, or a `.bin` that's a PNG). Fall back to the
            // filename extension for text formats and anything the sniffer
            // doesn't recognize.
            var fileExt = sniffedExt || this.deriveExtension(filename);

            var parsed;
            var prom;

            const decoder = new TextDecoder("utf-8");

            let dataType = "unknown";

            switch (fileExt.toLowerCase()) {
                case "txt": {
                    var text = decoder.decode(buffer);
                    // Sidecar carrying MISB ST 0604 PES PTS data — written
                    // alongside TS-extracted substreams as `<filename>.pts.txt`.
                    // The content is JSON; the .txt extension just keeps it out
                    // of the .json sitch/track loader paths. The actual consumer
                    // (CustomManagerSerialize._fetchPesSidecar) fetches the URL
                    // directly via the saved sidecarURL — this branch only
                    // handles the case where one is dropped standalone, in
                    // which case we recognize it and mark it as a non-track.
                    if (filename.toLowerCase().endsWith(".pts.txt") || /^\s*\{[^}]*"kind"\s*:\s*"klv-pes-pts"/.test(text)) {
                        try {
                            const jsonParsed = JSON.parse(text);
                            if (jsonParsed && jsonParsed.kind === "klv-pes-pts") {
                                parsed = jsonParsed;
                                dataType = "pts-sidecar";
                                break;
                            }
                        } catch (e) {
                            // Not parseable JSON — fall through to normal .txt handling.
                        }
                    }
                    const txtType = detectTXTType(text);
                    if (txtType === "PBA") {
                        text = extractPBACSV(text);
                        parsed = csv.toArrays(text);
                        const custom1Misb = parseCustom1CSV(parsed);
                        if (Sit.isCustom) {
                            parsed = new CTrackFileMISB(stripDuplicateTimes(custom1Misb));
                        } else {
                            parsed = new CTrackFileMISB(custom1Misb);
                        }
                        dataType = "trackfile";
                    } else {
                        parsed = this.detectTrackFile(filename, text);
                        if (parsed) {
                            dataType = "trackfile";
                        } else {
                            parsed = text;
                            dataType = "tle";
                        }
                    }
                    break;
                }
                case "tle":
                    parsed = decoder.decode(buffer);
                    dataType = "tle";
                    break;
                case "dat":
                    parsed = decoder.decode(buffer);
                    dataType = "dat";
                    break;
                case "klv": {
                    // When this KLV substream comes from Sitrec's TS demuxer
                    // (drag-and-drop of a .ts/.mpg file), the metadata
                    // bundle carries pesEntries: a per-PES PTS map from
                    // the original PCR-locked timeline. Threading those
                    // into parseKLVFile lets each MISB record retain its
                    // PES PTS, which is the MISB ST 0604 anchor used to
                    // pair KLV records to specific video frames. For KLV
                    // loaded from a flat .klv file (no TS context), this
                    // is null and the parser falls back to its existing
                    // behavior — Tag-2 UnixTimeStamp as the only anchor.
                    const pesEntries = metadata?.pesEntries || null;
                    const videoFirstPESus = (metadata && typeof metadata.videoFirstPESus === "number")
                        ? metadata.videoFirstPESus : null;
                    const klvMisb = parseKLVFile(buffer, pesEntries, videoFirstPESus);
                    if (klvMisb === undefined) {
                        console.warn(`parseAsset: KLV parsing failed for "${filename}", skipping file`);
                        parsed = null;
                        dataType = "klv";
                        break;
                    }
                    parsed = new CTrackFileMISB(klvMisb);
                    dataType = "trackfile";
                    break;
                }
                case "jpg":
                case "jpeg":
                    prom = createImageFromArrayBuffer(buffer, 'image/jpeg');
                    dataType = "image";
                    break;
                case "gif":
                    prom = createImageFromArrayBuffer(buffer, 'image/gif');
                    dataType = "image";
                    break;
                case "png":
                    prom = createImageFromArrayBuffer(buffer, 'image/png');
                    dataType = "image";
                    break;
                case "tif":
                case "tiff":
                    prom = (async () => {
                        try {
                            const tiff = await geotiffFromArrayBuffer(buffer);
                            const image = await tiff.getImage();
                            const bbox = image.getBoundingBox();
                            if (bbox && bbox.length === 4) {
                                const [west, south, east, north] = bbox;
                                if (west !== 0 || south !== 0 || east !== image.getWidth() || north !== image.getHeight()) {
                                    const geoKeys = image.getGeoKeys();
                                    const geographicType = geoKeys?.GeographicTypeGeoKey;
                                    const projectedType = geoKeys?.ProjectedCSTypeGeoKey;

                                    const isWGS84Geographic = geographicType === 4326 && !projectedType;
                                    const isValidLatLon = north >= -90 && north <= 90 &&
                                                          south >= -90 && south <= 90 &&
                                                          east >= -180 && east <= 180 &&
                                                          west >= -180 && west <= 180;

                                    let finalBounds = { north, south, east, west };

                                    if (!isWGS84Geographic && !isValidLatLon) {
                                        if (projectedType) {
                                            try {
                                                finalBounds = await projectedBoundsToWGS84(projectedType, west, south, east, north);
                                                console.log(`Converted EPSG:${projectedType} bounds to WGS84:`, finalBounds);
                                            } catch (e) {
                                                console.warn(`GeoTIFF has unsupported projected CRS (EPSG:${projectedType}): ${e.message}`);
                                                dataType = "image";
                                                return convertTiffBufferToPngImage(buffer);
                                            }
                                        } else {
                                            console.warn(`GeoTIFF has unknown CRS (Geographic: ${geographicType}). ` +
                                                `Bounds [${west}, ${south}, ${east}, ${north}] are not valid lat/lon.`);
                                            dataType = "image";
                                            return convertTiffBufferToPngImage(buffer);
                                        }
                                    }

                                    dataType = "geotiff";
                                    return {
                                        buffer: buffer,
                                        bounds: finalBounds,
                                        width: image.getWidth(),
                                        height: image.getHeight()
                                    };
                                }
                            }
                        } catch (e) {
                            console.log("GeoTIFF parsing failed, treating as regular image:", e.message);
                        }
                        dataType = "image";
                        return convertTiffBufferToPngImage(buffer);
                    })();
                    break;
                case "webp":
                    prom = createImageFromArrayBuffer(buffer, 'image/webp');
                    dataType = "image";
                    break;
                case "heic":
                    dataType = "image";
                    prom = createImageFromArrayBuffer(buffer, 'image/heic');
                    break;
                case "jp2":
                case "j2k":
                case "jpx":
                case "jpc":
                case "j2c":
                    dataType = "image";
                    prom = (async () => {
                        const {decodeJPEG2000ToImage} = await import("./JPEG2000Utils");
                        return decodeJPEG2000ToImage(buffer);
                    })();
                    break;
                case "csv": {
                    const buffer2 = cleanCSVText(buffer);
                    var text = decoder.decode(buffer);

                    const sondeTrackFile = this.detectTrackFile(filename, text);
                    if (sondeTrackFile) {
                        parsed = sondeTrackFile;
                        dataType = "trackfile";
                        break;
                    }

                    parsed = csv.toArrays(text);
                    dataType = detectCSVType(parsed);
                    if (dataType === "Unknown") {
                        parsed.shift();
                    } else if (dataType === "Airdata") {
                        const airdataMisb = parseAirdataCSV(parsed);
                        parsed = new CTrackFileMISB(airdataMisb);
                        dataType = "trackfile";
                    } else if (dataType === "MISB_FULL") {
                        const misbFullData = parseMISB1CSV(parsed);
                        parsed = new CTrackFileMISB(misbFullData);
                        dataType = "trackfile";
                    } else if (dataType === "MISB1") {
                        const csvMisb = parseMISB1CSV(parsed);
                        if (Sit.isCustom) {
                            parsed = new CTrackFileMISB(stripDuplicateTimes(csvMisb));
                        } else {
                            parsed = new CTrackFileMISB(csvMisb);
                        }
                        dataType = "trackfile";
                    } else if (dataType === "CUSTOM1") {
                        const custom1Misb = parseCustom1CSV(parsed);
                        if (Sit.isCustom) {
                            parsed = new CTrackFileMISB(stripDuplicateTimes(custom1Misb));
                        } else {
                            parsed = new CTrackFileMISB(custom1Misb);
                        }
                        dataType = "trackfile";
                    } else if (dataType === "CUSTOM_FLL") {
                        const customFllMisb = parseCustomFLLCSV(parsed);
                        if (Sit.isCustom) {
                            parsed = new CTrackFileMISB(stripDuplicateTimes(customFllMisb));
                        } else {
                            parsed = new CTrackFileMISB(customFllMisb);
                        }
                        dataType = "trackfile";
                    } else if (dataType === "FR24CSV") {
                        const fr24Misb = parseFR24CSV(parsed);
                        if (Sit.isCustom) {
                            parsed = new CTrackFileMISB(stripDuplicateTimes(fr24Misb));
                        } else {
                            parsed = new CTrackFileMISB(fr24Misb);
                        }
                        dataType = "trackfile";
                    }

                    break;
                }
                case "kml":
                case "ksv":
                case "xml": {
                    const xmlParsed = parseXml(decoder.decode(buffer));
                    parsed = this.detectTrackFile(filename, xmlParsed);
                    if (parsed) {
                        dataType = "trackfile";
                    } else {
                        console.warn("No trackfile handler found for XML/KML file: " + filename);
                        dataType = "unknown";
                        parsed = xmlParsed;
                    }
                    break;
                }
                case "glb":
                case "ply":
                    dataType = "model";
                    parsed = buffer;
                    break;
                case "bin":
                    dataType = "bin";
                    parsed = buffer;
                    break;
                case "sitch.js":
                    dataType = "sitch";
                    parsed = buffer;
                    break;
                case "srt": {
                    const srtText = decoder.decode(buffer);
                    parsed = this.detectTrackFile(filename, srtText);
                    if (parsed) {
                        dataType = "trackfile";
                    } else {
                        console.warn("No trackfile handler found for SRT file: " + filename);
                        dataType = "unknown";
                        parsed = srtText;
                    }
                    break;
                }
                case "json": {
                    const jsonParsed = JSON.parse(decoder.decode(buffer));
                    if (jsonParsed && jsonParsed.kind === "klv-pes-pts") {
                        // PES PTS sidecar emitted by older saves (since renamed
                        // to .pts.txt). Loader fetches the URL directly via
                        // _fetchPesSidecar; if one is dropped on the page
                        // standalone, mark it as a non-track non-sitch so the
                        // generic .json track-import path doesn't run.
                        dataType = "pts-sidecar";
                        parsed = jsonParsed;
                    } else if (jsonParsed.isASitchFile) {
                        dataType = "sitch";
                        parsed = buffer;
                    } else if (isFlightClubJSON(jsonParsed)) {
                        dataType = "flightclub";
                        parsed = jsonParsed;
                    } else {
                        parsed = this.detectTrackFile(filename, jsonParsed);
                        if (parsed) {
                            dataType = "trackfile";
                        } else {
                            dataType = "json";
                            parsed = jsonParsed;
                        }
                    }
                    break;
                }
                case "dad":
                case "h264":
                    dataType = "video";
                    parsed = buffer;
                    console.log("Parsed H.264 stream: " + filename + " (" + buffer.byteLength + " bytes)");
                    // Forward any PES timing the caller supplied (TS-demux substream
                    // callback or sidecar reload). Returned via the wrapper so the
                    // URL-fetch loadAsset path can stash them onto the FileManager
                    // entry — same effect parseResult achieves through the substream
                    // loop. Without this, video-side pesEntries are silently dropped
                    // on URL reloads, leaving framePTSus[] synthetic.
                    if (metadata && Array.isArray(metadata.pesEntries) && metadata.pesEntries.length > 0) {
                        return Promise.resolve({
                            filename: filename,
                            parsed: parsed,
                            dataType: dataType,
                            pesEntries: metadata.pesEntries,
                            videoFirstPESus: typeof metadata.videoFirstPESus === "number" ? metadata.videoFirstPESus : null,
                        });
                    }
                    break;

                case "m2v":
                    dataType = "video";
                    parsed = buffer;
                    if (metadata) {
                        parsed.fps = metadata.fps;
                        parsed.width = metadata.width;
                        parsed.height = metadata.height;
                        console.log("Parsed MPEG-2 stream: " + filename + " (" + buffer.byteLength + " bytes)" +
                                    (metadata.fps ? ` @ ${metadata.fps.toFixed(2)} fps` : '') +
                                    (metadata.width && metadata.height ? ` ${metadata.width}x${metadata.height}` : ''));
                    } else {
                        console.log("Parsed MPEG-2 stream: " + filename + " (" + buffer.byteLength + " bytes)");
                    }
                    break;

                case "html":
                case "htm": {
                    const htmlText = decoder.decode(buffer);
                    parsed = this.detectTrackFile(filename, htmlText);
                    if (parsed) {
                        dataType = "trackfile";
                    } else {
                        parsed = htmlText;
                        dataType = "unknown";
                    }
                    break;
                }

                case "mp4":
                case "mov":
                case "webm":
                case "avi":
                    dataType = "video";
                    parsed = buffer;
                    console.log("Parsed video: " + filename + " (" + buffer.byteLength + " bytes)");
                    break;

                default:
                    if (isAudioOnlyFormat(filename)) {
                        dataType = "video";
                        parsed = buffer;
                        console.log("Parsed audio file: " + filename + " (" + buffer.byteLength + " bytes)");
                        break;
                    }

                    console.warn("Unhandled extension " + fileExt + " for " + filename);
                    return Promise.resolve({filename: filename, parsed: buffer, dataType: dataType});
            }

            if (prom !== undefined) {
                return prom.then(parsed => {
                    return {
                        filename: filename, parsed: parsed, dataType: dataType
                    };
                });
            }

            return Promise.resolve({filename: filename, parsed: parsed, dataType: dataType});
        }
    },

    deriveExtension(filename) {
        var fileExt;
        if (filename.startsWith(SITREC_SERVER + "proxy.php")) {
            fileExt = "txt";
        } else if (filename.startsWith(SITREC_SERVER + "proxyStarlink.php")) {
            fileExt = "txt";
        } else {
            fileExt = getFileExtension(filename);
        }
        return fileExt;
    },

    detectTrackFile(filename, data) {
        const matchingClasses = trackFileClasses.filter(TrackFileClass => TrackFileClass.canHandle(filename, data));
        assert(matchingClasses.length <= 1,
            `Multiple trackfile handlers matched for ${filename}: ${matchingClasses.map(c => c.name).join(', ')}`);
        if (matchingClasses.length === 1) {
            return new matchingClasses[0](data);
        }
        return null;
    },
};
