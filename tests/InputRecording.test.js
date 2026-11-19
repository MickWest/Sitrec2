/** @jest-environment jsdom */
import {describeInputTarget, InputRecorder} from '../src/InputRecording';
import {notifyUIRecordingObserver} from '../src/UIRecordingHooks';

let recorder;
beforeEach(() => {
    jest.useFakeTimers();
    sessionStorage.clear();
    document.body.innerHTML = '';
    global.fetch = jest.fn(async (_url, request) => ({ok: true, status: 200,
        json: async () => ({success: true, ack: JSON.parse(request.body).events.at(-1).seq})}));
    recorder = new InputRecorder({url: '/inputlog.php', userID: 1, context: () => ({sitch: 'custom', frame: 12})});
});
afterEach(() => { recorder.stop(); jest.useRealTimers(); });

function control(html) {
    document.body.innerHTML = html;
    return document.body.firstElementChild;
}

test('passwords, free text, clipboard contents and typed characters are not retained', () => {
    recorder.start();
    const input = control('<input type="password" aria-label="API key">');
    input.value = 'private-password-123';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'p', code: 'KeyP', bubbles: true}));
    input.type = 'text'; input.setAttribute('aria-label', 'Search');
    input.value = 'private-search-456';
    input.dispatchEvent(new Event('input', {bubbles: true}));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'p', code: 'KeyP', bubbles: true}));
    const paste = new Event('paste', {bubbles: true});
    paste.clipboardData = {getData: () => 'clipboard-secret'};
    input.dispatchEvent(paste);
    const log = JSON.stringify(recorder.queue);
    expect(log).not.toMatch(/private-password|private-search|clipboard-secret|KeyP/);
    expect(recorder.queue.find(e => e.type === 'input').target.value).toBe('[redacted]');
    expect(recorder.queue.filter(e => e.type === 'keydown').map(e => e.key)).toEqual(['[redacted]', '[text]']);
    expect(recorder.queue.at(-1).target.textLength).toBe(18);
    const wrapper = control('<label>Notes<textarea>private-prefilled-text</textarea></label>');
    const description = describeInputTarget(wrapper.firstElementChild);
    expect(description.path).toBe('Notes');
    expect(JSON.stringify(description)).not.toContain('private-prefilled-text');
});

test('numeric values, checkbox state, selected labels and view names remain useful', () => {
    const input = control('<input type="number" aria-label="Altitude" value="1200">');
    expect(describeInputTarget(input)).toMatchObject({path: 'Altitude', value: 1200});
    const wrapper = control('<div data-input-recording-view="lookView"><input type="checkbox" checked></div>');
    expect(describeInputTarget(wrapper.firstChild)).toMatchObject({value: true, view: 'lookView'});
    const select = control('<select><option value="earth">Earth</option></select>');
    expect(describeInputTarget(select)).toMatchObject({value: 'earth', option: 'Earth'});
    const link = control('<button>Open https://name:secret@example.test/item?token=private#secret</button>');
    expect(describeInputTarget(link).path).toBe('Open https://example.test/item');
});

test('explicit numeric text fields retain numbers without weakening text or credential redaction', () => {
    const input = control('<input type="text" inputmode="numeric" aria-label="Year" value="2024">');
    expect(describeInputTarget(input).value).toBe('[text omitted]');
    input.dataset.inputRecordingValue = 'number';
    expect(describeInputTarget(input).value).toBe(2024);
    input.value = 'pasted text';
    expect(describeInputTarget(input).value).toBe('[text omitted]');
    input.value = '123456';
    input.setAttribute('aria-label', 'Access token');
    expect(describeInputTarget(input).value).toBe('[redacted]');
    input.setAttribute('aria-label', 'Year');
    input.dataset.inputRecording = 'redact';
    expect(describeInputTarget(input).value).toBe('[redacted]');
});

test('gesture sampling retains the final point and does not interfere with input', () => {
    recorder.start();
    const el = control('<canvas></canvas>');
    for (let x = 0; x < 20; x++) {
        el.dispatchEvent(new MouseEvent('pointermove', {clientX: x, clientY: 25, buttons: 1, bubbles: true}));
    }
    const up = new MouseEvent('pointerup', {clientX: 19, bubbles: true, cancelable: true});
    el.dispatchEvent(up);
    const moves = recorder.queue.filter(e => e.type === 'pointermove');
    expect(moves).toHaveLength(2);
    expect(moves.at(-1).x).toBe(19);
    expect(recorder.queue.at(-1)).toMatchObject({type: 'pointerup', context: {frame: 12}});
    expect(up.defaultPrevented).toBe(false);
});

test('a newer sample cannot overtake a pending resize', async () => {
    recorder.start();
    recorder.sample('resize', 'resize', {width: 100});
    jest.advanceTimersByTime(10);
    recorder.sample('resize', 'resize', {width: 101});
    jest.advanceTimersByTime(2000);
    recorder.sample('pointermove:0', 'pointermove', {x: 25});
    await recorder.flush();
    const events = JSON.parse(fetch.mock.calls[0][1].body).events;
    expect(events.map(e => e.type)).toEqual(['session', 'resize', 'resize', 'pointermove']);
    expect(events[2].width).toBe(101);
    expect(events.map(e => e.ts)).toEqual(events.map(e => e.ts).sort((a, b) => a - b));
    expect(events.map(e => e.seq)).toEqual([1, 2, 3, 4]);
});

