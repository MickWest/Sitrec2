/**
 * @jest-environment jsdom
 */
// A file with a multi-track picker asks the load-order pairing question inside the picker,
// as a checkbox ticked by default, so the user is asked once. See
// TrackManager.shouldAskLoadOrderPairing.

import {showMultiTrackLoadDialog} from "../src/TrackFilterDialog";
import {Globals} from "../src/Globals";
import {t} from "../src/i18n";

const previewInfos = [0, 1, 2].map(trackIndex => ({trackIndex, shortName: "N" + trackIndex, altMinFt: 0, altMaxFt: 1000}));

function button(label) {
    return [...document.querySelectorAll("button")].find(b => b.textContent === label);
}

function pairCheckbox() {
    return document.querySelector("input[type=checkbox]");
}

afterEach(() => {
    document.body.innerHTML = "";
    Globals.regression = false;
});

test("the checkbox is in the picker, ticked, and Load All keeps the pairing", async () => {
    const result = showMultiTrackLoadDialog(previewInfos, false, null, {askPairing: true});
    expect(document.body.textContent).toContain(t("trackManager.pairTracks.checkbox"));
    expect(pairCheckbox().checked).toBe(true);
    button("Load All").click();
    expect(await result).toEqual({selected: [0, 1, 2], pairByLoadOrder: true});
});

test("clearing the checkbox turns the pairing down", async () => {
    const result = showMultiTrackLoadDialog(previewInfos, false, null, {askPairing: true});
    pairCheckbox().click();
    button("Load All").click();
    expect(await result).toEqual({selected: [0, 1, 2], pairByLoadOrder: false});
});

test("the answer carries through Select...", async () => {
    const result = showMultiTrackLoadDialog(previewInfos, false, null, {askPairing: true});
    pairCheckbox().click();
    button("Select...").click();
    button("OK").click();
    expect(await result).toEqual({selected: [0, 1, 2], pairByLoadOrder: false});
});

test("without askPairing there is no checkbox, and the pairing is kept", async () => {
    const result = showMultiTrackLoadDialog(previewInfos, false, null);
    expect(pairCheckbox()).toBeNull();
    button("Load All").click();
    expect(await result).toEqual({selected: [0, 1, 2], pairByLoadOrder: true});
});

test("the regression harness gets every track and the pairing, with no dialog", async () => {
    Globals.regression = true;
    const result = await showMultiTrackLoadDialog(previewInfos, false, null, {askPairing: true});
    expect(document.querySelector("button")).toBeNull();
    expect(result).toEqual({selected: [0, 1, 2], pairByLoadOrder: true});
});
