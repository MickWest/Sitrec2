// Frame-rate-mismatch dialog — fires once per session when a loaded
// TS / video file has a labeled frame rate (from PES PTS spacing or
// container metadata) that disagrees with the real-time frame rate
// (derived from KLV UnixTimeStamp span). Lets the user pick which
// fps Sitrec should use, with a recommended default plus rationale.
//
// Why this exists: tactical / live-feed encoders sometimes write PES
// PTS values at a different cadence than the camera's actual capture
// rate (e.g. ffmpeg `-r N` without an `fps=N` filter). The result is
// three different "frame rate" values in a single file:
//   1. TS metadata header fps (often a default like 12)
//   2. PES-PTS-derived fps (the encoder's *configured* output rate)
//   3. KLV-UTS-derived fps (the *actual* real-world capture rate)
// Sitrec uses Sit.fps to convert frame indices to real-time, so the
// right value to pick is #3 — frames per real second of wall-clock —
// because that's the rate the video actually plays at and the rate
// MISB tracks are sampled at. Picking #2 makes the platform marker
// stop partway through the video; picking #1 makes it stop at
// ~40 % (the symptom that prompted this dialog).
//
// The dialog is the same visual pattern as showImageChoiceDialog in
// DragDropHandler.js — buttons stacked vertically, dark theme, modal
// overlay — so users see a consistent style.

import { EventManager } from "./CEventManager";
import { Sit, NodeMan } from "./Globals";
import { updateSitFrames } from "./UpdateSitFrames";

let _videoReady = false;
let _videoData = null;
let _shownForCurrentFile = false;

// Reset when a new file is dropped so the dialog can fire on the
// next mismatched file in the same session.
function resetState() {
    _videoReady = false;
    _videoData = null;
    _shownForCurrentFile = false;
}

// The "fileDropped" event fires from the drag-drop handler on each
// new drop. Use it as the per-file reset point.
EventManager.addEventListener("fileDropped", resetState);

// Video load completes asynchronously; keep the videoData reference
// so we can read frame count and existing Sit.fps when KLV finishes.
EventManager.addEventListener("videoLoaded", (data) => {
    _videoReady = true;
    _videoData = data && data.videoData;
    tryShow();
});

// Either MISB-track or video-data may finish first. After every
// "filesParsed" we re-attempt; tryShow is idempotent.
EventManager.addEventListener("filesParsed", () => {
    tryShow();
});

// Find any node that quacks like a CNodeMISBDataTrack. We can't
// import the class without risking a circular dependency, so duck-
// type on hasRecordPTS + a misb array.
function findMISBNode() {
    let found = null;
    if (!NodeMan || typeof NodeMan.iterate !== "function") return null;
    NodeMan.iterate((id, node) => {
        if (found) return;
        if (typeof node.hasRecordPTS === "function" && Array.isArray(node.misb) && node.misb.length > 0) {
            found = node;
        }
    });
    return found;
}

// Walk the misb array and compute the UnixTimeStamp span. Skip
// records with null timestamps; if fewer than 2 valid records exist,
// return null (insufficient data for a real-time anchor).
function computeKlvUtsSpanSeconds(misb) {
    let firstT = null;
    let lastT = null;
    for (let i = 0; i < misb.length; i++) {
        const row = misb[i];
        if (!row) continue;
        const t = row[2]; // MISB.UnixTimeStamp = 2 (microseconds since Unix epoch)
        if (t == null) continue;
        if (firstT === null) firstT = t;
        lastT = t;
    }
    if (firstT === null || lastT === null || lastT <= firstT) return null;
    return (lastT - firstT) / 1e6;
}

function tryShow() {
    if (_shownForCurrentFile) return;
    if (!_videoReady || !_videoData) return;

    const frames = _videoData.frames || _videoData.videoFrames;
    if (!frames || frames < 2) return;

    const misbNode = findMISBNode();
    if (!misbNode) return; // KLV not parsed yet, retry on next event

    const klvUtsSpan = computeKlvUtsSpanSeconds(misbNode.misb);
    if (klvUtsSpan == null) return;

    const realFps = frames / klvUtsSpan;
    const labeledFps = Sit.fps;

    // Three fps candidates:
    //   real    — frames / klvUtsSpan          (recommended, real-time)
    //   labeled — current Sit.fps              (whatever the video class auto-set)
    //   pcr     — frames / videoSpanS_seconds  (PES-PTS-derived, if available)
    let pcrFps = null;
    if (_videoData.framePTSus && _videoData.framePTSus.length >= 2) {
        const ptsArr = _videoData.framePTSus;
        const span = (ptsArr[ptsArr.length - 1] - ptsArr[0]) / 1e6;
        if (span > 0) pcrFps = ptsArr.length / span;
    }

    // No-op if all three agree within 1 %; nothing to ask the user.
    const gap = Math.abs(realFps - labeledFps) / Math.max(realFps, 1e-6);
    if (gap < 0.01) return;

    _shownForCurrentFile = true;
    showFpsChoiceDialog({ frames, klvUtsSpan, realFps, labeledFps, pcrFps })
        .then((chosen) => {
            if (chosen != null && chosen > 0 && chosen !== Sit.fps) {
                console.log(`[FpsMismatchDialog] User chose Sit.fps = ${chosen} (was ${Sit.fps})`);
                Sit.fps = chosen;
                updateSitFrames();
            }
        })
        .catch(() => { /* dialog dismissed without a choice */ });
}

