import fs from 'node:fs';
import path from 'node:path';
import {parse} from '@babel/parser';
import {Vector3} from 'three';

// "Hide Outside Track Data": the methods are exercised on their own, extracted from the
// source as in ObjectViewScale.test.js, so the browser-only dependencies of the two node
// files are not loaded.
function extractMethods(file, className, names, globals = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../src/nodes', file), 'utf8');
    const declaration = parse(source, {sourceType: 'module'}).program.body
        .find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === className).declaration;
    const methods = declaration.body.body.filter(node => names.includes(node.key?.name));
    expect(methods.map(node => node.key.name).sort()).toEqual([...names].sort());
    const body = methods.map(node => source.slice(node.start, node.end)).join('\n');
    return new Function(...Object.keys(globals), `return class {${body}}`)(...Object.values(globals));
}

describe('track data span', () => {
    const Sit = {fps: 1};
    const Track = extractMethods('CNodeTrackFromMISB.js', 'CNodeTrackFromMISB',
        ['getTimeOffsetFrames', 'getDataFrameSpan'], {Sit});
    const track = (span, timeOffset = 0, startOffset = 0) => Object.assign(new Track(), {
        dataFrameSpan: span,
        in: {misb: {timeOffset, getTrackStartTimeOffsetSeconds: () => startOffset}},
    });

    test('unshifted span passes through; null and undefined are kept', () => {
        expect(track({first: 532.5, last: 662.5}).getDataFrameSpan()).toEqual({first: 532.5, last: 662.5});
        expect(track(null).getDataFrameSpan()).toBeNull();
        expect(track(undefined).getDataFrameSpan()).toBeUndefined();
    });

    test('moves by the same offsets getValue applies (getValue(f) reads frame f + offset)', () => {
        // data at array frames 0..136; a +10 s offset at 1 fps makes getValue(f) read f + 10,
        // so the data shows at sitch frames -10..126
        expect(track({first: -0.5, last: 136.5}, 6, 4).getDataFrameSpan()).toEqual({first: -10.5, last: 126.5});
        Sit.fps = 30;
        expect(track({first: 0, last: 300}, -1).getDataFrameSpan()).toEqual({first: 30, last: 330});
        Sit.fps = 1;
    });
});

// recalculate() on a few timed rows: the span it records, in frames of the track's array.
describe('track data span from recalculate', () => {
    const MISB = {SensorVerticalFieldofView: 'vfov', WindDirection: 'windDir', WindSpeed: 'windSpeed'};
    const run = ({sit, msStart, times, valid, video = null, pesPTSus = null}) => {
        const Sit = {lat: 0, lon: 0, simSpeed: 1, ...sit};
        const Track = extractMethods('CNodeTrackFromMISB.js', 'CNodeTrackFromMISB',
            ['recalculate', 'patchColumn', 'getTimeOffsetFrames', 'getDataFrameSpan'], {
                Sit, MISB, Vector3,
                Globals: {equatorRadius: 6378137, polarRadius: 6356752.314245},
                NodeMan: {get: id => id === 'video' ? video : undefined},
                assert: (condition, message) => { if (!condition) throw new Error(message); },
                interpolate: (a, b, fraction) => a + fraction * (b - a),
                meanSeaLevelOffset: () => 0,
                LLAToECEF: () => new Vector3(), ECEFToLLAVD_radii: () => new Vector3(),
            });
        const rows = times.map(() => ({}));
        rows.pesPTSus = pesPTSus;
        const misb = {
            misb: rows, useAGL: false, timeOffset: 0,
            selectSourceColumns() {}, isTerrainDependent: () => false,
            adjustAlt: alt => alt, needsGeoidToHAE: () => false,
            hasRecordPTS: () => pesPTSus !== null,
        };
        const track = Object.assign(new Track(), {
            id: 'track', _columns: [],
            in: {misb, startTime: {getStartTimeValue: () => msStart}},
            latArray: times.map(() => 10), lonArray: times.map(() => 20), rawAltArray: times.map(() => 1000),
            timeArray: times, validArray: valid ?? times.map(() => true),
        });
        track.recalculate();
        return track;
    };

    test('wall clock: the frames of the first and last valid rows, half a frame wider each side', () => {
        const msStart = Date.UTC(2026, 0, 1);
        const at = seconds => msStart + seconds * 1000;
        // rows at 1, 2, 3 and 5 s; the first row is not valid
        const track = run({sit: {fps: 1, frames: 10}, msStart, times: [at(1), at(2), at(3), at(5)],
            valid: [false, true, true, true]});
        expect(track.dataFrameSpan).toEqual({first: 1.5, last: 5.5});
        expect(track.array.length).toBe(10);
        // the inverse of the sitch clock: at 30 fps and double sim speed, 4 s is frame 60
        const fast = run({sit: {fps: 30, frames: 120, simSpeed: 2}, msStart, times: [at(4), at(6)]});
        expect(fast.dataFrameSpan.first).toBeCloseTo(59.5, 9);
        expect(fast.dataFrameSpan.last).toBeCloseTo(90.5, 9);
    });

    test('PES time: the frames whose video time falls in the data, frame by frame', () => {
        // 1 fps video with frame 4 dropped: frame 4 is at 5 s, so frames 2 to 5 cover 2 to 6 s
        const framePTSus = [0, 1, 2, 3, 5, 6, 7, 8, 9, 10].map(seconds => seconds * 1e6);
        const video = {videoData: {framePTSus, getFrameTimeMs: f => framePTSus[f] / 1000, hasRealFramePTS: () => true}};
        const log = jest.spyOn(console, 'log').mockImplementation(() => {});
        const track = run({sit: {fps: 1, frames: 10}, msStart: 0, times: [0, 0, 0], video, pesPTSus: [2e6, 3e6, 6e6]});
        log.mockRestore();
        expect(track.pairingInfo.mode).toBe('pts');
        // the wall clock would end at frame 6.5
        expect(track.dataFrameSpan).toEqual({first: 1.5, last: 5.5});
    });
});

