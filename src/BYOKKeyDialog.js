// BYOKKeyDialog.js
// The one place a user manages every credential they have given Sitrec.
//
// Design rules, all deliberate:
//  - A stored secret is NEVER rendered, not even partially. The dialog shows "Set" or
//    "Not set" and nothing more. An earlier version displayed the last four characters of
//    the AI key; that leaked into a lil-gui label, which CSitrecAPI.getMenuSummary()
//    enumerates into the model's system prompt and POSTs to the server on every chat turn.
//    Management only — never display.
//  - Every node is built with textContent. Provider metadata is code-defined today, but
//    this dialog renders alongside data-derived UI and there is no reason to leave an
//    innerHTML sink lying around next to the credential manager.
//  - Providers, limits and usage all come from the BYOK_PROVIDERS registry, so adding
//    ADSB Exchange or another tile source is a table entry, not new UI.

import {deleteKey, getKey, setKey} from './BYOKKeyStore';
import {
    LIMIT_DEFS, PROVIDER_CATEGORIES, providersByCategory, visibleProviders,
} from './BYOKProviders';
import {
    estimateProviderSpendUSD, formatCostUSD, formatTokens, formatUsageReport,
    getProviderConfig, getProviderUsage, refreshBlockedState, resetProviderUsage,
    setProviderConfig,
} from './BYOKUsage';
import {showPrompt} from './showError';
import {SITREC_APP} from './configUtils';

const el = (tag, css, text) => {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text !== undefined) n.textContent = text;
    return n;
};

const BTN = (label, onClick, kind = 'plain') => {
    const bg = kind === 'primary' ? '#1976d2' : (kind === 'danger' ? '#b3261e' : '#5f6368');
    const b = el('button', 'padding:4px 10px; margin-left:6px; border:none; border-radius:4px;'
        + 'cursor:pointer; color:white; font-family:inherit; font-size:12px; background:' + bg + ';', label);
    b.onclick = onClick;
    return b;
};

// Ask for a credential. Password-typed and never prefilled with the stored value, so the
// secret is not put back into the DOM just to be edited.
async function promptForCredential(provider) {
    if (provider.auth === 'userpass') {
        const user = await showPrompt(
            provider.label + ' username.\n\nStored only in this browser; never sent to the Sitrec server.',
            {title: provider.label, okLabel: 'Next'});
        if (user === null) return undefined;
        const pass = await showPrompt(provider.label + ' password.',
            {title: provider.label, okLabel: 'Save', inputType: 'password'});
        if (pass === null) return undefined;
        const u = user.trim();
        return u === '' ? '' : {username: u, password: pass};
    }
    const hint = provider.keyHint ? ' It usually starts with "' + provider.keyHint + '".' : '';
    const entered = await showPrompt(
        'Paste your ' + provider.label + ' API key.' + hint + '\n\n' + provider.unlocks + '\n\n'
        + 'The key is stored only in this browser and is never sent to the Sitrec server. '
        + 'Leave the box empty and press Save to remove a stored key.',
        {title: provider.label, okLabel: 'Save', inputType: 'password'});
    if (entered === null) return undefined;   // cancelled
    return entered.trim();
}

function numberField(value, placeholder, onCommit) {
    const input = el('input', 'width:110px; padding:3px 6px; font-family:inherit; font-size:12px;'
        + 'border:1px solid #ccc; border-radius:4px;');
    input.type = 'number';
    input.placeholder = placeholder;
    if (value !== null && value !== undefined) input.value = String(value);
    // Commit on blur/Enter rather than per-keystroke, so a half-typed number is never stored.
    const commit = () => {
        const raw = input.value.trim();
        onCommit(raw === '' ? null : Number(raw));
    };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => {
        e.stopPropagation();                       // don't let Sitrec's global keys fire
        if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    });
    return input;
}

