// Multi-track loading dialog and reusable track filter system.
// Used both at load-time (for files with 3+ tracks) and post-load (Contents menu "Filter Tracks").

import {MISB} from "./MISBFields";
import {LLAToECEF} from "./LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {m2f} from "./utils";
import {Frustum, Matrix4, Vector3} from "three";
import {Globals, NodeMan, TrackManager, FileManager, Sit, setRenderOne} from "./Globals";
import {CTrackFile} from "./TrackFiles/CTrackFile";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {blockViewEvents, makeDraggable} from "./DragResizeUtils";


// ─── Track Preview Extraction ────────────────────────────────────────────────

// Extract summary info from a raw CTrackFile track without creating nodes.
// Returns null if the track has no valid data.
export function extractTrackPreviewInfo(trackFile, trackIndex, filename) {
    const misb = trackFile.toMISB(trackIndex);
    if (!misb || misb.length === 0) return null;

    const shortName = trackFile.getShortName(trackIndex, filename);

    // Altitude datum: LLAToECEF expects HAE, the displayed range should be MSL.
    // Raw column values are MSL for most sources but HAE for e.g. STANAG cs="WGS_84"
    // (trackFile.isAltitudeHAE), so convert in whichever direction is missing.
    const altIsHAE = typeof trackFile.isAltitudeHAE === "function" && trackFile.isAltitudeHAE(trackIndex);

    // Determine sitch time window (ms)
    const sitchEstablished = Globals.sitchEstablished && Sit.startTime !== "2000-01-01T00:00:00Z";
    let windowStartMs, windowEndMs;
    if (sitchEstablished) {
        windowStartMs = new Date(Sit.startTime).getTime();
        windowEndMs = windowStartMs + (Sit.frames / Sit.fps) * 1000;
    } else {
        // No sitch yet — use full track range
        windowStartMs = -Infinity;
        windowEndMs = Infinity;
    }

    let altMinM = Infinity;
    let altMaxM = -Infinity;
    const ecefSamples = [];
    let sampleCount = 0;
    let firstECEF = null;
    let lastECEF = null;

    for (let i = 0; i < misb.length; i++) {
        const t = misb[i][MISB.UnixTimeStamp];
        if (t !== null && t !== undefined && (t < windowStartMs || t > windowEndMs)) continue;

        const alt = misb[i][MISB.SensorTrueAltitude];

        const lat = misb[i][MISB.SensorLatitude];
        const lon = misb[i][MISB.SensorLongitude];
        const haveLL = lat !== null && lat !== undefined && lon !== null && lon !== undefined && isFinite(lat) && isFinite(lon);
        const geoidN = haveLL ? meanSeaLevelOffset(lat, lon) : 0;

        if (alt !== null && alt !== undefined && isFinite(alt)) {
            const altMSL = altIsHAE ? alt - geoidN : alt;   // display range is MSL
            if (altMSL < altMinM) altMinM = altMSL;
            if (altMSL > altMaxM) altMaxM = altMSL;
        }

        if (haveLL) {
            const a = alt ?? 0;
            const ecef = LLAToECEF(lat, lon, altIsHAE ? a : a + geoidN);   // LLAToECEF expects HAE
            // Always track first and last valid in-window points
            if (!firstECEF) firstECEF = ecef;
            lastECEF = ecef;
            // Sample every 10th in-window point for frustum checks
            if (sampleCount % 10 === 0) {
                ecefSamples.push(ecef);
            }
        }
        sampleCount++;
    }
    // Ensure first and last in-window points are included (needed for towards/away filters)
    if (firstECEF && (ecefSamples.length === 0 || ecefSamples[0] !== firstECEF)) {
        ecefSamples.unshift(firstECEF);
    }
    if (lastECEF && lastECEF !== firstECEF && ecefSamples[ecefSamples.length - 1] !== lastECEF) {
        ecefSamples.push(lastECEF);
    }

    if (altMinM === Infinity) altMinM = 0;
    if (altMaxM === -Infinity) altMaxM = 0;

    return {
        trackIndex,
        shortName,
        altMinFt: Math.round(m2f(altMinM)),
        altMaxFt: Math.round(m2f(altMaxM)),
        ecefSamples,
        misbData: misb,
        windowStartMs,
        windowEndMs,
    };
}


