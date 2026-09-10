import {Globals, FileManager} from '../Globals';
import {isLocal} from '../configUtils';
import {showConfirm, showError} from '../showError';
import {betaSaveNeedsWarning, buildLabel, cleanBuild} from './channelModel';
import {saveChannelHandoff} from './channelHandoff';
import {extractUserIdFromSitrecReference} from '../SitrecObjectResolver';
import {getSitchText} from './sitchSource';

export const currentBuild = cleanBuild(process.env.SITREC_BUILD_INFO);
const approved = new WeakSet();
let approvedText;

export function chooseChannelDialog(message, choices) {
    return new Promise(resolve => {
        const dialog = document.createElement('dialog');
        dialog.setAttribute('aria-label', 'Sitrec version');
        Object.assign(dialog.style, {maxWidth: '560px', color: '#eee', background: '#252525',
            border: '1px solid #777', borderRadius: '8px', padding: '24px', zIndex: '2147483647'});
        const text = document.createElement('p');
        text.style.whiteSpace = 'pre-line';
        text.textContent = message;
        dialog.append(text);
        let finished = false;
        const finish = choice => {
            if (finished) return;
            finished = true;
            dialog.remove();
            resolve(choice);
        };
        for (const choice of choices) {
            const button = document.createElement('button');
            button.textContent = choice.label;
            button.disabled = choice.disabled === true;
            button.dataset.channelChoice = choice.value;
            Object.assign(button.style, {margin: '4px', padding: '8px', whiteSpace: 'pre-line'});
            button.addEventListener('click', () => finish(choice.value));
            dialog.append(button);
        }
        dialog.addEventListener('cancel', event => { event.preventDefault(); finish('cancel'); });
        document.body.append(dialog);
        dialog.showModal();
    });
}

export async function approveSitchChannel(sitch, context = {}) {
    if (isLocal) return true;
    if (!sitch || typeof sitch !== 'object' || approved.has(sitch) ||
        (approvedText !== undefined && getSitchText(sitch) === approvedText)) return true;
    const state = window.__SITREC_CHANNEL_STATE__;
    if (!betaSaveNeedsWarning(sitch, currentBuild, state?.manifest)) return true;
    const beta = state?.manifest.beta;
    const shipped = state?.manifest.shipped || currentBuild;
    const choice = await chooseChannelDialog(
        `This sitch was saved with ${buildLabel(sitch.exportBuild)}.\n\n` +
        `You are using ${buildLabel(currentBuild)}.\n\n` +
        'It will probably work in Shipped, but newer features may look or behave differently.', [
            {value: 'beta', label: beta ? `Open in ${buildLabel(beta)}` : 'Beta unavailable', disabled: !beta},
            {value: 'cancel', label: 'Cancel'},
            {value: 'shipped', label: `Open in ${buildLabel(shipped)}`},
        ]);
    if (choice === 'shipped') { approved.add(sitch); approvedText = getSitchText(sitch); return true; }
    if (choice !== 'beta') return false;
    if (Globals.sitchDirty && !await showConfirm('Switching to Beta reloads Sitrec. Discard the unsaved changes in the current sitch?',
        {title: 'Unsaved changes', yesLabel: 'Discard and open Beta', noLabel: 'Cancel'})) return false;
    try {
        const sourceRef = Object.hasOwn(context, 'sourceRef') ? context.sourceRef : (FileManager?.loadURL ?? null);
        await saveChannelHandoff(sitch, {sourceRef, localFileHandle: context.localFileHandle,
            localDirectoryHandle: context.localDirectoryHandle,
            sourceUserID: sourceRef ? extractUserIdFromSitrecReference(sourceRef) : null});
        const url = new URL(window.location.href);
        url.searchParams.set('channel', 'beta');
        Globals.allowUnload = true;
        window.location.assign(url.href);
    } catch (error) {
        showError('Could not preserve this sitch locally for the Beta switch. The current sitch is still open.', error);
    }
    return false;
}

export function addChannelSettings(folder) {
    const state = window.__SITREC_CHANNEL_STATE__;
    if (!state) return;
    const settings = {betaProgram: state.preference};
    const control = folder.add(settings, 'betaProgram').name('Use Beta updates')
        .tooltip('On by default for logged-in Metabunk members; off for visitors. Turn off to use the fully reviewed Shipped version. When a full release is newer than the current Beta, Beta users get that release until a Beta at least as new is available. Switching versions reloads Sitrec.')
        .onChange(async value => {
            try {
                if (state.userID > 0) {
                    const response = await fetch(state.endpoint, {method: 'POST', credentials: 'same-origin',
                        headers: {'Content-Type': 'application/json', 'X-Sitrec-Channel': '1'},
                        body: JSON.stringify({betaProgram: value})});
                    if (!response.ok) throw new Error(`Preference save failed: HTTP ${response.status}`);
                } else {
                    localStorage.setItem('sitrec.betaProgram', String(value));
                }
                state.preference = value;
                if (await showConfirm('Your preference is saved. Reload now to switch versions?' +
                    (Globals.sitchDirty ? '\n\nThe current sitch has unsaved changes.' : ''),
                    {title: 'Sitrec version', yesLabel: 'Reload', noLabel: 'Later'})) {
                    const url = new URL(window.location.href);
                    url.searchParams.delete('channel');
                    // Leave the existing beforeunload protection active.
                    window.location.assign(url.href);
                }
            } catch (error) {
                settings.betaProgram = state.preference;
                control.updateDisplay();
                showError('Could not save the Beta preference.', error);
            }
        });
}
