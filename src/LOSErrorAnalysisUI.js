import {Globals, NodeMan, Sit, TrackManager} from "./Globals";
import {resolveLOSNode, resolveTruthTrack, truthTrackOptions} from "./AnalyzeTraverse";
import {withUnfilteredAnalysisAngles} from "./AnalysisAngleSmoothing";
import {abFrameRange} from "./TraverseAnalysisData";
import {collectLOSErrorSamples, syntheticLOSCSV} from "./LOSErrorData";
import {analyzeErrors, directionWithError, fitErrorModel, fitOperatorErrorModel, generateErrors, serializeErrorModel, validateErrorModel} from "./LOSErrorModel";
import {drawFigure, purgeFigure} from "./analysis/charts/PlotlyLoader";
import {makeDraggable, removeDraggable} from "./DragResizeUtils";
import {saveAs} from "file-saver";
import {t} from "./i18n";

// The open panel's close function, so a second open replaces the first.
let closeOpen = null;
// The Analyze LOS Error button of each Traverse folder, so setup can run again without a duplicate.
const buttons = new WeakMap();

const NOTE_CSS = "font-size:12px;line-height:1.5;color:#b4c4d9;";

function element(tag, text, css = "") {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    node.style.cssText = css;
    return node;
}

function format(value) {
    if (!Number.isFinite(value)) return "—";
    return Math.abs(value) < .001 && value !== 0 ? value.toExponential(2) : value.toFixed(4);
}

const freshSeed = () => String(crypto.getRandomValues(new Uint32Array(1))[0]);

// The label of a sampling rate ("Original", "10 Hz", "1 Hz") from analyzeErrors.
const rateLabel = label => label === "Original" ? t("losErrorAnalysis.originalRate") : label;

export function addLOSErrorButton(folder) {
    const existing = buttons.get(folder);
    if (existing && folder.controllers.includes(existing)) return existing;
    const action = {analyzeLOSError: () => openLOSErrorAnalysis()};
    const controller = folder.add(action, "analyzeLOSError").name(t("losErrorAnalysis.button.label"));
    controller.tooltip?.(t("losErrorAnalysis.button.tooltip"));
    buttons.set(folder, controller);
    return controller;
}

function truthNode(id) {
    let track = null;
    TrackManager?.iterate((key, trackOb) => {
        if (trackOb.trackID === id) track = trackOb.trackNode;
    });
    return track ?? NodeMan.get(id, false);
}

