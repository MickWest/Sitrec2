/**
 * @jest-environment jsdom
 */
// PlotlyLoader.test.js — Plotly loads from a file that a rebuild does not rename.
//
// What prompted this file: Plotly used to be a webpack chunk. Every build renames
// every chunk and deletes the previous files, so a tab that was open during a
// rebuild asked for a chunk that no longer existed, and its Charts button failed
// after a 5,400-file BOTBench run that existed only in that tab's memory.

import fs from "fs";
import path from "path";
import {BASE_CONFIG} from "../src/analysis/charts/RockV3ChartSpecs";

const ROOT = path.resolve(__dirname, "..");
const PLOTLY_MAIN = require.resolve("plotly.js-cartesian-dist-min");
const PLOTLY_VERSION = JSON.parse(
    fs.readFileSync(path.join(path.dirname(PLOTLY_MAIN), "package.json"), "utf8")).version;

// A fresh copy of the module each time, so its download cache starts empty.
function freshLoader() {
    let loader;
    jest.isolateModules(() => { loader = require("../src/analysis/charts/PlotlyLoader"); });
    return loader;
}

describe("the file Plotly is loaded from", () => {
    test("is named by the Plotly version, with nothing from the build in it", () => {
        expect(freshLoader().PLOTLY_SCRIPT).toBe(`./libs/plotly-cartesian-${PLOTLY_VERSION}.min.js`);
    });

    test("is the file the build copies Plotly to", () => {
        let patterns;
        const previous = process.env.IS_SERVERLESS_BUILD;
        jest.isolateModules(() => {
            // The patterns also read this checkout's install configuration and, outside
            // a serverless build, its server files. Neither has anything to do with Plotly.
            jest.doMock("../config/config-install", () => ({dev_path: "/nonexistent"}), {virtual: true});
            process.env.IS_SERVERLESS_BUILD = "true";
            try {
                patterns = require("../webpackCopyPatterns");
            } finally {
                if (previous === undefined) delete process.env.IS_SERVERLESS_BUILD;
                else process.env.IS_SERVERLESS_BUILD = previous;
            }
        });
        const copies = patterns.filter((pattern) => String(pattern.to).includes("plotly"));
        expect(copies).toHaveLength(1);
        expect(copies[0].from).toBe(PLOTLY_MAIN);
        expect(copies[0].to).toBe(freshLoader().PLOTLY_SCRIPT);
        expect(fs.existsSync(copies[0].from)).toBe(true);
    });

    test("is credited in the third-party notices, since webpack no longer sees it", () => {
        const source = fs.readFileSync(path.join(ROOT, "scripts/generateThirdPartyNotices.js"), "utf8");
        const list = source.match(/const COPIED_NOT_IMPORTED = \[([\s\S]*?)\];/);
        expect(list).not.toBeNull();
        expect(list[1]).toContain('"plotly.js-cartesian-dist-min"');
    });
});

describe("loadPlotly", () => {
    beforeEach(() => {
        document.head.innerHTML = "";
        delete window.Plotly;
    });

    test("adds one script tag for any number of callers, and resolves with Plotly", async () => {
        const loader = freshLoader();
        const first = loader.loadPlotly();
        const second = loader.loadPlotly();
        const scripts = document.head.querySelectorAll("script");
        expect(scripts).toHaveLength(1);
        expect(scripts[0].getAttribute("src")).toBe(loader.PLOTLY_SCRIPT);
        window.Plotly = {name: "Plotly"};
        scripts[0].dispatchEvent(new Event("load"));
        await expect(first).resolves.toBe(window.Plotly);
        await expect(second).resolves.toBe(window.Plotly);
        await expect(loader.loadPlotly()).resolves.toBe(window.Plotly);
        expect(document.head.querySelectorAll("script")).toHaveLength(1);
    });

    test("uses a Plotly that is already on the page", async () => {
        window.Plotly = {name: "Plotly"};
        const loader = freshLoader();
        await expect(loader.loadPlotly()).resolves.toBe(window.Plotly);
        expect(document.head.querySelectorAll("script")).toHaveLength(0);
    });

    test("a failed download names the file, and can be retried", async () => {
        const loader = freshLoader();
        const attempt = loader.loadPlotly();
        document.head.querySelector("script").dispatchEvent(new Event("error"));
        await expect(attempt).rejects.toThrow(loader.PLOTLY_SCRIPT);
        expect(document.head.querySelectorAll("script")).toHaveLength(0);
        loader.loadPlotly();
        expect(document.head.querySelectorAll("script")).toHaveLength(1);
    });

    test("a file that loads without defining Plotly is an error, not a hang", async () => {
        const loader = freshLoader();
        const attempt = loader.loadPlotly();
        document.head.querySelector("script").dispatchEvent(new Event("load"));
        await expect(attempt).rejects.toThrow(/did not define Plotly/);
    });
});

