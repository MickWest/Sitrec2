// Fine-grained recordings for the two accounts authorized by the server. See
// docs/dev/InputRecording.md for the event format, storage and analysis workflow.
import {setUIRecordingObserver} from './UIRecordingHooks';

const MAX_QUEUE = 1000;
const MAX_BATCH_BYTES = 48000; // below the shared keepalive/sendBeacon budget
const FLUSH_MS = 5000;
const SAMPLE_MS = 100;
const SECRET = /password|passwd|secret|credential|api.?key|access.?token|authorization|username/i;
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])';
// In an editable field only these keys keep their name. Every other key value can be
// typed text (an emoji has two UTF-16 code units; composition sends Dead or Process).
const NON_TEXT_KEY = /^(?:Enter|Tab|Escape|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Arrow(?:Up|Down|Left|Right)|Shift|Control|Alt|AltGraph|Meta|CapsLock|F\d{1,2})$/;

function clean(value, max = 300) {
    return String(value ?? '').replace(/[\x00-\x1f\x7f]/g, ' ').slice(0, max);
}

// Labels can contain URLs. Never include their query strings, fragments or credentials.
function labelText(value, max = 300) {
    return clean(value, 2000).replace(/https?:\/\/[^\s]+/gi, text => {
        try { const url = new URL(text); return url.origin + url.pathname; } catch (_) { return '[url]'; }
    }).replace(/\b(?:sk-[\w-]+|Bearer\s+\S+)/gi, '[redacted]').slice(0, max);
}

function staticLabelText(node) {
    if (!node || node.matches?.(EDITABLE)) return '';
    const copy = node.cloneNode(true);
    copy.querySelectorAll(EDITABLE).forEach(control => control.remove());
    return copy.textContent;
}

function labelFor(el) {
    const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
    return el.getAttribute('aria-label') || ids.map(id => staticLabelText(document.getElementById(id))).join(' ')
        || [...(el.labels || [])].map(staticLabelText).join(' ')
        || el.getAttribute('title') || el.getAttribute('placeholder')
        || (el.matches('button, summary, a, option, [role="button"], [role="menuitem"]') ? staticLabelText(el) : '');
}

export function describeInputTarget(target, pathFor = () => null) {
    const el = target?.closest ? target : document.documentElement;
    const control = el.closest(EDITABLE) || el.closest('.controller')?.querySelector('input, select') || el;
    const path = el.closest('[data-input-recording-path]')?.dataset.inputRecordingPath
        || pathFor(el) || labelFor(control) || el.closest('[id]')?.id || el.tagName.toLowerCase();
    const sensitive = !!el.closest('[data-input-recording="redact"]') || control.type === 'password'
        || SECRET.test([path, control.id, control.name, control.autocomplete, labelFor(control)].join(' '));
    const result = {
        tag: el.tagName.toLowerCase(), id: clean(el.id, 100), path: labelText(path),
        role: clean(el.getAttribute('role'), 40), inputType: clean(control.type, 40), sensitive,
        view: clean(el.closest('[data-input-recording-view]')?.dataset.inputRecordingView, 100),
        disabled: !!(control.disabled || el.closest('.disabled, [aria-disabled="true"]')),
    };
    if (sensitive) {
        result.value = '[redacted]';
    } else if (control.matches('input[type="checkbox"], input[type="radio"]')) {
        result.value = control.checked;
    } else if (control.matches('select')) {
        result.value = labelText(control.value);
        result.option = labelText(control.selectedOptions?.[0]?.textContent);
    } else if (control.matches('input[type="file"]')) {
        result.fileCount = control.files?.length || 0; // no file paths or file contents
    } else if (control.matches(EDITABLE)) {
        const value = control.value ?? control.textContent ?? '';
        const numeric = control.matches('input[type="number"], input[type="range"], input[data-input-recording-value="number"]')
            || control.closest('.controller.number');
        if (numeric && value !== '' && Number.isFinite(Number(value))) result.value = Number(value);
        else if (control.matches('input[type="color"], input[type="date"], input[type="time"], input[type="datetime-local"]')) {
            result.value = clean(value, 100);
        } else {
            // Free text can contain credentials or pasted documents. Record editing
            // activity and length, not the characters, even on key and clipboard events.
            result.textLength = value.length;
            result.value = '[text omitted]';
        }
    }
    return result;
}

