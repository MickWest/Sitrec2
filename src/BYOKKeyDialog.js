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
//  - ONE LINE PER PROVIDER until you ask for more. There are a dozen entries and growing;
//    rendering every description, rate box and limit at once pushed most of the list below
//    the fold. Each row is now a compact header (enable, name, state, spend, buttons) with
//    a one-line summary, and the detail opens on click.

import {deleteKey, getKeyRaw, isProviderEnabled, setKey, setProviderEnabled} from './BYOKKeyStore';
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
    const b = el('button', 'padding:2px 8px; margin-left:5px; border:none; border-radius:4px;'
        + 'cursor:pointer; color:white; font-family:inherit; font-size:11px; line-height:16px;'
        + 'background:' + bg + ';', label);
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
    const input = el('input', 'width:96px; padding:2px 5px; font-family:inherit; font-size:11px;'
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
// `onKeysChanged` is additionally invoked after every individual add/remove/enable,
// because the dialog can be left open indefinitely while the rest of the app holds stale
// state: with only the on-close callback, clearing a key left Globals.hasByokKeys true and
// the model dropdown still offering "(your key)" entries backed by nothing.
export async function showKeyDialog(onKeysChanged = null) {
    const overlay = el('div', 'position:fixed; top:0; left:0; width:100%; height:100%;'
        + 'background:rgba(0,0,0,0.5); z-index:10000; display:flex; align-items:center;'
        + 'justify-content:center;');
    const modal = el('div', 'background:white; border-radius:8px; padding:14px 16px;'
        + 'width:80vw; max-width:720px; max-height:86vh; overflow-y:auto;'
        + 'box-shadow:0 4px 20px rgba(0,0,0,0.3); font-family:Arial, sans-serif;'
        + 'outline:none;');
    modal.tabIndex = -1;              // focusable, so the dialog receives Escape immediately
    overlay.appendChild(modal);

    // Which rows are showing their detail. Held here rather than in the DOM because
    // render() rebuilds the whole modal after every change and would otherwise collapse
    // the row the user is working in.
    const expanded = new Set();

    let resolveClosed;
    const closed = new Promise(r => { resolveClosed = r; });
    const close = () => {
        document.removeEventListener('keydown', onDocumentKey);
        if (overlay.parentNode) document.body.removeChild(overlay);
        resolveClosed();
    };
    const changed = async () => { if (onKeysChanged) await onKeysChanged(); };

    // Repaint from storage after every mutation — simpler and less bug-prone than patching
    // individual rows, and the dialog is small.
    async function render() {
        modal.textContent = '';
        const title = el('div', 'display:flex; align-items:baseline; gap:10px;');
        title.appendChild(el('h3', 'margin:0; color:#1976d2; font-size:16px;', 'API Keys'));
        // Intro, with a link to the full storage/security write-up. Handing an app a
        // credential is a real decision, so the claims made here are backed by a page that
        // also states what is NOT protected.
        const intro = el('div', 'color:#444; font-size:11px; line-height:1.4; flex:1;',
            'Stored only in this browser, never sent to the Sitrec server, never shown back to you. ');
        const details = el('a', 'color:#1976d2;', 'Details…');
        details.href = SITREC_APP + 'docs/APIKeys.html';
        details.target = '_blank';
        details.rel = 'noopener noreferrer';
        intro.appendChild(details);
        title.appendChild(intro);
        modal.appendChild(title);
        modal.appendChild(el('div', 'color:#777; font-size:11px; margin:4px 0 2px 0;',
            'Untick to keep a key but stop using it. Click a row for usage, rates and limits.'));

        const shown = visibleProviders();
        const [keys, usageByProvider, config] = await Promise.all([
            Promise.all(shown.map(p => getKeyRaw(p.id))),
            getProviderUsage(),
            getProviderConfig(),
        ]);
        const hasKey = {};
        shown.forEach((p, i) => { hasKey[p.id] = !!keys[i]; });

        const grouped = providersByCategory();
        for (const [catId, catLabel] of Object.entries(PROVIDER_CATEGORIES)) {
            const providers = grouped[catId] || [];
            if (providers.length === 0) continue;
            modal.appendChild(el('div', 'margin:10px 0 3px 0; font-size:10px; font-weight:bold;'
                + 'text-transform:uppercase; letter-spacing:0.06em; color:#666;', catLabel));

            for (const provider of providers) {
                const isSet = hasKey[provider.id];
                const enabled = isProviderEnabled(provider.id);
                const isOpen = expanded.has(provider.id);
                const usage = usageByProvider[provider.id] || {};
                const cfg = config[provider.id] || {};
                const unit = provider.unitLabel || 'requests';

                const row = el('div', 'border:1px solid #e0e0e0; border-radius:5px;'
                    + 'padding:5px 8px; margin-bottom:4px;'
                    + (isSet && !enabled ? 'background:#fafafa;' : ''));

                // ── Header: one line, always visible ─────────────────────────────────
                const head = el('div', 'display:flex; align-items:center; gap:6px;'
                    + 'cursor:pointer; min-height:20px;');
                head.appendChild(el('span', 'color:#999; font-size:10px; width:8px;',
                    isOpen ? '▾' : '▸'));

                // Only meaningful with a key stored, but rendered either way so the name
                // column stays aligned down the list.
                const enableBox = el('input', 'margin:0; cursor:pointer;');
                enableBox.type = 'checkbox';
                enableBox.checked = isSet && enabled;
                enableBox.disabled = !isSet;
                enableBox.title = isSet
                    ? 'Use this key. Unticked, the key is kept but Sitrec falls back to its own.'
                    : 'No key stored.';
                enableBox.onclick = async e => {
                    e.stopPropagation();                    // don't also toggle the detail
                    await setProviderEnabled(provider.id, enableBox.checked);
                    await changed();
                    await render();
                };
                head.appendChild(enableBox);

                head.appendChild(el('div', 'font-size:12px; font-weight:bold;'
                    + 'color:' + (isSet && !enabled ? '#888' : '#222') + ';', provider.label));

                const state = isSet ? (enabled ? 'Set' : 'Off') : 'Not set';
                const stateBG = isSet ? (enabled ? '#e6f4ea' : '#fce8e6') : '#f1f3f4';
                const stateFG = isSet ? (enabled ? '#137333' : '#a50e0e') : '#5f6368';
                head.appendChild(el('span', 'font-size:10px; padding:1px 6px; border-radius:8px;'
                    + 'background:' + stateBG + '; color:' + stateFG + ';', state));

                head.appendChild(el('div', 'flex:1;'));

                // Spend belongs on the collapsed line: it is the number a user opens this
                // dialog to look at, and it costs no extra height here.
                const spendText = await summaryUsageText(provider, usage, cfg);
                if (spendText) head.appendChild(el('span', 'font-size:10px; color:#777;', spendText));

                head.appendChild(BTN(isSet ? 'Change' : 'Set…', async e => {
                    e.stopPropagation();
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
                    head.appendChild(BTN('Clear', async e => {
                        e.stopPropagation();
                        await deleteKey(provider.id);
                        await changed();
                        await render();
                    }, 'danger'));
                }
                head.onclick = () => {
                    if (isOpen) expanded.delete(provider.id); else expanded.add(provider.id);
                    render();
                };
                row.appendChild(head);

                // ── One-line summary, so a collapsed list still says what each key is for ─
                if (!isOpen) {
                    row.appendChild(el('div', 'font-size:11px; color:#777; margin-left:20px;'
                        + 'white-space:nowrap; overflow:hidden; text-overflow:ellipsis;',
                        provider.unlocks));
                    modal.appendChild(row);
                    continue;
                }

                // ── Detail ───────────────────────────────────────────────────────────
                const body = el('div', 'margin:4px 0 2px 20px;');

                const desc = el('div', 'font-size:11px; color:#555; line-height:1.4;',
                    provider.unlocks + ' ');
                if (provider.signupURL) {
                    const a = el('a', 'color:#1976d2; white-space:nowrap;', 'Where to get one');
                    a.href = provider.signupURL;
                    a.target = '_blank';
                    a.rel = 'noopener noreferrer';
                    desc.appendChild(a);
                }
                body.appendChild(desc);

                // ── Usage, with the rate box on the same line ────────────────────────
                const usageRow = el('div', 'display:flex; align-items:center; flex-wrap:wrap;'
                    + 'gap:6px; margin-top:5px; font-size:11px; color:#333;');
                usageRow.appendChild(el('span', '', await detailUsageText(provider, usage, cfg, unit)));

                // A rate turns counts into money. Deliberately user-supplied: tile pricing
                // varies by plan, region and free-tier allowance, so a shipped default
                // would be confidently wrong. Blank = show counts, no dollar figure.
                if (provider.usage !== 'spend' && provider.usage !== 'none') {
                    usageRow.appendChild(el('span', 'color:#777; margin-left:6px;',
                        provider.rate?.label || ('Your rate per 1000 ' + unit + ' (USD)')));
                    usageRow.appendChild(numberField(cfg.unitPricePer1000 ?? null,
                            provider.rate?.placeholder || 'e.g. 1.00', async v => {
                        await setProviderConfig(provider.id, {unitPricePer1000: v});
                        await render();
                    }));
                }
                if (provider.usage !== 'spend' && (usage.total || 0) > 0) {
                    const reset = BTN('Reset counter', async () => {
                        await resetProviderUsage(provider.id);
                        await refreshBlockedState(provider.id);
                        await render();
                    });
                    usageRow.appendChild(reset);
                }
                body.appendChild(usageRow);

                // ── Limits ───────────────────────────────────────────────────────────
                if (provider.limits && provider.limits.length > 0) {
                    const box = el('div', 'margin-top:5px; padding-top:5px; border-top:1px dashed #e0e0e0;');
                    for (const limitName of provider.limits) {
                        const def = LIMIT_DEFS[limitName];
                        if (!def) continue;
                        const lr = el('div', 'display:flex; align-items:center; gap:6px;'
                            + 'font-size:11px; color:#555;');
                        lr.appendChild(el('span', 'flex:1;', def.label));
                        const field = numberField(cfg.limits?.[limitName] ?? null, 'unlimited', async v => {
                            await setProviderConfig(provider.id, {limits: {[limitName]: v}});
                            await refreshBlockedState(provider.id);
                            await render();
                        });
                        if (!isSet) field.disabled = true;
                        lr.appendChild(field);
                        lr.appendChild(el('span', 'font-size:10px; color:#888;', def.unit));
                        box.appendChild(lr);
                        box.appendChild(el('div', 'font-size:10px; color:#999; line-height:1.35;',
                            isSet ? def.help : 'Limits apply once you set a key here. ' + def.help));
                    }
                    body.appendChild(box);
                }

                row.appendChild(body);
                modal.appendChild(row);
            }
        }

        const footer = el('div', 'display:flex; justify-content:flex-end; margin-top:12px;');
        footer.appendChild(BTN('Close', close, 'primary'));
        modal.appendChild(footer);
    }

    // The short, right-aligned figure on a collapsed row. Null where there is nothing
    // worth a number — an unset key, or a provider with no meter.
    async function summaryUsageText(provider, usage, cfg) {
        if (provider.usage === 'none') return null;
        if (provider.usage === 'spend') {
            const report = await formatUsageReport(provider.usageModelMatch);
            if (report.totalRequests === 0) return null;
            return formatCostUSD(report.totalCost) + ' / ' + report.totalRequests + ' req';
        }
        if (!(usage.total > 0)) return null;
        const spend = estimateProviderSpendUSD(usage, cfg, provider.rate?.per ?? 1000);
        return formatTokens(usage.total) + ' ' + (provider.unitLabel || 'requests')
            + (spend === null ? '' : ' — ' + formatCostUSD(spend));
    }

    async function detailUsageText(provider, usage, cfg, unit) {
        if (provider.usage === 'none') return 'No usage counter for this provider.';
        if (provider.usage === 'spend') {
            // Real token accounting, priced per model. Filter per provider so the
            // Anthropic and OpenRouter rows do not each display the combined total.
            const report = await formatUsageReport(provider.usageModelMatch);
            return report.totalRequests === 0
                ? 'Usage: none yet'
                : 'Usage: approx ' + formatCostUSD(report.totalCost)
                  + ' over ' + report.totalRequests + ' requests';
        }
        const spend = estimateProviderSpendUSD(usage, cfg, provider.rate?.per ?? 1000);
        return 'Usage: ' + formatTokens(usage.total || 0) + ' ' + unit
            + ' (' + formatTokens(usage.dailyCount || 0) + ' today)'
            + (spend === null ? '' : ' — approx ' + formatCostUSD(spend));
    }

    // Escape has to be caught at the document, not the overlay: the overlay only sees the
    // key when focus is already inside it, and after a "Set…" round trip focus can be
    // anywhere. Two guards keep it from stealing a nested dialog's Escape — showPrompt
    // appends its own overlay AFTER this one, so this is no longer the last child, and it
    // preventDefaults the key it handles.
    const onDocumentKey = e => {
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        if (document.body.lastElementChild !== overlay) return;
        e.preventDefault();
        close();
    };

    overlay.addEventListener('keydown', e => {
        e.stopPropagation();                        // shield Sitrec's global shortcuts
        if (e.key === 'Escape') { e.preventDefault(); close(); }
    });

    await render();
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onDocumentKey);
    modal.focus();
    await closed;
}
