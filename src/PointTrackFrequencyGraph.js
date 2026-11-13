import {Globals, NodeMan, setRenderOne, Sit} from './Globals';
import {ViewMan} from './CViewManager';
import {t} from './i18n';
import {findPointTrack, pointTracks} from './PointTrackRegistry';

const VIEW_ID = 'pointTrackFrequencyGraph';
// minPeakHz is the peak-search floor in Hz (0 = off), also when flashes per
// minute are shown. 0.5 Hz (30 a minute) is below the slowest aircraft
// anti-collision beacon (40 a minute). A floor above a flash rate does not just
// hide that rate: a short flash has strong harmonics, and one of them gets the label.
export const FREQUENCY_DEFAULTS = {radius: 4, percent: true, showBackground: true, perMinute: false, minPeakHz: 0.5};
// At 1 px the 1.75–2.5 radius background ring holds at most 14 pixels, fewer
// than measurePointFlux requires, so no frame would ever give a sample.
export const MIN_APERTURE_RADIUS = 2;
export const clampApertureRadius = value => Math.max(MIN_APERTURE_RADIUS, Math.min(100, Number(value) || 4));
export const MAX_PEAK_FLOOR_HZ = 30;
export const clampPeakFloor = value => {
    const hz = value === null || value === '' ? NaN : Number(value);
    return Number.isNaN(hz) ? FREQUENCY_DEFAULTS.minPeakHz : Math.max(0, Math.min(MAX_PEAK_FLOOR_HZ, hz));
};
const sanitizeOption = (key, value) => key === 'radius' ? clampApertureRadius(value)
    : key === 'minPeakHz' ? clampPeakFloor(value) : !!value;
let sharedSettings = {...FREQUENCY_DEFAULTS};
const graphIds = new Set();
let showAll = false;
export const clampFrequencyRadiusOverride = value => Number(value) > 0 ? clampApertureRadius(value) : 0;
const wanted = new Map();
const activeId = () => findPointTrack()?.trackId ?? 'track1';
const viewId = id => id === 'track1' ? VIEW_ID : `${VIEW_ID}_${id}`;
function settingsFor(id = activeId()) {
    return {...sharedSettings, radius: clampFrequencyRadiusOverride(findPointTrack(id)?.frequencyRadius) || sharedSettings.radius};
}
function frequencyViews() {
    const ids = new Set([...graphIds, ...pointTracks.map(track => track.trackId), activeId()]);
    return [...new Set([...ids].map(id => currentView(id)).filter(Boolean))];
}
function applyViewSettings(view, id) {
    const options = settingsFor(id);
    const radiusChanged = view.options?.radius !== options.radius;
    const changed = Object.keys(options).some(key => view.options?.[key] !== options[key]);
    view.options = options;
    if (radiusChanged) view.refreshAnalysis();
    else if (changed) view.updateSpectrum();
}
export function setPointTrackFrequencyRadius(id, value) {
    const track = findPointTrack(id);
    if (!track) return;
    track.frequencyRadius = clampFrequencyRadiusOverride(value);
    const view = currentView(id);
    if (view) applyViewSettings(view, id);
    setRenderOne();
}
export function showNewPointTrackFrequencyGraph(id) {
    if (showAll) return showPointTrackFrequencyGraph(true, null, id);
}
// Each view supplies its own required range, including warning space. Reading
// those ranges instead of the already shared maxY prevents scale feedback.
export function sharedPointTrackFrequencyMaxY(view) {
    let maximum = view.requiredMaxY();
    for (const other of frequencyViews()) {
        if (other !== view && other.visible) maximum = Math.max(maximum, other.requiredMaxY());
    }
    return maximum;
}
// Render Widening Video: In/Out go from In 1/Out 1 to In 2/Out 2, and back
// if pingPong is on. A frame is null until the user sets it. Until then
// In 2/Out 2 show the In/Out region, and In 1/Out 1 show its middle quarter
// (at least 16 frames, the fewest that give a spectrum).
const WIDENING_KEYS = ['in1', 'in2', 'out1', 'out2'];
const WIDENING_DEFAULTS = {in1: null, in2: null, out1: null, out2: null, pingPong: false};
let widening = {...WIDENING_DEFAULTS};
function wideningFrame(key) {
    if (widening[key] !== null) return widening[key];
    const last = Math.max(0, (Sit?.frames ?? 1) - 1);
    const a = Sit?.aFrame ?? 0, b = Sit?.bFrame ?? last;
    if (key === 'in2') return a;
    if (key === 'out2') return b;
    const half = Math.max(8, Math.round((b - a + 1) / 8)), middle = Math.round((a + b) / 2);
    return key === 'in1' ? Math.max(a, middle - half) : Math.min(b, middle + half - 1);
}
async function renderWidening() {
    // The values that show now are the ones to use, also the ones never set.
    for (const key of WIDENING_KEYS) widening[key] = wideningFrame(key);
    const {renderWideningVideo} = await import('./pointFrequency/WideningVideo');
    await renderWideningVideo({...widening});
}
export const getPointTrackFrequencyView = (id = activeId()) => NodeMan.get(viewId(id), false);
const currentView = getPointTrackFrequencyView;

