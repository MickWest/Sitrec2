import assert from "node:assert/strict";
import test from "node:test";
import {DEFAULT_IDLE_TIMEOUT_MS, idleTimeoutIsExplicit, parseIdleTimeout, rankTakeoverCandidates, shouldIdleExit} from "../lifecycle.js";

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

test("idleTimeoutIsExplicit distinguishes an asked-for timeout from the default", () => {
    assert.equal(idleTimeoutIsExplicit(undefined), false);
    assert.equal(idleTimeoutIsExplicit(""), false);
    assert.equal(idleTimeoutIsExplicit("invalid"), false);
    assert.equal(idleTimeoutIsExplicit("-1"), false);
    assert.equal(idleTimeoutIsExplicit("0"), true);
    assert.equal(idleTimeoutIsExplicit("1500"), true);
});

test("a quiet bridge whose parent is still working is NOT reaped", () => {
    // The bug this exists for: a Claude Code session that spends two hours editing, building and
    // running tests makes no MCP calls at all, and the bridge used to read that as abandonment
    // and shut itself down mid-task.
    const base = {idleTimeoutMs: 1000, explicit: false, busy: false, msSinceActivity: 999999};
    assert.equal(shouldIdleExit({...base, parentAlive: true}), false);
    // Once the parent really has gone, the default timeout does reap it.
    assert.equal(shouldIdleExit({...base, parentAlive: false}), true);
});

test("an explicitly configured idle timeout is obeyed literally", () => {
    // Tests, sandbox supervisors and CI ask for a hard reap and must keep getting one.
    const base = {idleTimeoutMs: 200, explicit: true, busy: false, msSinceActivity: 500};
    assert.equal(shouldIdleExit({...base, parentAlive: true}), true);
    assert.equal(shouldIdleExit({...base, parentAlive: false}), true);
});

test("idle exit never fires while work is in flight, or before the timeout", () => {
    const base = {idleTimeoutMs: 200, explicit: true, parentAlive: false};
    assert.equal(shouldIdleExit({...base, busy: true, msSinceActivity: 999999}), false);
    assert.equal(shouldIdleExit({...base, busy: false, msSinceActivity: 199}), false);
    // A zero/disabled timeout means never.
    assert.equal(shouldIdleExit({idleTimeoutMs: 0, explicit: true, busy: false,
        msSinceActivity: 999999, parentAlive: false}), false);
});
