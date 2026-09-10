import {cleanBuild, entryFiles, selectBuild, validateManifest} from './channelModel';

const appBase = new URL('./', window.location.href).href;
const scriptBase = new URL('./', document.currentScript?.src || appBase).href;
const params = new URLSearchParams(window.location.search);
// The only proof that someone chose Beta for THIS load. A member's saved preference
// defaults to Beta without any choice, so it earns no messages: channel handling is
// silent for everyone who did not explicitly ask for Beta — they simply get the latest.
const explicitBeta = params.get('channel') === 'beta';
const bootstrapBuild = cleanBuild(process.env.SITREC_BUILD_INFO);
const enabled = process.env.IS_SERVERLESS_BUILD !== 'true' &&
    process.env.IS_SECURE_BUILD !== 'true' &&
    String(window.__SITREC_ENV__?.SITREC_CHANNELS_ENABLED ?? process.env.SITREC_CHANNELS_ENABLED) === 'true';

function browserPreference() {
    try { return localStorage.getItem('sitrec.betaProgram') === 'true'; } catch { return false; }
}

async function json(url) {
    const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000)});
    if (!response.ok) throw new Error(`Startup request failed: HTTP ${response.status}`);
    return response.json();
}

// One dismissable dialog, fixed over the page so nothing in normal flow moves. Sitrec's
// own dialogs do not exist yet at this point, so it is built by hand. 2.157.1 appended
// a plain paragraph here instead; it sat above the application, black on black, and
// pushed every view down 63px. Startup can raise several notices in a row (a failed
// Beta, then a failed fallback), so they share one box and one OK rather than stacking
// identical dialogs on top of each other. `extra`, when given, is appended to the line.
// Callers gate channel messages on `explicitBeta`; only a total startup failure speaks
// to everyone, and then without naming a channel.
let dialog = null;
let messages = null;
function notice(message, extra) {
    if (!dialog || !dialog.isConnected) {
        dialog = document.createElement('div');
        dialog.setAttribute('role', 'dialog');
        dialog.setAttribute('aria-live', 'polite');
        dialog.style.cssText = 'position:fixed;top:48px;left:50%;transform:translateX(-50%);z-index:100000;' +
            'max-width:32rem;padding:12px 16px;display:flex;gap:16px;align-items:center;' +
            'background:#1e1e1e;color:#eee;border:1px solid #666;border-radius:6px;' +
            'font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.6);';
        messages = document.createElement('div');
        messages.style.cssText = 'display:flex;flex-direction:column;gap:6px;';
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = 'OK';
        button.style.cssText = 'padding:4px 14px;font:inherit;cursor:pointer;';
        button.addEventListener('click', () => dialog.remove());
        dialog.append(messages, button);
        document.body.append(dialog);
    }
    // The fallback loop can fail two builds in a row with the same message; say it once.
    if (!extra && messages.lastElementChild?.textContent === message) return dialog;
    const line = document.createElement('div');
    line.textContent = message;
    if (extra) line.append(extra);
    messages.append(line);
    return dialog;
}

async function start() {
    let assetBase = scriptBase;
    let state = null;
    if (enabled) {
        try {
            const endpoint = new URL('sitrecServer/channels.php', appBase);
            if (params.has('testUserID')) endpoint.searchParams.set('testUserID', params.get('testUserID'));
            const response = await json(endpoint.href);
            if (response.enabled) {
                const manifest = validateManifest(response.manifest, appBase);
                const preference = response.userID > 0 ? response.betaProgram === true : browserPreference();
                const selected = selectBuild(manifest, preference, params.get('channel'));
                state = {manifest, selected, preference, userID: response.userID, appBase,
                    endpoint: endpoint.href, preferenceAvailable: response.preferenceAvailable !== false};
                assetBase = selected.assetBase;
                if (!state.preferenceAvailable) console.warn('Beta preference unavailable; opening Shipped unless explicitly selected.');
                if (explicitBeta && !manifest.beta) notice('Beta is unavailable. Opening Shipped.');
            }
        } catch (error) {
            console.warn('Channel selection unavailable; opening Shipped.', error);
            if (explicitBeta) notice('Channel selection is unavailable. Opening Shipped.');
        }
    }
    let entry;
    const choices = [{base: assetBase, build: state?.selected || bootstrapBuild}];
    if (state?.selected.channel === 'beta') choices.push({base: state.manifest.shipped.assetBase, build: state.manifest.shipped});
    if (assetBase !== scriptBase) choices.push({base: scriptBase, build: bootstrapBuild});
    for (let i = 0; i < choices.length; i++) {
        const choice = choices[i];
        try {
            const candidate = await json(new URL('app-entry.json', choice.base).href);
            const build = cleanBuild(candidate.build);
            if (!build || (choice.build ? build.id !== choice.build.id : build.channel !== 'shipped')) {
                throw new Error('Application build identity does not match the selected channel.');
            }
            entry = entryFiles(candidate);
            assetBase = choice.base;
            if (state) state.selected = {...build, assetBase};
            break;
        } catch (error) {
            if (i === choices.length - 1) throw error;
            console.warn('Selected build could not be loaded; trying the next.', error);
            if (explicitBeta) notice('The selected build could not be loaded. Opening Shipped.');
        }
    }
    window.__SITREC_CHANNEL_STATE__ = state;
    window.__SITREC_ASSET_BASE__ = assetBase;
    window.__SITREC_APP_BASE__ = appBase;
    for (const name of entry.styles) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = new URL(name, assetBase).href;
        document.head.append(link);
    }
    for (const name of entry.scripts) {
        await new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = new URL(name, assetBase).href;
            script.onload = resolve;
            script.onerror = () => reject(new Error('The application script could not be loaded.'));
            document.head.append(script);
        });
    }
}

start().catch(error => {
    console.error('Sitrec startup failed:', error);
    // Everyone hears that startup failed; only someone who asked for Beta is offered the
    // other channel, and the link lives inside the dialog beside the words that name it.
    if (!explicitBeta) {
        notice('Sitrec could not start. Your saved files are unchanged. Reload the page.');
        return;
    }
    const link = document.createElement('a');
    const url = new URL(window.location.href);
    url.searchParams.set('channel', 'shipped');
    link.href = url.href;
    link.textContent = 'open Shipped';
    link.style.color = '#9cf';
    notice('Sitrec could not start. Your saved files are unchanged. Reload, or ', link);
});