export class InputRecorder {
    constructor({url, userID, context = () => ({}), pathFor = () => null}) {
        this.url = url;
        this.userID = userID;
        this.context = context;
        this.pathFor = pathFor;
        this.storageKey = `sitrec-input-recording-v1-${userID}`;
        this.session = `${new Date().toISOString().slice(0, 10)}_${crypto.randomUUID()}`;
        this.seq = 0;
        this.queue = [];
        this.recovery = [];
        this.dropped = 0;
        this.listeners = [];
        this.samples = new Map();
        this.started = performance.now();
        this.retryAt = 0;
        this.failures = 0;
        this.active = false;
        try {
            const saved = JSON.parse(sessionStorage.getItem(this.storageKey));
            if (saved && /^\d{4}-\d{2}-\d{2}_[\da-f-]{36}$/.test(saved.session)
                && Array.isArray(saved.queue) && Number.isSafeInteger(saved.seq)) {
                // Each page gets a new session: duplicating a tab copies sessionStorage.
                // Replay its old queue under the old id, then use the new id for new input.
                this.recovery = [...(saved.recovery || []), {session: saved.session, events: saved.queue}]
                    .filter(batch => Array.isArray(batch.events) && batch.events.length);
                this.dropped = saved.dropped || 0;
            }
        } catch (_) { /* private browsing or full storage: retain the in-memory queue */ }
    }

    persist() {
        try {
            sessionStorage.setItem(this.storageKey, JSON.stringify({session: this.session,
                seq: this.seq, queue: this.queue, recovery: this.recovery, dropped: this.dropped}));
        } catch (_) { /* recording still works without browser storage */ }
    }

    record(type, data = {}) {
        // Give older samples their sequence numbers before this newer event.
        // Keep each stream's sampling interval when another stream emits.
        this.drainSamples(false);
        this.appendRecord(type, data);
    }

    appendRecord(type, data) {
        if (!this.active) return;
        if (this.queue.length + this.recovery.reduce((sum, batch) => sum + batch.events.length, 0) >= MAX_QUEUE) {
            this.dropped++; return;
        }
        this.queue.push({seq: ++this.seq, ts: Date.now(), elapsed: Math.round(performance.now() - this.started),
            type, context: this.context(), ...data});
        if (!this.persistTimer) this.persistTimer = setTimeout(() => {
            this.persistTimer = null;
            this.persist();
        }, 250);
    }

    // Sample frequent motion, but retain its last point before a button-up or flush.
    sample(key, type, data) {
        data = {ts: Date.now(), elapsed: Math.round(performance.now() - this.started), context: this.context(), ...data};
        const previous = this.samples.get(key);
        const now = performance.now();
        if (!previous || now - previous.time >= SAMPLE_MS) {
            // This point supersedes this stream's pending point. Other streams
            // must drain before it so delayed samples cannot move backwards in time.
            if (previous) delete previous.pending;
            this.record(type, data);
            this.samples.set(key, {time: now});
        } else {
            previous.pending = {type, data};
        }
    }

    drainSamples(reset = true) {
        const pending = [];
        for (const sample of this.samples.values()) {
            if (sample.pending) pending.push(sample.pending);
            delete sample.pending;
        }
        if (reset) this.samples.clear();
        pending.sort((a, b) => a.data.ts - b.data.ts || a.data.elapsed - b.data.elapsed);
        for (const sample of pending) this.appendRecord(sample.type, sample.data);
    }

