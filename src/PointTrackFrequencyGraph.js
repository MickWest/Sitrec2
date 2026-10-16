import {Globals, NodeMan, setRenderOne} from './Globals';
import {ViewMan} from './CViewManager';
import {t} from './i18n';

const VIEW_ID = 'pointTrackFrequencyGraph';
export const FREQUENCY_DEFAULTS = {radius: 4, percent: true, showBackground: true, perMinute: false};
// At 1 px the 1.75–2.5 radius background ring holds at most 14 pixels, fewer
// than measurePointFlux requires, so no frame would ever give a sample.
export const MIN_APERTURE_RADIUS = 2;
export const clampApertureRadius = value => Math.max(MIN_APERTURE_RADIUS, Math.min(100, Number(value) || 4));
let settings = {...FREQUENCY_DEFAULTS};
let wanted = false;
const currentView = () => NodeMan.get(VIEW_ID, false);

export const pointFrequencyTargetColor = (dark = true) => dark ? '#54e2a8' : '#087a51';

export function getPointTrackFrequencyAperture() {
    const view = currentView();
    return view?.visible ? {radius: view.options.radius, color: pointFrequencyTargetColor(view.dark)} : null;
}

export async function showPointTrackFrequencyGraph(show, savedState = null) {
    show = !!show;
    wanted = show;
    let view = currentView();
    if (!view) {
        if (!show) return;
        const generation = Globals.loadGeneration;
        const {createPointTrackFrequencyGraphView} = await import('./pointFrequency/CNodePointTrackFrequencyGraphView');
        if (Globals.loadGeneration !== generation || !wanted) return;
        view = currentView() ?? createPointTrackFrequencyGraphView(VIEW_ID, settings);
    }
    if (savedState) view.modDeserialize(savedState);
    view.show(show);
    if (show && savedState?.fullscreenSuppressed && ViewMan.fullscreenView) ViewMan.fullscreenSuppressed.add(view);
    wanted = false;
    setRenderOne();
}

export function addPointTrackFrequencyMenu(folder) {
    const proxy = {
        get show() { return currentView()?.visible ?? wanted; },
        set show(value) { showPointTrackFrequencyGraph(value); },
        refresh() { currentView()?.refreshAnalysis(); },
        exportCSV() { currentView()?.exportCSV(); },
    };
    folder.add(proxy, 'show').name(t('pointFrequency.menu')).tooltip(t('pointFrequency.tooltip')).listen().perm();
    const controls = folder.addFolder(t('pointFrequency.settings')).close().perm();
    for (const key of Object.keys(FREQUENCY_DEFAULTS)) Object.defineProperty(proxy, key, {
        get() { return (currentView()?.options ?? settings)[key]; },
        set(value) {
            value = key === 'radius' ? clampApertureRadius(value) : !!value;
            settings[key] = value;
            const view = currentView();
            if (view) {
                view.options[key] = value;
                if (key === 'radius') view.refreshAnalysis();
                else view.updateSpectrum();
            }
            setRenderOne();
        },
    });
    controls.add(proxy, 'radius', MIN_APERTURE_RADIUS, 100, 1).name(t('pointFrequency.radius')).tooltip(t('pointFrequency.radiusTooltip')).listen().perm();
    controls.add(proxy, 'percent').name(t('pointFrequency.percent')).listen().perm();
    controls.add(proxy, 'showBackground').name(t('pointFrequency.showBackground')).listen().perm();
    controls.add(proxy, 'refresh').name(t('videoTonal.refresh')).perm();
    controls.add(proxy, 'exportCSV').name(t('videoTonal.exportCSV')).perm();
    controls.add(proxy, 'perMinute').name(t('pointFrequency.perMinute')).tooltip(t('pointFrequency.perMinuteTooltip')).listen().perm();
}

export function serializePointTrackFrequencyGraph() {
    const view = currentView();
    if (!view?.visible) return undefined;
    const state = view.modSerialize();
    state.fullscreenSuppressed = !!ViewMan.fullscreenView && ViewMan.fullscreenSuppressed.has(view);
    delete state.rootTestRemove;
    return state;
}

export function deserializePointTrackFrequencyGraph(state) {
    if (state?.visible) return showPointTrackFrequencyGraph(true, state);
}

export function resetPointTrackFrequencyGraph() {
    wanted = false;
    settings = {...FREQUENCY_DEFAULTS};
}
