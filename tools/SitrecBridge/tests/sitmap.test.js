import test from "node:test";
import assert from "node:assert/strict";
import {SitMapStream, requestSitMap, isSitMapSender} from "../extension/sitmap.js";

class FakeSocket {
    static instances = [];
    constructor(url, protocol) { this.url = url; this.protocol = protocol; this.readyState = 1; this.sent = []; FakeSocket.instances.push(this); }
    send(value) { this.sent.push(JSON.parse(value)); }
    receive(value) { this.onmessage({data: JSON.stringify(value)}); }
    close() { this.readyState = 3; this.onclose?.(); }
}
test("live stream sends the next frame without waiting, and bounds queued poses", () => {
    const events = [];
    const stream = new SitMapStream({WebSocketImpl: FakeSocket, notify: value => events.push(value)});
    try {
        stream.connect(); const socket = FakeSocket.instances.at(-1);
        assert.equal(socket.url, "ws://127.0.0.1:9877"); assert.equal(socket.protocol, "sitmap-v1");
        stream.offer({sequence: 1}); stream.offer({sequence: 2});
        assert.equal(socket.sent.length, 0);
        socket.receive({type: "ready", apiVersion: 1});
        assert.deepEqual(socket.sent, [{sequence: 2}]);
        stream.offer({sequence: 3}); stream.offer({sequence: 4}); stream.offer({sequence: 5});
        assert.deepEqual(socket.sent, [{sequence: 2}, {sequence: 3}]);
        socket.receive({type: "applied", sequence: 2});
        assert.deepEqual(socket.sent, [{sequence: 2}, {sequence: 3}, {sequence: 5}]);
        assert.equal(events.at(-1).sequence, 2);
        socket.receive({type: "applied", sequence: 5});
        assert.equal(stream.inFlight, false);
    } finally { stream.close(); }
});
test("coalesced native acknowledgements retire every superseded in-flight pose", () => {
    const stream = new SitMapStream({WebSocketImpl: FakeSocket});
    try {
        stream.connect(); const socket = FakeSocket.instances.at(-1);
        socket.receive({type: "ready", apiVersion: 1});
        for (let sequence=1; sequence<=1000; sequence++) stream.offer({sequence});
        assert.deepEqual(socket.sent, [{sequence:1}, {sequence:2}]);
        assert.equal(stream.pending.sequence, 1000);
        socket.receive({type:"applied",sequence:2});
        assert.deepEqual(socket.sent, [{sequence:1}, {sequence:2}, {sequence:1000}]);
        socket.receive({type:"applied",sequence:1000});
        assert.equal(stream.inFlight, false);
    } finally { stream.close(); }
});
test("a replacement connection receives the latest pose and old messages are ignored", () => {
    const stream = new SitMapStream({WebSocketImpl: FakeSocket});
    try {
        stream.connect(); const old = FakeSocket.instances.at(-1);
        stream.offer({sequence: 9}); stream.connect(); const current = FakeSocket.instances.at(-1);
        old.receive({type: "ready", apiVersion: 1}); assert.equal(old.sent.length, 0);
        current.receive({type: "ready", apiVersion: 1}); assert.equal(current.sent[0].sequence, 9);
    } finally { stream.close(); }
});
test("HTTP relay fixes the endpoint and rejects other apps and API errors", async () => {
    let captured;
    await requestSitMap("view", {latitude: 37}, async (url, options) => {
        captured = {url, options}; return {ok: true, json: async () => ({app: "SitMap", apiVersion: 1})};
    });
    assert.equal(captured.url, "http://127.0.0.1:9876/v1/view");
    assert.equal(captured.options.headers["X-SitMap-Client"], "SitrecBridge-v1");
    assert.equal(captured.options.redirect, "error");
    await assert.rejects(requestSitMap("https://elsewhere.test"), /Unknown/);
    await assert.rejects(requestSitMap("status", {}, async () => ({ok: true, json: async () => ({app: "Other"})})), /not SitMap/);
    await assert.rejects(requestSitMap("view", {}, async () => ({ok: false, json: async () => ({error: "Invalid camera"})})), /Invalid camera/);
});
test("only supported Sitrec origins can reach the native relay", () => {
    const sender = url => ({id: "bridge", tab: {url}, url});
    for (const url of ["https://local.metabunk.org/sitrec/", "https://www.metabunk.org/sitrec/", "http://127.0.0.1:8081/", "https://a.sitrec.work/"]) {
        assert.equal(isSitMapSender(sender(url), "bridge"), true);
    }
    for (const url of ["https://evil.test/", "https://www.metabunk.org/forum/", "https://local.metabunk.org.evil.test/", "file:///tmp/index.html"]) {
        assert.equal(isSitMapSender(sender(url), "bridge"), false);
    }
    assert.equal(isSitMapSender(sender("https://local.metabunk.org/"), "other"), false);
});
