// PlotlyLoader.js — fetch Plotly only when a chart is actually wanted.
//
// plotly.js-cartesian-dist-min is 1.49 MB, which is far too much to carry in the
// main bundle for a view most sessions never open, so nothing downloads until the
// first call.
//
// WHY A SCRIPT TAG, NOT import(). A dynamic import made webpack emit Plotly as a
// chunk, and every build renames every chunk: the name carries the build's unique
// id, and the build deletes the previous files. A page that was open during a
// rebuild then asked for a chunk that no longer existed, and Charts failed with
// "Loading chunk plotly failed" after a 5,400-file BOTBench run that existed only
// in that tab's memory. So the build copies Plotly to libs/ under a name that
// carries only Plotly's version (webpackCopyPatterns.js), and this loads that file
// the same way OpenCV and jsfeat are loaded. A rebuild keeps the name; only a
// Plotly upgrade changes it.
//
// The cartesian bundle is the right one: it is where the `box` trace lives, and
// box, scatter, scattergl and bar are the only trace types the figures use. The
// full plotly.js-dist-min is over twice the size and adds 3D, maps and finance.

import {buildAssetURL} from "../../release/assetURL";
import plotlyPackage from "plotly.js-cartesian-dist-min/package.json";
import {localPlotlyConfig} from "./PlotlyConfig";

/**
 * Where the build puts Plotly, relative to the app. webpackCopyPatterns.js writes
 * the same name from the same package version, and tests/PlotlyLoader.test.js
 * holds the two together.
 */
export const PLOTLY_SCRIPT = `./libs/plotly-cartesian-${plotlyPackage.version}.min.js`;

let plotlyPromise = null;
let plotly = null;

/**
 * The Plotly namespace, downloading it on first use.
 * Concurrent callers share one download, and a failed download can be retried.
 */
export function loadPlotly() {
    if (plotly) return Promise.resolve(plotly);
    if (!plotlyPromise) {
        plotlyPromise = new Promise((resolve, reject) => {
            if (window.Plotly) {
                resolve(window.Plotly);
                return;
            }
            const script = document.createElement("script");
            script.src = buildAssetURL(PLOTLY_SCRIPT);
            script.async = true;
            script.onload = () => {
                if (window.Plotly) resolve(window.Plotly);
                else reject(new Error(`${PLOTLY_SCRIPT} loaded but did not define Plotly`));
            };
            script.onerror = () => {
                // Removed, so a retry adds a fresh tag instead of waiting on a dead one.
                script.remove();
                reject(new Error(`${PLOTLY_SCRIPT} did not load`));
            };
            document.head.appendChild(script);
        }).then((lib) => {
            plotly = lib;
            return lib;
        }, (error) => {
            plotlyPromise = null;      // let a later attempt retry
            throw error;
        });
    }
    return plotlyPromise;
}

/** True once Plotly is in memory, for a caller that wants to avoid the wait. */
export const plotlyReady = () => plotly !== null;

/**
 * Draw a figure spec into an element. Reuses the existing plot when one is
 * already there, which is much faster than tearing it down and rebuilding.
 */
export async function drawFigure(element, figure) {
    const Plotly = await loadPlotly();
    await Plotly.react(element, figure.data, figure.layout, localPlotlyConfig(figure.config));
    return element;
}

/** Free a plot's WebGL contexts and listeners. A scattergl trace holds both. */
export async function purgeFigure(element) {
    if (!plotly || !element) return;
    plotly.purge(element);
}

/**
 * Render a figure to an image the caller can save.
 *
 * `scale` multiplies the layout's pixel size, so a 1500 px figure at scale 3 is
 * 4500 px, which is past 300 dpi for a full-page journal figure. SVG ignores
 * scale and keeps the text as text, which is what a journal actually wants.
 *
 * @returns {Promise<string>} a data URL
 */
export async function figureToImage(figure, {format = "svg", scale = 3} = {}) {
    const Plotly = await loadPlotly();
    // An off-screen node, because toImage needs a real laid-out plot and we do
    // not want the on-screen one resized underneath the reader.
    const holder = document.createElement("div");
    holder.style.cssText = "position:absolute; left:-10000px; top:0;";
    document.body.appendChild(holder);
    try {
        await Plotly.newPlot(holder, figure.data, figure.layout, localPlotlyConfig({...figure.config, staticPlot: true}));
        return await Plotly.toImage(holder, {
            format,
            width: figure.layout.width ?? 1500,
            height: figure.layout.height ?? 900,
            scale: format === "svg" ? 1 : scale,
        });
    } finally {
        Plotly.purge(holder);
        holder.remove();
    }
}
