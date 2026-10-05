// app.js — The page of the XML Wind Profile Analyzer. It loads a file, runs
// analyzeXML() on it, and shows the result. All the detection is in analyze.js;
// this file only reads the file and builds the page.
//
// Text from the file is always placed with textContent, never as HTML.

import {analyzeXML, buildReport, checkSettings, ROLES, settingsText} from "./analyze.js";
import {xmlToObject} from "./xmlObject.js";

const els = Object.fromEntries(["drop", "fileInput", "chooseButton", "sampleButton", "status", "results",
    "fileSummary", "positions", "profile", "settingsBlock", "notes", "settings", "checkButton",
    "copySettingsButton", "check", "othersBlock", "others", "includeValues", "copyReportButton", "report",
].map(id => [id, document.getElementById(id)]));

// The file now shown: {name, text, xml, analysis}
let current = null;

// ─── Small DOM helpers ───────────────────────────────────────────────────

function el(tag, options = {}, ...children) {
    const node = document.createElement(tag);
    if (options.className) node.className = options.className;
    if (options.title) node.title = options.title;
    for (const child of children) {
        if (child === null || child === undefined || child === false) continue;
        node.append(child instanceof Node ? child : String(child));
    }
    return node;
}

const tagName = name => el("span", {className: "tag"}, `<${name}>`);

function table(headings, rows) {
    return el("table", {},
        el("thead", {}, el("tr", {}, ...headings.map(heading => el("th", {}, heading)))),
        el("tbody", {}, ...rows));
}

function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.className = isError ? "error" : "";
}

const round = (number, places = 1) => number === null ? "" : (Math.round(number * 10 ** places) / 10 ** places).toString();

// ─── Loading ─────────────────────────────────────────────────────────────

function loadText(text, name) {
    const document_ = new DOMParser().parseFromString(text, "text/xml");
    const parseError = document_.getElementsByTagName("parsererror")[0];
    if (parseError) {
        els.results.hidden = true;
        setStatus(`${name} is not well-formed XML: ${parseError.textContent.trim().split("\n")[0]}`, true);
        return;
    }
    const xml = xmlToObject(document_);
    const analysis = analyzeXML(xml, text);
    if (!analysis) {
        els.results.hidden = true;
        setStatus(`${name} has no elements.`, true);
        return;
    }
    current = {name, text, xml, analysis};
    setStatus(analysis.profile
        ? `${name}: found a vertical wind profile of ${analysis.profile.records.length} levels.`
        : `${name}: no vertical wind profile found.`, !analysis.profile);
    render();
}

async function loadFile(file) {
    setStatus(`Reading ${file.name}...`);
    loadText(await file.text(), file.name);
}

// ─── Rendering ───────────────────────────────────────────────────────────

function renderFileSummary({analysis, text, name}) {
    const namespaces = analysis.namespaces.length
        ? el("ul", {}, ...analysis.namespaces.map(entry => el("li", {}, el("code", {}, entry.prefix), ": ", el("code", {}, entry.uri))))
        : el("p", {className: "muted"}, "The file declares no namespace.");
    els.fileSummary.replaceChildren(
        el("p", {}, el("strong", {}, name), `, ${text.length.toLocaleString()} characters, ${analysis.elementCount.toLocaleString()} elements. Root element: `,
            tagName(analysis.root.tag), "."),
        el("p", {}, "Namespaces (Sitrec can identify the file by a part of one of these):"),
        namespaces,
        el("p", {}, "Where a field keeps its number: ",
            analysis.valueTag ? el("span", {}, "in a ", tagName(analysis.valueTag.name), " element inside the field.")
                : "in the field element itself."));
}

