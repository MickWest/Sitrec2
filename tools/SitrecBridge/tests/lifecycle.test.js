import assert from "node:assert/strict";
import test from "node:test";
import {DEFAULT_IDLE_TIMEOUT_MS, parseIdleTimeout, rankTakeoverCandidates} from "../lifecycle.js";

test("parseIdleTimeout accepts zero and positive values", () => {
    assert.equal(parseIdleTimeout(undefined), DEFAULT_IDLE_TIMEOUT_MS);
    assert.equal(parseIdleTimeout("0"), 0);
    assert.equal(parseIdleTimeout("1500"), 1500);
    assert.equal(parseIdleTimeout("invalid"), DEFAULT_IDLE_TIMEOUT_MS);
    assert.equal(parseIdleTimeout("-1"), DEFAULT_IDLE_TIMEOUT_MS);
});

test("rankTakeoverCandidates uses least-recently-used order with same-parent tie-breaking", () => {
    const statuses = [
        {
            service: "SitrecBridge", port: 9799, parentPid: 10, pairedOrigin: null,
            busy: false, controlToken: "a", startedAt: 100, lastMcpActivityAt: 300,
        },
        {
            service: "SitrecBridge", port: 9798, parentPid: 20, pairedOrigin: null,
            busy: false, controlToken: "b", startedAt: 50, lastMcpActivityAt: 200,
        },
        {
            service: "SitrecBridge", port: 9797, parentPid: 10, pairedOrigin: null,
            busy: false, controlToken: "c", startedAt: 200, lastMcpActivityAt: 200,
        },
        {
            service: "SitrecBridge", port: 9796, parentPid: 20, pairedOrigin: null,
            busy: false, controlToken: "d", startedAt: 25, lastMcpActivityAt: 50,
        },
    ];

    assert.deepEqual(
        rankTakeoverCandidates(statuses, 10).map((status) => status.port),
        [9796, 9797, 9798, 9799]
    );
});

test("rankTakeoverCandidates excludes busy, paired, and unrelated services", () => {
    const base = {
        service: "SitrecBridge", parentPid: 10, pairedOrigin: null,
        busy: false, controlToken: "token", startedAt: 100, lastMcpActivityAt: 100,
    };
    const statuses = [
        {...base, port: 9799, busy: true},
        {...base, port: 9798, pairedOrigin: "http://localhost:8081"},
        {...base, port: 9797, service: "SomethingElse"},
        {...base, port: 9796},
    ];

    assert.deepEqual(rankTakeoverCandidates(statuses, 10).map((status) => status.port), [9796]);
});