export const pointFrequencyTargetColor = (dark = true) => dark ? '#54e2a8' : '#087a51';

export function getPointTrackFrequencyAperture(id) {
    const view = currentView(id);
    return view?.visible ? {radius: view.options.radius, color: pointFrequencyTargetColor(view.dark)} : null;
}

export async function showPointTrackFrequencyGraph(show, savedState = null, id = activeId()) {
    show = !!show;
    wanted.set(id, show);
    if (show) graphIds.add(id);
    let view = currentView(id);
    if (!view) {
        if (!show) return;
        const generation = Globals.loadGeneration;
        const {createPointTrackFrequencyGraphView} = await import('./pointFrequency/CNodePointTrackFrequencyGraphView');
        if (Globals.loadGeneration !== generation || !wanted.get(id)) return;
        view = currentView(id) ?? createPointTrackFrequencyGraphView(viewId(id), settingsFor(id), id);
    }
    if (savedState) view.modDeserialize({...savedState, frequencyOptions: settingsFor(id)});
    applyViewSettings(view, id);
    view.show(show);
    if (show && savedState?.fullscreenSuppressed && ViewMan.fullscreenView) ViewMan.fullscreenSuppressed.add(view);
    wanted.delete(id);
    setRenderOne();
}

export function arrangePointTrackFrequencyGraphs() {
    const views = pointTracks.map(track => currentView(track.trackId)).filter(view => view?.visible);
    const columns = Math.min(3, views.length), rows = Math.ceil(views.length / columns);
    views.forEach((view, i) => {
        Object.assign(view, {left: i % columns / columns, top: .5 + Math.floor(i / columns) * .48 / rows,
            width: 1 / columns, height: .48 / rows});
        view.updateWH();
    });
    setRenderOne();
}

export function addPointTrackFrequencyMenu(folder) {
    const proxy = {
        get show() { return frequencyViews().some(view => view.visible) || [...wanted.values()].some(Boolean); },
        set show(value) {
            showAll = !!value;
            const ids = new Set([...graphIds, ...pointTracks.map(track => track.trackId)]);
            if (!ids.size) ids.add(activeId());
            for (const id of ids) showPointTrackFrequencyGraph(showAll, null, id);
        },
        refresh() { for (const view of frequencyViews()) view.refreshAnalysis(); },
        exportCSV() { currentView()?.exportCSV(); },
        arrange: arrangePointTrackFrequencyGraphs,
    };
    folder.add(proxy, 'show').name(t('pointFrequency.menu')).tooltip(t('pointFrequency.tooltip')).listen().perm();
    folder.add(proxy, 'arrange').name('Arrange Frequency Graphs')
        .tooltip('Place the visible point-track graphs side by side below the video.').perm();
    const controls = folder.addFolder(t('pointFrequency.settings')).close().perm()
        .tooltip(t('pointFrequency.settingsTooltip'));
    for (const key of Object.keys(FREQUENCY_DEFAULTS)) Object.defineProperty(proxy, key, {
        get() { return sharedSettings[key]; },
        set(value) {
            value = sanitizeOption(key, value);
            sharedSettings[key] = value;
            for (const view of frequencyViews()) applyViewSettings(view, view.trackId ?? activeId());
            setRenderOne();
        },
    });
    controls.add(proxy, 'radius', MIN_APERTURE_RADIUS, 100, 1).name(t('pointFrequency.radius')).tooltip(t('pointFrequency.radiusTooltip')).listen().perm();
    controls.add(proxy, 'percent').name(t('pointFrequency.percent')).tooltip(t('pointFrequency.percentTooltip')).listen().perm();
    controls.add(proxy, 'showBackground').name(t('pointFrequency.showBackground')).tooltip(t('pointFrequency.showBackgroundTooltip')).listen().perm();
    controls.add(proxy, 'minPeakHz', 0, MAX_PEAK_FLOOR_HZ, .1).name(t('pointFrequency.minPeakHz')).tooltip(t('pointFrequency.minPeakHzTooltip')).listen().perm();
    controls.add(proxy, 'refresh').name(t('videoTonal.refresh')).tooltip(t('pointFrequency.refreshTooltip')).perm();
    controls.add(proxy, 'exportCSV').name(t('videoTonal.exportCSV')).tooltip(t('pointFrequency.exportTooltip')).perm();
    controls.add(proxy, 'perMinute').name(t('pointFrequency.perMinute')).tooltip(t('pointFrequency.perMinuteTooltip')).listen().perm();
    for (const key of WIDENING_KEYS) {
        Object.defineProperty(proxy, key, {
            get() { return wideningFrame(key); },
            set(value) { widening[key] = Math.max(0, Math.round(Number(value) || 0)); },
        });
        controls.add(proxy, key, 0, 9999999, 1).noSlider().name(t(`pointFrequency.widening.${key}`))
            .tooltip(t(`pointFrequency.widening.${key}Tooltip`)).listen().perm();
    }
    Object.defineProperty(proxy, 'pingPong', {
        get() { return widening.pingPong; },
        set(value) { widening.pingPong = !!value; },
    });
    controls.add(proxy, 'pingPong').name(t('pointFrequency.widening.pingPong'))
        .tooltip(t('pointFrequency.widening.pingPongTooltip')).listen().perm();
    proxy.renderWidening = renderWidening;
    controls.add(proxy, 'renderWidening').name(t('pointFrequency.widening.render')).tooltip(t('pointFrequency.widening.renderTooltip')).perm();
}

