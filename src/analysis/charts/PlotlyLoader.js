// PlotlyLoader.js — fetch Plotly only when a chart is actually wanted.
//
// plotly.js-cartesian-dist-min is 1.49 MB, which is far too much to carry in the
// main bundle for a view most sessions never open. The dynamic import below
// makes webpack emit it as its own chunk, named so it is recognisable in a build
// report, and nothing downloads until the first call.
//
// The cartesian bundle is the right one: it is where the `box` trace lives, and
// box, scatter, scattergl and bar are the only trace types the figures use. The
// full plotly.js-dist-min is over twice the size and adds 3D, maps and finance.

let plotlyPromise = null;
let plotly = null;

/**
 * The Plotly namespace, downloading it on first use.
 * Concurrent callers share one download.
 */
export function loadPlotly() {
    if (plotly) return Promise.resolve(plotly);
    if (!plotlyPromise) {
        plotlyPromise = import(/* webpackChunkName: "plotly" */ "plotly.js-cartesian-dist-min")
            .then((module) => {
                // The dist build is UMD, so webpack may hand it back either bare or
                // under `default` depending on how it was consumed.
                plotly = module.default ?? module;
                return plotly;
            })
            .catch((error) => {
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
    await Plotly.react(element, figure.data, figure.layout, figure.config);
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
        await Plotly.newPlot(holder, figure.data, figure.layout, {...figure.config, staticPlot: true});
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
