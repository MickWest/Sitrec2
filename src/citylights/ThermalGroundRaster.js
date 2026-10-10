import {decodeCompact, ROAD_CLASSES} from "./CityLightsData";

// Estimated paved widths in meters by road class: typical carriageway widths, not mapped widths (the source has none).
export const ROAD_WIDTHS_M = Object.freeze({motorway: 15, trunk: 12, primary: 10, secondary: 8, tertiary: 7,
    residential: 6, service: 4, pedestrian: 3, footway: 1.5, cycleway: 2, unclassified: 5, unknown: 5});
// Paths for people are usually concrete or paving; roads for vehicles are usually asphalt.
export const PAVED_PATH_CLASSES = Object.freeze(["pedestrian", "footway", "cycleway"]);

// Thermal ground mask for one region: R road surface (asphalt), G building footprint (roof), B paved path (concrete),
// each as the covered fraction of the texel. Coordinates are the region's normalized Web Mercator square.
export function rasterThermalGround(source) {
    const started = performance.now(), decoder = decodeCompact(source.data), meta = decoder.meta, size = meta.size;
    const pixelsPerMeter = size / meta.meters;
    const layers = ["roads", "buildings", "paths"].map(() => {
        const canvas = new OffscreenCanvas(size, size), context = canvas.getContext("2d", {willReadFrequently: true});
        context.lineCap = context.lineJoin = "round";
        context.strokeStyle = context.fillStyle = "#fff";
        return {canvas, context};
    });
    const [roads, buildings, paths] = layers;
    const footprints = new Path2D(), strokes = new Map();
    const stats = {roads: 0, buildings: 0, paths: 0, bytes: source.bytes, loadMs: source.loadMs};
    for (const feature of decoder.features()) {
        if (feature.kind === 0) {
            for (const ring of feature.paths) {
                ring.forEach((point, i) => i ? footprints.lineTo(point[0] * size, point[1] * size) : footprints.moveTo(point[0] * size, point[1] * size));
                footprints.closePath();
            }
            stats.buildings++;
            continue;
        }
        const roadClass = ROAD_CLASSES[feature.style] ?? "unknown";
        let shape = strokes.get(roadClass);
        if (!shape) strokes.set(roadClass, shape = new Path2D());
        for (const line of feature.paths)
            line.forEach((point, i) => i ? shape.lineTo(point[0] * size, point[1] * size) : shape.moveTo(point[0] * size, point[1] * size));
        stats[PAVED_PATH_CLASSES.includes(roadClass) ? "paths" : "roads"]++;
    }
    buildings.context.fill(footprints, "nonzero");
    for (const [roadClass, shape] of strokes) {
        const target = PAVED_PATH_CLASSES.includes(roadClass) ? paths : roads;
        // A width under one texel draws an antialiased line whose coverage approximates the paved fraction.
        target.context.lineWidth = Math.max(0.5, (ROAD_WIDTHS_M[roadClass] ?? 5) * pixelsPerMeter);
        target.context.stroke(shape);
    }
    const [r, g, b] = layers.map(layer => layer.context.getImageData(0, 0, size, size).data);
    const pixels = new Uint8Array(size * size * 4);
    for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = r[i + 3]; pixels[i + 1] = g[i + 3]; pixels[i + 2] = b[i + 3]; pixels[i + 3] = 255;
    }
    for (const layer of layers) layer.canvas.width = 1;
    stats.rasterMs = performance.now() - started;
    stats.metersPerTexel = meta.meters / size;
    return {meta, stats, pixels: pixels.buffer};
}
