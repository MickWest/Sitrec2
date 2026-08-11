import {blockViewEvents, clampBelowMenuBar, makeDraggable} from "./DragResizeUtils";
import {setRenderOne} from "./Globals";

function getDockContainer() {
    return document.getElementById("Content") ?? document.body;
}

function getInitialPanelLeft(container, panelWidth, margin = 24) {
    const containerWidth = container?.clientWidth ?? window.innerWidth;
    return Math.max(16, containerWidth - panelWidth - margin);
}

function escapeHTML(value) {
    return String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#39;");
}

function formatImportMetadataValue(value, digits = 2) {
    if (value === undefined || value === null || value === "") return "-";
    if (value instanceof Date) return value.toISOString();
    if (typeof value === "number") {
        return Number.isInteger(value) ? `${value}` : value.toFixed(digits);
    }
    return `${value}`;
}

// Bit rates arrive in bits/second, straight from the container, and span three orders of
// magnitude between an audio track and a 4K video track — so pick the unit per value.
function formatBitrate(bitsPerSecond) {
    if (!(bitsPerSecond > 0)) return undefined;
    if (bitsPerSecond >= 1e6) return `${(bitsPerSecond / 1e6).toFixed(2)} Mbps`;
    if (bitsPerSecond >= 1e3) return `${Math.round(bitsPerSecond / 1e3)} kbps`;
    return `${Math.round(bitsPerSecond)} bps`;
}