// Resolves when the dialog CLOSES, not when it finishes rendering — the caller has
// resync work (re-priming the key cache, refreshing the AI model list) that is only
// correct once the user has finished making changes.
//
// `onKeysChanged` is additionally invoked after every individual add/remove, because the
// dialog can be left open indefinitely while the rest of the app holds stale state: with
// only the on-close callback, clearing a key left Globals.hasByokKeys true and the model
// dropdown still offering "(your key)" entries backed by nothing.
export async function showKeyDialog(onKeysChanged = null) {
    const overlay = el('div', 'position:fixed; top:0; left:0; width:100%; height:100%;'
        + 'background:rgba(0,0,0,0.5); z-index:10000; display:flex; align-items:center;'
        + 'justify-content:center;');
    const modal = el('div', 'background:white; border-radius:8px; padding:20px;'
        + 'width:80vw; max-width:720px; max-height:82vh; overflow-y:auto;'
        + 'box-shadow:0 4px 20px rgba(0,0,0,0.3); font-family:Arial, sans-serif;');
    overlay.appendChild(modal);

    let resolveClosed;
    const closed = new Promise(r => { resolveClosed = r; });
    const close = () => {
        if (overlay.parentNode) document.body.removeChild(overlay);
        resolveClosed();
    };
    const changed = async () => { if (onKeysChanged) await onKeysChanged(); };

    // Repaint from storage after every mutation — simpler and less bug-prone than patching
    // individual rows, and the dialog is small.
    async function render() {
        modal.textContent = '';
        modal.appendChild(el('h3', 'margin:0 0 4px 0; color:#1976d2; font-size:18px;', 'API Keys'));
        // Intro, with a link to the full storage/security write-up. Handing an app a
        // credential is a real decision, so the claims made here are backed by a page that
        // also states what is NOT protected.
        const intro = el('div', 'color:#444; font-size:13px; line-height:1.5; margin-bottom:14px;',
            "Use your own accounts instead of Sitrec's shared quota. Everything here is stored "
            + 'only in this browser — never sent to the Sitrec server — and is never shown '
            + 'back to you once saved. ');
        const details = el('a', 'color:#1976d2;', 'Details…');
        details.href = SITREC_APP + 'docs/APIKeys.html';
        details.target = '_blank';
        details.rel = 'noopener noreferrer';
        intro.appendChild(details);
        modal.appendChild(intro);

        const shown = visibleProviders();
        const [keys, usageByProvider, config, aiReport] = await Promise.all([
            Promise.all(shown.map(p => getKey(p.id))),
            getProviderUsage(),
            getProviderConfig(),
            formatUsageReport(),
        ]);
        const hasKey = {};
        shown.forEach((p, i) => { hasKey[p.id] = !!keys[i]; });

        const grouped = providersByCategory();
        for (const [catId, catLabel] of Object.entries(PROVIDER_CATEGORIES)) {
            const providers = grouped[catId] || [];
            if (providers.length === 0) continue;
            modal.appendChild(el('div', 'margin:14px 0 6px 0; font-size:12px; font-weight:bold;'
                + 'text-transform:uppercase; letter-spacing:0.05em; color:#666;', catLabel));

            for (const provider of providers) {
                const isSet = hasKey[provider.id];
                const usage = usageByProvider[provider.id] || {};
                const cfg = config[provider.id] || {};
                const unit = provider.unitLabel || 'requests';

                const row = el('div', 'border:1px solid #e0e0e0; border-radius:6px; padding:10px;'
                    + 'margin-bottom:8px;');

                const head = el('div', 'display:flex; align-items:baseline; flex-wrap:wrap;');
                head.appendChild(el('div', 'font-size:14px; font-weight:bold; color:#222; flex:1;',
                    provider.label));
                head.appendChild(el('span', 'font-size:11px; padding:2px 8px; border-radius:10px;'
                    + 'background:' + (isSet ? '#e6f4ea' : '#f1f3f4') + ';'
                    + 'color:' + (isSet ? '#137333' : '#5f6368') + ';',
                    isSet ? 'Set' : 'Not set'));
                head.appendChild(BTN(isSet ? 'Change' : 'Set…', async () => {
                    const value = await promptForCredential(provider);
                    if (value === undefined) return;             // cancelled
                    if (value === '') {
                        if (isSet) await deleteKey(provider.id);
                    } else {
                        await setKey(provider.id, value);
                    }
                    await changed();
                    await render();
                }, 'primary'));
                if (isSet) {
                    head.appendChild(BTN('Clear', async () => {
                        await deleteKey(provider.id);
                        await changed();
                        await render();
                    }, 'danger'));
                }
                row.appendChild(head);

                row.appendChild(el('div', 'font-size:12px; color:#555; margin-top:4px; line-height:1.45;',
                    provider.unlocks));

                if (provider.signupURL) {
                    const wrap = el('div', 'margin-top:2px;');
                    const a = el('a', 'font-size:11px; color:#1976d2;', 'Where to get one');
                    a.href = provider.signupURL;
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    wrap.appendChild(a);
                    row.appendChild(wrap);
                }

                // ── Usage ────────────────────────────────────────────────────────────
                const usageLine = el('div', 'font-size:12px; color:#333; margin-top:8px;');
                if (provider.usage === 'spend') {
                    // Real token accounting, priced per model.
                    usageLine.textContent = aiReport.totalRequests === 0
                        ? 'Usage: none yet'
                        : 'Usage: approx ' + formatCostUSD(aiReport.totalCost)
                          + ' over ' + aiReport.totalRequests + ' requests';
                } else if (provider.usage !== 'none') {
                    const spend = estimateProviderSpendUSD(usage, cfg, provider.rate?.per ?? 1000);
                    usageLine.textContent = 'Usage: ' + formatTokens(usage.total || 0) + ' ' + unit
                        + ' (' + formatTokens(usage.dailyCount || 0) + ' today)'
                        + (spend === null ? '' : ' — approx ' + formatCostUSD(spend));
                }
                row.appendChild(usageLine);

                // A rate turns counts into money. Deliberately user-supplied: tile pricing
                // varies by plan, region and free-tier allowance, so a shipped default
                // would be confidently wrong. Blank = show counts, no dollar figure.
                if (provider.usage !== 'spend' && provider.usage !== 'none') {
                    const rateRow = el('div', 'display:flex; align-items:center; gap:6px; margin-top:6px;');
                    rateRow.appendChild(el('span', 'font-size:12px; color:#555;',
                        provider.rate?.label || ('Your rate per 1000 ' + unit + ' (USD)')));
                    rateRow.appendChild(numberField(cfg.unitPricePer1000 ?? null,
                            provider.rate?.placeholder || 'e.g. 1.00', async v => {
                        await setProviderConfig(provider.id, {unitPricePer1000: v});
                        await render();
                    }));
                    row.appendChild(rateRow);
                }

                // ── Limits ───────────────────────────────────────────────────────────
                if (provider.limits && provider.limits.length > 0) {
                    const box = el('div', 'margin-top:8px; padding-top:8px; border-top:1px dashed #e0e0e0;');
                    box.appendChild(el('div', 'font-size:11px; color:#666; margin-bottom:4px;',
                        isSet
                            ? 'Limits (blank = unlimited, the default on your own key)'
                            : 'Limits apply once you set a key here.'));
                    for (const limitName of provider.limits) {
                        const def = LIMIT_DEFS[limitName];
                        if (!def) continue;
                        const lr = el('div', 'display:flex; align-items:center; gap:6px; margin-top:4px;');
                        lr.appendChild(el('span', 'font-size:12px; color:#555; flex:1;', def.label));
                        const field = numberField(cfg.limits?.[limitName] ?? null, 'unlimited', async v => {
                            await setProviderConfig(provider.id, {limits: {[limitName]: v}});
                            await refreshBlockedState(provider.id);
                            await render();
                        });
                        if (!isSet) field.disabled = true;
                        lr.appendChild(field);
                        lr.appendChild(el('span', 'font-size:11px; color:#888;', def.unit));
                        box.appendChild(lr);
                        box.appendChild(el('div', 'font-size:11px; color:#888; margin-top:2px;', def.help));
                    }
                    row.appendChild(box);
                }

                if (provider.usage !== 'spend' && (usage.total || 0) > 0) {
                    const wrap = el('div', 'margin-top:8px;');
                    const reset = BTN('Reset counter', async () => {
                        await resetProviderUsage(provider.id);
                        await refreshBlockedState(provider.id);
                        await render();
                    });
                    reset.style.marginLeft = '0';
                    wrap.appendChild(reset);
                    row.appendChild(wrap);
                }

                modal.appendChild(row);
            }
        }

        const footer = el('div', 'display:flex; justify-content:flex-end; margin-top:16px;');
        footer.appendChild(BTN('Close', close, 'primary'));
        modal.appendChild(footer);
    }

    overlay.addEventListener('keydown', e => {
        e.stopPropagation();
        if (e.key === 'Escape') close();
    });

    await render();
    document.body.appendChild(overlay);
    await closed;
}