export function openLOSErrorAnalysis() {
    closeOpen?.();
    const panel = element("section", undefined, "position:fixed;z-index:10000;left:3vw;top:35px;width:94vw;max-width:1450px;max-height:calc(100vh - 55px);overflow:auto;background:#18212d;color:#eef3fa;padding:18px;box-sizing:border-box;border:1px solid #536477;border-radius:8px;font:14px Arial,sans-serif;box-shadow:0 5px 28px #0009;");
    panel.id = "los-error-analysis";
    panel.dataset.interactionNative = "true";
    const title = element("div", undefined, "display:flex;align-items:center;gap:12px;cursor:move;position:sticky;top:-18px;background:#18212d;z-index:2;padding:12px 0;");
    title.append(element("strong", t("losErrorAnalysis.title"), "font-size:21px;flex:1;"));
    panel.append(title);
    const button = (parent, label, onClick) => {
        const node = element("button", label, "padding:7px 11px;cursor:pointer;background:#30445d;border:1px solid #687c94;border-radius:4px;color:white;font:inherit;");
        node.type = "button";
        node.onclick = onClick;
        parent.append(node);
        return node;
    };
    const charts = [];
    const close = () => {
        clearInterval(lifecycle);
        charts.forEach(chart => purgeFigure(chart));
        removeDraggable(panel);
        panel.remove();
        if (closeOpen === close) closeOpen = null;
    };
    button(title, t("losErrorAnalysis.close"), close);
    makeDraggable(panel, {handle: title});
    closeOpen = close;
    // A new sitch closes the panel: it shows data of the sitch that it was opened for.
    const generation = Globals.loadGeneration;
    const lifecycle = setInterval(() => {
        if (Globals.loadGeneration !== generation) close();
    }, 500);
    panel.addEventListener("keydown", event => {
        event.stopPropagation();
        if (event.key === "Escape") close();
    });
    panel.addEventListener("keyup", event => event.stopPropagation());
    panel.append(element("p", t("losErrorAnalysis.intro"), "line-height:1.5;margin:6px 0 12px;"));

    const controls = element("div", undefined, "display:flex;align-items:center;flex-wrap:wrap;gap:10px;");
    panel.append(controls);
    controls.append(element("label", t("losErrorAnalysis.truthTrack.label")));
    const truth = element("select", undefined, "max-width:270px;padding:6px;");
    truth.setAttribute("aria-label", t("losErrorAnalysis.truthTrack.ariaLabel"));
    truth.append(element("option", t("losErrorAnalysis.truthTrack.choose")));
    truth.options[0].value = "";
    for (const [label, id] of Object.entries(truthTrackOptions())) {
        const option = element("option", label);
        option.value = id;
        truth.append(option);
    }
    truth.value = resolveTruthTrack()?.trackID ?? "";
    controls.append(truth);

    controls.append(element("label", t("losErrorAnalysis.pointing.label")));
    const pointing = element("select", undefined, "max-width:270px;padding:6px;");
    pointing.setAttribute("aria-label", t("losErrorAnalysis.pointing.ariaLabel"));
    const current = element("option", t("losErrorAnalysis.pointing.current"));
    current.value = "";
    pointing.append(current);
    NodeMan.iterate((id, node) => {
        if (!node.in?.cameraTrack || !node.in?.sensorAz || !node.in?.platformHeading) return;
        const option = element("option", t("losErrorAnalysis.pointing.recorded", {id}));
        option.value = id;
        pointing.append(option);
    });
    controls.append(pointing);

    controls.append(element("label", t("losErrorAnalysis.originalHz.label")));
    const originalHz = element("input", undefined, "width:80px;padding:6px;");
    originalHz.type = "number";
    originalHz.min = "0.01";
    originalHz.step = "any";
    originalHz.placeholder = t("losErrorAnalysis.originalHz.placeholder");
    originalHz.setAttribute("aria-label", t("losErrorAnalysis.originalHz.ariaLabel"));
    originalHz.title = t("losErrorAnalysis.originalHz.tooltip");
    controls.append(originalHz);

    controls.append(element("label", t("losErrorAnalysis.modelFamily.label")));
    const modelChoice = element("select", undefined, "padding:6px;");
    modelChoice.setAttribute("aria-label", t("losErrorAnalysis.modelFamily.ariaLabel"));
    for (const family of ["operator", "ar"]) {
        const option = element("option", t(`losErrorAnalysis.modelFamily.${family}`));
        option.value = family;
        modelChoice.append(option);
    }
    controls.append(modelChoice);

    const message = element("p", t("losErrorAnalysis.start"), "line-height:1.5;color:#cad8eb;");
    panel.append(message);
    const content = element("div");
    panel.append(content);

    // captured: the samples and geometry read from the scene. observed / generated: the analysis
    // of the measured and of the latest synthetic errors. model / modelFit: the current model and
    // the operator fit that made it, if any.
    let captured, observed, generated, generatedSeed, model, modelFit;
    let editor, comparison, ratePicker, scale, includeBias;
    const reportError = error => {
        message.textContent = error.message;
        message.style.color = "#ffb3a7";
    };
    const safe = action => async () => {
        try {
            await action();
        } catch (error) {
            reportError(error);
        }
    };
    const generatePreview = (parameters, seed = freshSeed()) => {
        generated = analyzeErrors(generateErrors(parameters, observed.samples.map(row => row.t), seed, captured.geometry));
        generatedSeed = seed;
    };

    const analyzeButton = button(controls, t("losErrorAnalysis.analyze"), safe(async () => {
        const los = pointing.value ? NodeMan.get(pointing.value, false) : resolveLOSNode();
        const target = truthNode(truth.value);
        if (!los || !truth.value || !target) throw new Error(t("losErrorAnalysis.needInputs"));
        analyzeButton.disabled = true;
        try {
            const range = abFrameRange(Math.min(Sit.frames, los.frames), 2);
            captured = await withUnfilteredAnalysisAngles(los, () => collectLOSErrorSamples({
                losNode: los, truthNode: target, frame0: range.frame0, frame1: range.frame1,
                originalHz: originalHz.value === "" ? null : Number(originalHz.value),
            }));
            if (!panel.isConnected || generation !== Globals.loadGeneration) return;
            observed = analyzeErrors(captured.samples);
            generated = null;
            modelFit = null;
            model = null;
            if (observed.samples.length >= 20 && modelChoice.value === "operator") {
                modelFit = await fitOperatorErrorModel(observed.samples, captured.geometry, {
                    cancelled: () => !panel.isConnected || generation !== Globals.loadGeneration,
                    onProgress: (done, total) => {
                        message.textContent = t("losErrorAnalysis.fitProgress", {done, total});
                    },
                });
                model = modelFit.model;
            } else {
                model = fitErrorModel(observed.samples);
            }
            if (!panel.isConnected || generation !== Globals.loadGeneration) return;
            generatePreview(model);
            render();
            const excluded = Object.values(captured.counts).reduce((sum, count) => sum + count, 0)
                + Object.values(observed.rejected).reduce((sum, count) => sum + count, 0);
            message.style.color = "#cad8eb";
            message.textContent = t("losErrorAnalysis.result", {
                cadenceSource: captured.cadenceSource, hz: format(captured.cadence.hz), valid: observed.samples.length,
                excluded, gaps: captured.cadence.gaps, los: captured.losLabel,
            });
        } finally {
            analyzeButton.disabled = false;
        }
    }));

    function render() {
        charts.splice(0).forEach(chart => purgeFigure(chart));
        content.replaceChildren();
        content.append(element("h3", t("losErrorAnalysis.comparisonHeading")));
        comparison = element("div", undefined, "overflow-x:auto;");
        content.append(comparison);
        renderTable();

        const rateRow = element("div", undefined, "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin:14px 0;");
        content.append(rateRow);
        rateRow.append(element("label", t("losErrorAnalysis.plotRate.label")));
        ratePicker = element("select", undefined, "padding:6px;");
        ratePicker.setAttribute("aria-label", t("losErrorAnalysis.plotRate.ariaLabel"));
        observed.views.forEach((view, index) => {
            const label = rateLabel(view.label);
            const option = element("option", view.summary ? label : t("losErrorAnalysis.plotRate.unavailable", {rate: label}));
            option.value = String(index);
            option.disabled = !view.summary;
            ratePicker.append(option);
        });
        rateRow.append(ratePicker);
        ratePicker.onchange = safe(renderCharts);
        const grid = element("div", undefined, "display:grid;grid-template-columns:repeat(auto-fit,minmax(400px,1fr));gap:10px;");
        content.append(grid);
        for (let index = 0; index < 3; index++) {
            const chart = element("div", undefined, "height:280px;min-width:0;");
            grid.append(chart);
            charts.push(chart);
        }
        content.append(element("p", t("losErrorAnalysis.chartsNote"), NOTE_CSS));
        content.append(element("p", t("losErrorAnalysis.frameNote"), NOTE_CSS));

        content.append(element("h3", t("losErrorAnalysis.modelHeading")));
        content.append(element("p", t(model?.modelType === "operator-feedback"
            ? "losErrorAnalysis.operatorExplanation" : "losErrorAnalysis.arExplanation"), "line-height:1.5;"));
        if (modelFit) {
            content.append(element("p", t("losErrorAnalysis.operatorFit", {
                candidates: modelFit.candidates, delay: format(modelFit.delay.seconds),
                explained: (100 * modelFit.delay.explainedFraction).toFixed(1),
            }), NOTE_CSS));
        }
        if (observed.samples.length < 20) {
            content.append(element("p", t("losErrorAnalysis.shortClip"), "font-size:12px;line-height:1.5;color:#ffc071;"));
        }

        const tools = element("div", undefined, "display:flex;align-items:center;gap:10px;flex-wrap:wrap;");
        content.append(tools);
        tools.append(element("label", t("losErrorAnalysis.amplitude")));
        scale = element("input", undefined, "width:70px;padding:6px;");
        scale.type = "number";
        scale.min = "0";
        scale.max = "100";
        scale.step = "0.1";
        scale.value = "1";
        tools.append(scale);
        const biasLabel = element("label", t("losErrorAnalysis.includeBias") + " ");
        includeBias = element("input");
        includeBias.type = "checkbox";
        includeBias.checked = true;
        biasLabel.append(includeBias);
        tools.append(biasLabel);
        const seed = element("input", undefined, "width:120px;padding:6px;");
        seed.value = generatedSeed;
        seed.setAttribute("aria-label", t("losErrorAnalysis.seed.ariaLabel"));
        tools.append(element("label", t("losErrorAnalysis.seed.label")), seed);

        // The model in the editor, with the amplitude multiplier and the bias choice applied.
        const currentModel = () => {
            const edited = validateErrorModel(JSON.parse(editor.value));
            const amplitude = Number(scale.value);
            if (!Number.isFinite(amplitude) || amplitude < 0 || amplitude > 100) throw new Error(t("losErrorAnalysis.amplitudeRange"));
            if (edited.modelType === "operator-feedback") {
                for (const key of ["amplitude", "driftSpeed", "correctionSpeed"]) edited.operator[key] *= amplitude;
                edited.jitterSigmaDeg = edited.jitterSigmaDeg.map(sigma => sigma * amplitude);
            } else {
                edited.innovationSigmaDeg = edited.innovationSigmaDeg.map(sigma => sigma * amplitude);
            }
            if (!includeBias.checked) edited.meanDeg = [0, 0];
            return validateErrorModel(edited);
        };
        button(tools, t("losErrorAnalysis.generateWithSeed"), safe(async () => {
            generatePreview(currentModel(), seed.value);
            renderTable();
            await renderCharts();
        }));
        button(tools, t("losErrorAnalysis.freshSeed"), safe(async () => {
            seed.value = freshSeed();
            generatePreview(currentModel(), seed.value);
            renderTable();
            await renderCharts();
        }));
        button(tools, t("losErrorAnalysis.exportModel"), safe(() =>
            saveAs(new Blob([serializeErrorModel(currentModel())], {type: "application/json"}), "LOSNoiseModel.json")));
        const fileInput = element("input");
        fileInput.type = "file";
        fileInput.accept = ".json,application/json";
        fileInput.hidden = true;
        tools.append(fileInput);
        button(tools, t("losErrorAnalysis.importModel"), () => fileInput.click());
        fileInput.onchange = safe(async () => {
            if (!fileInput.files[0]) return;
            if (fileInput.files[0].size > 100000) throw new Error(t("losErrorAnalysis.modelTooLarge"));
            model = validateErrorModel(JSON.parse(await fileInput.files[0].text()));
            modelFit = null;
            generatePreview(model);
            // An imported model may use a different family. Rebuild its
            // explanation and tuning controls as well as the JSON editor.
            render();
        });
        button(tools, t("losErrorAnalysis.exportCSV"), safe(() => {
            if (!generated) throw new Error(t("losErrorAnalysis.generateFirst"));
            saveAs(new Blob([syntheticLOSCSV(captured.geometry, generated.samples, directionWithError)], {type: "text/csv"}), "SyntheticLOS.csv");
        }));
        content.append(element("p", t("losErrorAnalysis.exportNote"), NOTE_CSS));

        const details = element("details");
        details.append(element("summary", t("losErrorAnalysis.editParameters")));
        editor = element("textarea", undefined, "width:100%;height:250px;box-sizing:border-box;background:#101824;color:#d9e6f8;font:12px monospace;padding:10px;");
        editor.value = serializeErrorModel(model);
        editor.setAttribute("aria-label", t("losErrorAnalysis.editorAriaLabel"));
        details.append(editor);
        content.append(details);
        if (model?.modelType === "operator-feedback") {
            const tuning = element("div", undefined, "display:flex;gap:12px;flex-wrap:wrap;margin:12px 0;");
            details.before(tuning);
            for (const key of ["amplitude", "driftSpeed", "reactionTime", "correctionSpeed", "accuracy", "trackingDelaySeconds"]) {
                const labelNode = element("label", t(`losErrorAnalysis.tuning.${key}`) + " ");
                const input = element("input", undefined, "width:90px;padding:5px;");
                input.type = "number";
                input.step = "any";
                input.min = "0";
                input.value = String(key === "trackingDelaySeconds" ? model[key] : model.operator[key]);
                input.onchange = safe(() => {
                    const edited = JSON.parse(editor.value);
                    if (key === "trackingDelaySeconds") edited[key] = Number(input.value);
                    else edited.operator[key] = Number(input.value);
                    editor.value = serializeErrorModel(edited);
                });
                labelNode.append(input);
                tuning.append(labelNode);
            }
        }
        const blocks = observed.views[0].summary.blocks;
        content.append(element("p", t("losErrorAnalysis.stationarity", {
            rms: blocks.map(block => format(block.rms) + "°").join(" / "),
            means: blocks.map(block => block.mean.map(format).join(" / ") + "°").join("; "),
        }), NOTE_CSS));
        renderCharts().catch(reportError);
    }

    function renderTable() {
        comparison.replaceChildren();
        const table = element("table", undefined, "width:100%;border-collapse:collapse;text-align:right;font-size:12px;");
        comparison.append(table);
        const head = element("tr");
        for (const column of ["series", "count", "bias", "sigma", "radialRms", "radialTails", "stepRms", "correlation", "kurtosis"]) {
            head.append(element("th", t(`losErrorAnalysis.table.${column}`), "padding:8px;border-bottom:1px solid #75879d;"));
        }
        table.append(head);
        for (const [series, result] of [["measured", observed], ["synthetic", generated]]) {
            if (!result) continue;
            for (const view of result.views) {
                const row = element("tr");
                const summary = view.summary;
                const name = t("losErrorAnalysis.seriesRate", {series: t(`losErrorAnalysis.series.${series}`), rate: rateLabel(view.label)});
                const values = summary ? [
                    name,
                    summary.n,
                    summary.mean.map(format).join(" / "),
                    summary.sigma.map(format).join(" / "),
                    format(summary.radialRms),
                    [summary.radialP95, summary.radialP99].map(format).join(" / "),
                    format(summary.incrementRms),
                    summary.acf.find(entry => Math.abs(entry.seconds - 1) < .001)?.axes.map(format).join(" / ") ?? "—",
                    summary.excessKurtosis.map(format).join(" / "),
                ] : [name, t("losErrorAnalysis.table.unavailable")];
                values.forEach(value => row.append(element("td", String(value), "padding:7px;border-bottom:1px solid #384a60;")));
                table.append(row);
            }
        }
    }

    async function renderCharts() {
        const index = Number(ratePicker.value);
        const view = observed.views[index];
        const generatedView = generated?.views[index];
        if (!view.summary) return;
        const style = {
            paper_bgcolor: "#1e2b3b", plot_bgcolor: "#1e2b3b", font: {color: "#dce7f5", size: 11},
            margin: {t: 38, l: 55, r: 15, b: 80}, height: 280, autosize: true,
            legend: {orientation: "h", y: -.43, font: {size: 10}}, hovermode: "closest",
        };
        // The measured series is solid and opaque; the model's realization is dashed at 50%.
        const series = [
            [t("losErrorAnalysis.series.measured"), view, "solid", 1],
            [t("losErrorAnalysis.series.model"), generatedView, "dash", .5],
        ].filter(([, seriesView]) => seriesView?.summary);
        const axisName = axis => axis ? "V" : "H";
        const axisColor = axis => axis ? "#ffc071" : "#78baff";
        // Plot thinning is display-only; all statistics use all valid samples.
        const thin = rows => rows.filter((row, rowIndex) => rowIndex % Math.max(1, Math.ceil(rows.length / 6000)) === 0);
        const traces = [];
        for (const [name, seriesView, dash, opacity] of series) {
            const rows = thin(seriesView.samples);
            for (let axis = 0; axis < 2; axis++) {
                traces.push({type: "scatter", mode: "lines", name: `${name} ${axisName(axis)}`, opacity,
                    x: rows.map(row => row.t), y: rows.map(row => row.e[axis]), line: {color: axisColor(axis), dash, width: 1}});
            }
        }
        const distributions = [];
        for (const [name, seriesView, dash, opacity] of series) {
            const radial = seriesView.samples.map(row => Math.hypot(...row.e)).sort((a, b) => a - b);
            const stride = Math.max(1, Math.ceil(radial.length / 3000));
            distributions.push({type: "scatter", mode: "lines", name, opacity, line: {color: "#78baff", dash},
                x: radial.filter((_, rowIndex) => rowIndex % stride === 0),
                y: radial.map((_, rowIndex) => (rowIndex + 1) / radial.length).filter((_, rowIndex) => rowIndex % stride === 0)});
        }
        const correlations = [];
        for (const [name, seriesView, dash, opacity] of series) {
            for (let axis = 0; axis < 2; axis++) {
                correlations.push({type: "scatter", mode: "lines+markers", name: `${name} ${axisName(axis)}`, opacity,
                    x: seriesView.summary.acf.map(entry => entry.seconds), y: seriesView.summary.acf.map(entry => entry.axes[axis]),
                    line: {color: axisColor(axis), dash}});
            }
        }
        const config = {responsive: true, displayModeBar: false};
        await Promise.all([
            drawFigure(charts[0], {data: traces, layout: {...style, title: {text: t("losErrorAnalysis.charts.error", {rate: rateLabel(view.label)})},
                xaxis: {title: {text: t("losErrorAnalysis.charts.time")}}, yaxis: {title: {text: t("losErrorAnalysis.charts.degrees")}}}, config}),
            drawFigure(charts[1], {data: distributions, layout: {...style, title: {text: t("losErrorAnalysis.charts.distribution")},
                xaxis: {title: {text: t("losErrorAnalysis.charts.separation")}}, yaxis: {title: {text: t("losErrorAnalysis.charts.cumulative")}, range: [0, 1]}}, config}),
            drawFigure(charts[2], {data: correlations, layout: {...style, title: {text: t("losErrorAnalysis.charts.correlation")},
                xaxis: {title: {text: t("losErrorAnalysis.charts.lag")}, type: "log", tickvals: [.001, .01, .1, 1, 10, 100],
                    ticktext: ["0.001", "0.01", "0.1", "1", "10", "100"]}, yaxis: {range: [-1, 1]}}, config}),
        ]);
    }

    document.body.append(panel);
    truth.focus();
    return panel;
}
