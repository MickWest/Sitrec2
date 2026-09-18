/** @jest-environment jsdom */
import {updateSummary} from "../../src/analysis/BotBenchUI";

test("the rendered summary separates fits, compatibility, evidence and MaxRange warnings", () => {
    const summary = document.createElement("div");
    const top = {key: "lantern", name: "Balloon", errDeg: 0.01};
    const rows = [
        {viableClasses: ["balloon"], pathCompatibleClasses: ["bird", "quadcopter"],
            verdictCode: "consistent-one", top, maxRangeViolations: [top]},
        {viableClasses: [], pathCompatibleClasses: [], verdictCode: "insufficient"},
        {viableClasses: ["balloon", "fixedWing"], verdictCode: "consistent-several"},
    ];
    updateSummary({summary, entries: rows.map(row => ({status: "done", row: {...row, quality: {}}}))});
    const cells = Object.fromEntries([...summary.children].map(cell =>
        [cell.children[0].textContent, cell.children[1].textContent]));
    expect(cells.Resolved).toBeUndefined();
    expect(cells["Model fits"]).toBe("2/3");
    expect(cells["Compatible paths"]).toBe("1/2");
    expect(cells["Insufficient evidence"]).toBe("1");
    expect(cells["MaxRange conflicts"]).toBe("1");
    expect(summary.textContent).not.toMatch(/NaN|undefined/);
});

test("an empty run renders an empty denominator without implying a success rate", () => {
    const summary = document.createElement("div");
    updateSummary({summary, entries: []});
    expect(summary.textContent).toContain("Model fits0/0");
    expect(summary.textContent).not.toContain("Resolved");
    expect(summary.textContent).not.toContain("MaxRange conflicts");
});
