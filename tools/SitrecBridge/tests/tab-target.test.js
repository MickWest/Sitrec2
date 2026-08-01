import assert from "node:assert/strict";
import test from "node:test";
import {normalizeTabArgs} from "../tab-target.js";

test("tabId is accepted as an alias for tab", () => {
    assert.deepEqual(normalizeTabArgs({tabId: 12345, expression: "1+1"}),
        {tab: 12345, expression: "1+1"});
    assert.deepEqual(normalizeTabArgs({tabId: "local.metabunk.org"}),
        {tab: "local.metabunk.org"});
});

test("tab is passed through untouched", () => {
    assert.deepEqual(normalizeTabArgs({tab: 7, view: "mainView"}), {tab: 7, view: "mainView"});
    assert.deepEqual(normalizeTabArgs({}), {});
    assert.deepEqual(normalizeTabArgs(undefined), undefined);
});

test("tab and tabId agreeing is fine, disagreeing is refused", () => {
    assert.deepEqual(normalizeTabArgs({tab: 5, tabId: "5"}), {tab: "5"});
    assert.throws(() => normalizeTabArgs({tab: 5, tabId: 6}), /Conflicting tab targets/);
});

// The bug this guards: an unrecognised tab key used to be dropped silently, and
// the command then ran against the default tab — plausible-looking results from
// the wrong page.
test("misspelled tab parameters are refused, never silently ignored", () => {
    for (const key of ["tabID", "tabid", "tabTarget", "tab_id"]) {
        assert.throws(() => normalizeTabArgs({[key]: 99}), /Unknown tab parameter/,
            `${key} should be refused`);
    }
});

test("non-tab parameters are left alone", () => {
    const args = {expression: "tabulate()", frame: 10, quality: 75};
    assert.deepEqual(normalizeTabArgs(args), args);
});