// ─── Reusable Filter Functions ───────────────────────────────────────────────

// Returns true if any point's altitude (ft) falls within [lowFt, highFt] during the sitch window.
export function filterByAltitude(info, lowFt, highFt) {
    const misb = info.misbData;
    for (let i = 0; i < misb.length; i++) {
        const t = misb[i][MISB.UnixTimeStamp];
        if (t !== null && t !== undefined && (t < info.windowStartMs || t > info.windowEndMs)) continue;
        const alt = misb[i][MISB.SensorTrueAltitude];
        if (alt !== null && alt !== undefined && isFinite(alt)) {
            const altFt = m2f(alt);
            if (altFt >= lowFt && altFt <= highFt) return true;
        }
    }
    return false;
}

// Returns true if any sampled ECEF point falls within the camera's frustum.
export function filterCrossesFrustum(info, camera) {
    const frustum = new Frustum();
    const projScreenMatrix = new Matrix4();
    projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(projScreenMatrix);

    for (const pt of info.ecefSamples) {
        if (frustum.containsPoint(pt)) return true;
    }
    return false;
}

// Returns true if the track's overall direction during the sitch window is towards the camera.
export function filterTowardsCamera(info, cameraPosition) {
    if (info.ecefSamples.length < 2) return false;
    const first = info.ecefSamples[0];
    const last = info.ecefSamples[info.ecefSamples.length - 1];
    const trackDir = new Vector3().subVectors(last, first);
    const midpoint = new Vector3().addVectors(first, last).multiplyScalar(0.5);
    const toCamera = new Vector3().subVectors(cameraPosition, midpoint);
    return trackDir.dot(toCamera) > 0;
}

// Returns true if the track's overall direction during the sitch window is away from the camera.
export function filterAwayFromCamera(info, cameraPosition) {
    if (info.ecefSamples.length < 2) return false;
    const first = info.ecefSamples[0];
    const last = info.ecefSamples[info.ecefSamples.length - 1];
    const trackDir = new Vector3().subVectors(last, first);
    const midpoint = new Vector3().addVectors(first, last).multiplyScalar(0.5);
    const toCamera = new Vector3().subVectors(cameraPosition, midpoint);
    return trackDir.dot(toCamera) < 0;
}

// Apply all enabled filters (AND logic). Returns boolean array, one per info.
export function applyFilters(infos, filterOptions) {
    return infos.map(info => {
        if (filterOptions.altitudeEnabled) {
            if (!filterByAltitude(info, filterOptions.altLowFt, filterOptions.altHighFt)) return false;
        }
        if (filterOptions.frustumEnabled && filterOptions.camera) {
            if (!filterCrossesFrustum(info, filterOptions.camera)) return false;
        }
        if (filterOptions.towardsEnabled && filterOptions.cameraPosition) {
            if (!filterTowardsCamera(info, filterOptions.cameraPosition)) return false;
        }
        if (filterOptions.awayEnabled && filterOptions.cameraPosition) {
            if (!filterAwayFromCamera(info, filterOptions.cameraPosition)) return false;
        }
        return true;
    });
}


// ─── Shared Dialog Styling ───────────────────────────────────────────────────

const OVERLAY_STYLE = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.5); z-index: 10000;
    display: flex; align-items: center; justify-content: center;
`;

const DIALOG_STYLE = `
    background: #2a2a2a; border-radius: 8px; padding: 20px;
    min-width: 340px; max-width: 520px;
    box-shadow: 0 4px 20px rgba(0,0,0,0.5);
    font-family: Arial, sans-serif; color: white;
`;

const TITLE_STYLE = `margin: 0 0 10px 0; font-size: 18px; color: #fff;`;

const MSG_STYLE = `margin: 0 0 15px 0; font-size: 14px; color: #ccc;`;

const BTN_STYLE = `
    padding: 10px 20px; border: none; border-radius: 4px;
    cursor: pointer; font-size: 14px; margin: 5px; width: calc(100% - 10px);
`;

function makeButton(text, bgColor, onClick) {
    const btn = document.createElement('button');
    btn.textContent = text;
    btn.style.cssText = BTN_STYLE + `background: ${bgColor}; color: white;`;
    btn.onclick = onClick;
    return btn;
}

