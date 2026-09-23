import { decodeCompact, ROAD_CLASSES } from "./CityLightsData";
let buildingCache = null;
const yields = [],
    channel = new MessageChannel();
channel.port1.onmessage = () => yields.shift()?.();
function cooperate() {
    return new Promise((resolve) => {
        yields.push(resolve);
        channel.port2.postMessage(0);
    });
}
export function lightRandom(seed, index) {
    let n = (seed ^ Math.imul(index + 1, 0x9e3779b9)) >>> 0;
    n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
    n = Math.imul(n ^ (n >>> 15), 0x735a2d97);
    return ((n ^ (n >>> 15)) >>> 0) / 4294967296;
}
const random = lightRandom;
export async function rasterCityLights(source, roadFraction, pathFraction, cancelled = () => false) {
    const started = performance.now(),
        decoder = decodeCompact(source.data),
        meta = decoder.meta,
        size = meta.size,
        ppm = size / meta.meters;
    const buildings = new OffscreenCanvas(size, size);
    const bc = buildings.getContext("2d", { willReadFrequently: true }),
        roadPixels = new Uint8Array(size * size * 2);
    const stats = {
        buildings: 0,
        roads: 0,
        lamps: 0,
        candidates: 0,
        roadLamps: 0,
        pathLamps: 0,
        bytes: source.bytes,
        decodedBytes: source.data.byteLength,
        loadMs: source.loadMs,
    };
    const cachedBuildings = buildingCache?.key === meta.key ? buildingCache : null;
    const buildingPaths = new Map();
    // Small software stamps avoid thousands of expensive canvas draw calls.
    // Subpixel phases and area sampling preserve energy as lamps become tiny.
    const sprites = new Map();
    function lamp(x, y, major, cool) {
        const ix = Math.floor(x),
            iy = Math.floor(y),
            phases = 8;
        const fx = Math.floor((x - ix) * phases),
            fy = Math.floor((y - iy) * phases),
            key = `${major}/${fx}/${fy}`;
        let sprite = sprites.get(key);
        if (!sprite) {
            const physical = major ? 5 : 3.4,
                radius = Math.max(1.3, physical * ppm),
                edge = Math.ceil(radius) + 1;
            const peak = Math.min(1, ((physical * ppm) / radius) ** 2),
                cx = (fx + 0.5) / phases,
                cy = (fy + 0.5) / phases;
            sprite = [];
            for (let dy = -edge; dy <= edge; dy++)
                for (let dx = -edge; dx <= edge; dx++) {
                    let sum = 0;
                    for (const sy of [0.25, 0.75])
                        for (const sx of [0.25, 0.75]) {
                            const d = Math.hypot(dx + sx - cx, dy + sy - cy) / radius;
                            sum +=
                                d < 0.22
                                    ? 1 - (d / 0.22) * 0.28
                                    : d < 0.6
                                      ? 0.72 - ((d - 0.22) / 0.38) * 0.6
                                      : d < 1
                                        ? (0.12 * (1 - d)) / 0.4
                                        : 0;
                        }
                    const value = Math.round(sum * 0.25 * peak * 255);
                    if (value) sprite.push([dx, dy, value]);
                }
            sprites.set(key, sprite);
        }
        for (const [dx, dy, value] of sprite) {
            const px = ix + dx,
                py = iy + dy;
            if (px < 0 || py < 0 || px >= size || py >= size) continue;
            const at = (py * size + px) * 2 + (cool ? 1 : 0);
            roadPixels[at] = Math.min(255, roadPixels[at] + value);
        }
    }
    let fi = 0;
    for (const f of decoder.features()) {
        if (fi % 2048 === 0) {
            await cooperate();
            if (cancelled()) return null;
        }
        fi++;
        if (f.kind === 0) {
            if (cachedBuildings) {
                stats.buildings++;
                continue;
            }
            let shape = buildingPaths.get(f.style);
            if (!shape) {
                shape = new Path2D();
                buildingPaths.set(f.style, shape);
            }
            for (const path of f.paths) {
                path.forEach((p, i) =>
                    i ? shape.lineTo(p[0] * size, p[1] * size) : shape.moveTo(p[0] * size, p[1] * size),
                );
                shape.closePath();
            }
            stats.buildings++;
            continue;
        }
        const cls = ROAD_CLASSES[f.style],
            major = ["motorway", "trunk", "primary", "secondary"].includes(cls);
        const minor = ["service", "pedestrian", "footway", "cycleway"].includes(cls);
        const fraction = minor ? pathFraction : roadFraction,
            spacing = (major ? 42 : minor ? 48 : 38) * ppm;
        const offset = (major ? 6 : minor ? 1.5 : 3.5) * ppm;
        let index = 0;
        stats.roads++;
        for (const path of f.paths) {
            let next = random(f.seed, 0) * spacing;
            for (let j = 1; j < path.length; j++) {
                const a = path[j - 1],
                    b = path[j],
                    dx = (b[0] - a[0]) * size,
                    dy = (b[1] - a[1]) * size,
                    len = Math.hypot(dx, dy);
                if (!len) continue;
                for (; next < len; next += spacing) {
                    index++;
                    stats.candidates++;
                    if (random(f.seed, index) >= fraction) continue;
                    const side = index % 2 ? 1 : -1;
                    const px = a[0] * size + (dx * next) / len - (dy / len) * offset * side,
                        py = a[1] * size + (dy * next) / len + (dx / len) * offset * side;
                    lamp(px, py, major, random(f.seed, 137) > 0.32);
                    stats.lamps++;
                    stats[minor ? "pathLamps" : "roadLamps"]++;
                }
                next -= len;
            }
        }
    }
    // At most 256 fills instead of a separate canvas operation per building.
    for (const [style, shape] of buildingPaths) {
        bc.fillStyle = `rgb(${style},0,0)`;
        bc.fill(shape, "evenodd");
    }
    const bp = cachedBuildings
        ? new ImageData(new Uint8ClampedArray(cachedBuildings.pixels), size, size)
        : bc.getImageData(0, 0, size, size);
    if (!cachedBuildings) buildingCache = { key: meta.key, pixels: new Uint8ClampedArray(bp.data) };
    for (let i = 0; i < bp.data.length; i += 4) {
        bp.data[i + 1] = roadPixels[i / 2];
        bp.data[i + 2] = roadPixels[i / 2 + 1];
    }
    buildings.width = 1;
    stats.rasterMs = performance.now() - started;
    stats.metersPerTexel = meta.meters / size;
    return { meta, stats, pixels: bp.data.buffer };
}
