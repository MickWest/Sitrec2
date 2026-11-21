import fs from 'fs';
import vm from 'vm';
import {parse} from '@babel/parser';
import {beginInitialCameraPosition, canPlaceInitialCamera, noteCameraPositionChange,
    withInitialCameraPlacement} from '../src/InitialCameraPosition';
import {identifiedStarDirections, solvedFieldDirections} from '../src/starTrack/StarTemplateView';

// Run the real applyTemplateStarSetup from StarTrackerUI with the scene observed.
// Loading the whole Star Tracker in Jest would need workers and WebGL.
const source = fs.readFileSync(require.resolve('../src/starTrack/StarTrackerUI'), 'utf8');
const declaration = parse(source, {sourceType: 'module'}).program.body
    .find(node => node.type === 'FunctionDeclaration' && node.id?.name === 'applyTemplateStarSetup');

function harness({locationKnown = false, timeKnown = false, identify, choice} = {}) {
    const videoData = {_templateStarSetupPending: true};
    // As the app's listeners do: a position or camera-source change that is not an
    // announced initial placement stops later text navigation from moving the camera.
    const position = {_LLA: [40, -100, 2], agl: true,
        gotoLLA(lat, lon, alt, agl) { this._LLA = [lat, lon, alt]; this.agl = agl; noteCameraPositionChange(this); }};
    const cameraTrackSwitch = {choice: 'fixedCamera',
        selectOption(option) { this.choice = option; noteCameraPositionChange(position, true); }};
    beginInitialCameraPosition(position, true);
    const nodes = {fixedCameraPosition: position, cameraTrackSwitch,
        lookCamera: {camera: {fov: 40, position: {}}},
        starTrackCameraController: {bakeFrom: () => true, frame0: 0, vfovDeg: 40,
            posesAt: () => ({centre: {raDeg: 195, decDeg: -30}, above: {raDeg: 195, decDeg: -29}})}};
    const result = {videoData, videoW: 1500, videoH: 1000,
        identify: identify ?? {solved: {ok: true}, identified: new Map([[0, {raDeg: 190, decDeg: -24}]])}};
    const context = {
        videoView: () => ({videoData}), Sit: {}, par: {frame: 0}, params: {},
        templateOptions: () => ({findNightView: true, frameStars: true}),
        templateConstraints: () => ({locationKnown, timeKnown}), templateContextSnapshot: () => ({}),
        applyTemplateInference: (sitch, apply) => apply(),
        NodeMan: {get: id => nodes[id]}, ECEFToLLAVD_radii: () => ({x: 40, y: -100}),
        GlobalDateTimeNode: {dateNow: Date.parse('2026-11-21T12:00:00Z'), setNowDateTime: jest.fn()},
        findTemplateNightView: jest.fn(() => choice ?? {latitude: 35.68, longitude: 139.69, region: 'Elsewhere',
            date: new Date('2026-11-21T12:00:00Z'), minAltitude: 40, sunAltitude: -30}),
        solvedFieldDirections, identifiedStarDirections, withInitialCameraPlacement,
        setRenderOne: jest.fn(), UndoManager: {add: jest.fn()},
    };
    vm.createContext(context);
    vm.runInContext(source.slice(declaration.start, declaration.end), context);
    return {...context, run: () => context.applyTemplateStarSetup(result), result, videoData, position};
}

test('an assumed viewing location leaves the look camera free for Go To', () => {
    const h = harness();
    h.run();
    expect(h.position._LLA).toEqual([35.68, 139.69, 2]);
    expect(canPlaceInitialCamera(h.position, 'fixedCamera')).toBe(true);
    // Undo and redo use the same placement.
    const step = h.UndoManager.add.mock.calls[0][0];
    step.undo();
    expect(h.position._LLA).toEqual([40, -100, 2]);
    step.redo();
    expect(canPlaceInitialCamera(h.position, 'fixedCamera')).toBe(true);
});

test('a camera that the user moved before the solve stays protected', () => {
    const h = harness();
    h.position._LLA = [41, -101, 2];
    noteCameraPositionChange(h.position);
    h.run();
    expect(canPlaceInitialCamera(h.position, 'fixedCamera')).toBe(false);
});

test('a known location and time give a Viewing Setup status and no search', () => {
    const h = harness({locationKnown: true, timeKnown: true});
    h.run();
    expect(h.findTemplateNightView).not.toHaveBeenCalled();
    expect(h.videoData._templateViewingStatus).toBe('Location and time known; unchanged');
    expect(h.videoData._templateStarSetupPending).toBe(false);
});

test('a partial or mirrored solve says why the view is not set and stays pending', () => {
    const partial = harness({identify: {solved: {ok: true}, partial: true}});
    partial.run();
    expect(partial.videoData._templateViewingStatus).toBe('Not set: only part of the video was identified');
    expect(partial.videoData._templateStarSetupPending).toBe(true);
    const mirrored = harness({identify: {solved: {ok: true, mirrored: true}}});
    mirrored.run();
    expect(mirrored.videoData._templateViewingStatus).toBe('Not set: the solved field is mirrored');
    // A result for other media does not write this media's status.
    const other = harness({identify: {solved: {ok: true}, partial: true}});
    other.result.videoData = {};
    other.run();
    expect(other.videoData._templateViewingStatus).toBeUndefined();
});

test('a time chosen from the identified stars says the lower frame is below the horizon', () => {
    const h = harness({locationKnown: true, choice: {latitude: 40, longitude: -100, region: 'Known location',
        date: new Date('2026-04-20T07:00:00Z'), minAltitude: 15, sunAltitude: -30,
        lowFrame: true, fieldMinAltitude: -4}});
    h.run();
    expect(h.findTemplateNightView.mock.calls[0][1].stars).toHaveLength(1);
    expect(h.position._LLA).toEqual([40, -100, 2]);
    expect(h.videoData._templateViewingStatus).toContain('identified stars above 15°, lower part of the frame below the horizon');
});