describe('object visibility outside the data', () => {
    // a stand-in for CNodeSwitch: the selected input is inputs[choice]
    class CNodeSwitch {
        constructor(inputs, choice) { Object.assign(this, {inputs, choice}); }
    }
    const Obj = extractMethods('CNode3DObject.js', 'CNode3DObject', ['trackDataSpan', 'applyTrackDataVisibility'],
        {CNodeSwitch});
    const object = ({span, hide = true, visible = true, labelVisible} = {}) => {
        const source = {getDataFrameSpan: () => span};
        const smoothed = {in: {source}};
        return Object.assign(new Obj(), {
            hideOutsideTrackData: hide,
            visible,
            group: {visible},
            label: {visible: labelVisible, group: {visible: labelVisible !== false}},
            getSourceTrack: () => smoothed,
        });
    };

    test('hides the object and its label outside the span, shows them inside', () => {
        const ob = object({span: {first: 532.5, last: 662.5}});
        ob.applyTrackDataVisibility(300);
        expect([ob.group.visible, ob.label.group.visible]).toEqual([false, false]);
        ob.applyTrackDataVisibility(533);
        expect([ob.group.visible, ob.label.group.visible]).toEqual([true, true]);
        ob.applyTrackDataVisibility(532);
        expect(ob.group.visible).toBe(false);
        expect(ob.visible).toBe(true);   // the saved Visible flag is not changed
    });

    test('never shows what Visible (or the label) hides', () => {
        const ob = object({span: {first: 0, last: 10}, visible: false, labelVisible: false});
        ob.applyTrackDataVisibility(5);
        expect([ob.group.visible, ob.label.group.visible]).toEqual([false, false]);
    });

    test('the span is found through a switch, on its selected input', () => {
        // the custom sitch camera object: smoothed track -> position switch -> chosen track
        const track = {getDataFrameSpan: () => ({first: 10, last: 20})};
        const fixed = {in: {}};
        const positionSwitch = new CNodeSwitch({fixedCamera: fixed, track}, 'track');
        const ob = Object.assign(new Obj(), {
            hideOutsideTrackData: true, visible: true, group: {visible: true},
            getSourceTrack: () => ({in: {source: positionSwitch}}),
        });
        expect(ob.trackDataSpan()).toEqual({first: 10, last: 20});
        ob.applyTrackDataVisibility(5);
        expect(ob.group.visible).toBe(false);
        positionSwitch.choice = 'fixedCamera';
        expect(ob.trackDataSpan()).toBeUndefined();
        ob.applyTrackDataVisibility(5);
        expect(ob.group.visible).toBe(true);
    });

    test('no valid data hides; an unknown span does not', () => {
        const none = object({span: null});
        none.applyTrackDataVisibility(5);
        expect(none.group.visible).toBe(false);
        const unknown = object({span: undefined});
        unknown.applyTrackDataVisibility(5);
        expect(unknown.group.visible).toBe(true);
    });

    test('turning the option off restores Visible once, then leaves the group alone', () => {
        const ob = object({span: {first: 0, last: 10}});
        ob.applyTrackDataVisibility(50);
        expect(ob.group.visible).toBe(false);
        ob.hideOutsideTrackData = false;
        ob.applyTrackDataVisibility(50);
        expect([ob.group.visible, ob.label.group.visible]).toEqual([true, true]);
        ob.group.visible = 'set elsewhere';
        ob.applyTrackDataVisibility(51);
        expect(ob.group.visible).toBe('set elsewhere');
    });
});
