import {Globals, NodeMan, setRenderOne} from './Globals';
import {ViewMan} from './CViewManager';
import {t} from './i18n';

const VIEW_ID = 'videoTonalGraph';
export const TONAL_DEFAULTS = {mode: 'percentiles', showMean: false, showExtremes: false,
    targetAnalysis: false, targetRadius: 6};
let settings = {...TONAL_DEFAULTS};
let wanted = false;
const currentView = () => NodeMan.get(VIEW_ID, false);

export async function showVideoTonalGraph(show, savedState = null) {
    wanted = show;
    let view = currentView();
    if (!view) {
        if (!show) return;
        const generation = Globals.loadGeneration;
        const {createVideoTonalGraphView} = await import('./videoTonal/CNodeVideoTonalGraphView');
        if (Globals.loadGeneration !== generation || !wanted) return;
        view = currentView() ?? createVideoTonalGraphView(VIEW_ID, settings);
    }
    if (savedState) view.modDeserialize(savedState);
    view.show(show);
    if (show && savedState?.fullscreenSuppressed && ViewMan.fullscreenView) ViewMan.fullscreenSuppressed.add(view);
    wanted = false;
    setRenderOne();
}

export function addVideoTonalGraphMenu(folder) {
    const proxy = {
        get show() { return currentView()?.visible ?? wanted; },
        set show(value) { showVideoTonalGraph(value); },
        refresh() { currentView()?.refreshAnalysis(); },
        exportCSV() { currentView()?.exportCSV(); },
    };
    folder.add(proxy, 'show').name(t('videoTonal.menu')).tooltip(t('videoTonal.tooltip')).listen().perm();
    const controls = folder.addFolder(t('videoTonal.settings')).close().perm();
    for (const key of Object.keys(TONAL_DEFAULTS)) {
        Object.defineProperty(proxy, key, {
            get() { return (currentView()?.options ?? settings)[key]; },
            set(value) {
                settings[key] = value;
                const view = currentView();
                if (view) {
                    view.options[key] = value;
                    if (key === 'targetAnalysis' || key === 'targetRadius') view.refreshAnalysis();
                    view.invalidatePlot();
                }
                setRenderOne();
            },
        });
    }
    controls.add(proxy, 'mode', {
        [t('videoTonal.percentiles')]: 'percentiles', [t('videoTonal.histogram')]: 'histogram',
        [t('videoTonal.contrast')]: 'contrast', [t('videoTonal.relativeContrast')]: 'relativeContrast',
    }).name(t('videoTonal.display')).listen().perm();
    for (const key of ['showMean', 'showExtremes', 'targetAnalysis']) {
        controls.add(proxy, key).name(t(`videoTonal.${key}`)).listen().perm();
    }
    controls.add(proxy, 'targetRadius', 1, 100, 1).name(t('videoTonal.targetRadius'))
        .tooltip(t('videoTonal.targetTooltip')).listen().perm();
    controls.add(proxy, 'refresh').name(t('videoTonal.refresh')).perm();
    controls.add(proxy, 'exportCSV').name(t('videoTonal.exportCSV')).perm();
}

export function serializeVideoTonalGraph() {
    const view = currentView();
    if (!view?.visible) return undefined;
    const state = view.modSerialize();
    state.fullscreenSuppressed = !!ViewMan.fullscreenView && ViewMan.fullscreenSuppressed.has(view);
    delete state.rootTestRemove;
    return state;
}

export function deserializeVideoTonalGraph(state) {
    if (state?.visible) return showVideoTonalGraph(true, state);
}

export function resetVideoTonalGraph() {
    wanted = false;
    settings = {...TONAL_DEFAULTS};
}