function renderPositions({analysis}) {
    if (analysis.positions.length === 0) {
        els.positions.replaceChildren(el("p", {}, "No position found: no element has a latitude with a longitude beside it."));
        return;
    }
    const coordinate = part => el("td", {}, tagName(part.node.name), el("br"),
        `${part.text}${part.sense ? ` ${part.sense}` : ""} `, el("span", {className: "muted"}, `= ${round(part.value, 6)}°`));
    const rows = analysis.positions.map(position => el("tr", {className: position === analysis.position ? "used" : ""},
        el("td", {}, el("code", {}, position.path), position.insideLevel ? el("div", {className: "muted"}, "inside a level") : null),
        coordinate(position.lat),
        coordinate(position.lon),
        position.elev
            ? el("td", {}, tagName(position.elev.node.name), el("br"), position.elev.text,
                position.elev.unitHints.length ? ` ${position.elev.unitHints.join(", ")}` : el("span", {className: "guess"}, " (unit not stated)"))
            : el("td", {className: "muted"}, "none"),
        el("td", {}, position === analysis.position ? "Used: nearest to the profile" : "")));
    els.positions.replaceChildren(
        el("p", {}, `${analysis.positions.length} found.`),
        table(["Where", "Latitude", "Longitude", "Elevation", ""], rows));
}

function fieldRows(group) {
    return group.fields.map(field => {
        const role = field.role ? ROLES.find(entry => entry.role === field.role).label : null;
        const isGuess = field.evidence?.startsWith("GUESS");
        const kind = field.numbers.length === 0 ? "text"
            : `${round(field.min, 3)} to ${round(field.max, 3)}${field.trend === "none" ? "" : `, ${field.trend}`}${field.allNumeric ? "" : ", some missing"}`;
        return el("tr", {className: field.role ? "used" : ""},
            el("td", {}, tagName(field.name)),
            el("td", {className: role ? "role" : "muted"}, role ?? "not used"),
            el("td", {className: isGuess ? "guess" : ""}, field.evidence ?? ""),
            el("td", {}, field.unitHints.join(", ")),
            el("td", {}, kind),
            el("td", {}, field.texts.slice(0, 3).map(text => text ?? "-").join(", ")));
    });
}

const FIELD_HEADINGS = ["Tag", "What it is", "Evidence", "Unit in file", "Values", "First values"];

function renderProfile({analysis}) {
    const profile = analysis.profile;
    if (!profile) {
        els.profile.replaceChildren(el("p", {}, "No vertical wind profile found. A profile is an element that repeats, "
            + "with a wind direction, a wind speed, and an altitude or a pressure in it. "
            + "The repeating elements that the file does have are listed below."));
        return;
    }
    els.profile.replaceChildren(
        el("p", {}, tagName(profile.name), ` repeats ${profile.records.length} times in `, el("code", {}, profile.path),
            ". Each one is a level."),
        table(FIELD_HEADINGS, fieldRows(profile)));
}

function renderOthers({analysis}) {
    const others = analysis.groups.filter(group => group !== analysis.profile);
    els.othersBlock.hidden = others.length === 0;
    els.othersBlock.open = !analysis.profile;
    els.others.replaceChildren(...others.flatMap(group => [
        el("p", {}, tagName(group.name), ` repeats ${group.records.length} times in `, el("code", {}, group.path)),
        table(FIELD_HEADINGS, fieldRows(group)),
    ]));
}

function renderNotes({analysis}) {
    els.notes.replaceChildren(...analysis.notes.map(note =>
        el("li", {className: note.startsWith("WARNING") ? "warning" : ""}, note)));
}

