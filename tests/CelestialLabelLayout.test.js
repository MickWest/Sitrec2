import {CelestialLabelLayout, celestialLabelDensity} from "../src/CelestialLabelLayout";
import {DEEP_SKY_OBJECTS, PROMINENT_DEEP_SKY_IDS} from "../src/DeepSkyObjects";

const rect = {x: 0, y: 0, w: 1000, h: 600};
const label = (id, magnitude, x, extra = {}) => ({id, kind: "star", magnitude,
    box: {x, y: 100, w: 45, h: 14}, ...extra});

test("default density keeps a quarter of a field, brightest first regardless of catalog order", () => {
    const labels = Array.from({length: 16}, (_, i) => label(`star:${i}`, i / 2, 10 + i * 60)).reverse();
    const layout = new CelestialLabelLayout();
    expect(layout.place(labels, rect).map(l => l.id)).toEqual(["star:0", "star:1", "star:2", "star:3"]);
    expect(layout.place(labels, rect, 0)).toEqual([]);
    expect(layout.place(labels, rect, 1)).toHaveLength(16);
});

test("ordinary deep sky is removed before dim stars; prominent objects compete by brightness", () => {
    const labels = [
        label("galaxy", 1, 10, {kind: "deepSky"}),
        label("dim star", 5, 70),
        label("Andromeda", 3.44, 130, {kind: "deepSky", prominent: true}),
        label("Jupiter", -2, 190, {kind: "planet"}),
        label("bright star", 1, 250),
        label("Pluto", 14, 310, {kind: "planet"}),
    ];
    const layout = new CelestialLabelLayout();
    expect(layout.place(labels, rect, 0.5).map(l => l.id)).toEqual(["Jupiter", "bright star", "Andromeda"]);
    expect(layout.place(labels, rect, 0.8).map(l => l.id)).toEqual([
        "Jupiter", "bright star", "Andromeda", "dim star", "Pluto",
    ]);
    expect(layout.place(labels, rect, 1).at(-1).id).toBe("galaxy");
});

test("crowded names lose to brighter neighbors and do not spend the budget", () => {
    const labels = [label("dim", 4, 20), label("bright", 0, 10), label("far", 2, 180), label("last", 3, 240)];
    expect(new CelestialLabelLayout().place(labels, rect, 0.5).map(l => l.id)).toEqual(["bright", "far"]);
    const placed = new CelestialLabelLayout().place(labels, rect, 1);
    expect(placed.map(l => l.id)).toEqual(["bright", "far", "last"]);
});

test("a dense patch of faint objects cannot inflate the default label budget", () => {
    const bright = Array.from({length: 8}, (_, i) => label(`bright:${i}`, i, 10 + i * 60));
    const crowded = Array.from({length: 80}, (_, i) => label(`faint:${i}`, 10, 10, {kind: "deepSky"}));
    const layout = new CelestialLabelLayout();
    expect(layout.place([...bright, ...crowded], rect)).toHaveLength(2);
    expect(layout.availableCount).toBe(8);
});

test("names leave space for compass labels without counting blocked names in the budget", () => {
    const layout = new CelestialLabelLayout();
    const labels = [label("near compass", 0, 10), label("clear", 1, 90)];
    expect(layout.place(labels, rect, 1, [{x: 35, y: 98, w: 20, h: 14}]).map(l => l.id)).toEqual(["clear"]);
    expect(layout.availableCount).toBe(1);
});

test("the displayed clip limits candidates and the density budget when panning or resizing", () => {
    const labels = Array.from({length: 12}, (_, i) => label(String(i), i, 10 + i * 60));
    const layout = new CelestialLabelLayout();
    expect(layout.place(labels, {x: 180, y: 80, w: 250, h: 100}).map(l => l.id)).toEqual(["3"]);
    expect(layout.candidateCount).toBe(4);
    expect(layout.place(labels, {x: 240, y: 80, w: 130, h: 100}, 1).map(l => l.id)).toEqual(["4", "5"]);
});

test("small motions keep clear labels stable without letting faint names displace bright ones", () => {
    const layout = new CelestialLabelLayout();
    const bright = label("bright", 0, 10), dim = label("dim", 2, 62);
    expect(layout.place([dim, bright], rect, 1)).toHaveLength(2);
    dim.box.x = 60; // five pixels clearance, below the six required for a new label
    expect(layout.place([dim, bright], rect, 1)).toHaveLength(2);
    dim.box.x = 57;
    expect(layout.place([dim, bright], rect, 1).map(l => l.id)).toEqual(["bright"]);
    expect(layout.place([dim, bright], rect, 0)).toEqual([]);
});

test("prominent deep sky entries exist in this catalog, including Andromeda and Pleiades", () => {
    for (const id of PROMINENT_DEEP_SKY_IDS) expect(DEEP_SKY_OBJECTS.some(o => o.id === id)).toBe(true);
    expect(PROMINENT_DEEP_SKY_IDS.has(DEEP_SKY_OBJECTS.find(o => o.name === "M31").id)).toBe(true);
    expect(PROMINENT_DEEP_SKY_IDS.has("M 45")).toBe(true);
});

test("density defaults and limits preserve an explicit zero", () => {
    expect(celestialLabelDensity()).toBe(0.25);
    expect(celestialLabelDensity(NaN)).toBe(0.25);
    expect(celestialLabelDensity(0)).toBe(0);
    expect(celestialLabelDensity(-1)).toBe(0);
    expect(celestialLabelDensity(2)).toBe(1);
});
