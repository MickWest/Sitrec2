import assert from "node:assert/strict";
import test from "node:test";
import {
    DEFAULT_IDLE_TIMEOUT_MS,
    idleTimeoutIsExplicit,
    isAnchorBridge,
    parseIdleTimeout,
    rankTakeoverCandidates,
    shouldIdleExit,
    shouldReleasePort,
} from "../lifecycle.js";

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

// ── Port lease ──────────────────────────────────────────────────────────────

const releasable = {
    bound: true,
    paired: null,
    busy: false,
    everUsed: false,
    isActiveFallback: false,
    isAnchor: false,
    hasLocalComputeClients: false,
    msSinceActivity: 10 * 60 * 1000,
};

test("a bridge that has never relayed a call gives its port back", () => {
    // The measured failure: 7 of 20 ports held by bg-spare / --remote-control / codex app-server
    // children that had served zero tool calls between them.
    assert.equal(shouldReleasePort(releasable), true);
    // ...but not before the grace period is up.
    assert.equal(shouldReleasePort({...releasable, msSinceActivity: 1000}), false);
});

test("a used-but-quiet bridge waits far longer than an unused one", () => {
    const used = {...releasable, everUsed: true, msSinceActivity: 5 * 60 * 1000};
    assert.equal(shouldReleasePort(used), false);
    assert.equal(shouldReleasePort({...used, msSinceActivity: 31 * 60 * 1000}), true);
});

test("work in flight, a paired sandbox, or a Local Compute client all pin the port", () => {
    assert.equal(shouldReleasePort({...releasable, busy: true}), false);
    assert.equal(shouldReleasePort({...releasable, paired: "http://localhost:8081"}), false);
    assert.equal(shouldReleasePort({...releasable, hasLocalComputeClients: true}), false);
    assert.equal(shouldReleasePort({...releasable, bound: false}), false);
});

test("the bridge the extension is talking to keeps its port", () => {
    assert.equal(shouldReleasePort({...releasable, isActiveFallback: true}), false);
});

test("the anchor keeps its port so the range never goes empty", () => {
    // Local Compute discovers the bridge by scanning the port range from the page, with no MCP
    // call involved. If every bridge released, that discovery would find nothing.
    assert.equal(shouldReleasePort({...releasable, isAnchor: true}), false);
});

test("exactly one bridge considers itself the anchor", () => {
    const statuses = [
        {service: "SitrecBridge", pid: 30, pairedOrigin: null, bound: true, startedAt: 300},
        {service: "SitrecBridge", pid: 10, pairedOrigin: null, bound: true, startedAt: 100},
        {service: "SitrecBridge", pid: 20, pairedOrigin: null, bound: true, startedAt: 200},
    ];
    assert.equal(isAnchorBridge(statuses, 10), true);
    assert.equal(isAnchorBridge(statuses, 20), false);
    assert.equal(isAnchorBridge(statuses, 30), false);
});

test("anchor selection ignores unbound bridges, paired sandboxes and other services", () => {
    const statuses = [
        {service: "SitrecBridge", pid: 10, pairedOrigin: null, bound: false, startedAt: 100},
        {service: "SitrecBridge", pid: 20, pairedOrigin: "http://localhost:8081", bound: true, startedAt: 150},
        {service: "SomethingElse", pid: 30, pairedOrigin: null, bound: true, startedAt: 175},
        {service: "SitrecBridge", pid: 40, pairedOrigin: null, bound: true, startedAt: 200},
    ];
    assert.equal(isAnchorBridge(statuses, 40), true);
    assert.equal(isAnchorBridge(statuses, 10), false);
});

test("a lone bridge with nothing bound anywhere is the anchor", () => {
    assert.equal(isAnchorBridge([], 99), true);
});

test("takeover prefers bridges that have never been used", () => {
    const base = {
        service: "SitrecBridge", parentPid: 10, pairedOrigin: null,
        busy: false, controlToken: "t", startedAt: 100, lastMcpActivityAt: 100,
    };
    const statuses = [
        {...base, port: 9799, everUsed: true, lastMcpActivityAt: 50},
        {...base, port: 9797, everUsed: false},
    ];
    // Never-used first, even though the used one has the older activity timestamp.
    assert.deepEqual(rankTakeoverCandidates(statuses, 10).map((s) => s.port), [9797, 9799]);
});

test("takeover never targets a bridge whose port is pinned", () => {
    // These must match the pins in shouldReleasePort. releasePort() force-closes the extension and
    // Local Compute sockets, so a peer must not be able to take what a self-check would refuse.
    const base = {
        service: "SitrecBridge", parentPid: 10, pairedOrigin: null,
        busy: false, controlToken: "t", startedAt: 100, lastMcpActivityAt: 100, everUsed: false,
    };
    const statuses = [
        {...base, port: 9799, isActiveFallback: true},
        {...base, port: 9798, localComputeClients: 1},
        {...base, port: 9797, busy: true},
        {...base, port: 9796},
    ];
    assert.deepEqual(rankTakeoverCandidates(statuses, 10).map((s) => s.port), [9796]);
});

test("pre-v5 bridges, which report no pins, stay eligible for takeover", () => {
    // Old bridges have no isActiveFallback/localComputeClients fields at all. Treating undefined as
    // "pinned" would make them un-reclaimable and could wedge a full range.
    const legacy = {
        service: "SitrecBridge", port: 9799, parentPid: 10, pairedOrigin: null,
        busy: false, controlToken: "t", startedAt: 100, lastMcpActivityAt: 100,
    };
    assert.deepEqual(rankTakeoverCandidates([legacy], 10).map((s) => s.port), [9799]);
});
