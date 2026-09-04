// AttributionOverlay.js
// Displays legally required on-screen attribution for active map, elevation,
// and 3D tile data sources.  Renders as a small semi-transparent HTML overlay
// positioned at the bottom-right of the viewport.

import {Globals} from "./Globals";
import {getEnv, getEnvBool} from "./envUtils";
import {getDisplayFilename} from "./FilenameUtils";

let overlayDiv = null;
let filenameDiv = null;
let currentParts = {map: "", elevation: "", water: "", tiles: ""};
let currentFilename = "";

function htmlToText(html) {
    // Convert an HTML snippet to plain text using the DOM, avoiding regex-based stripping
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    return tmp.textContent || "";
}

function getBottomOffsetPx() {
    const bannerActive = getEnvBool("BANNER_ACTIVE", process.env.BANNER_ACTIVE);
    const bannerHeight = bannerActive
        ? (parseInt(getEnv("BANNER_HEIGHT", process.env.BANNER_HEIGHT)) || 20)
        : 0;
    return bannerHeight + 2;
}

function createOverlay() {
    if (overlayDiv) return overlayDiv;

    overlayDiv = document.createElement("div");
    overlayDiv.id = "sitrec-attribution";

    Object.assign(overlayDiv.style, {
        position: "fixed",
        bottom: getBottomOffsetPx() + "px",
        right: "2px",
        maxWidth: "60vw",
        padding: "1px 4px",
        background: "rgba(0,0,0,0.45)",
        color: "rgba(255,255,255,0.8)",
        fontSize: "10px",
        fontFamily: "sans-serif",
        lineHeight: "1.3",
        pointerEvents: "auto",
        zIndex: "10000",
        borderRadius: "2px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
    });
    document.body.appendChild(overlayDiv);
    return overlayDiv;
}

function createFilenameOverlay() {
    if (filenameDiv) return filenameDiv;

    filenameDiv = document.createElement("div");
    filenameDiv.id = "sitrec-filename";
    Object.assign(filenameDiv.style, {
        position: "fixed",
        bottom: getBottomOffsetPx() + "px",
        left: "50%",
        transform: "translateX(-50%)",
        maxWidth: "60vw",
        padding: "1px 4px",
        background: "rgba(0,0,0,0.45)",
        color: "rgba(255,255,255,0.8)",
        fontSize: "10px",
        fontFamily: "sans-serif",
        lineHeight: "1.3",
        pointerEvents: "none",
        zIndex: "10000",
        borderRadius: "2px",
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
    });
    document.body.appendChild(filenameDiv);
    return filenameDiv;
}

function renderFilename() {
    const el = createFilenameOverlay();
    if (!el) return;
    if (!Globals.settings?.showFilename || !currentFilename) {
        el.style.display = "none";
        return;
    }
    el.style.display = "";
    el.textContent = currentFilename;
}

function render() {
    const el = createOverlay();
    if (!el) return;
    const parts = [currentParts.map, currentParts.elevation, currentParts.water, currentParts.tiles]
        .filter(Boolean);
    if (parts.length === 0) {
        el.style.display = "none";
        return;
    }
    el.style.display = "";
    // Join with a separator, using innerHTML so links are clickable
    el.innerHTML = parts.join(" | ");

    // Style all links
    for (const a of el.querySelectorAll("a")) {
        a.style.color = "rgba(255,255,255,0.8)";
        a.style.textDecoration = "none";
        a.target = "_blank";
        a.rel = "noopener noreferrer";
    }
    renderFilename();
}

/**
 * Build an HTML snippet from a source definition's attribution/termsURL fields.
 * Returns "" if there is no attribution text.
 */
function formatAttribution(sourceDef) {
    if (!sourceDef || !sourceDef.attribution) return "";
    const text = sourceDef.attribution;
    const url = sourceDef.termsURL;
    if (url) {
        return `<a href="${url}">${text}</a>`;
    }
    return text;
}

export function setMapAttribution(sourceDef) {
    currentParts.map = formatAttribution(sourceDef);
    render();
}

export function setElevationAttribution(sourceDef) {
    currentParts.elevation = formatAttribution(sourceDef);
    render();
}

/**
 * The vector water source (CNodeWaterReflection / WaterMaskTiles).
 *
 * A slot of its own rather than folding into the map slot, because the water
 * polygons are a SEPARATE source from the imagery and are most needed exactly
 * when there is no map attribution to fold into: Google Photorealistic 3D tiles
 * replace the basemap, setMapAttribution(null) is called, and the ODbL water
 * data becomes the only thing on screen that has to be credited.
 */
export function setWaterAttribution(sourceDef) {
    currentParts.water = formatAttribution(sourceDef);
    render();
}

export function setTilesAttribution(text) {
    currentParts.tiles = text || "";
    render();
}

/**
 * Return the current attribution as plain text (for canvas/video rendering).
 */
export function getAttributionText() {
    const parts = [currentParts.map, currentParts.elevation, currentParts.water, currentParts.tiles]
        .filter(Boolean)
        .map(html => htmlToText(html));
    return parts.join(" | ");
}

export function setFilenameOverlaySource(source) {
    currentFilename = getDisplayFilename(source);
    renderFilename();
}

export function updateFilenameOverlay() {
    renderFilename();
}

/**
 * Draw attribution text onto a 2D canvas context (for video export).
 * Positioned at bottom-right, matching the on-screen overlay style.
 */
export function drawAttributionOnCanvas(ctx, canvasWidth, canvasHeight) {
    const text = getAttributionText();
    ctx.save();
    ctx.font = "10px sans-serif";
    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.textBaseline = "bottom";
    if (Globals.settings?.showFilename && currentFilename) {
        ctx.textAlign = "center";
        ctx.fillText(currentFilename, canvasWidth / 2, canvasHeight - 2);
    }
    if (text) {
        ctx.textAlign = "right";
        ctx.fillText(text, canvasWidth - 4, canvasHeight - 2);
    }
    ctx.restore();
}

export function disposeAttributionOverlay() {
    if (overlayDiv && overlayDiv.parentNode) {
        overlayDiv.parentNode.removeChild(overlayDiv);
    }
    if (filenameDiv && filenameDiv.parentNode) {
        filenameDiv.parentNode.removeChild(filenameDiv);
    }
    overlayDiv = null;
    filenameDiv = null;
    currentParts = {map: "", elevation: "", tiles: ""};
    currentFilename = "";
}