    capture(event) {
        try {
            const type = event.type;
            const target = describeInputTarget(event.target, this.pathFor);
            const data = {target, trusted: event.isTrusted};
            if (type.startsWith('pointer') || ['click', 'dblclick', 'contextmenu', 'wheel', 'drop', 'dragstart'].includes(type)) {
                data.x = Math.round(event.clientX || 0);
                data.y = Math.round(event.clientY || 0);
                data.button = event.button || 0;
                data.buttons = event.buttons || 0;
                data.pointerId = event.pointerId || 0;
                data.pointerType = event.pointerType || 'mouse';
                const rect = event.target?.getBoundingClientRect?.();
                if (rect) data.bounds = {x: Math.round(rect.x), y: Math.round(rect.y),
                    width: Math.round(rect.width), height: Math.round(rect.height)};
            }
            data.modifiers = {alt: !!event.altKey, ctrl: !!event.ctrlKey, meta: !!event.metaKey, shift: !!event.shiftKey};
            if (type.startsWith('key')) {
                const editing = event.target?.closest?.(EDITABLE);
                // Do not retain key codes either: those reconstruct omitted text.
                data.key = target.sensitive ? '[redacted]' : editing && !NON_TEXT_KEY.test(event.key ?? '') ? '[text]' : clean(event.key, 40);
                data.repeat = !!event.repeat;
            }
            if (type === 'input') data.inputType = clean(event.inputType, 40);
            if (type === 'wheel') {
                data.deltaX = event.deltaX; data.deltaY = event.deltaY; data.deltaMode = event.deltaMode;
            }
            if (type === 'scroll') {
                data.scrollX = event.target?.scrollLeft ?? window.scrollX;
                data.scrollY = event.target?.scrollTop ?? window.scrollY;
            }
            if (type === 'drop') data.fileCount = event.dataTransfer?.files?.length || 0;
            if (['pointermove', 'wheel', 'scroll'].includes(type)) {
                this.sample(`${type}:${data.pointerId || 0}`, type, data);
            } else {
                this.drainSamples();
                this.record(type, data);
            }
        } catch (_) { /* malformed/removed elements must not affect the UI */ }
    }

    listen(object, type, callback) {
        object.addEventListener(type, callback, {capture: true, passive: true});
        this.listeners.push(() => object.removeEventListener(type, callback, true));
    }