function renderCheck(result) {
    const parts = [];
    if (result.messages.length > 0) {
        parts.push(el("ul", {className: "messages"}, ...result.messages.map(message => el("li", {}, message))));
    }
    const sonde = result.sonde;
    if (sonde) {
        parts.push(el("p", {}, result.identified
            ? `Sitrec identifies the file as layout "${result.identified}".`
            : "These settings have nothing that identifies the file (no _XMLNS_CONTAINS or _FILE_CONTAINS), so Sitrec tries the layout on every XML file."));
        parts.push(el("p", {}, `Position: latitude ${round(sonde.station.lat, 6)}°, longitude ${round(sonde.station.lon, 6)}°, `
            + `elevation ${round(sonde.station.elev / 0.3048, 0)} ft (${round(sonde.station.elev, 0)} m).`));
        const number = text => el("td", {className: "number"}, text);
        const rows = sonde.levels.map(level => el("tr", {},
            number(level.height === null ? "" : `${round(level.height / 0.3048, 0)} ft`),
            number(level.height === null ? "from pressure" : `${round(level.height, 0)} m`),
            number(level.windDir === null ? "" : `${round(level.windDir, 0)}°`),
            number(level.windSpeed === null ? "" : `${round(level.windSpeed / 0.514444)} kt`),
            number(level.windSpeed === null ? "" : `${round(level.windSpeed)} m/s`),
            number(level.pressure === null ? "" : `${round(level.pressure)} hPa`),
            number(level.temp === null ? "" : `${round(level.temp)} °C`)));
        parts.push(table(["Altitude", "", "Wind from", "Wind speed", "", "Pressure", "Temperature"], rows));
    }
    els.check.replaceChildren(...parts);
}

function renderReport() {
    els.report.value = buildReport(current.analysis, {includeValues: els.includeValues.checked, fileName: current.name});
}

function render() {
    const {analysis, name} = current;
    els.results.hidden = false;
    renderFileSummary(current);
    renderPositions(current);
    renderProfile(current);
    renderOthers(current);

    els.settingsBlock.hidden = !analysis.settings;
    if (analysis.settings) {
        renderNotes(current);
        els.settings.value = settingsText(analysis.settings, name);
        renderCheck(analysis.check);
    }
    renderReport();
}

// ─── Events ──────────────────────────────────────────────────────────────

els.chooseButton.addEventListener("click", () => els.fileInput.click());
els.fileInput.addEventListener("change", () => {
    if (els.fileInput.files.length > 0) loadFile(els.fileInput.files[0]);
    els.fileInput.value = "";
});

els.sampleButton.addEventListener("click", async () => {
    setStatus("Reading the sample file...");
    try {
        const response = await fetch(new URL("./sample.xml", import.meta.url));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        loadText(await response.text(), "sample.xml");
    } catch (error) {
        setStatus(`The sample file did not load: ${error.message}`, true);
    }
});

// The whole window takes a drop, so a file that misses the box does not make the
// browser navigate to it.
window.addEventListener("dragover", event => {
    event.preventDefault();
    els.drop.classList.add("over");
});
window.addEventListener("dragleave", () => els.drop.classList.remove("over"));
window.addEventListener("drop", event => {
    event.preventDefault();
    els.drop.classList.remove("over");
    const file = event.dataTransfer?.files?.[0];
    if (file) loadFile(file);
});

els.checkButton.addEventListener("click", () => {
    if (current) renderCheck(checkSettings(current.xml, current.text, els.settings.value));
});

els.includeValues.addEventListener("change", () => {
    if (current) renderReport();
});

async function copyFrom(textarea, button) {
    try {
        await navigator.clipboard.writeText(textarea.value);
    } catch (error) {
        // No clipboard permission (or not a secure context): select the text so the
        // user can copy it by hand.
        textarea.focus();
        textarea.select();
        return;
    }
    const label = button.textContent;
    button.textContent = "Copied";
    setTimeout(() => { button.textContent = label; }, 1200);
}
els.copySettingsButton.addEventListener("click", () => copyFrom(els.settings, els.copySettingsButton));
els.copyReportButton.addEventListener("click", () => copyFrom(els.report, els.copyReportButton));

// ─── MCP / debug bridge ──────────────────────────────────────────────────
// Module-private bindings are not on window, so the SitrecBridge sitrec_eval
// cannot reach them. On a local development host only, expose the live state and
// a direct eval inside this module (see tools/shf/app.js for the pattern).
const isLocalHost = /^(local\.metabunk\.org|localhost|127\.0\.0\.1)$/.test(window.location.hostname);
if (isLocalHost) {
    window.xmlWindEval = code => eval(code);
    window.xmlWind = {
        els,
        loadText,
        get current() { return current; },
    };
}
