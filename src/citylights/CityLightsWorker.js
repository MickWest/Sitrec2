import {PMTiles} from "pmtiles";
import {VectorTile} from "@mapbox/vector-tile";
import {PbfReader} from "pbf";
import {buildingStyle, encodeCompact, ROAD_CLASSES, stableHash} from "./CityLightsData";
import {CITY_LIGHTS_RELEASE, cityLightsTiles} from "./CityLightsRegion";
import {rasterCityLights} from "./CityLightsRaster";

const sources = Object.fromEntries(["buildings", "transportation"].map(theme => [theme,
    new PMTiles(`https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${CITY_LIGHTS_RELEASE}/${theme}.pmtiles`),
]));
// Keep stripped geometry only. Full source tiles contain much larger property
// tables. Two regions cover the normal main/look views without an endless cache.
const cache = new Map(), latest = new Map(), queue = new Map();
let running = false;

async function loadRegion(region, cancelled, progress) {
    if (cache.has(region.key)) return cache.get(region.key);
    const started = performance.now(), tasks = cityLightsTiles(region), features = new Array(tasks.length);
    let cursor = 0, completed = 0, bytes = 0;
    async function loadTiles() {
        while (cursor < tasks.length && !cancelled()) {
            const index = cursor++, tile = tasks[index];
            const result = await sources[tile.theme].getZxy(tile.z, tile.x, tile.y);
            if (cancelled()) return;
            const records = []; features[index] = records;
            if (result) {
                bytes += result.data.byteLength;
                const layer = new VectorTile(new PbfReader(new Uint8Array(result.data))).layers[tile.theme === "buildings" ? "building" : "segment"];
                if (layer) for (let i = 0; i < layer.length; i++) {
                    const feature = layer.feature(i), props = feature.properties, kind = tile.theme === "buildings" ? 0 : 1;
                    if ((!kind && props.is_underground) || (kind && (props.subtype !== "road" || !ROAD_CLASSES.includes(props.class)
                        || /is_tunnel|is_indoor|is_under_construction/.test(props.road_flags || "")))) continue;
                    const geometry = feature.loadGeometry();
                    const paths = geometry.map(ring => ring.map(point => [
                        Math.round(Math.max(0, Math.min(1, ((tile.unwrappedX + point.x / feature.extent) * tile.scale - region.x0) / region.across)) * 65535),
                        Math.round(Math.max(0, Math.min(1, ((tile.y + point.y / feature.extent) * tile.scale - region.y0) / region.across)) * 65535),
                    ]));
                    const seed = stableHash(props.id ?? feature.id ?? `${tile.theme}/${tile.z}/${tile.x}/${tile.y}/${i}`);
                    records.push({kind, paths, seed, style: kind ? ROAD_CLASSES.indexOf(props.class) : buildingStyle(geometry, seed, feature.extent)});
                }
            }
            completed++;
            if (completed % 8 === 0 || completed === tasks.length) progress(`Loading roads and buildings: ${completed}/${tasks.length}`);
        }
    }
    // Wait for all requests on error, so retries never exceed this concurrency.
    const results = await Promise.allSettled(Array.from({length: 6}, loadTiles));
    const failure = results.find(result => result.status === "rejected");
    if (failure) throw failure.reason;
    if (cancelled()) return null;
    const data = encodeCompact({...region, release: CITY_LIGHTS_RELEASE}, features.flat());
    const source = {data, bytes, loadMs: performance.now() - started};
    if (cache.size >= 2) cache.delete(cache.keys().next().value);
    cache.set(region.key, source);
    return source;
}

async function processQueue() {
    if (running) return;
    running = true;
    try {
        while (queue.size) {
            const [view, request] = queue.entries().next().value;
            queue.delete(view);
            const {id, region, roadFraction, pathFraction} = request;
            const cancelled = () => latest.get(view) !== id;
            const progress = text => {if (!cancelled()) self.postMessage({view, id, progress: text});};
            try {
                const source = await loadRegion(region, cancelled, progress);
                if (!source || cancelled()) continue;
                progress("Preparing city lights…");
                const result = await rasterCityLights(source, roadFraction, pathFraction, cancelled);
                if (result && !cancelled()) self.postMessage({view, id, ...result}, [result.pixels]);
            } catch (error) {
                if (!cancelled()) self.postMessage({view, id, error: error.message});
            }
        }
    } finally { running = false; }
}

self.onmessage = ({data}) => {
    latest.set(data.view, data.id);
    if (data.cancel) {queue.delete(data.view); return;}
    queue.set(data.view, data);
    processQueue();
};
