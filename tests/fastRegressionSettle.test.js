const {spawnSync} = require('node:child_process');
const {pathToFileURL} = require('node:url');
const path = require('node:path');

test('regression grace renders and restarts when loading resumes, within the timeout', () => {
    const runner = pathToFileURL(path.resolve(__dirname, '../tests_regression/fast-regression/run.mjs')).href;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
        import assert from 'node:assert/strict';
        const {waitForSettle, settleStateFn, renderOneFrame} = await import(${JSON.stringify(runner)});
        let now = 0, renders = 0;
        const originalNow = Date.now;
        Date.now = () => now;
        const state = pending => ({ready:true, pendingActions:pending, frame:10,
            textureNeedsHighRes:0, activeVisibleTextureTiles:1, visibleTileHash:1});
        const page = {
            evaluate: async fn => fn === settleStateFn
                ? state(now >= 200 && now < 600 ? 1 : 0) : void renders++,
            waitForTimeout: async ms => {now += ms;},
        };
        try {
            const result = await waitForSettle(page, {minWaitMs:0, stableChecks:2,
                postSettleMs:1000, maxWaitMs:3000, wantFrame:10});
            assert.equal(result.timedOut, false);
            assert(now >= 1600, 'late loading must restart the grace period');
            assert(renders > 2, 'the grace period must advance rendering');
            now = 0;
            page.evaluate = async fn => fn === settleStateFn ? state(1) : undefined;
            const timeout = await waitForSettle(page, {minWaitMs:0, stableChecks:2,
                postSettleMs:1000, maxWaitMs:300, wantFrame:10});
            assert.equal(timeout.timedOut, true);
            assert(now < 400, 'the grace period must respect the loading deadline');
        } finally {Date.now = originalNow;}
        let wakes = 0;
        globalThis.window = {par:{renderOne:false}, __sitrecWakeRenderLoop:()=>wakes++};
        globalThis.requestAnimationFrame = callback => callback();
        await renderOneFrame({evaluate:fn=>fn()});
        assert.equal(window.par.renderOne, true);
        assert.equal(wakes, 1, 'production captures must wake the render loop');
        globalThis.window = {};
        await assert.rejects(renderOneFrame({evaluate:fn=>fn()}), /cannot request a render/);
    `], {encoding:'utf8'});
    expect({status:result.status, error:result.error?.message,
        stderr:result.status ? result.stderr : ''}).toEqual({status:0, error:undefined, stderr:''});
});
