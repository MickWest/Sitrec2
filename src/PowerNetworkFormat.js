import {ukSuspensionStyle} from "../tools/vehicles/ukTransmission.js";

// Coordinates in the interchange formats are longitude first. A way vertex is
// often just a bend in the mapped line. Only explicit tower/pole nodes get models.
const many = value => value == null ? [] : Array.isArray(value) ? value : [value];
const supports = {tower: "pylon", pole: "pole"};
const isWay = tag => tag === "line" || tag === "minor_line";

function supportDesign(tags) {
    if (tags["sitrec:design"]) return tags["sitrec:design"];
    if (tags.power !== "tower") return;
    if (!tags.line_attachment || tags.line_attachment === "suspension") {
        const ukStyle = ukSuspensionStyle(tags["design:ref"]);
        if (ukStyle) return ukStyle;
    }
    if (tags.design === "guyed_v-frame") return "guyedV";
    if (tags.design === "delta") return "horizontal";
    if (tags.design === "donau") return "danube";
    if (tags.design === "barrel") return "barrel";
    if (tags.design === "bipole") return "wintrack";
    if (tags.design === "h-frame" && tags.material === "wood") return "woodH";
    if (tags.design === "one-level" && (+tags.circuits === 2 || +tags.cables === 6)) return "flat";
}

function heightMetres(value) {
    const match = /^(\d+(?:\.\d+)?)\s*(m|ft|feet|')?$/i.exec(String(value ?? "").trim());
    if (!match) return undefined;
    const height = Number(match[1]) * (match[2] && match[2].toLowerCase() !== "m" ? .3048 : 1);
    return height > 0 && height <= 1000 ? height : undefined;
}

function readKML(container, add) {
    for (const child of [...many(container.Document), ...many(container.Folder)]) readKML(child, add);
    for (const placemark of many(container.Placemark)) {
        const fields = placemark.ExtendedData;
        const tags = Object.fromEntries([
            ...many(fields?.SchemaData).flatMap(schema => many(schema.SimpleData).map(d => [d.name, d["#text"]?.trim()])),
            ...many(fields?.Data).map(d => [d.name, d.value?.["#text"]?.trim()]),
        ]);
        if (!Object.hasOwn(supports, tags.power) && !isWay(tags.power)) continue;
        function readGeometry(geometry) {
            for (const type of ["Point", "LineString"]) {
                for (const item of many(geometry[type])) {
                    const coordinates = (item.coordinates?.["#text"] ?? "").trim().split(/\s+/).map(c =>
                        c.split(",").map(v => v.trim() ? Number(v) : NaN));
                    add(tags, type, type === "Point" ? coordinates[0] : coordinates);
                }
            }
            for (const child of many(geometry.MultiGeometry)) readGeometry(child);
        }
        readGeometry(placemark);
    }
}

export function parsePowerNetwork(data) {
    const points = [], ways = [], indices = new Map();
    function indexAt(xy) {
        if (!Array.isArray(xy)) return undefined;
        const [lon, lat] = xy;
        if (!Number.isFinite(lon) || Math.abs(lon) > 180 || !Number.isFinite(lat) || Math.abs(lat) > 90) return undefined;
        const key = lon + "," + lat;
        if (!indices.has(key)) {
            indices.set(key, points.length);
            points.push({lon, lat});
        }
        return indices.get(key);
    }
    function add(tags, type, coordinates) {
        if (type === "Point" && Object.hasOwn(supports, tags.power)) {
            const i = indexAt(coordinates);
            if (i !== undefined) {
                Object.assign(points[i], {kind: supports[tags.power], height: heightMetres(tags.height)});
                const design = supportDesign(tags);
                if (design) points[i].design = design;
                if (typeof tags["sitrec:object"] === "string") points[i].objectId = tags["sitrec:object"];
            }
        } else if (type === "LineString" && isWay(tags.power) && Array.isArray(coordinates)) {
            const cables = /^[1-9]\d*$/.test(tags.cables) ? Number(tags.cables) : undefined;
            let path = [];
            const finish = () => {
                if (path.length >= 2) ways.push({path, minor: tags.power === "minor_line", cables,
                    voltage: Number(tags.voltage) || undefined});
                path = [];
            };
            for (const xy of coordinates) {
                const i = indexAt(xy);
                if (i === undefined) finish(); // Never bridge a missing piece of a way.
                else if (i !== path[path.length - 1]) path.push(i);
            }
            finish();
        }
    }
    if (data?.kml) readKML(data.kml, add);
    else if (data?.type === "FeatureCollection" && Array.isArray(data.features)) {
        for (const feature of data.features) {
            const tags = feature?.properties?.tags ?? feature?.properties, g = feature?.geometry;
            if (!tags || !g) continue;
            if (g.type === "MultiLineString") {
                for (const line of g.coordinates ?? []) add(tags, "LineString", line);
            } else add(tags, g.type, g.coordinates);
        }
    } else if (Array.isArray(data?.elements)) {
        // Overpass "out geom" carries coordinates on ways. "out body; >; out skel"
        // instead supplies separate nodes, sometimes repeating the tagged supports.
        const nodes = new Map();
        for (const e of data.elements) {
            if (e?.type !== "node") continue;
            const xy = [e.lon, e.lat];
            nodes.set(e.id, xy);
            if (e.tags) add(e.tags, "Point", xy);
        }
        for (const e of data.elements) {
            if (e?.type === "way" && isWay(e.tags?.power)) {
                const coordinates = e.geometry?.map(p => p && [p.lon, p.lat]) ?? e.nodes?.map(id => nodes.get(id));
                add(e.tags, "LineString", coordinates);
            }
        }
    }
    return ways.length || points.some(p => p.kind) ? {points, ways} : null;
}