// makeOverlayAndDialog creates either a blocking modal (with overlay) or a
// modeless draggable panel, controlled by the `modeless` option.
function makeOverlayAndDialog(options = {}) {
    if (options.modeless) {
        // Modeless: floating draggable panel, no overlay — scene remains interactive
        const dialog = document.createElement('div');
        dialog.style.cssText = DIALOG_STYLE + `
            position: fixed; top: 80px; left: 50%; transform: translateX(-50%);
            z-index: 10000; cursor: default;
        `;
        blockViewEvents(dialog);

        // Draggable title bar
        const titleBar = document.createElement('div');
        titleBar.style.cssText = `
            cursor: move; margin: -20px -20px 10px -20px; padding: 10px 20px;
            background: #333; border-radius: 8px 8px 0 0; user-select: none;
        `;
        dialog.appendChild(titleBar);

        document.body.appendChild(dialog);

        makeDraggable(dialog, {
            handle: titleBar,
            onDragStart: () => {
                // Remove centering transform on first drag so left-based positioning works
                if (dialog.style.transform) {
                    const rect = dialog.getBoundingClientRect();
                    dialog.style.left = rect.left + 'px';
                    dialog.style.top = rect.top + 'px';
                    dialog.style.transform = '';
                }
            },
        });

        // Return dialog as both overlay and dialog — cleanup removes the dialog itself
        return {overlay: dialog, dialog, titleBar};
    }

    // Modal: full-screen overlay blocks scene interaction
    const overlay = document.createElement('div');
    overlay.style.cssText = OVERLAY_STYLE;
    blockViewEvents(overlay);
    const dialog = document.createElement('div');
    dialog.style.cssText = DIALOG_STYLE;
    overlay.appendChild(dialog);
    return {overlay, dialog, titleBar: null};
}

function cleanup(overlay) {
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
}


// ─── Checkbox Track List ─────────────────────────────────────────────────────

// Shows a scrollable checkbox list of tracks. Returns Promise<number[]|null> (selected indices or null for cancel).
function showCheckboxList(previewInfos, initialChecked) {
    return new Promise(resolve => {
        const {overlay, dialog} = makeOverlayAndDialog();
        dialog.style.maxHeight = '80vh';
        dialog.style.display = 'flex';
        dialog.style.flexDirection = 'column';

        const title = document.createElement('h3');
        title.textContent = 'Select Tracks';
        title.style.cssText = TITLE_STYLE;
        dialog.appendChild(title);

        // Select All / None toggle
        const toggleRow = document.createElement('div');
        toggleRow.style.cssText = 'margin-bottom: 10px; display: flex; gap: 8px;';
        const selectAllBtn = makeButton('Select All', '#555', () => {
            checkboxes.forEach(cb => cb.checked = true);
        });
        selectAllBtn.style.width = 'auto';
        selectAllBtn.style.margin = '0';
        selectAllBtn.style.padding = '6px 12px';
        const selectNoneBtn = makeButton('Select None', '#555', () => {
            checkboxes.forEach(cb => cb.checked = false);
        });
        selectNoneBtn.style.width = 'auto';
        selectNoneBtn.style.margin = '0';
        selectNoneBtn.style.padding = '6px 12px';
        toggleRow.appendChild(selectAllBtn);
        toggleRow.appendChild(selectNoneBtn);
        dialog.appendChild(toggleRow);

        // Scrollable list
        const listDiv = document.createElement('div');
        listDiv.style.cssText = `
            overflow-y: auto; max-height: 50vh; margin-bottom: 15px;
            border: 1px solid #444; border-radius: 4px; padding: 4px;
        `;

        const checkboxes = [];
        previewInfos.forEach((info, i) => {
            const row = document.createElement('label');
            row.style.cssText = `
                display: flex; align-items: center; padding: 6px 8px; cursor: pointer;
                border-bottom: 1px solid #333; font-size: 13px; gap: 8px;
            `;
            row.addEventListener('mouseover', () => row.style.background = '#383838');
            row.addEventListener('mouseout', () => row.style.background = '');

            const cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.checked = initialChecked ? initialChecked[i] : true;
            cb.style.cssText = 'width: 16px; height: 16px; flex-shrink: 0;';
            checkboxes.push(cb);

            const nameSpan = document.createElement('span');
            nameSpan.textContent = info.shortName;
            nameSpan.style.cssText = 'flex: 1; color: #eee;';

            const altSpan = document.createElement('span');
            altSpan.textContent = `${info.altMinFt.toLocaleString()}–${info.altMaxFt.toLocaleString()} ft`;
            altSpan.style.cssText = 'color: #999; font-size: 12px; white-space: nowrap;';

            row.appendChild(cb);
            row.appendChild(nameSpan);
            row.appendChild(altSpan);
            listDiv.appendChild(row);
        });
        dialog.appendChild(listDiv);

        // OK / Cancel
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 8px;';
        btnRow.appendChild(makeButton('OK', '#1976d2', () => {
            const selected = [];
            checkboxes.forEach((cb, i) => { if (cb.checked) selected.push(previewInfos[i].trackIndex); });
            cleanup(overlay);
            resolve(selected);
        }));
        btnRow.appendChild(makeButton('Cancel', '#757575', () => {
            cleanup(overlay);
            resolve(null);
        }));
        dialog.appendChild(btnRow);

        document.body.appendChild(overlay);
    });
}


