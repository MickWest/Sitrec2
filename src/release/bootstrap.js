import {betaSuperseded, cleanBuild, entryFiles, selectBuild, validateManifest} from './channelModel';

const appBase = new URL('./', window.location.href).href;
const scriptBase = new URL('./', document.currentScript?.src || appBase).href;
const params = new URLSearchParams(window.location.search);
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

function notice(message) {
    const element = document.createElement('p');
    element.setAttribute('role', 'status');
    element.textContent = message;
    document.body.append(element);
    return element;
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
                if (!state.preferenceAvailable) notice('Your Beta preference is unavailable. Opening Shipped unless explicitly selected.');
                if ((preference || params.get('channel') === 'beta') && !manifest.beta) {
                    notice('Beta is unavailable. Opening Shipped.');
                }
                const override = params.get('channel');
                if (preference && override !== 'beta' && override !== 'shipped' && betaSuperseded(manifest)) {
                    notice(`Shipped ${manifest.shipped.version} is newer than Beta ${manifest.beta.version}b. Opening Shipped.`);
                }
            }
        } catch (error) {
            console.warn('Channel selection unavailable; opening Shipped.', error);
            notice('Channel selection is unavailable. Opening Shipped.');
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
            notice('The selected build could not be loaded. Opening Shipped.');
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
    notice('Sitrec could not start. Reload, or open Shipped below. Your saved files are unchanged.');
    const link = document.createElement('a');
    const url = new URL(window.location.href);
    url.searchParams.set('channel', 'shipped');
    link.href = url.href;
    link.textContent = 'Open Shipped';
    document.body.append(link);
});