describe("chart sharing is disabled", () => {
    const figure = () => ({
        data: [{x: [1, 2], y: [3, 4], type: "scatter"}],
        layout: {width: 600, height: 400},
        config: {
            showSendToCloud: true,
            plotlyServerURL: "/chart-sharing",
            modeBarButtons: [["sendChartToCloud", "zoom2d"], ["toImage"]],
            modeBarButtonsToAdd: [{name: "sendChartToCloud", click: jest.fn()}, "toggleSpikelines"],
            modeBarButtonsToRemove: ["lasso2d"],
        },
    });

    beforeEach(() => {
        window.Plotly = {
            react: jest.fn().mockResolvedValue(undefined),
            newPlot: jest.fn().mockResolvedValue(undefined),
            toImage: jest.fn().mockResolvedValue("data:image/svg+xml,local-chart"),
            purge: jest.fn(),
        };
    });
    afterEach(() => { delete window.Plotly; });

    test("figure specs disable the default cloud button for every renderer", () => {
        expect(BASE_CONFIG.showSendToCloud).toBe(false);
        expect(BASE_CONFIG.plotlyServerURL).toBe("");
        expect(BASE_CONFIG.modeBarButtonsToRemove).toContain("sendChartToCloud");
    });

    test("drawing overrides sharing options and removes custom cloud buttons without changing the figure", async () => {
        const spec = figure();
        const element = document.createElement("div");
        await freshLoader().drawFigure(element, spec);
        const config = window.Plotly.react.mock.calls[0][3];
        expect(config).toMatchObject({
            showSendToCloud: false,
            plotlyServerURL: "",
            modeBarButtons: [["zoom2d"], ["toImage"]],
            modeBarButtonsToAdd: ["toggleSpikelines"],
        });
        expect(config.modeBarButtonsToRemove).toEqual(expect.arrayContaining(["lasso2d", "sendChartToCloud"]));
        expect(spec.config.showSendToCloud).toBe(true);
        expect(spec.config.modeBarButtons[0]).toContain("sendChartToCloud");
    });

    test("a chart without custom controls retains valid Plotly modebar defaults", async () => {
        const spec = figure();
        delete spec.config;
        await freshLoader().drawFigure(document.createElement("div"), spec);
        expect(window.Plotly.react.mock.calls[0][3]).toMatchObject({
            showSendToCloud: false, plotlyServerURL: "", modeBarButtons: false, modeBarButtonsToAdd: [],
        });
    });

    test.each(["svg", "png"])("%s export disables sharing and keeps local image generation", async format => {
        await expect(freshLoader().figureToImage(figure(), {format})).resolves.toBe("data:image/svg+xml,local-chart");
        const [holder, , , config] = window.Plotly.newPlot.mock.calls[0];
        expect(config).toMatchObject({showSendToCloud: false, plotlyServerURL: "", staticPlot: true});
        expect(window.Plotly.toImage).toHaveBeenCalledWith(holder,
            {format, width: 600, height: 400, scale: format === "svg" ? 1 : 3});
        expect(window.Plotly.purge).toHaveBeenCalledWith(holder);
        expect(holder.isConnected).toBe(false);
    });
});
