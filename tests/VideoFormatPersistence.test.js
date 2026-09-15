/** @jest-environment jsdom */
import {Globals, guiMenus} from "../src/Globals";
import {
    deserializeVideoFormatEffects, disposeVideoFormatLayer, getVideoFormatLayerSettings,
    serializeVideoFormatEffects, setupVideoFormatEffectsMenu,
} from "../src/videoFilters/VideoFormatLayer";

jest.mock('../src/VideoExporter', () => ({getCanvasDisplayRect: jest.fn()}));

beforeEach(() => {
    localStorage.clear();
    deserializeVideoFormatEffects();
});

test('enabled flag and every tuning section survive a detached JSON round trip', () => {
    deserializeVideoFormatEffects({enabled: true,
        signal: {format: 'rs170', jitter: .23, headSwitch: .16, interlace: 1},
        screen: {enabled: true, preset: 'tripod', zoom: .86, exposureBias: .86, hfov: 42},
        encoding: {bitrateMbps: 12}});
    const current = getVideoFormatLayerSettings();
    const sectionRefs = [current.signal, current.screen, current.encoding];
    const saved = serializeVideoFormatEffects();
    current.signal.jitter = 1.4;
    current.screen.zoom = 2;
    current.enabled = false;
    expect(saved.signal.jitter).toBe(.23);
    deserializeVideoFormatEffects(JSON.parse(JSON.stringify(saved)));
    expect(serializeVideoFormatEffects()).toEqual(saved);
    expect(getVideoFormatLayerSettings()).toBe(current);
    expect(current.signal).toBe(sectionRefs[0]);
    expect(current.screen).toBe(sectionRefs[1]);
    expect(current.encoding).toBe(sectionRefs[2]);
    saved.enabled = false;
    deserializeVideoFormatEffects(saved);
    expect(serializeVideoFormatEffects()).toEqual(saved);
});

test('new/old sitches do not inherit the previous enabled flag or its unsaved tuning', () => {
    deserializeVideoFormatEffects({enabled: true, signal: {format: 'rs170', jitter: 1.2}});
    disposeVideoFormatLayer();
    expect(getVideoFormatLayerSettings().enabled).toBe(false);
    deserializeVideoFormatEffects();
    expect(getVideoFormatLayerSettings().enabled).toBe(false);
    expect(getVideoFormatLayerSettings().signal.format).toBe('digital');
});

test('partial saves fill format defaults and missing enabled remains off', () => {
    deserializeVideoFormatEffects({signal: {format: 'rs170'}});
    expect(getVideoFormatLayerSettings().signal.lumaMHz).toBe(4.5);
    expect(getVideoFormatLayerSettings().enabled).toBe(false);
});

test('restore refreshes all permanent controllers and editing marks the sitch dirty', () => {
    const all = [];
    const folder = {
        add(object, property) {
            const c = {object, property, updateDisplay: jest.fn(),
                perm() {return this;}, name() {return this;}, tooltip() {return this;},
                onChange(fn) {this.change = fn; return this;}};
            all.push(c);
            return c;
        },
        addFolder() {return this;}, close() {return this;}, perm() {return this;},
    };
    guiMenus.videoFormat = folder;
    setupVideoFormatEffectsMenu();
    Globals.deserializing = Globals.disposing = Globals.sitchDirty = false;
    const enabled = all[0];
    enabled.object.enabled = true;
    enabled.change();
    expect(Globals.sitchDirty).toBe(true);
    const saved = serializeVideoFormatEffects();
    Globals.sitchDirty = false;
    deserializeVideoFormatEffects({...saved, enabled: false});
    expect(enabled.object.enabled).toBe(false);
    for (const c of all) expect(c.updateDisplay).toHaveBeenCalled();
    expect(Globals.sitchDirty).toBe(false);
    delete guiMenus.videoFormat;
});