    start() {
        if (this.active) return;
        this.active = true;
        this.record('session', {width: innerWidth, height: innerHeight, pixelRatio: devicePixelRatio,
            build: clean(process.env.BUILD_VERSION_STRING, 100), page: location.pathname,
            language: navigator.language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone});
        for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'click', 'dblclick', 'contextmenu',
            'wheel', 'scroll', 'input', 'change', 'keydown', 'keyup', 'focusin', 'focusout', 'dragstart', 'drop', 'copy', 'cut', 'paste']) {
            this.listen(document, type, event => this.capture(event));
        }
        setUIRecordingObserver((controller, finished) => {
            const target = describeInputTarget(controller.domElement, this.pathFor);
            const value = controller.getValue();
            if (!target.sensitive && (typeof value === 'boolean' || typeof value === 'number')) target.value = value;
            // Controller changes include scripted changes; label them separately from DOM inputs.
            if (finished) { this.drainSamples(); this.record('control_finish', {target}); }
            else this.sample(`control:${target.path}`, 'control_change', {target});
        });
        this.listen(window, 'resize', () => this.sample('resize', 'resize', {width: innerWidth, height: innerHeight}));
        this.listen(window, 'error', event => this.record('error', {name: clean(event.error?.name || 'ResourceError', 60),
            file: labelText(event.filename || ''), line: event.lineno || 0, column: event.colno || 0}));
        this.listen(window, 'unhandledrejection', () => this.record('error', {name: 'UnhandledRejection'}));
        this.listen(window, 'online', () => { this.record('online'); this.retryAt = 0; void this.flush(); });
        this.listen(window, 'offline', () => this.record('offline'));
        this.listen(window, 'pagehide', () => { this.drainSamples(); this.record('pagehide'); void this.flush(true); });
        this.listen(window, 'pageshow', () => this.record('pageshow'));
        this.listen(document, 'visibilitychange', () => {
            this.drainSamples();
            this.record('visibility', {state: document.visibilityState});
            if (document.visibilityState === 'hidden') void this.flush(true);
        });
        this.interval = setInterval(() => void this.flush(), FLUSH_MS);
    }

    async flush(beacon = false) {
        if (!this.active) return;
        this.drainSamples();
        const recovering = this.recovery[0];
        const pending = recovering?.events || this.queue;
        if (!pending.length) return;
        this.persist();
        if (!beacon && (this.inFlight || Date.now() < this.retryAt)) return;
        let events = [];
        let bytes = 200;
        for (const event of pending) {
            const size = new TextEncoder().encode(JSON.stringify(event)).length + 1;
            if (bytes + size > MAX_BATCH_BYTES || events.length >= 100) break;
            events.push(event); bytes += size;
        }
        if (!events.length) return;
        const body = JSON.stringify({schema: 1, session: recovering?.session || this.session, events});
        if (beacon) {
            // Keep the queue until an acknowledged fetch. A beacon is not an acknowledgement.
            try { if (navigator.sendBeacon?.(this.url, new Blob([body], {type: 'application/json'}))) return; } catch (_) { /* fall through */ }
            if (this.inFlight) return;
        }
        this.inFlight = true;
        clearTimeout(this.drainTimer);
        let delivered = false;
        const abort = new AbortController();
        const timeout = setTimeout(() => abort.abort(), 15000);
        try {
            const response = await fetch(this.url, {method: 'POST', credentials: 'same-origin',
                headers: {'Content-Type': 'application/json'}, body, keepalive: true, signal: abort.signal});
            if (!this.active) return;
            if ([401, 403].includes(response.status)) {
                // The recorder stops for this session, so this shows once.
                console.warn(`Input recording stopped: the server refused the upload (HTTP ${response.status}).`);
                this.stop(true);
                return;
            }
            if (!response.ok) throw new Error('Recording upload failed');
            const result = await response.json();
            if (!this.active) return;
            const lastSeq = events[events.length - 1].seq;
            if (result.disabled) { this.stop(true); return; }
            if (!result.success || !Number.isSafeInteger(result.ack) || result.ack < lastSeq) throw new Error('Recording not acknowledged');
            if (recovering) {
                recovering.events = recovering.events.filter(event => event.seq > lastSeq);
                if (!recovering.events.length) this.recovery.shift();
            } else this.queue = this.queue.filter(event => event.seq > lastSeq);
            this.failures = 0;
            this.retryAt = 0;
            if (this.dropped) {
                const count = this.dropped; this.dropped = 0;
                this.record('gap', {count});
            }
            this.persist();
            delivered = true;
        } catch (_) {
            this.retryAt = Date.now() + Math.min(60000, FLUSH_MS * 2 ** Math.min(this.failures++, 4));
        } finally {
            clearTimeout(timeout);
            this.inFlight = false;
            // Drain a busy gesture or an offline backlog faster than the idle interval,
            // with at most one catch-up request per second.
            if (delivered && this.active && (this.queue.length || this.recovery.length)) {
                this.drainTimer = setTimeout(() => void this.flush(), 1000);
            }
        }
    }

    stop(discard = false) {
        this.active = false;
        clearInterval(this.interval);
        clearTimeout(this.drainTimer);
        clearTimeout(this.persistTimer);
        this.persistTimer = null;
        this.listeners.forEach(remove => remove());
        this.listeners = [];
        setUIRecordingObserver(undefined);
        if (discard) {
            this.queue = [];
            this.recovery = [];
            try { sessionStorage.removeItem(this.storageKey); } catch (_) { /* unavailable */ }
        } else this.persist();
    }
}
