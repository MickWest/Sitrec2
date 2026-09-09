/** @jest-environment jsdom */
jest.mock('../src/Globals', () => ({Globals: {sitchDirty: false}, FileManager: {loadURL: 'sitrec://42/current/file.js'}}));
jest.mock('../src/showError', () => ({showConfirm: jest.fn(), showError: jest.fn()}));
jest.mock('../src/release/channelHandoff', () => ({saveChannelHandoff: jest.fn()}));
jest.mock('../src/SitrecObjectResolver', () => ({extractUserIdFromSitrecReference: () => '42'}));
import {approveSitchChannel, addChannelSettings} from '../src/release/ChannelUI';
import {rememberSitchText} from '../src/release/sitchSource';
import {Globals, FileManager} from '../src/Globals';
import {showConfirm} from '../src/showError';
import {saveChannelHandoff} from '../src/release/channelHandoff';

const shipped = {id: 'shipped-test', channel: 'shipped', version: '2.155.2', builtAt: '2026-09-09T00:00:00Z'};
const beta = {...shipped, id: 'beta-test', channel: 'beta', builtAt: '2026-09-09T01:00:00Z'};
const saved = () => ({exportBuild: beta, name: 'shared-file'});
const choose = value => document.querySelector(`[data-channel-choice="${value}"]`).click();

beforeEach(() => {
    jest.clearAllMocks();
    HTMLDialogElement.prototype.showModal = function () { this.open = true; };
    document.body.innerHTML = '';
    Globals.sitchDirty = true;
    window.__SITREC_CHANNEL_STATE__ = {manifest: {format: 1, shipped, beta}, preference: false, userID: 0};
    localStorage.clear();
});

test('Cancel leaves the dirty scene, load reference and handoff untouched', async () => {
    const before = {...FileManager};
    const pending = approveSitchChannel(saved(), {sourceRef: 'sitrec://73/new/file.js'});
    expect(document.querySelector('dialog').textContent).toContain('2.155.2b');
    expect(document.querySelector('dialog').textContent).toContain('UTC');
    choose('cancel');
    expect(await pending).toBe(false);
    expect(FileManager).toEqual(before);
    expect(Globals.sitchDirty).toBe(true);
    expect(saveChannelHandoff).not.toHaveBeenCalled();
});

test('choosing Shipped approves the same file through a second parse without another warning', async () => {
    const raw = 'unique raw file for shipped-choice';
    const pending = approveSitchChannel(rememberSitchText(saved(), raw));
    choose('shipped');
    expect(await pending).toBe(true);
    expect(await approveSitchChannel(rememberSitchText(saved(), raw))).toBe(true);
    expect(document.querySelector('dialog')).toBeNull();
    expect(saveChannelHandoff).not.toHaveBeenCalled();
});

test('declining the unsaved-change prompt also cancels a Beta switch', async () => {
    showConfirm.mockResolvedValue(false);
    const pending = approveSitchChannel(saved());
    choose('beta');
    expect(await pending).toBe(false);
    expect(saveChannelHandoff).not.toHaveBeenCalled();
    expect(Globals.sitchDirty).toBe(true);
});

test('missing Beta disables that choice and still offers Cancel and Shipped', async () => {
    window.__SITREC_CHANNEL_STATE__.manifest.beta = null;
    const pending = approveSitchChannel(saved());
    expect(document.querySelector('[data-channel-choice="beta"]').disabled).toBe(true);
    choose('cancel');
    expect(await pending).toBe(false);
});

test('anonymous explicit opt-in is stored only in this browser', async () => {
    let change;
    const control = {name: () => control, tooltip: () => control, onChange: fn => {change = fn; return control;}};
    const folder = {add: jest.fn(() => control)};
    addChannelSettings(folder);
    expect(folder.add.mock.calls[0][0].betaProgram).toBe(false);
    showConfirm.mockResolvedValue(false);
    await change(true);
    expect(localStorage.getItem('sitrec.betaProgram')).toBe('true');
    expect(window.__SITREC_CHANNEL_STATE__.preference).toBe(true);
});

test('member opt-out writes only the dedicated preference endpoint', async () => {
    window.__SITREC_CHANNEL_STATE__ = {...window.__SITREC_CHANNEL_STATE__, userID: 42,
        preference: true, endpoint: '/sitrec/sitrecServer/channels.php'};
    window.fetch = jest.fn().mockResolvedValue({ok: true});
    let change;
    const control = {name: () => control, tooltip: () => control, onChange: fn => {change = fn; return control;}};
    addChannelSettings({add: () => control});
    showConfirm.mockResolvedValue(false);
    await change(false);
    expect(fetch).toHaveBeenCalledWith('/sitrec/sitrecServer/channels.php', expect.objectContaining({
        method: 'POST', body: JSON.stringify({betaProgram: false})}));
    expect(localStorage.getItem('sitrec.betaProgram')).toBeNull();
});