// Round to a "clean" fps value if very close to an integer / NTSC
// rate. 29.96 → 30, 27.003 → 27, 23.97 → 23.976. Avoids the
// recommendation buttons reading "29.9603 fps" when the user
// actually wants "30."
function snapFps(fps) {
    const candidates = [12, 15, 23.976, 24, 25, 29.97, 30, 50, 59.94, 60];
    for (const c of candidates) {
        if (Math.abs(fps - c) / c < 0.01) return c;
    }
    // Fall back to integer when within 0.5 %; otherwise keep the
    // computed value but trim to 3 decimals.
    const rounded = Math.round(fps);
    if (Math.abs(fps - rounded) / rounded < 0.005) return rounded;
    return Math.round(fps * 1000) / 1000;
}

function showFpsChoiceDialog({ frames, klvUtsSpan, realFps, labeledFps, pcrFps }) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.style.cssText = `
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0, 0, 0, 0.5); z-index: 10000;
            display: flex; align-items: center; justify-content: center;
        `;

        const modal = document.createElement("div");
        modal.style.cssText = `
            background: #2a2a2a; border-radius: 8px; padding: 20px;
            min-width: 480px; max-width: 640px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
            font-family: Arial, sans-serif; color: white;
        `;

        const title = document.createElement("h3");
        title.textContent = "Frame Rate Mismatch Detected";
        title.style.cssText = "margin: 0 0 10px 0; font-size: 18px; color: #fff;";

        const recReal = snapFps(realFps);
        const recLabeled = snapFps(labeledFps);
        const recPcr = pcrFps ? snapFps(pcrFps) : null;

        const explanation = document.createElement("div");
        explanation.style.cssText = "margin: 0 0 16px 0; font-size: 13px; color: #ccc; line-height: 1.5;";
        explanation.innerHTML = `
            This file's video and KLV metadata report different frame rates:
            <ul style="margin: 8px 0; padding-left: 20px;">
                <li><b>${recReal}</b> fps from KLV UnixTimeStamp (real-time wall-clock anchor)</li>
                ${recPcr && Math.abs(recPcr - recReal) / recReal > 0.01
                    ? `<li><b>${recPcr}</b> fps from PES PTS spacing (encoder's labeled output rate)</li>` : ""}
                <li><b>${recLabeled}</b> fps current Sit.fps (auto-detected from container/decoder)</li>
            </ul>
            Encoder PTS-cadence misconfigurations (e.g. <code>ffmpeg -r N</code> without
            <code>fps=N</code>) write timestamps at one rate while the camera captures at another.
            The <b>${recReal} fps</b> value derived from KLV UTS is the real-time rate the source
            actually captured at — that's what aligns the platform track to the full video timeline.
            <br><br>
            You can change this later in the <b>Time / FPS</b> menu.
        `;

        const buttonStyle = `
            padding: 10px 16px; border: none; border-radius: 4px; cursor: pointer;
            font-size: 14px; margin: 4px 0; width: 100%; text-align: left;
        `;

        const makeButton = (label, sub, fps, recommended) => {
            const btn = document.createElement("button");
            btn.style.cssText = buttonStyle + (recommended
                ? "background: #1976d2; color: white;"
                : "background: #555; color: white;");
            btn.innerHTML = `<b>${recommended ? "★ " : ""}${label}</b><br><span style="font-size: 12px; opacity: 0.85;">${sub}</span>`;
            btn.onclick = () => {
                document.body.removeChild(overlay);
                resolve(fps);
            };
            return btn;
        };

        modal.appendChild(title);
        modal.appendChild(explanation);

        // Recommended first.
        modal.appendChild(makeButton(
            `Use ${recReal} fps (recommended)`,
            `Real-time fps from KLV UnixTimeStamp — aligns platform track to the full video.`,
            recReal,
            true
        ));

        if (recPcr && Math.abs(recPcr - recReal) / recReal > 0.01) {
            modal.appendChild(makeButton(
                `Use ${recPcr} fps`,
                `PES-PTS-derived fps — what the encoder labeled, not real time.`,
                recPcr,
                false
            ));
        }

        if (Math.abs(recLabeled - recReal) / recReal > 0.01 &&
            (!recPcr || Math.abs(recLabeled - recPcr) / recPcr > 0.01)) {
            modal.appendChild(makeButton(
                `Keep ${recLabeled} fps (current)`,
                `Auto-detected from container or decoder — may be a default.`,
                recLabeled,
                false
            ));
        }

        // Cancel = leave Sit.fps unchanged.
        const cancelButton = document.createElement("button");
        cancelButton.textContent = "Decide later";
        cancelButton.style.cssText = buttonStyle + "background: #757575; color: white; text-align: center;";
        cancelButton.onclick = () => {
            document.body.removeChild(overlay);
            resolve(null);
        };
        modal.appendChild(cancelButton);

        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    });
}
