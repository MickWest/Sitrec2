// Tests for CManager.UniqueName(prefix) and the id-generation sites that use it.
//
// Background: synthetic objects, tracks and balloons were id'ed
// `${prefix}_${Date.now()}`. A millisecond timestamp is not unique — two created in
// the same millisecond got the SAME id, and the second threw out of CManager.add
// ("seem to be adding <id> twice to a CManager"). Measured live, two Add Object calls
// landed 19 ms apart, so the window is narrow but reachable: a double click, a script,
// or a deserialize loop.
//
// UniqueName lives on the CManager base class, so every manager (NodeMan, TrackManager,
// FileManager, ViewMan, FeatureManager) has it.

import fs from 'fs';
import path from 'path';
import {CManager} from '../src/CManager';
import {CNodeManager} from '../src/nodes/CNodeManager';

describe('CManager.UniqueName', () => {

    let man;
    beforeEach(() => { man = new CManager(); });

    test('returns the name unchanged when nothing holds it', () => {
        // The overwhelmingly common case — ids must stay readable.
        expect(man.UniqueName('syntheticObject_1788018627986'))
            .toBe('syntheticObject_1788018627986');
    });

    test('appends _1 on the first collision', () => {
        man.add('syntheticObject_100', {});
        expect(man.UniqueName('syntheticObject_100')).toBe('syntheticObject_100_1');
    });

    test('increments past every taken suffix', () => {
        man.add('obj', {});
        man.add('obj_1', {});
        man.add('obj_2', {});
        expect(man.UniqueName('obj')).toBe('obj_3');
    });

    test('skips to the first FREE suffix, not the highest', () => {
        // _1 is free, so it is reused even though _2 exists.
        man.add('obj', {});
        man.add('obj_2', {});
        expect(man.UniqueName('obj')).toBe('obj_1');
    });

    test('a suffixed name is itself a valid input', () => {
        man.add('obj_1', {});
        expect(man.UniqueName('obj_1')).toBe('obj_1_1');
    });

    test('successive calls stay unique when each result is claimed', () => {
        // The real usage: generate, then immediately construct (which add()s it).
        const claimed = [];
        for (let i = 0; i < 4; i++) {
            const id = man.UniqueName('syntheticObject_100');
            man.add(id, {});
            claimed.push(id);
        }
        expect(claimed).toEqual([
            'syntheticObject_100',
            'syntheticObject_100_1',
            'syntheticObject_100_2',
            'syntheticObject_100_3',
        ]);
        expect(new Set(claimed).size).toBe(4);
    });

    test('the same-millisecond collision no longer throws', () => {
        // Simulates two Add Object calls inside one millisecond: both compute the
        // identical `syntheticObject_${Date.now()}` string.
        const sameTimestampName = `syntheticObject_${1788018627986}`;
        const first = man.UniqueName(sameTimestampName);
        man.add(first, {});
        const second = man.UniqueName(sameTimestampName);
        expect(() => man.add(second, {})).not.toThrow();
        expect(second).not.toBe(first);
    });

    test('is inherited by CNodeManager, not just the base class', () => {
        const nodeMan = new CNodeManager();
        nodeMan.add('n', {});
        expect(nodeMan.UniqueName('n')).toBe('n_1');
    });

    test('does not disturb the manager — it only reads', () => {
        man.add('obj', {});
        const sizeBefore = man.size();
        const versionBefore = man.listVersion;
        man.UniqueName('obj');
        expect(man.size()).toBe(sizeBefore);
        expect(man.listVersion).toBe(versionBefore);
    });
});

// Call-site guards. These id generators live inside methods that need a live scene to
// run, so the wiring is pinned by reading the source (as tests/nodeRegistration.test.js
// does). The bug was a raw template literal reaching add() unchecked.
describe('generated ids go through UniqueName', () => {

    const read = (...p) => fs.readFileSync(path.resolve(__dirname, '..', ...p), 'utf-8');

    // Every `${prefix}_${Date.now()}` that becomes a manager id must be wrapped.
    const GENERATORS = [
        ['src/CustomManagerMenus.js', 'syntheticObject_'],
        ['src/CustomManagerMenus.js', 'syntheticTrack_'],
        ['src/CustomManagerMenus.js', 'feature_'],
        ['src/TrackManager.js', 'syntheticTrack_'],
        ['src/TrackManager.js', 'syntheticTrackDisplay_'],
        ['src/TrackManager.js', 'balloonTrack_'],
        ['src/TrackManager.js', 'balloonObject_'],
        ['src/TrackManager.js', 'balloonTrackDisplay_'],
    ];

    test.each(GENERATORS)('%s: %s ids are wrapped in UniqueName', (file, prefix) => {
        const source = read(file);
        // Find every generation of this prefix and require UniqueName on the same line.
        const lines = source.split('\n').filter(line =>
            line.includes('`' + prefix + '${Date.now()}`'));
        expect(lines.length).toBeGreaterThan(0);
        for (const line of lines) {
            expect(line).toMatch(/UniqueName\(/);
        }
    });

    test('deserialized ids are still used verbatim', () => {
        // A saved sitch must restore its exact ids or graph references stop resolving,
        // so UniqueName may only apply to the generated fallback after `||`.
        const source = read('src', 'TrackManager.js');
        expect(source).toMatch(/const trackID = options\.trackID \|\| NodeMan\.UniqueName\(/);
        expect(source).toMatch(/const displayTrackID = options\.displayTrackID \|\| NodeMan\.UniqueName\(/);
    });
});
