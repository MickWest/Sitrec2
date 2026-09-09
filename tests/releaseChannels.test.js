import {betaSaveNeedsWarning, buildLabel, cleanBuild, entryFiles, selectBuild, validateManifest} from '../src/release/channelModel';
const {channelBuild} = require('../scripts/channelBuild');

const shipped = {id: 'shipped-example', channel: 'shipped', version: '2.155.2', builtAt: '2026-09-09T00:00:00Z', assetBase: '/sitrec/builds/shipped-example/'};
const beta = {...shipped, id: 'beta-example', channel: 'beta', assetBase: '/sitrec/builds/beta-example/'};
const manifest = {format: 1, shipped, beta};
const base = 'https://app.example.test/sitrec/';

describe('release channel selection', () => {
    test('explicit selection overrides account preference without changing it', () => {
        expect(selectBuild(manifest, true).id).toBe(beta.id);
        expect(selectBuild(manifest, false).id).toBe(shipped.id);
        expect(selectBuild(manifest, true, 'shipped').id).toBe(shipped.id);
        expect(selectBuild(manifest, false, 'beta').id).toBe(beta.id);
        expect(selectBuild({...manifest, beta: null}, true).id).toBe(shipped.id);
    });
    test('kill switch excludes beta and keeps shipped available', () => {
        const result = validateManifest({...manifest, betaEnabled: false}, base);
        expect(result.beta).toBeNull();
        expect(selectBuild(result, true).id).toBe(shipped.id);
    });
    test.each(['https://evil.example/app/', '//evil.example/', '/sitrec/builds/other/',
        '/sitrec/builds/beta-example/../../', 'javascript:alert(1)'])('refuses script routing outside the exact build prefix: %s', assetBase => {
        expect(() => validateManifest({...manifest, beta: {...beta, assetBase}}, base)).toThrow();
    });
    test.each(['../x', 'x/y', 'x?query=1', '<script>', 'a'.repeat(97)])('refuses unsafe build ID %s', id => {
        expect(cleanBuild({...beta, id})).toBeNull();
    });
    test('discarding unknown metadata prevents it becoming a URL or trusted setting', () => {
        expect(cleanBuild({...beta, redirect: 'https://evil.example/', trusted: true})).not.toHaveProperty('redirect');
    });
    test('legacy and shipped files need no beta warning', () => {
        expect(betaSaveNeedsWarning({}, shipped, manifest)).toBe(false);
        expect(betaSaveNeedsWarning({exportBuild: shipped}, shipped, manifest)).toBe(false);
    });
    test('warns for an uncovered beta; full ship coverage removes the warning', () => {
        const file = {exportBuild: beta};
        expect(betaSaveNeedsWarning(file, shipped, manifest)).toBe(true);
        expect(betaSaveNeedsWarning(file, beta, manifest)).toBe(false);
        expect(betaSaveNeedsWarning(file, shipped, {...manifest,
            shipped: {...shipped, coveredBetaIds: [beta.id]}})).toBe(false);
        expect(betaSaveNeedsWarning(file, {...shipped, version: '99.0.0'}, manifest)).toBe(true);
    });
    test('beta display suffix never enters the numeric migration version', () => {
        const info = channelBuild('2.155.3', {SITREC_BUILD_CHANNEL: 'beta', SITREC_BUILD_TIME: beta.builtAt, SITREC_SOURCE_HASH: 'example'});
        expect(info.version).toBe('2.155.3');
        expect(buildLabel(info)).toContain('2.155.3b');
        expect(buildLabel(info)).toContain('UTC');
        expect(() => channelBuild('2.155.3b', {})).toThrow();
    });
    test('entry manifests cannot inject remote scripts or path traversal', () => {
        expect(entryFiles({scripts: ['index.abc.bundle.js'], styles: ['index.css']})).toEqual({scripts: ['index.abc.bundle.js'], styles: ['index.css']});
        for (const name of ['https://evil.example/x.js', '../x.js', '/x.js', 'x.js?bad', 'x//y.js']) {
            expect(() => entryFiles({scripts: [name], styles: []})).toThrow();
        }
    });
});