// ─── Filter Panel ────────────────────────────────────────────────────────────

// Shows the filter UI. Returns Promise<boolean[]|null> (pass/fail per track, or null for cancel).
// onPreview: optional callback(boolean[]) called when Preview is on and filters change.
// onPreviewRestore: optional callback() called to restore original state on cancel/preview-off.
export function showFilterPanel(previewInfos, hasFrustum, cameraPosition, onPreview, onPreviewRestore) {
    const isModeless = !!onPreview; // modeless when used from Contents menu (post-load)
    return new Promise(resolve => {
        const {overlay, dialog, titleBar} = makeOverlayAndDialog({modeless: isModeless});

        const title = document.createElement('h3');
        title.textContent = 'Filter Tracks';
        title.style.cssText = TITLE_STYLE;
        if (titleBar) {
            // Put title inside the draggable title bar
            title.style.margin = '0';
            titleBar.appendChild(title);
        } else {
            dialog.appendChild(title);
        }

        // Compute global altitude range across all tracks for defaults
        let globalMinFt = Infinity, globalMaxFt = -Infinity;
        for (const info of previewInfos) {
            if (info.altMinFt < globalMinFt) globalMinFt = info.altMinFt;
            if (info.altMaxFt > globalMaxFt) globalMaxFt = info.altMaxFt;
        }
        if (globalMinFt === Infinity) globalMinFt = 0;
        if (globalMaxFt === -Infinity) globalMaxFt = 50000;

        const fieldStyle = `margin-bottom: 12px;`;
        const inputStyle = `background: #1a1a1a; border: 1px solid #555; border-radius: 3px; color: #eee; padding: 4px 8px; width: 80px; font-size: 13px;`;
        const disabledColor = '#666';

        // Get camera object for frustum filter
        let camera = null;
        if (hasFrustum && NodeMan.exists("lookCamera")) {
            camera = NodeMan.get("lookCamera").camera;
        }

        // Helper: build current filter options from UI state
        function getFilterOptions() {
            return {
                altitudeEnabled: altCb.checked,
                altLowFt: parseFloat(altLow.value),
                altHighFt: parseFloat(altHigh.value),
                frustumEnabled: frustumCb.checked,
                camera: camera,
                towardsEnabled: towardsCb.checked,
                awayEnabled: awayCb.checked,
                cameraPosition: cameraPosition,
            };
        }

        // Helper: run preview if enabled
        function runPreview() {
            if (previewCb && previewCb.checked && onPreview) {
                const results = applyFilters(previewInfos, getFilterOptions());
                onPreview(results);
            }
        }

        // --- Altitude ---
        const altDiv = document.createElement('div');
        altDiv.style.cssText = fieldStyle;
        const altCb = document.createElement('input');
        altCb.type = 'checkbox';
        altCb.id = 'filter-alt-cb';
        altCb.addEventListener('change', runPreview);
        const altLabel = document.createElement('label');
        altLabel.htmlFor = 'filter-alt-cb';
        altLabel.textContent = ' Altitude Range (ft)';
        altLabel.style.cssText = `font-size: 14px; color: #eee; cursor: pointer;`;
        altDiv.appendChild(altCb);
        altDiv.appendChild(altLabel);

        const altInputRow = document.createElement('div');
        altInputRow.style.cssText = 'margin-top: 6px; display: flex; align-items: center; gap: 8px; padding-left: 22px;';
        const altLow = document.createElement('input');
        altLow.type = 'number';
        altLow.value = globalMinFt;
        altLow.style.cssText = inputStyle;
        altLow.addEventListener('input', runPreview);
        const altDash = document.createElement('span');
        altDash.textContent = '–';
        altDash.style.color = '#999';
        const altHigh = document.createElement('input');
        altHigh.type = 'number';
        altHigh.value = globalMaxFt;
        altHigh.style.cssText = inputStyle;
        altHigh.addEventListener('input', runPreview);
        const altUnit = document.createElement('span');
        altUnit.textContent = 'ft';
        altUnit.style.cssText = 'color: #999; font-size: 13px;';
        altInputRow.appendChild(altLow);
        altInputRow.appendChild(altDash);
        altInputRow.appendChild(altHigh);
        altInputRow.appendChild(altUnit);
        altDiv.appendChild(altInputRow);
        dialog.appendChild(altDiv);

        // --- Crosses Frustum ---
        const frustumDiv = document.createElement('div');
        frustumDiv.style.cssText = fieldStyle;
        const frustumCb = document.createElement('input');
        frustumCb.type = 'checkbox';
        frustumCb.id = 'filter-frustum-cb';
        frustumCb.disabled = !hasFrustum;
        frustumCb.addEventListener('change', runPreview);
        const frustumLabel = document.createElement('label');
        frustumLabel.htmlFor = 'filter-frustum-cb';
        frustumLabel.textContent = ' Crosses Frustum';
        frustumLabel.style.cssText = `font-size: 14px; cursor: pointer; color: ${hasFrustum ? '#eee' : disabledColor};`;
        frustumDiv.appendChild(frustumCb);
        frustumDiv.appendChild(frustumLabel);
        dialog.appendChild(frustumDiv);

        // --- Towards Camera ---
        const hasCam = !!cameraPosition;
        const towardsDiv = document.createElement('div');
        towardsDiv.style.cssText = fieldStyle;
        const towardsCb = document.createElement('input');
        towardsCb.type = 'checkbox';
        towardsCb.id = 'filter-towards-cb';
        towardsCb.disabled = !hasCam;
        towardsCb.addEventListener('change', runPreview);
        const towardsLabel = document.createElement('label');
        towardsLabel.htmlFor = 'filter-towards-cb';
        towardsLabel.textContent = ' Towards Camera';
        towardsLabel.style.cssText = `font-size: 14px; cursor: pointer; color: ${hasCam ? '#eee' : disabledColor};`;
        towardsDiv.appendChild(towardsCb);
        towardsDiv.appendChild(towardsLabel);
        dialog.appendChild(towardsDiv);

        // --- Away From Camera ---
        const awayDiv = document.createElement('div');
        awayDiv.style.cssText = fieldStyle;
        const awayCb = document.createElement('input');
        awayCb.type = 'checkbox';
        awayCb.id = 'filter-away-cb';
        awayCb.disabled = !hasCam;
        awayCb.addEventListener('change', runPreview);
        const awayLabel = document.createElement('label');
        awayLabel.htmlFor = 'filter-away-cb';
        awayLabel.textContent = ' Away From Camera';
        awayLabel.style.cssText = `font-size: 14px; cursor: pointer; color: ${hasCam ? '#eee' : disabledColor};`;
        awayDiv.appendChild(awayCb);
        awayDiv.appendChild(awayLabel);
        dialog.appendChild(awayDiv);

        // --- Preview (only when callbacks provided, i.e. post-load mode) ---
        let previewCb = null;
        if (onPreview) {
            const previewDiv = document.createElement('div');
            previewDiv.style.cssText = 'margin-bottom: 12px; border-top: 1px solid #444; padding-top: 10px;';
            previewCb = document.createElement('input');
            previewCb.type = 'checkbox';
            previewCb.checked = true;
            previewCb.id = 'filter-preview-cb';
            previewCb.addEventListener('change', () => {
                if (previewCb.checked) {
                    runPreview();
                } else if (onPreviewRestore) {
                    onPreviewRestore();
                }
            });
            const previewLabel = document.createElement('label');
            previewLabel.htmlFor = 'filter-preview-cb';
            previewLabel.textContent = ' Preview';
            previewLabel.style.cssText = `font-size: 14px; color: #eee; cursor: pointer;`;
            previewDiv.appendChild(previewCb);
            previewDiv.appendChild(previewLabel);
            dialog.appendChild(previewDiv);
        }

        // --- Buttons ---
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display: flex; gap: 8px; margin-top: 10px;';

        btnRow.appendChild(makeButton('Apply Filter', '#1976d2', () => {
            const results = applyFilters(previewInfos, getFilterOptions());
            cleanup(overlay);
            resolve(results);
        }));
        btnRow.appendChild(makeButton('Cancel', '#757575', () => {
            if (onPreviewRestore) onPreviewRestore();
            cleanup(overlay);
            resolve(null);
        }));
        dialog.appendChild(btnRow);

        document.body.appendChild(overlay);
    });
}