export function serializePointTrackFrequencyGraph() {
    const tracks = {};
    const ids = new Set([...graphIds, ...pointTracks.map(track => track.trackId)]);
    for (const id of ids) {
        const view = currentView(id);
        const state = view?.modSerialize() ?? {visible: false};
        // Settings are common; effective radii are derived from each track's override.
        delete state.frequencyOptions;
        state.fullscreenSuppressed = !!ViewMan.fullscreenView && ViewMan.fullscreenSuppressed.has(view);
        delete state.rootTestRemove;
        tracks[id] = state;
    }
    return {version: 3, settings: {...sharedSettings}, showAll, tracks, widening: {...widening}};
}

export async function deserializePointTrackFrequencyGraph(state) {
    if (!state) return;
    if (state.widening) widening = {...WIDENING_DEFAULTS, ...state.widening};
    const tracks = state.tracks ?? {track1: state};
    // Older saves had settings per graph. Use the selected graph's settings as
    // the common values, keeping different apertures as explicit track overrides.
    const legacy = tracks[activeId()] ?? Object.values(tracks)[0];
    const options = state.settings ?? legacy?.frequencyOptions ?? {};
    for (const key of Object.keys(FREQUENCY_DEFAULTS)) {
        sharedSettings[key] = sanitizeOption(key, options[key] ?? FREQUENCY_DEFAULTS[key]);
    }
    showAll = state.showAll ?? Object.values(tracks).every(saved => saved.visible);
    for (const [id, saved] of Object.entries(tracks)) {
        const track = findPointTrack(id);
        if (!track) continue;
        graphIds.add(id);
        if (!state.settings && saved.frequencyOptions?.radius !== undefined) {
            const radius = clampApertureRadius(saved.frequencyOptions.radius);
            if (radius !== sharedSettings.radius) track.frequencyRadius = radius;
        }
        if (!saved.visible && saved.left === undefined) continue;
        await showPointTrackFrequencyGraph(true, saved, id);
        if (!saved.visible) await showPointTrackFrequencyGraph(false, null, id);
    }
    // A shared setting also applies to windows that existed before restoration.
    for (const view of frequencyViews()) applyViewSettings(view, view.trackId ?? activeId());
}

export function removePointTrackFrequencyGraph(id) {
    wanted.delete(id);
    graphIds.delete(id);
    const view = currentView(id);
    if (view) NodeMan.disposeRemove(view.id);
}

export function resetPointTrackFrequencyGraph() {
    wanted.clear();
    graphIds.clear();
    sharedSettings = {...FREQUENCY_DEFAULTS};
    showAll = false;
    widening = {...WIDENING_DEFAULTS};
}
