import {Ray, Sphere, Vector3} from "three";
import {GroundAnchorRegion, isLiveSource, pickGroundHit, TILE_DETAIL_KEY, tileDetailOf} from "../src/TileGround";

// A list of hits as {height, detail}; returns the index that pickGroundHit takes.
function pick(hits, referenceHeight, tolerance = 40) {
    return pickGroundHit(hits.length, hitIndex => hits[hitIndex].height, hitIndex => hits[hitIndex].detail,
        referenceHeight, tolerance);
}

describe("pickGroundHit", () => {
    test("the hit on the most detailed tile wins, not the hit nearest to the elevation map", () => {
        // Measured in a sitch: the look view's fine tile is 0.430 m above the elevation
        // map, and the main view's coarse tile is 0.419 m below it.
        const hits = [{height: 251.222, detail: 8}, {height: 252.071, detail: 0.5}];
        expect(pick(hits, 251.641)).toBe(1);
        expect(pick([hits[1], hits[0]], 251.641)).toBe(0);
    });

    test("a hit outside the tolerance is not ground, even on the most detailed tile", () => {
        const hits = [{height: 300, detail: 0.1}, {height: 252, detail: 8}];
        expect(pick(hits, 251.6)).toBe(1);
    });

    test("no hit inside the tolerance gives -1", () => {
        expect(pick([{height: 5000, detail: 0.1}, {height: -4700, detail: 2}], 251.6)).toBe(-1);
        expect(pick([], 251.6)).toBe(-1);
    });

    test("hits of equal detail go by distance from the elevation map", () => {
        const hits = [{height: 255, detail: 1}, {height: 252, detail: 1}, {height: 249, detail: 1}];
        expect(pick(hits, 251.6)).toBe(1);
    });

    test("hits with no known detail go by distance, and lose to a hit with a known detail", () => {
        expect(pick([{height: 255}, {height: 252}], 251.6)).toBe(1);
        expect(pick([{height: 252}, {height: 255, detail: 16}], 251.6)).toBe(1);
    });
});

describe("tileDetailOf", () => {
    test("reads the detail from the nearest parent that has it", () => {
        const root = {userData: {[TILE_DETAIL_KEY]: 2.5}, parent: {userData: {[TILE_DETAIL_KEY]: 40}, parent: null}};
        const mesh = {userData: {}, parent: {userData: {}, parent: root}};
        expect(tileDetailOf(mesh)).toBe(2.5);
        expect(tileDetailOf(root.parent)).toBe(40);
    });

    test("gives undefined when no parent has a detail", () => {
        expect(tileDetailOf({userData: {}, parent: {parent: null}})).toBeUndefined();
    });

    test("a detail of zero (a last tile) is a known detail", () => {
        expect(tileDetailOf({userData: {[TILE_DETAIL_KEY]: 0}, parent: null})).toBe(0);
    });
});

describe("GroundAnchorRegion", () => {
    // A bounding volume that is a sphere, with the two tests that the region uses.
    function volume(center, radius) {
        const sphere = new Sphere(center, radius);
        return {
            intersectsSphere: other => sphere.intersectsSphere(other),
            intersectsRay: ray => ray.intersectsSphere(sphere),
            distanceToPoint: point => Math.max(0, sphere.distanceToPoint(point)),
        };
    }

    const ground = new Vector3(6370000, 0, 0);
    const up = new Vector3(1, 0, 0);
    const region = new GroundAnchorRegion(ground, up, 40);

    test("asks for the last tile: its error target is zero", () => {
        expect(region.errorTarget).toBe(0);
        // The library refines a tile while this value is more than the renderer's target.
        expect(region.calculateError({geometricError: 3}, {errorTarget: 20})).toBe(23);
        expect(region.calculateError({geometricError: 0}, {errorTarget: 20})).toBe(20);
    });

    test("takes a tile that the vertical line goes through near the ground", () => {
        expect(region.intersectsTile(volume(new Vector3(6370010, 5, 0), 20))).toBe(true);
    });

    test("does not take a tile beside the column", () => {
        // 30 m to the side: inside the 40 m sphere, but the vertical line misses it.
        expect(region.intersectsTile(volume(new Vector3(6370000, 30, 0), 10))).toBe(false);
    });

    test("does not take a tile on the line but far above or below the ground", () => {
        expect(region.intersectsTile(volume(new Vector3(6370500, 0, 0), 20))).toBe(false);
        // The far side of the Earth is on the same line.
        expect(region.intersectsTile(volume(new Vector3(-6370000, 0, 0), 500))).toBe(false);
    });

    test("setColumn moves the column", () => {
        const moved = new GroundAnchorRegion(ground, up, 40);
        moved.setColumn(new Vector3(0, 6370000, 0), new Vector3(0, 1, 0));
        expect(moved.intersectsTile(volume(new Vector3(0, 6370010, 0), 20))).toBe(true);
        expect(moved.intersectsTile(volume(new Vector3(6370010, 5, 0), 20))).toBe(false);
        expect(moved.ray).toBeInstanceOf(Ray);
    });

    test("a tile at the ground point is nearer than a tile above it", () => {
        expect(region.calculateDistance(volume(ground, 10))).toBe(0);
        expect(region.calculateDistance(volume(new Vector3(6370030, 0, 0), 10))).toBeCloseTo(20, 6);
    });
});

describe("isLiveSource", () => {
    // A small graph of nodes: connect(a, b) makes b read a.
    const node = name => ({name, outputs: []});
    const connect = (from, to) => { from.outputs.push(to); };
    // A switch reads the input whose key is its choice.
    function makeSwitch(name, inputs, choice) {
        const made = {name, outputs: [], inputs, choice, selectOption: () => {}};
        for (const input of Object.values(inputs)) connect(input, made);
        return made;
    }

    // The camera chain of a custom sitch: the Manual position feeds the position switch
    // and the flight simulator; the switch feeds the smoothed track, which a controller reads.
    function cameraChain(choice) {
        const manual = node("fixedCameraPosition");
        const flightSim = node("flightSimCameraPosition");
        connect(manual, flightSim);
        const loadedTrack = node("loadedTrack");
        const positionSwitch = makeSwitch("cameraTrackSwitch",
            {fixedCamera: manual, flightSimCamera: flightSim, track: loadedTrack}, choice);
        const smoothed = node("cameraTrackSwitchSmooth");
        connect(positionSwitch, smoothed);
        connect(smoothed, node("trackPositionController"));
        return {manual, flightSim, loadedTrack};
    }

    test("the Manual position is in use when the switch has it selected", () => {
        expect(isLiveSource(cameraChain("fixedCamera").manual)).toBe(true);
    });

    test("it is not in use when the camera follows a loaded track", () => {
        const chain = cameraChain("track");
        expect(isLiveSource(chain.manual)).toBe(false);
        expect(isLiveSource(chain.loadedTrack)).toBe(true);
    });

    test("it is in use as the origin of the flight simulator when that is selected", () => {
        const chain = cameraChain("flightSimCamera");
        expect(isLiveSource(chain.manual)).toBe(true);
    });

    test("a node that nothing reads through the graph is the end of its own chain", () => {
        expect(isLiveSource(node("readById"))).toBe(true);
    });

    test("a loop in the graph does not hang", () => {
        const first = node("first"), second = node("second");
        connect(first, second);
        connect(second, first);
        expect(isLiveSource(first)).toBe(false);
    });
});
