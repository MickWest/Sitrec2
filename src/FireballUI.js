import {
    GMN_SOURCE,
    parseGMNSummary,
    validateFireball,
    nearbyFireballs,
    fireballPeak,
    isFireballLinkURL,
    GMN_HOST,
} from "./FireballData";
import { GlobalDateTimeNode, NodeMan, Sit, setRenderOne } from "./Globals";
import { DragDropHandler } from "./DragDropHandler";
import { ECEFToLLAVD_radii } from "./LLA-ECEF-ENU";
import { par } from "./par";
import { t } from "./i18n";

function jump(time) {
    const frame = Math.round(GlobalDateTimeNode.msToFrame(time));
    par.paused = true;
    if (frame >= 0 && frame < Sit.frames) par.frame = frame;
    else {
        par.frame = 0;
        GlobalDateTimeNode.setStartDateTime(new Date(time));
        NodeMan.recalculateAllRootFirst();
    }
    GlobalDateTimeNode.liveMode = false;
    GlobalDateTimeNode.update(par.frame);
    setRenderOne(true);
}
export function addFireballTrackControls(folder, event) {
    const peak = fireballPeak(event);
    const actions = {
        begin: () => jump(Date.parse(event.samples[0].time)),
        peak: () => jump(peak.time),
        provenance: () => showFireballDetails(event),
    };
    folder.add(actions, "begin").name(t("fireballs.track.jumpToStart"));
    const control = folder
        .add(actions, "peak")
        .name(
            peak
                ? peak.kind === "estimated"
                    ? t("fireballs.track.jumpToEstimatedPeak")
                    : t("fireballs.track.jumpToMeasuredPeak")
                : t("fireballs.track.peakUnavailable"),
        );
    if (!peak) control.disable();
    else control.tooltip(t("fireballs.track.peakTooltip", { label: peak.label }));
    folder.add(actions, "provenance").name(t("fireballs.track.sourceAndLimits"));
}
function modal(title) {
    document.getElementById("fireball-dialog")?.remove();
    const root = document.createElement("dialog");
    root.id = "fireball-dialog";
    root.style.cssText =
        "color:#eee;background:#20252c;border:1px solid #778;border-radius:8px;width:min(760px,90vw);max-height:85vh;overflow:auto;padding:20px;font:14px sans-serif";
    const heading = document.createElement("h2");
    heading.textContent = title;
    root.append(heading);
    const close = document.createElement("button");
    close.textContent = t("fireballs.close");
    close.onclick = () => root.close();
    root.append(close);
    root.addEventListener("close", () => root.remove());
    document.body.append(root);
    root.showModal();
    return root;
}
function paragraph(root, text) {
    const p = document.createElement("p");
    p.textContent = text;
    root.append(p);
    return p;
}
function link(root, label, url, hosts) {
    if (!isFireballLinkURL(url, hosts)) {
        if (typeof url === "string" && url) paragraph(root, `${label}: ${url}`);
        return;
    }
    const a = document.createElement("a");
    a.textContent = label;
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.style.cssText = "color:#9cf;margin-right:16px";
    root.append(a);
}
export function showFireballDetails(event) {
    const root = modal(t("fireballs.details.title", { id: event.id }));
    describe(root, event);
}
function describe(root, event) {
    paragraph(
        root,
        t("fireballs.details.conventions", {
            network: event.source.network,
            license: event.source.license,
            pathMethod: event.pathMethod,
        }),
    );
    link(root, t("fireballs.details.originalSource"), event.source.url, [GMN_HOST]);
    if (event.source.license === "CC BY 4.0") link(root, "CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/");
    if (event.source.network === "Global Meteor Network")
        link(root, t("fireballs.details.gmnConventions"), "https://globalmeteornetwork.org/data/media/GMN_orbit_data_columns.pdf");
    const peak = fireballPeak(event);
    paragraph(
        root,
        peak
            ? t("fireballs.details.peak", { label: peak.label, time: new Date(peak.time).toISOString() })
            : t("fireballs.details.noPeak"),
    );
    paragraph(root, t("fireballs.limits"));
    const pre = document.createElement("pre");
    pre.style.cssText = "white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px";
    pre.textContent = JSON.stringify(
        {
            source: event.source,
            peakMagnitude: event.peakMagnitude,
            peakHeightM: event.peakHeightM,
            quality: event.quality,
            samples: event.samples,
        },
        null,
        2,
    );
    root.append(pre);
}
// The default search center: the look camera's position, so the search follows the scene
// rather than the sitch's start-up origin (Sit.lat/lon), which can be far from it.
function sceneLatLon() {
    const camera = NodeMan.get("lookCamera", false)?.camera;
    if (!camera) return { lat: Sit.lat || 0, lon: Sit.lon || 0 };
    const lla = ECEFToLLAVD_radii(camera.position);
    return { lat: Number(lla.x.toFixed(4)), lon: Number(lla.y.toFixed(4)) };
}
export function openFireballBrowser() {
    const root = modal(t("fireballs.browser.title"));
    let events = [];
    let importGeneration = 0;
    root.addEventListener("close", () => importGeneration++);
    paragraph(root, t("fireballs.browser.intro"));
    link(root, t("fireballs.browser.dailyFiles"), GMN_SOURCE + "daily/");
    link(root, t("fireballs.browser.monthlyFiles"), GMN_SOURCE + "monthly/");
    link(root, t("fireballs.browser.references"), "https://globalmeteornetwork.org/data/");
    paragraph(root, t("fireballs.limits"));
    const file = document.createElement("input");
    file.type = "file";
    file.accept = ".txt,.json";
    file.setAttribute("aria-label", t("fireballs.browser.importLabel"));
    root.append(file);
    const source = document.createElement("input");
    source.type = "url";
    source.placeholder = t("fireballs.browser.sourcePlaceholder");
    source.style.width = "95%";
    source.setAttribute("aria-label", t("fireballs.browser.sourceLabel"));
    root.append(source);
    const status = paragraph(root, t("fireballs.browser.noRecords"));
    const form = document.createElement("div");
    form.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;margin:16px 0";
    root.append(form);
    const fields = {};
    const center = sceneLatLon();
    const defaults = {
        utc: GlobalDateTimeNode?.dateNow?.toISOString() || Sit.startTime,
        latitude: center.lat,
        longitude: center.lon,
        hours: 24,
        radius: 1000,
        faintest: -3,
    };
    for (const [name, value] of Object.entries(defaults)) {
        const label = document.createElement("label");
        label.textContent = t(`fireballs.browser.fields.${name}`) + " ";
        const input = document.createElement("input");
        input.value = value;
        input.type = name === "utc" ? "text" : "number";
        input.style.width = name === "utc" ? "240px" : "90px";
        label.append(input);
        form.append(label);
        fields[name] = input;
    }
    const results = document.createElement("div");
    const search = document.createElement("button");
    search.textContent = t("fireballs.browser.find");
    root.append(search, results);
    search.onclick = () => {
        results.replaceChildren();
        const utc = Date.parse(fields.utc.value),
            lat = +fields.latitude.value,
            lon = +fields.longitude.value,
            hours = +fields.hours.value,
            km = +fields.radius.value,
            faintest = +fields.faintest.value;
        if (
            !/Z$/.test(fields.utc.value) ||
            !Number.isFinite(utc) ||
            Math.abs(lat) > 90 ||
            Math.abs(lon) > 180 ||
            hours < 0 ||
            km < 0 ||
            ![lat, lon, hours, km, faintest].every(Number.isFinite)
        ) {
            paragraph(results, t("fireballs.browser.invalidSearch"));
            return;
        }
        const matches = nearbyFireballs(events, { utc, lat, lon, hours, km, faintest });
        paragraph(results, t("fireballs.browser.matches", { count: matches.length }));
        for (const { event, distanceKm, deltaHours } of matches.slice(0, 100)) {
            const row = document.createElement("div");
            row.style.cssText = "padding:12px 0;border-top:1px solid #667";
            paragraph(
                row,
                t("fireballs.browser.match", {
                    id: event.id,
                    time: event.samples[0].time,
                    magnitude: Number.isFinite(event.peakMagnitude)
                        ? event.peakMagnitude
                        : t("fireballs.browser.unknownMagnitude"),
                    distance: distanceKm.toFixed(0),
                    hours: deltaHours.toFixed(2),
                }),
            );
            const load = document.createElement("button");
            load.textContent = t("fireballs.browser.loadPath");
            load.onclick = async () => {
                load.disabled = true;
                try {
                    await DragDropHandler.uploadDroppedFile(
                        new File([JSON.stringify(event)], event.id + ".fireball.json", { type: "application/json" }),
                    );
                    paragraph(row, t("fireballs.browser.loadFinished"));
                } catch (e) {
                    paragraph(row, e.message);
                } finally {
                    load.disabled = false;
                }
            };
            const details = document.createElement("button");
            details.textContent = t("fireballs.browser.sourcePeakMethod");
            details.onclick = () => {
                const block = document.createElement("div");
                describe(block, event);
                row.append(block);
                details.disabled = true;
            };
            row.append(load, details);
            results.append(row);
        }
    };
    file.onchange = async () => {
        const generation = ++importGeneration;
        const sourceURL = source.value;
        events = [];
        results.replaceChildren();
        search.disabled = true;
        try {
            const f = file.files[0];
            if (!f) return;
            if (f.size > 100 * 1024 * 1024) throw new Error(t("fireballs.browser.tooLarge"));
            status.textContent = t("fireballs.browser.reading");
            const text = await f.text();
            if (generation !== importGeneration || !root.isConnected) return;
            let rejected = 0;
            if (f.name.endsWith(".json")) events = [validateFireball(JSON.parse(text))];
            else {
                const url = new URL(sourceURL);
                if (url.protocol !== "https:" || url.hostname !== GMN_HOST || !url.pathname.endsWith(".txt"))
                    throw new Error(t("fireballs.browser.needGMNURL"));
                const parsed = parseGMNSummary(text, sourceURL);
                events = parsed.events;
                rejected = parsed.rejected;
                for (const event of events) event.source.originalFilename = f.name;
            }
            if (!events.length) throw new Error(t("fireballs.browser.noTrajectories"));
            const times = events.map((e) => Date.parse(e.samples[0].time)),
                lats = events.flatMap((e) => e.samples.map((p) => p.lat)),
                lons = events.flatMap((e) => e.samples.map((p) => p.lon));
            const min = (a) => a.reduce((x, y) => Math.min(x, y), Infinity),
                max = (a) => a.reduce((x, y) => Math.max(x, y), -Infinity);
            status.textContent = t("fireballs.browser.imported", {
                count: events.length,
                rejected,
                first: new Date(min(times)).toISOString(),
                last: new Date(max(times)).toISOString(),
                latMin: min(lats).toFixed(2),
                latMax: max(lats).toFixed(2),
                lonMin: min(lons).toFixed(2),
                lonMax: max(lons).toFixed(2),
            });
            search.disabled = false;
            search.click();
        } catch (e) {
            if (generation !== importGeneration || !root.isConnected) return;
            events = [];
            results.replaceChildren();
            status.textContent = e.message;
        } finally {
            if (generation === importGeneration && root.isConnected) search.disabled = false;
        }
    };
    source.onchange = () => {
        if (file.files.length) file.onchange();
    };
}
