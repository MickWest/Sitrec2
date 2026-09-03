import {nextSequentialObjectName, parseObjectInput} from '../src/utils/parseObjectInput';
import {menuMethods} from '../src/CustomManagerMenus';
import {CNodeManager} from '../src/nodes/CNodeManager';
import {setNodeMan} from '../src/Globals';

describe('parseObjectInput', () => {
    test('coordinates in D M S with hemisphere letters', () => {
        const result = parseObjectInput("Home N40 26.767 W074 00.36 50m");
        expect(result).not.toBeNull();
        expect(result.name).toBe("Home");
        expect(result.lat).toBeCloseTo(40.446117, 5);
        expect(result.lon).toBeCloseTo(-74.006, 5);
        expect(result.alt).toBeCloseTo(50);
        expect(result.hasExplicitAlt).toBe(true);
    });

    test('a bare D M S pair with a unitless altitude', () => {
        const result = parseObjectInput("Tower 40 26 46 -79 58 56 100");
        expect(result).not.toBeNull();
        expect(result.name).toBe("Tower");
        expect(result.lat).toBeCloseTo(40.446111, 5);
        expect(result.lon).toBeCloseTo(-79.982222, 5);
        expect(result.alt).toBeCloseTo(100);
        expect(result.hasExplicitAlt).toBe(true);
    });

    test('a pasted Google-style pair with symbols', () => {
        const result = parseObjectInput(`Pier 40°26'46"N, 79°58'56"W`);
        expect(result).not.toBeNull();
        expect(result.name).toBe("Pier");
        expect(result.lat).toBeCloseTo(40.446111, 5);
        expect(result.lon).toBeCloseTo(-79.982222, 5);
        expect(result.hasExplicitAlt).toBe(false);
    });

    test('MGRS', () => {
        const result = parseObjectInput("Grid 37SCR1192692923 10ft");
        expect(result).not.toBeNull();
        expect(result.name).toBe("Grid");
        expect(result.lat).toBeCloseTo(32.4576, 3);
        expect(result.alt).toBeCloseTo(3.048, 3);
    });

    test('a southern latitude just below the equator keeps its sign', () => {
        const result = parseObjectInput("Quito -0 13 0, -78 30 0");
        expect(result.lat).toBeCloseTo(-0.216667, 5);
        expect(result.lon).toBeCloseTo(-78.5, 5);
    });

    test('a name with a digit in it is still a name', () => {
        const result = parseObjectInput("Object1 37.7749 -122.4194");
        expect(result.name).toBe("Object1");
        expect(result.lat).toBeCloseTo(37.7749);
    });

    test('altitudes without a leading digit', () => {
        expect(parseObjectInput("37.7749 -122.4194 .5m").alt).toBeCloseTo(0.5);
        expect(parseObjectInput("37.7749 -122.4194 -.5ft").alt).toBeCloseTo(-0.1524);
        expect(parseObjectInput("37.7749 -122.4194 5.m").alt).toBeCloseTo(5);
        expect(parseObjectInput("37.7749 -122.4194 .5").alt).toBeCloseTo(0.5);
    });

    test('garbage after the coordinates is not an altitude', () => {
        expect(parseObjectInput("Spot 37.7749 -122.4194 high")).toBeNull();
    });


    test('parses full input with name and altitude in meters', () => {
        const result = parseObjectInput("MyObject 37.7749 -122.4194 100m");
        expect(result).not.toBeNull();
        expect(result.name).toBe("MyObject");
        expect(result.lat).toBeCloseTo(37.7749);
        expect(result.lon).toBeCloseTo(-122.4194);
        expect(result.alt).toBeCloseTo(100);
        expect(result.hasExplicitAlt).toBe(true);
    });

    test('parses comma-separated input without name', () => {
        const result = parseObjectInput("37.7749, -122.4194, 100m");
        expect(result).not.toBeNull();
        expect(result.name).toBeNull();
        expect(result.lat).toBeCloseTo(37.7749);
        expect(result.lon).toBeCloseTo(-122.4194);
        expect(result.alt).toBeCloseTo(100);
        expect(result.hasExplicitAlt).toBe(true);
    });

    test('parses input with name but no altitude', () => {
        const result = parseObjectInput("Landmark 37.7749 -122.4194");
        expect(result).not.toBeNull();
        expect(result.name).toBe("Landmark");
        expect(result.lat).toBeCloseTo(37.7749);
        expect(result.lon).toBeCloseTo(-122.4194);
        expect(result.hasExplicitAlt).toBe(false);
    });

    test('parses input with altitude in feet and converts to meters', () => {
        const result = parseObjectInput("37.7749 -122.4194 300ft");
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(37.7749);
        expect(result.lon).toBeCloseTo(-122.4194);
        expect(result.alt).toBeCloseTo(91.44); // 300 * 0.3048
        expect(result.hasExplicitAlt).toBe(true);
    });

    test('parses space-separated input without name or altitude', () => {
        const result = parseObjectInput("37.7749 -122.4194");
        expect(result).not.toBeNull();
        expect(result.name).toBeNull();
        expect(result.lat).toBeCloseTo(37.7749);
        expect(result.lon).toBeCloseTo(-122.4194);
        expect(result.hasExplicitAlt).toBe(false);
    });

    test('handles negative coordinates', () => {
        const result = parseObjectInput("-33.8688 151.2093 50m");
        expect(result).not.toBeNull();
        expect(result.lat).toBeCloseTo(-33.8688);
        expect(result.lon).toBeCloseTo(151.2093);
        expect(result.alt).toBeCloseTo(50);
    });

    test('handles altitude without unit suffix (defaults to meters)', () => {
        const result = parseObjectInput("37.7749 -122.4194 200");
        expect(result).not.toBeNull();
        expect(result.alt).toBeCloseTo(200);
        expect(result.hasExplicitAlt).toBe(true);
    });

    test('handles decimal altitude values', () => {
        const result = parseObjectInput("37.7749 -122.4194 123.45m");
        expect(result).not.toBeNull();
        expect(result.alt).toBeCloseTo(123.45);
    });

    test('returns null for empty string', () => {
        const result = parseObjectInput("");
        expect(result).toBeNull();
    });

    test('returns null for whitespace only', () => {
        const result = parseObjectInput("   ");
        expect(result).toBeNull();
    });

    test('returns null for invalid input (no numbers)', () => {
        const result = parseObjectInput("Just a name");
        expect(result).toBeNull();
    });

    test('returns null for insufficient coordinates (only one number)', () => {
        const result = parseObjectInput("37.7749");
        expect(result).toBeNull();
    });

    test('returns null for null input', () => {
        const result = parseObjectInput(null);
        expect(result).toBeNull();
    });

    test('handles multi-word names', () => {
        const result = parseObjectInput("Golden Gate Bridge 37.8199 -122.4783 67m");
        expect(result).not.toBeNull();
        expect(result.name).toBe("Golden Gate Bridge");
        expect(result.lat).toBeCloseTo(37.8199);
        expect(result.lon).toBeCloseTo(-122.4783);
        expect(result.alt).toBeCloseTo(67);
    });

    test('handles mixed comma and space separation', () => {
        const result = parseObjectInput("Object1 37.7749, -122.4194, 100m");
        expect(result).not.toBeNull();
        expect(result.name).toBe("Object1");
        expect(result.lat).toBeCloseTo(37.7749);
        expect(result.lon).toBeCloseTo(-122.4194);
        expect(result.alt).toBeCloseTo(100);
    });
});

