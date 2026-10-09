import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function harness({throws = false} = {}) {
    const events = [];
    let rotation = 0;
    const rect = {left: 0, top: 0, width: 480, height: 480};
    const canvas = () => ({width: 480, height: 480, style: {},
        getBoundingClientRect: () => rect,
        getContext: () => ({fillRect() {}, drawImage() {}}),
        toDataURL: () => 'data:image/jpeg;base64,capture'});
    const view = {id: 'lookView', camera: {}, renderer: {}, canvas: canvas(),
        leftPx: 0, topPx: 0, widthPx: 480, heightPx: 480, _effectivelyVisible: true,
        renderCanvas(frame) {
            events.push(['draw', frame, rotation]);
            if (throws) throw new Error('draw failed');
        }};
    const overlay = {id: 'hud', canvas: canvas(), overlayView: view,
        leftPx: 0, topPx: 0, widthPx: 480, heightPx: 480, _effectivelyVisible: true,
        renderCanvas(frame) { events.push(['hud', frame, rotation]); }};
    const node = {preRender(v) {events.push(['pre', v.id]); rotation = 30;},
        postRender(v) {events.push(['post', v.id]); rotation = 0;}};
    const window = {location: {pathname: '/flir1/'}, par: {frame: 904},
        NodeMan: {get: () => view, getPreRenderNodes: () => [node], getPostRenderNodes: () => [node]},
        ViewMan: {widthPx: 480, heightPx: 480, topPx: 0,
            computeEffectiveVisibility() {}, iterate(fn) {fn(view.id, view); fn(overlay.id, overlay);}}};
    const source = fs.readFileSync(new URL('../extension/page-bridge.js', import.meta.url), 'utf8')
        .split('// ── Message Listener')[0];
    const context = vm.createContext({window, document: {createElement: canvas}});
    vm.runInContext(source + '\nglobalThis.capture = handlers.sitrec_screenshot;', context);
    return {capture: context.capture, events, rotation: () => rotation};
}

for (const view of ['look', undefined]) {
    test(`${view ?? 'composite'} capture applies rotations during draw and restores before HUD`, () => {
        const h = harness();
        assert.equal(h.capture({view}).imageData, 'capture');
        assert.deepEqual(h.events, [['pre', 'lookView'], ['draw', 904, 30], ['post', 'lookView'], ['hud', 904, 0]]);
        assert.equal(h.rotation(), 0);
    });
    test(`${view ?? 'composite'} capture restores transforms after a draw error`, () => {
        const h = harness({throws: true});
        assert.match(h.capture({view}).error, /draw failed/);
        assert.deepEqual(h.events, [['pre', 'lookView'], ['draw', 904, 30], ['post', 'lookView']]);
        assert.equal(h.rotation(), 0);
    });
}