// ─── Multi-Track Load Dialog ─────────────────────────────────────────────────

// Main entry point for the multi-track dialog.
// Returns Promise<number[]|null> — selected track indices, all indices, or null (cancel).
export function showMultiTrackLoadDialog(previewInfos, hasFrustum, cameraPosition) {
    // Skip dialog only in automated regression tests
    if (Globals.regression) {
        return Promise.resolve(previewInfos.map(info => info.trackIndex));
    }

    return new Promise((resolve, reject) => {
        const {overlay, dialog} = makeOverlayAndDialog();

        const title = document.createElement('h3');
        title.textContent = 'Multiple Tracks Detected';
        title.style.cssText = TITLE_STYLE;
        dialog.appendChild(title);

        const msg = document.createElement('p');
        msg.textContent = `This file contains ${previewInfos.length} tracks.`;
        msg.style.cssText = MSG_STYLE;
        dialog.appendChild(msg);

        // Load All
        dialog.appendChild(makeButton('Load All', '#1976d2', () => {
            cleanup(overlay);
            resolve(previewInfos.map(info => info.trackIndex));
        }));

        // Select...
        dialog.appendChild(makeButton('Select...', '#388e3c', async () => {
            cleanup(overlay);
            const selected = await showCheckboxList(previewInfos, null);
            resolve(selected);
        }));

        // Filter...
        dialog.appendChild(makeButton('Filter...', '#e65100', async () => {
            cleanup(overlay);
            const filterResults = await showFilterPanel(previewInfos, hasFrustum, cameraPosition);
            if (filterResults === null) {
                // User cancelled filter — resolve null to skip loading
                resolve(null);
                return;
            }
            // Show checkbox list with filter results pre-checked
            const selected = await showCheckboxList(previewInfos, filterResults);
            resolve(selected);
        }));

        // Cancel
        dialog.appendChild(makeButton('Cancel', '#757575', () => {
            cleanup(overlay);
            resolve(null);
        }));

        document.body.appendChild(overlay);
    });
}


