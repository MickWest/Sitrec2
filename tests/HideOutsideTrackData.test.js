import fs from 'node:fs';
import path from 'node:path';
import {parse} from '@babel/parser';

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

describe('object visibility outside the data', () => {
    const Obj = extractMethods('CNode3DObject.js', 'CNode3DObject', ['trackDataSpan', 'applyTrackDataVisibility']);
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
