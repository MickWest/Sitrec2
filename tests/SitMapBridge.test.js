import {SitMapClient} from "../src/SitMapBridge";

function harness() {
    const sent = [];
    let receive;
    const window = {location: {origin: "https://local.metabunk.org"},
        addEventListener: (_, fn) => { receive = fn; }, postMessage: data => sent.push(data)};
    let camera = {latitude: 37, longitude: -122, altitudeMSL: 1000, heading: 0, elevation: -40, verticalFov: 20};
    const client = new SitMapClient({targetWindow: window, sampleCamera: () => ({...camera})});
    const reply = data => receive({source: window, origin: window.location.origin, data: {source: "sitmap-extension", ...data}});
    return {client, sent, reply, setCamera: value => { camera = {...camera, ...value}; }};
}
beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

test("sync sends the initial camera then only changed rendered poses", async () => {
    const h = harness();
    const start = h.client.startSync();
    h.reply({id: h.sent[0].id, result: {connected: true}}); await start;
    expect(h.sent.at(-1).action).toBe("pose");
    expect(h.sent.at(-1).params.sequence).toBe(1);
    h.client.publish(); expect(h.sent).toHaveLength(2);
    h.setCamera({heading: 10}); h.client.publish();
    expect(h.sent.at(-1).params.camera.heading).toBe(10);
    expect(h.sent.at(-1).params.sequence).toBe(2);
    h.reply({live: {type: "applied", sequence: 2, sentAt: 1000, appliedAt: 1012}});
    expect(h.client.sync.lastLatencyMs).toBe(12);
    const stop = h.client.stopSync(); h.reply({id: h.sent.at(-1).id, result: {stopped: true}}); await stop;
    h.setCamera({heading: 20}); const count = h.sent.length; h.client.publish(); expect(h.sent).toHaveLength(count);
});
test("reconnect republishes an unchanged camera and errors remain visible", async () => {
    const h = harness(); const start = h.client.startSync();
    h.reply({id: h.sent[0].id, result: {connected: true}}); await start;
    h.reply({live: {type: "reconnecting"}}); expect(h.client.sync.connected).toBe(false);
    h.reply({live: {type: "ready"}}); h.client.publish(); expect(h.sent.at(-1).params.sequence).toBe(2);
    h.reply({live: {type: "error", error: "Invalid altitude"}}); expect(h.client.sync.error).toBe("Invalid altitude");
});
test("missing extension times out without enabling a sync loop", async () => {
    const h = harness(); const result = h.client.startSync();
    const rejected = expect(result).rejects.toThrow(/SitMap did not respond/);
    jest.advanceTimersByTime(6500); await rejected;
    expect(h.client.sync.enabled).toBe(false); expect(h.client.pending.size).toBe(0);
});

test("stopping while the start reply is pending does not re-enable sync", async () => {
    const h = harness();
    const start = h.client.startSync(), startID = h.sent.at(-1).id;
    const stop = h.client.stopSync(), stopID = h.sent.at(-1).id;
    h.reply({id: startID, result: {connected: true}}); await start;
    h.reply({id: stopID, result: {stopped: true}}); await stop;
    expect(h.client.sync.enabled).toBe(false);
    expect(h.sent.some(message => message.action === "pose")).toBe(false);
});

test("native pitch acknowledgements refine the source terrain without a render or feedback loop", async () => {
    const h = harness(), sample = h.client.sampleCamera;
    h.client.sampleCamera = (view, pitch) => ({...sample(view),
        ...(pitch === 35 ? {sourceGroundTarget: {latitude: 37, longitude: -122,
            altitudeMSL: 100, distance: 1100, pitch}} : {})});
    const start = h.client.startSync(); h.reply({id: h.sent[0].id, result: {connected: true}}); await start;
    h.reply({live: {type: "applied", sequence: 1, nativePitch: 35, sentAt: 10, appliedAt: 20}});
    expect(h.sent.at(-1).params.camera.sourceGroundTarget.pitch).toBe(35);
    expect(h.sent.at(-1).params.sequence).toBe(2);
    const count = h.sent.length;
    h.reply({live: {type: "applied", sequence: 2, nativePitch: 35.00000001, sentAt: 20, appliedAt: 30}});
    expect(h.sent).toHaveLength(count);
});

test("one-shot requests also refine terrain when MapKit clamps pitch", async () => {
    const h = harness(), sample = h.client.sampleCamera;
    h.client.sampleCamera = (view, pitch) => ({...sample(view),
        ...(pitch === 35 ? {sourceGroundTarget: {latitude: 37, longitude: -122,
            altitudeMSL: 100, distance: 1100, pitch}} : {})});
    const request = h.client.sendView();
    h.reply({id: h.sent[0].id, result: {applied: {pitch: 35}}});
    await Promise.resolve();
    expect(h.sent.at(-1).params.sourceGroundTarget.pitch).toBe(35);
    h.reply({id: h.sent.at(-1).id, result: {applied: {pitch: 35}, refined: true}});
    expect((await request).refined).toBe(true);
});