// ─── Camera Helpers ──────────────────────────────────────────────────────────

// Get the current camera state for filtering. Returns {hasFrustum, cameraPosition}.
export function getCameraFilterState() {
    let hasFrustum = false;
    let cameraPosition = null;

    if (NodeMan.exists("lookCamera")) {
        const lookCam = NodeMan.get("lookCamera");
        if (lookCam.camera) {
            hasFrustum = true;
        }
    }

    if (NodeMan.exists("mainCamera")) {
        const mainCam = NodeMan.get("mainCamera");
        if (mainCam.camera && mainCam.camera.position) {
            cameraPosition = mainCam.camera.position.clone();
        }
    }

    return {hasFrustum, cameraPosition};
}


// ─── Post-Load Filter (Contents Menu) ────────────────────────────────────────

// Shows the filter dialog for already-loaded tracks. Toggles visibility.
export async function showPostLoadFilterDialog() {
    // Gather all loaded tracks and build preview infos
    const previewInfos = [];
    const trackEntries = []; // parallel array to map back to display nodes

    TrackManager.iterate((id, metaTrack) => {
        const dataNode = metaTrack.trackDataNode;
        if (!dataNode || !dataNode.misb) return;

        const misb = dataNode.misb;
        const shortName = metaTrack.menuText || id;

        // Build preview info from loaded track data
        const sitchEstablished = Globals.sitchEstablished && Sit.startTime !== "2000-01-01T00:00:00Z";
        let windowStartMs, windowEndMs;
        if (sitchEstablished) {
            windowStartMs = new Date(Sit.startTime).getTime();
            windowEndMs = windowStartMs + (Sit.frames / Sit.fps) * 1000;
        } else {
            windowStartMs = -Infinity;
            windowEndMs = Infinity;
        }

        let altMinM = Infinity, altMaxM = -Infinity;
        const ecefSamples = [];
        let sampleCount = 0;
        let firstECEF = null;
        let lastECEF = null;

        for (let i = 0; i < misb.length; i++) {
            const t = misb[i][MISB.UnixTimeStamp];
            if (t !== null && t !== undefined && (t < windowStartMs || t > windowEndMs)) continue;

            const alt = misb[i][MISB.SensorTrueAltitude];
            if (alt !== null && alt !== undefined && isFinite(alt)) {
                if (alt < altMinM) altMinM = alt;
                if (alt > altMaxM) altMaxM = alt;
            }

            const lat = misb[i][MISB.SensorLatitude];
            const lon = misb[i][MISB.SensorLongitude];
            if (lat !== null && lat !== undefined && lon !== null && lon !== undefined && isFinite(lat) && isFinite(lon)) {
                const a = alt ?? 0;
                const ecef = LLAToECEF(lat, lon, a);
                if (!firstECEF) firstECEF = ecef;
                lastECEF = ecef;
                if (sampleCount % 10 === 0) {
                    ecefSamples.push(ecef);
                }
            }
            sampleCount++;
        }
        // Ensure first and last in-window points are included (needed for towards/away filters)
        if (firstECEF && (ecefSamples.length === 0 || ecefSamples[0] !== firstECEF)) {
            ecefSamples.unshift(firstECEF);
        }
        if (lastECEF && lastECEF !== firstECEF && ecefSamples[ecefSamples.length - 1] !== lastECEF) {
            ecefSamples.push(lastECEF);
        }

        if (altMinM === Infinity) altMinM = 0;
        if (altMaxM === -Infinity) altMaxM = 0;

        const info = {
            trackIndex: 0, // not meaningful for post-load, but keeps shape consistent
            shortName,
            altMinFt: Math.round(m2f(altMinM)),
            altMaxFt: Math.round(m2f(altMaxM)),
            ecefSamples,
            misbData: misb,
            windowStartMs,
            windowEndMs,
        };

        previewInfos.push(info);
        trackEntries.push({id, metaTrack});
    });

    if (previewInfos.length === 0) return;

    // Save original visibility so we can restore on cancel
    const originalVisibility = [];
    for (const {id} of trackEntries) {
        let vis = true;
        NodeMan.iterate((nodeId, node) => {
            if (node instanceof CNodeDisplayTrack && node.in.track && node.in.track.id === id) {
                vis = node.visible;
            }
        });
        originalVisibility.push(vis);
    }

    // Apply a boolean[] to track visibility
    function applyVisibility(results) {
        for (let i = 0; i < trackEntries.length; i++) {
            const {id} = trackEntries[i];
            const visible = results[i];
            NodeMan.iterate((nodeId, node) => {
                if (node instanceof CNodeDisplayTrack && node.in.track && node.in.track.id === id) {
                    node.visible = visible;
                    node.show(visible);
                    if (node.in.dataTrackDisplay !== undefined) {
                        node.in.dataTrackDisplay.visible = visible;
                        node.in.dataTrackDisplay.show(visible);
                    }
                    if (node.metaTrack !== undefined) {
                        node.metaTrack.show(visible);
                    }
                }
            });
        }
        setRenderOne(true);
    }

    const {hasFrustum, cameraPosition} = getCameraFilterState();
    const filterResults = await showFilterPanel(
        previewInfos, hasFrustum, cameraPosition,
        (results) => applyVisibility(results),               // onPreview
        () => applyVisibility(originalVisibility),            // onPreviewRestore
    );

    if (filterResults === null) return; // cancelled (visibility already restored)

    applyVisibility(filterResults);
}
