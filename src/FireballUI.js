import {
    FIREBALL_LIMITS,
    GMN_SOURCE,
    parseGMNSummary,
    validateFireball,
    nearbyFireballs,
    fireballPeak,
} from "./FireballData";
import { GlobalDateTimeNode, NodeMan, Sit, setRenderOne } from "./Globals";
import { DragDropHandler } from "./DragDropHandler";
import { par } from "./par";

function jump(time) {
    const start = GlobalDateTimeNode.dateStart.getTime();
    const frame = Math.round(((time - start) * Sit.fps) / (1000 * (Sit.simSpeed || 1)));
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
    folder.add(actions, "begin").name("Jump to observed start");
    const control = folder
        .add(actions, "peak")
        .name(
            peak
                ? peak.label.startsWith("Estimated")
                    ? "Jump to estimated peak"
                    : "Jump to measured peak"
                : "Peak time unavailable",
        );
    if (!peak) control.disable();
    else
        control.tooltip(
            peak.label + ". Outside the timeline this shifts its start; inside it jumps to the nearest frame.",
        );
    folder.add(actions, "provenance").name("Fireball source & limits");
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
    close.textContent = "Close";
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
function link(root, label, url) {
    if (!/^https?:\/\//.test(url)) return;
    const a = document.createElement("a");
    a.textContent = label;
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.style.cssText = "color:#9cf;margin-right:16px";
    root.append(a);
}
export function showFireballDetails(event) {
    const root = modal("Fireball " + event.id);
    describe(root, event);
}
function describe(root, event) {
    paragraph(
        root,
        `${event.source.network} · ${event.source.license}. ${event.pathMethod}. Heights: metres above WGS84 ellipsoid. UTC timestamps render to milliseconds; printed digits do not establish measurement accuracy. No light curve is synthesized. Positions between samples are interpolated; the marker holds the endpoint outside the observed interval and does not represent continued flight.`,
    );
    link(root, "Original source", event.source.url);
    if (event.source.license === "CC BY 4.0") link(root, "CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/");
    if (event.source.network === "Global Meteor Network")
        link(root, "GMN conventions", "https://globalmeteornetwork.org/data/media/GMN_orbit_data_columns.pdf");
    const peak = fireballPeak(event);
    paragraph(
        root,
        peak
            ? `${peak.label}: ${new Date(peak.time).toISOString()}`
            : "No usable peak time or peak height is supplied.",
    );
    paragraph(root, FIREBALL_LIMITS);
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
export function openFireballBrowser() {
    const root = modal("Recorded fireballs");
    let events = [];
    let importGeneration = 0;
    root.addEventListener("close", () => importGeneration++);
    paragraph(
        root,
        "Import a GMN daily/monthly summary (.txt), or a sitrec-fireball-v1 JSON with measured samples. Search covers only this file. Download a modest period; maximum import is 100 MB. GMN archives start in December 2018 and are updated; there is no bundled global archive.",
    );
    link(root, "GMN daily files", GMN_SOURCE + "daily/");
    link(root, "GMN monthly files", GMN_SOURCE + "monthly/");
    link(root, "Source & references", "https://globalmeteornetwork.org/data/");
    paragraph(root, FIREBALL_LIMITS);
    const file = document.createElement("input");
    file.type = "file";
    file.accept = ".txt,.json";
    file.setAttribute("aria-label", "Import fireball records");
    root.append(file);
    const source = document.createElement("input");
    source.type = "url";
    source.placeholder = "Exact original GMN .txt download URL (required for summaries)";
    source.style.width = "95%";
    source.setAttribute("aria-label", "Original summary source URL");
    root.append(source);
    const status = paragraph(
        root,
        "No records imported. Supply the exact original download URL to preserve provenance.",
    );
    const form = document.createElement("div");
    form.style.cssText = "display:flex;flex-wrap:wrap;gap:12px;margin:16px 0";
    root.append(form);
    const fields = {};
    const defaults = {
        UTC: GlobalDateTimeNode?.dateNow?.toISOString() || Sit.startTime,
        Latitude: Sit.lat || 0,
        Longitude: Sit.lon || 0,
        "Time window hours": 24,
        "Radius km": 1000,
        "Faintest absolute magnitude": -3,
    };
    for (const [name, value] of Object.entries(defaults)) {
        const label = document.createElement("label");
        label.textContent = name + " ";
        const input = document.createElement("input");
        input.value = value;
        input.type = name === "UTC" ? "text" : "number";
        input.style.width = name === "UTC" ? "240px" : "90px";
        label.append(input);
        form.append(label);
        fields[name] = input;
    }
    const results = document.createElement("div");
    const search = document.createElement("button");
    search.textContent = "Find nearby records";
    root.append(search, results);
    search.onclick = () => {
        results.replaceChildren();
        const utc = Date.parse(fields.UTC.value),
            lat = +fields.Latitude.value,
            lon = +fields.Longitude.value,
            hours = +fields["Time window hours"].value,
            km = +fields["Radius km"].value,
            faintest = +fields["Faintest absolute magnitude"].value;
        if (
            !/Z$/.test(fields.UTC.value) ||
            !Number.isFinite(utc) ||
            Math.abs(lat) > 90 ||
            Math.abs(lon) > 180 ||
            hours < 0 ||
            km < 0 ||
            ![lat, lon, hours, km, faintest].every(Number.isFinite)
        ) {
            paragraph(results, "Enter valid UTC ending in Z, coordinates and nonnegative windows.");
            return;
        }
        const matches = nearbyFireballs(events, { utc, lat, lon, hours, km, faintest });
        paragraph(
            results,
            `${matches.length} matches. Records with unknown brightness are included. Distance is to the nearest supplied sample, not visibility or distance to every point of the interpolated path. Showing at most 100; narrow filters for more.`,
        );
        for (const { event, distanceKm, deltaHours } of matches.slice(0, 100)) {
            const row = document.createElement("div");
            row.style.cssText = "padding:12px 0;border-top:1px solid #667";
            paragraph(
                row,
                `${event.id} · ${event.samples[0].time} · abs mag ${Number.isFinite(event.peakMagnitude) ? event.peakMagnitude : "unknown"} · ${distanceKm.toFixed(0)} km · Δ ${deltaHours.toFixed(2)} h`,
            );
            const load = document.createElement("button");
            load.textContent = "Load observed path";
            load.onclick = async () => {
                load.disabled = true;
                try {
                    await DragDropHandler.uploadDroppedFile(
                        new File([JSON.stringify(event)], event.id + ".fireball.json", { type: "application/json" }),
                    );
                    paragraph(row, "Import request finished. If accepted, the path appears under Contents → Fireball with start/peak and source controls.");
                } catch (e) {
                    paragraph(row, e.message);
                } finally {
                    load.disabled = false;
                }
            };
            const details = document.createElement("button");
            details.textContent = "Source / peak method";
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
            if (f.size > 100 * 1024 * 1024)
                throw new Error("Import exceeds 100 MB; choose a daily or smaller summary.");
            status.textContent = "Reading records…";
            const text = await f.text();
            if (generation !== importGeneration || !root.isConnected) return;
            let rejected = 0;
            if (f.name.endsWith(".json")) events = [validateFireball(JSON.parse(text))];
            else {
                const url = new URL(sourceURL);
                if (
                    url.protocol !== "https:" ||
                    url.hostname !== "globalmeteornetwork.org" ||
                    !url.pathname.endsWith(".txt")
                )
                    throw new Error("Provide the exact HTTPS GMN .txt download URL, not an archive directory.");
                const parsed = parseGMNSummary(text, sourceURL);
                events = parsed.events;
                rejected = parsed.rejected;
                for (const event of events) event.source.originalFilename = f.name;
            }
            if (!events.length) throw new Error("No usable trajectories in this file.");
            const times = events.map((e) => Date.parse(e.samples[0].time)),
                lats = events.flatMap((e) => e.samples.map((p) => p.lat)),
                lons = events.flatMap((e) => e.samples.map((p) => p.lon));
            const min = (a) => a.reduce((x, y) => Math.min(x, y), Infinity),
                max = (a) => a.reduce((x, y) => Math.max(x, y), -Infinity);
            status.textContent = `${events.length} records; ${rejected} rejected. UTC ${new Date(min(times)).toISOString()} to ${new Date(max(times)).toISOString()}. Sample extent lat ${min(lats).toFixed(2)}…${max(lats).toFixed(2)}, lon ${min(lons).toFixed(2)}…${max(lons).toFixed(2)} (not a surveyed coverage boundary).`;
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
