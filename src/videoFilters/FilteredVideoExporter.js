// Wraps a MediabunnyExporter so that every frame passes through the analog / off-a-screen
// filter on its way to the encoder.
//
// It presents exactly the MediabunnyExporter interface (initialize / addFrame / finalize /
// getFrameCount / dispose), which is why one hook in createVideoExporter reaches every
// export path in the app - viewport, single view, source re-encode, panorama, motion
// analysis, tracking and the benchmark recorder - without any of them knowing it is there.

import {MediabunnyExporter} from "../MediabunnyExporter";
import {AnalogVideoFilter} from "./AnalogVideoFilter";
import {describeVideoFilter, filterOutputSize, isVideoFilterActive} from "./VideoFilterSettings";

export class FilteredVideoExporter {
    constructor(exporterOptions, settings) {
        this.settings = settings;

        // The filter may change the output raster (a 4:3 signal format from a 16:9
        // viewport), so the encoder has to be built at the FILTERED size, not the
        // caller's. Rounded even here because the encoder needs even dimensions and
        // matching them avoids a per-frame canvas copy inside addFrame.
        const requested = filterOutputSize(settings, exporterOptions.width, exporterOptions.height);
        this.width = Math.ceil(requested.width / 2) * 2;
        this.height = Math.ceil(requested.height / 2) * 2;

        this.inner = new MediabunnyExporter({
            ...exporterOptions,
            width: this.width,
            height: this.height,
        });

        this.filter = null;
        this.filterFailed = false;
        this.fallbackCanvas = null;
    }

    // Fit a frame into the encoder's raster when the filter is not there to do it.
    //
    // This matters because the encoder was sized for the FILTERED output, which for a
    // format-native export is smaller than the frames the caller renders. MediabunnyExporter
    // handles a size mismatch by drawing at 0,0 without scaling - right for the odd-to-even
    // rounding it was written for, badly wrong here, where it would silently emit the
    // top-left corner of every frame. Letterboxed to preserve aspect, the same fit the
    // filter's own resample pass applies, so a failed filter yields a genuinely unfiltered
    // version of the same picture rather than a differently broken one.
    fitToEncoder(canvas) {
        if (canvas.width === this.width && canvas.height === this.height) return canvas;

        if (!this.fallbackCanvas) {
            this.fallbackCanvas = document.createElement("canvas");
            this.fallbackCanvas.width = this.width;
            this.fallbackCanvas.height = this.height;
        }
        const ctx = this.fallbackCanvas.getContext("2d");
        ctx.fillStyle = "#000000";
        ctx.fillRect(0, 0, this.width, this.height);

        const scale = Math.min(this.width / canvas.width, this.height / canvas.height);
        const drawWidth = canvas.width * scale;
        const drawHeight = canvas.height * scale;
        ctx.drawImage(canvas, (this.width - drawWidth) / 2, (this.height - drawHeight) / 2,
            drawWidth, drawHeight);
        return this.fallbackCanvas;
    }

    async initialize() {
        try {
            this.filter = new AnalogVideoFilter({
                width: this.width,
                height: this.height,
                settings: this.settings,
                fps: this.inner.fps,
            });
            console.log(`Video export filter: ${describeVideoFilter(this.settings)}, ${this.width}x${this.height}`);
        } catch (e) {
            // A missing WebGL2 context must not cost the user their export; encode the
            // unfiltered frames and say plainly that the filter did not run.
            console.error("Video export filter could not start, exporting unfiltered:", e);
            this.filter = null;
            this.filterFailed = true;
        }
        await this.inner.initialize();
    }

    async addFrame(canvas, frameIndex) {
        if (this.filter) {
            try {
                return this.inner.addFrame(this.filter.filterFrame(canvas), frameIndex);
            } catch (e) {
                // Retire the filter rather than retrying it every frame. A half-filtered
                // file is bad enough; worse is that `filter` is what callers read to ask
                // "was this frame filtered?" - BOTBench maps its ground-truth pixel through
                // the filter's geometry on that basis. Leaving a dead filter in place has
                // it map fallback frames through whatever geometry the last SUCCESSFUL
                // frame left behind, which silently writes wrong coordinates into the
                // dataset. Dropping it here makes the answer honestly "no" from now on.
                console.error(`Video export filter failed at frame ${frameIndex}, ` +
                    "encoding the rest unfiltered:", e);
                this.filterFailed = true;
                this.disposeFilter();
            }
        }
        return this.inner.addFrame(this.fitToEncoder(canvas), frameIndex);
    }

    async finalize(onProgress = null, onStatus = null) {
        const blob = await this.inner.finalize(onProgress, onStatus);
        this.disposeFilter();
        return blob;
    }

    getFrameCount() {
        return this.inner.getFrameCount();
    }

    disposeFilter() {
        if (this.filter) {
            this.filter.dispose();
            this.filter = null;
        }
    }

    async dispose() {
        this.disposeFilter();
        return this.inner.dispose();
    }
}

// Build an exporter for the given options, filtered when the settings ask for it and
// a plain MediabunnyExporter when they do not.
export function createExporterWithFilter(exporterOptions, settings) {
    if (!isVideoFilterActive(settings)) {
        return new MediabunnyExporter(exporterOptions);
    }
    return new FilteredVideoExporter(exporterOptions, settings);
}
