import fs from 'fs';
import vm from 'vm';
import {parse} from '@babel/parser';
import {minimumIdentifyObservations, unconfirmedIdentificationStatus} from '../src/starTrack/StarIdentificationPolicy';

// Run the real UI workflow with the worker and scene mutations observed. Loading
// the entire renderer in Jest would require browser workers and WebGL.
const source = fs.readFileSync(require.resolve('../src/starTrack/StarTrackerUI'), 'utf8');
const declaration = parse(source, {sourceType: 'module'}).program.body
    .find(node => node.declaration?.id?.name === 'identifyByBrightTriples').declaration;

function harness(observations = 100) {
    const videoData = {_templateStarSetupPending: true};
    const classified = Array.from({length: 6}, (_, index) => ({index, n: observations,
        klass: 'star', position: [100 + index * 20, 100 + index * 10], magnitude: index}));
    const result = {videoData, generation: 1, frame0: 0, frame1: 193, stoppedEarly: true,
        videoW: 1080, videoH: 1920, solved: {classified, transforms: Array(194), tracks: []}};
    const matches = classified.map(c => ({star: {index: c.index},
        object: {label: `Star ${c.index}`, hip: c.index, raDeg: c.index, decDeg: 10, mag: 1}}));
    const best = {matches, nMatched: 6, nMissing: 0, rmsPx: 0.1};
    const report = {ok: true, best, candidates: [best]};
    const context = {result, dismissedOverlayStatus: null,
        params: {tripleMagLimit: 3, status: 'identify failed: too few stars'},
        Globals: {loadGeneration: 1}, Sit: {}, D2R: Math.PI / 180, PLANET_LABELS: [],
        ensureCandidateStars: async () => true, videoView: () => ({videoData}),
        ensureIdentifyData: async () => ({catalog: {n: 0}, names: new Map()}),
        GlobalDateTimeNode: {frameToDate: () => new Date('2026-01-01')},
        observerECEF: () => ({clone: () => ({normalize: () => ({})})}),
        ECEFToLLAVD_radii: () => ({x: 0, y: 0}),
        minimumIdentifyObservations, unconfirmedIdentificationStatus,
        pointSourceStats: () => ({}), NodeMan: {get: () => ({camera: {fov: 60}})},
        TRIPLE_DEFAULTS: {maxCandidateStars: 30},
        setStatus: text => { context.params.status = text; }, yieldToBrowser: async () => {},
        initProgress: jest.fn(), updateProgress: jest.fn(), hideProgress: jest.fn(),
        performance: {now: () => 0}, setRenderOne: jest.fn(), startCompletionFade: jest.fn(),
        resetCompletionFade: jest.fn(),
        identifyBrightTriplesOffThread: jest.fn(async () => report),
        assessBrightTripleIdentification: jest.fn(() => ({accepted: true, fit: {rmsPx: 0.2}})),
        classifiedByIndex: (_, index) => classified[index],
        UndoManager: {add: jest.fn()}, applyManualLabels: jest.fn(),
    };
    vm.createContext(context);
    vm.runInContext(source.slice(declaration.start, declaration.end), context);
    return context;
}

test('short noise tracks never reach the fallback or change the camera', async () => {
    const h = harness(9);
    await h.identifyByBrightTriples({auto: true});
    expect(h.identifyBrightTriplesOffThread).not.toHaveBeenCalled();
    expect(h.applyManualLabels).not.toHaveBeenCalled();
    expect(h.UndoManager.add).not.toHaveBeenCalled();
    expect(h.params.status).toContain('after 194 frames (Enough)');
    expect(h.params.status).toContain('0 persistent candidate stars');
    // The circles stay, so the user can right-click and name them.
    expect(h.startCompletionFade).not.toHaveBeenCalled();
});

test('an ambiguous worker result never becomes names, a camera fit or a relocation', async () => {
    const h = harness();
    h.assessBrightTripleIdentification.mockReturnValue({accepted: false, reason: 'multiple patterns fit'});
    await h.identifyByBrightTriples({auto: true});
    expect(h.applyManualLabels).not.toHaveBeenCalled();
    expect(h.UndoManager.add).not.toHaveBeenCalled();
    expect(h.result.manualLabels).toBeUndefined();
    expect(h.result.videoData._templateViewingStatus).toBe('Not set: stars not reliably identified');
    expect(h.params.status).toContain('No reliable star identification');
    expect(h.startCompletionFade).not.toHaveBeenCalled();
});

test('a confirmed fallback applies once, reports success and fades the markers', async () => {
    const h = harness();
    await h.identifyByBrightTriples({auto: true});
    expect(h.applyManualLabels).toHaveBeenCalledTimes(1);
    expect(h.UndoManager.add).toHaveBeenCalledTimes(1);
    expect(h.params.status).toBe('Identified 6 stars with Bright Triples; rms 0.2 px');
    expect(h.resetCompletionFade).toHaveBeenCalledTimes(1);
    expect(h.startCompletionFade).toHaveBeenCalledTimes(1);
});