test.each(['flush', 'direct event'])('pending streams drain in capture order before a %s', async action => {
    recorder.start();
    recorder.sample('a', 'control_change', {target: {path: 'A', value: 0}});
    recorder.sample('b', 'control_change', {target: {path: 'B', value: 0}});
    jest.advanceTimersByTime(10);
    recorder.sample('b', 'control_change', {target: {path: 'B', value: 1}});
    jest.advanceTimersByTime(10);
    recorder.sample('a', 'control_change', {target: {path: 'A', value: 2}});
    jest.advanceTimersByTime(10);
    if (action === 'direct event') recorder.record('error', {name: 'ResourceError'});
    await recorder.flush();
    const events = JSON.parse(fetch.mock.calls[0][1].body).events;
    expect(events.filter(e => e.type === 'control_change').map(e => [e.target.path, e.target.value]))
        .toEqual([['A', 0], ['B', 0], ['B', 1], ['A', 2]]);
    expect(events.map(e => e.ts)).toEqual(events.map(e => e.ts).sort((a, b) => a - b));
});

test('draining before another stream does not reset the sampling interval', () => {
    recorder.start();
    recorder.sample('a', 'pointermove', {x: 0});
    jest.advanceTimersByTime(10);
    recorder.sample('a', 'pointermove', {x: 1});
    jest.advanceTimersByTime(10);
    recorder.sample('b', 'resize', {width: 100});
    expect(recorder.queue.filter(e => e.type === 'pointermove').map(e => e.x)).toEqual([0, 1]);
    jest.advanceTimersByTime(10);
    recorder.sample('a', 'pointermove', {x: 2});
    expect(recorder.queue.filter(e => e.type === 'pointermove').map(e => e.x)).toEqual([0, 1]);
    jest.advanceTimersByTime(70);
    recorder.sample('a', 'pointermove', {x: 3});
    recorder.drainSamples();
    expect(recorder.queue.filter(e => e.type === 'pointermove').map(e => e.x)).toEqual([0, 1, 3]);
});

test('controller callbacks capture slider values without replacing application handlers', () => {
    recorder.start();
    const domElement = control('<div class="controller number"><input value="3"></div>');
    notifyUIRecordingObserver({domElement, getValue: () => 12.5});
    notifyUIRecordingObserver({domElement, getValue: () => 14}, true);
    expect(recorder.queue.at(-2)).toMatchObject({type: 'control_change', target: {value: 12.5}});
    expect(recorder.queue.at(-1)).toMatchObject({type: 'control_finish', target: {value: 14}});
});

test('failed uploads retry the same sequences and clear only acknowledged events', async () => {
    recorder.start();
    fetch.mockRejectedValueOnce(new Error('offline'));
    await recorder.flush();
    const original = JSON.parse(fetch.mock.calls[0][1].body);
    expect(recorder.queue.length).toBeGreaterThan(0);
    recorder.record('click', {target: {path: 'Save'}});
    await recorder.flush();
    expect(fetch).toHaveBeenCalledTimes(1); // backoff
    jest.advanceTimersByTime(5000);
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const retry = JSON.parse(fetch.mock.calls[1][1].body);
    expect(retry.session).toBe(original.session);
    expect(retry.events[0]).toEqual(original.events[0]);
    expect(recorder.queue).toEqual([]);
});

test('beacons remain unacknowledged and survive a reload for the same account', async () => {
    recorder.start();
    Object.defineProperty(navigator, 'sendBeacon', {configurable: true, value: jest.fn(() => true)});
    await recorder.flush(true);
    expect(recorder.queue).toHaveLength(1);
    const resumed = new InputRecorder({url: '/inputlog.php', userID: 1});
    expect(resumed.session).not.toBe(recorder.session);
    expect(resumed.recovery).toEqual([{session: recorder.session, events: recorder.queue}]);
    const otherUser = new InputRecorder({url: '/inputlog.php', userID: 99999999});
    expect(otherUser.queue).toEqual([]);
    navigator.sendBeacon.mockReturnValue(false);
    await recorder.flush(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(recorder.queue).toEqual([]);
});

test('batching counts UTF-8 bytes and never clears events past the acknowledgement', async () => {
    recorder.start();
    for (let i = 0; i < 200; i++) recorder.record('click', {target: {path: '天'.repeat(300)}});
    await recorder.flush();
    const body = fetch.mock.calls[0][1].body;
    expect(new TextEncoder().encode(body).length).toBeLessThan(48000);
    expect(recorder.queue.length).toBeGreaterThan(0);
    expect(recorder.queue[0].seq).toBe(JSON.parse(body).events.at(-1).seq + 1);
});

test('an invalid acknowledgement retains events and revocation removes listeners and pending data', async () => {
    recorder.start();
    fetch.mockResolvedValueOnce({ok: true, status: 200, json: async () => ({success: true})});
    await recorder.flush();
    expect(recorder.queue).toHaveLength(1);
    recorder.retryAt = 0;
    fetch.mockResolvedValueOnce({ok: false, status: 403});
    await recorder.flush();
    expect(recorder.active).toBe(false);
    expect(sessionStorage.getItem(recorder.storageKey)).toBeNull();
    document.body.dispatchEvent(new MouseEvent('click', {bubbles: true}));
    expect(recorder.queue).toEqual([]);
});

test('buffer overflow is reported as a gap after a successful upload', async () => {
    recorder.start();
    for (let i = 0; i < 1100; i++) recorder.record('click');
    expect(recorder.queue).toHaveLength(1000);
    await recorder.flush();
    expect(recorder.queue.at(-1)).toMatchObject({type: 'gap', count: 101});
});