describe('nextSequentialObjectName', () => {

    test('returns Object 1 when nothing is in use', () => {
        expect(nextSequentialObjectName([])).toBe("Object 1");
    });

    test('returns Object 1 for a missing list', () => {
        expect(nextSequentialObjectName(undefined)).toBe("Object 1");
    });

    test('increments past the highest existing number', () => {
        expect(nextSequentialObjectName(["Object 1", "Object 2"])).toBe("Object 3");
    });

    test('uses the highest number, not the count, so gaps are not reused', () => {
        expect(nextSequentialObjectName(["Object 1", "Object 5"])).toBe("Object 6");
    });

    test('is not confused by order', () => {
        expect(nextSequentialObjectName(["Object 7", "Object 2"])).toBe("Object 8");
    });

    test('handles numbers above 9 numerically, not lexically', () => {
        expect(nextSequentialObjectName(["Object 9", "Object 12"])).toBe("Object 13");
    });

    test('ignores names that only resemble the pattern', () => {
        const names = ["Object", "Object A", "MyObject 4", "Object 3x", "object 6", "Object  8"];
        expect(nextSequentialObjectName(names)).toBe("Object 1");
    });

    test('ignores non-string entries', () => {
        expect(nextSequentialObjectName([null, undefined, 42, {}, "Object 2"])).toBe("Object 3");
    });
});