function formatBytes(bytes) {
    if (!(bytes > 0)) return undefined;
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${bytes} bytes`;
}

function formatDuration(seconds) {
    if (!(seconds > 0)) return undefined;
    if (seconds < 60) return `${seconds.toFixed(2)} s`;
    const minutes = Math.floor(seconds / 60);
    const rest = seconds - minutes * 60;
    return `${minutes}:${rest < 10 ? "0" : ""}${rest.toFixed(2)} (${seconds.toFixed(1)} s)`;
}

function sectionHeaderHTML(title) {
    return `<div style="margin:10px 0 4px; padding-bottom:3px; border-bottom:1px solid rgba(255,255,255,0.14); opacity:0.7; text-transform:uppercase; letter-spacing:0.06em; font-size:10px;">${escapeHTML(title)}</div>`;
}

// The container/stream facts — what the file IS, as opposed to what the camera recorded.
// Available for every video and image; EXIF usually is not.
function buildMediaHTML(media) {
    if (!media) return "";

    const rows = [];
    const pushRow = (label, value) => {
        if (value === undefined || value === null || value === "" || value === "-") return;
        rows.push(`<div><strong>${escapeHTML(label)}:</strong> ${escapeHTML(value)}</div>`);
    };

    if (media.width && media.height) pushRow("Size", `${media.width} x ${media.height}`);
    pushRow("Duration", formatDuration(media.durationSeconds));
    // A still image is one frame with no frame rate — saying "Frames: 1" is just noise.
    if (media.frames > 1) pushRow("Frames", media.frames);
    if (media.fps) pushRow("Frame Rate", `${formatImportMetadataValue(media.fps, 2)} fps`);
    pushRow("Container", media.container);
    pushRow("Video Codec", media.videoCodec);
    pushRow("Video Bitrate", formatBitrate(media.videoBitrate));
    pushRow("Video Track Size", formatBytes(media.videoBytes));
    pushRow("Audio Codec", media.audioCodec);
    pushRow("Audio Bitrate", formatBitrate(media.audioBitrate));
    if (media.audioSampleRate) {
        const channels = media.audioChannels ? `, ${media.audioChannels} ch` : "";
        pushRow("Audio Format", `${media.audioSampleRate} Hz${channels}`);
    }

    if (rows.length === 0) return "";
    return sectionHeaderHTML("Media") + rows.join("");
}

function buildEXIFInspectorHTML(metadata, media) {
    const mediaHTML = buildMediaHTML(media);

    if (!metadata) {
        return mediaHTML || "<div>No metadata available</div>";
    }

    const rows = [];
    const pushRow = (label, value) => {
        if (value === undefined || value === null || value === "" || value === "-") return;
        rows.push(`<div><strong>${escapeHTML(label)}:</strong> ${escapeHTML(value)}</div>`);
    };

    const placement = metadata.placement ?? {};
    const optics = metadata.optics ?? {};
    const camera = metadata.camera ?? {};
    const capture = metadata.capture ?? {};

    pushRow("Camera", [camera.make, camera.model].filter(Boolean).join(" "));
    pushRow("Lens", camera.lensModel);
    pushRow("Captured", formatImportMetadataValue(capture.date));
    if (placement.hasLocation) {
        pushRow(
            "GPS",
            `${formatImportMetadataValue(placement.latitude, 6)}, ${formatImportMetadataValue(placement.longitude, 6)} @ ${formatImportMetadataValue(placement.altitude, 1)} m`
        );
    }
    pushRow("Heading", placement.heading !== undefined ? `${formatImportMetadataValue(placement.heading, 1)} deg` : undefined);
    pushRow("Pitch", placement.pitch !== undefined ? `${formatImportMetadataValue(placement.pitch, 1)} deg` : undefined);
    pushRow("Roll", placement.roll !== undefined ? `${formatImportMetadataValue(placement.roll, 1)} deg` : undefined);
    pushRow("Focal Length", optics.focalLengthMm !== undefined ? `${formatImportMetadataValue(optics.focalLengthMm, 1)} mm` : undefined);
    pushRow("35mm Eq", optics.focalLength35mm !== undefined ? `${formatImportMetadataValue(optics.focalLength35mm, 1)} mm` : undefined);
    pushRow("Digital Zoom", optics.digitalZoomRatio !== undefined ? `${formatImportMetadataValue(optics.digitalZoomRatio, 2)}x` : undefined);
    pushRow("Vertical FOV", optics.verticalFovDeg !== undefined ? `${formatImportMetadataValue(optics.verticalFovDeg, 2)} deg` : undefined);
    pushRow("Aperture", optics.fNumber !== undefined ? `f/${formatImportMetadataValue(optics.fNumber, 1)}` : undefined);
    pushRow("ISO", optics.iso);

    if (rows.length === 0) {
        return mediaHTML || "<div>No usable EXIF metadata</div>";
    }

    return mediaHTML + sectionHeaderHTML("EXIF") + rows.join("");
}

function buildRawEXIFHTML(metadata, media) {
    if (!metadata && !media) {
        return "<div>No metadata available</div>";
    }

    try {
        // Both halves, so "Copy Raw" is still worth having on a video with no EXIF at all.
        const rawSource = {media: media ?? null, exif: metadata?.raw ?? metadata ?? null};
        return `<pre style="margin:0; white-space:pre-wrap; word-break:break-word; user-select:text; -webkit-user-select:text;">${escapeHTML(JSON.stringify(rawSource, null, 2))}</pre>`;
    } catch (error) {
        return `<div>Unable to render raw metadata: ${escapeHTML(error.message)}</div>`;
    }
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        let copied = false;
        try {
            copied = document.execCommand("copy");
        } finally {
            textarea.remove();
        }
        return copied;
    }
}

export class EXIFInfoPanel {
    constructor(options = {}) {
        this.title = options.title ?? "EXIF/Metadata";
        this.onVisibilityChange = options.onVisibilityChange ?? null;
        this.metadata = null;
        this.media = null;
        this.filename = "";
        this.visible = false;
        this.mode = "compact";

        this.createPanel();
    }

    createPanel() {
        const container = getDockContainer();
        const panelWidth = 380;
        const initialLeft = getInitialPanelLeft(container, panelWidth);

        this.panel = document.createElement("div");
        this.panel.style.cssText = `
            position: absolute;
            top: 16px;
            left: ${initialLeft}px;
            width: ${panelWidth}px;
            min-width: 300px;
            min-height: 220px;
            max-height: calc(100% - 32px);
            display: none;
            flex-direction: column;
            background: rgba(20, 24, 29, 0.96);
            color: #eef2f6;
            border: 1px solid rgba(255, 255, 255, 0.12);
            border-radius: 10px;
            box-shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
            overflow: hidden;
            resize: both;
            z-index: 2000;
            backdrop-filter: blur(8px);
        `;

        this.header = document.createElement("div");
        this.header.className = "exif-info-panel-header";
        this.header.style.cssText = `
            display: flex;
            flex-direction: column;
            gap: 8px;
            padding: 10px 12px 8px;
            background: rgba(255, 255, 255, 0.05);
            border-bottom: 1px solid rgba(255, 255, 255, 0.08);
            font-size: 13px;
            font-weight: 600;
        `;

        this.titleRow = document.createElement("div");
        this.titleRow.style.cssText = `
            display: flex;
            align-items: center;
            gap: 12px;
            cursor: move;
            user-select: none;
        `;

        this.titleElement = document.createElement("div");
        this.titleElement.textContent = this.title;
        this.titleElement.style.cssText = `
            flex: 1 1 auto;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
        `;
        this.titleRow.appendChild(this.titleElement);

        this.closeButton = this.createActionButton("Close", () => this.hide());
        this.titleRow.appendChild(this.closeButton);
        this.header.appendChild(this.titleRow);

        this.toolbar = document.createElement("div");
        this.toolbar.style.cssText = `
            display: flex;
            align-items: center;
            gap: 8px;
            flex-wrap: wrap;
        `;

        this.copyGPSButton = this.createActionButton("Copy GPS", () => this.copyGPS());
        this.copyTimeButton = this.createActionButton("Copy Time", () => this.copyCaptureTime());
        this.copyRawButton = this.createActionButton("Copy Raw", () => this.copyRaw());
        this.modeButton = this.createActionButton("Show Raw", () => this.toggleMode());

        this.toolbar.appendChild(this.copyGPSButton);
        this.toolbar.appendChild(this.copyTimeButton);
        this.toolbar.appendChild(this.copyRawButton);
        this.toolbar.appendChild(this.modeButton);
        this.header.appendChild(this.toolbar);

        this.status = document.createElement("div");
        this.status.style.cssText = `
            min-height: 18px;
            padding: 6px 12px 0;
            color: rgba(238, 242, 246, 0.74);
            font-size: 11px;
        `;

        this.content = document.createElement("div");
        this.content.style.cssText = `
            flex: 1 1 auto;
            min-height: 0;
            padding: 12px;
            overflow-x: auto;
            overflow-y: scroll;
            line-height: 1.45;
            font-size: 12px;
            white-space: normal;
            user-select: text;
            -webkit-user-select: text;
        `;

        this.panel.appendChild(this.header);
        this.panel.appendChild(this.status);
        this.panel.appendChild(this.content);
        container.appendChild(this.panel);

        blockViewEvents(this.panel);

        makeDraggable(this.panel, {
            handle: this.titleRow,
            excludeElements: [this.closeButton, this.toolbar],
        });

        // Render up front: the panel can be opened (or restored from a save) before any
        // media has loaded, and would otherwise come up blank instead of "no EXIF".
        this.renderContent();
    }

    createActionButton(label, onClick) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.style.cssText = `
            border: 0;
            border-radius: 6px;
            padding: 4px 8px;
            background: rgba(255, 255, 255, 0.08);
            color: inherit;
            cursor: pointer;
            font: inherit;
        `;
        button.addEventListener("click", async (event) => {
            event.stopPropagation();
            await onClick();
        });
        return button;
    }

    getGPSValue() {
        const placement = this.metadata?.placement;
        if (!placement?.hasLocation) return null;
        return `${formatImportMetadataValue(placement.latitude, 6)}, ${formatImportMetadataValue(placement.longitude, 6)} @ ${formatImportMetadataValue(placement.altitude, 1)} m`;
    }

    getCaptureTimeValue() {
        return this.metadata?.capture?.date ? formatImportMetadataValue(this.metadata.capture.date) : null;
    }

    setStatus(message) {
        this.status.textContent = message ?? "";
    }

    async copyGPS() {
        const value = this.getGPSValue();
        if (!value) {
            this.setStatus("No GPS data to copy");
            return;
        }
        this.setStatus(await copyText(value) ? "GPS copied" : "Unable to copy GPS");
    }

    async copyCaptureTime() {
        const value = this.getCaptureTimeValue();
        if (!value) {
            this.setStatus("No capture time to copy");
            return;
        }
        this.setStatus(await copyText(value) ? "Capture time copied" : "Unable to copy capture time");
    }

    async copyRaw() {
        if (this.mode !== "raw") {
            this.setStatus("Switch to raw view to copy the raw EXIF text");
            return;
        }

        const rawElement = this.content.querySelector("pre");
        const value = rawElement?.textContent ?? "";
        if (!value) {
            this.setStatus("No raw EXIF data to copy");
            return;
        }

        this.setStatus(await copyText(value) ? "Raw EXIF copied" : "Unable to copy raw EXIF");
    }

    toggleMode() {
        this.mode = this.mode === "compact" ? "raw" : "compact";
        this.renderContent();
    }

    renderContent() {
        this.titleElement.textContent = this.filename ? `${this.title}: ${this.filename}` : this.title;
        this.content.innerHTML = this.mode === "raw"
            ? buildRawEXIFHTML(this.metadata, this.media)
            : buildEXIFInspectorHTML(this.metadata, this.media);
        this.modeButton.textContent = this.mode === "raw" ? "Show Compact" : "Show Raw";
        this.copyGPSButton.disabled = !this.getGPSValue();
        this.copyTimeButton.disabled = !this.getCaptureTimeValue();
        this.copyRawButton.disabled = this.mode !== "raw";
        this.copyGPSButton.style.opacity = this.copyGPSButton.disabled ? "0.5" : "1";
        this.copyTimeButton.style.opacity = this.copyTimeButton.disabled ? "0.5" : "1";
        this.copyRawButton.style.opacity = this.copyRawButton.disabled ? "0.5" : "1";
    }

    // Note the panel does NOT close itself when the metadata goes away — it is a
    // persistent window that simply reports what it has, so it can be opened (and
    // restored from a save) before any media has loaded. `media` is the container/stream
    // info from CVideoData.getMediaInfo(); EXIF is often absent but that almost never is.
    setMetadata(metadata, filename = "", media = null) {
        this.metadata = metadata ?? null;
        this.media = media ?? null;
        this.filename = filename ?? "";
        this.setStatus("");
        this.renderContent();
    }

    // Pull the window back inside its container. Geometry restored from a save was measured
    // in whatever window the save was made in, so a sitch saved on a wide screen and opened
    // on a narrow one can place the panel completely outside the viewport — and the title bar
    // is the only drag handle, so an off-screen panel cannot be dragged back. Clamped on every
    // show(), which also covers a window that has since been made smaller.
    clampIntoView(margin = 16) {
        const container = getDockContainer();
        // `||` not `??`: a container that hasn't been laid out yet reports 0, which is not a
        // usable bound — fall back to the window in that case rather than pinning to the corner.
        const containerWidth = container?.clientWidth || window.innerWidth;
        const containerHeight = container?.clientHeight || window.innerHeight;

        const width = this.panel.offsetWidth || parseFloat(this.panel.style.width) || 0;
        const left = parseFloat(this.panel.style.left) || 0;
        const maxLeft = Math.max(margin, containerWidth - width - margin);
        this.panel.style.left = `${Math.min(Math.max(left, margin), maxLeft)}px`;

        // Vertically it is enough that the header stays reachable — that is the drag handle,
        // and it carries Close. clampBelowMenuBar then has the final say on the top edge.
        const headerHeight = this.header.offsetHeight || 60;
        const top = parseFloat(this.panel.style.top) || 0;
        const maxTop = Math.max(0, containerHeight - headerHeight - margin);
        if (top > maxTop) this.panel.style.top = `${maxTop}px`;
        clampBelowMenuBar(this.panel);
    }

    show() {
        this.visible = true;
        this.panel.style.display = "flex";
        this.clampIntoView();   // a restored or stale position must not strand it off-screen
        this.onVisibilityChange?.(true);
        setRenderOne(true);
    }

    hide() {
        this.visible = false;
        this.panel.style.display = "none";
        this.onVisibilityChange?.(false);
        setRenderOne(true);
    }

    toggle() {
        if (this.visible) {
            this.hide();
        } else {
            this.show();
        }
    }

    // Save/restore of the floating window itself. Geometry is read straight back out of
    // the inline styles, which is where createPanel(), makeDraggable() and the CSS
    // `resize: both` handle all write it.
    getState() {
        return {
            visible: this.visible,
            mode: this.mode,
            left: this.panel.style.left,
            top: this.panel.style.top,
            width: this.panel.style.width,
            height: this.panel.style.height,
        };
    }

    setState(state) {
        if (!state) return;
        if (state.left) this.panel.style.left = state.left;
        if (state.top) this.panel.style.top = state.top;
        if (state.width) this.panel.style.width = state.width;
        if (state.height) this.panel.style.height = state.height;
        if (state.mode === "raw" || state.mode === "compact") this.mode = state.mode;
        this.renderContent();
        if (state.visible) this.show(); else this.hide();
    }

    destroy() {
        this.panel.remove();
    }
}