// Regression tests for the "Add Object" menu crash:
//   TypeError: NodeMan.getAllNodes is not a function
// getNextObjectName() called an invented manager method, and was only reached when
// the user typed bare coordinates with no name - so the named path never hit it.
// These exercise the REAL menuMethods.getNextObjectName against a REAL CNodeManager,
// so any future invented API throws here exactly as it did in the browser.
describe('CCustomManager.getNextObjectName', () => {

    let nodeMan;

    beforeEach(() => {
        nodeMan = new CNodeManager();
        setNodeMan(nodeMan);
    });

    test('CNodeManager exposes iterate(), and has no getAllNodes()', () => {
        // The root cause, pinned: getAllNodes has never existed on any CManager.
        expect(typeof nodeMan.iterate).toBe('function');
        expect(nodeMan.getAllNodes).toBeUndefined();
    });

    test('does not throw on an empty node graph, and starts at Object 1', () => {
        expect(() => menuMethods.getNextObjectName()).not.toThrow();
        expect(menuMethods.getNextObjectName()).toBe("Object 1");
    });

    test('counts a name held in menuText, which is where addSyntheticTrack puts it', () => {
        // createObjectFromInput() -> TrackManager.addSyntheticTrack() sets
        // splineEditorNode.menuText = name, on a node whose id is timestamped.
        nodeMan.add("syntheticTrack_1700000000000_unsmoothed", {
            id: "syntheticTrack_1700000000000_unsmoothed",
            menuText: "Object 1",
        });
        expect(menuMethods.getNextObjectName()).toBe("Object 2");
    });

    test('counts a name held in the node id', () => {
        nodeMan.add("Object 3", {id: "Object 3"});
        expect(menuMethods.getNextObjectName()).toBe("Object 4");
    });

    test('takes the highest across ids and menuText together', () => {
        nodeMan.add("Object 2", {id: "Object 2"});
        nodeMan.add("syntheticTrack_1700000000001_unsmoothed", {
            id: "syntheticTrack_1700000000001_unsmoothed",
            menuText: "Object 5",
        });
        expect(menuMethods.getNextObjectName()).toBe("Object 6");
    });

    test('ignores unrelated nodes and user-chosen names', () => {
        nodeMan.add("mainCamera", {id: "mainCamera"});
        nodeMan.add("syntheticObject_1700000000002", {
            id: "syntheticObject_1700000000002",
            menuText: "Golden Gate Bridge",
        });
        expect(menuMethods.getNextObjectName()).toBe("Object 1");
    });

    test('tolerates nodes with no menuText', () => {
        nodeMan.add("bare", {id: "bare"});
        expect(() => menuMethods.getNextObjectName()).not.toThrow();
    });
});
