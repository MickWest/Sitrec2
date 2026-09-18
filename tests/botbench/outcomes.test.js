import {summarizeOutcomeCounts} from "../../src/analysis/BotBenchOutcome";

test("count explicit fits separately from evidence sufficiency and object identification", () => {
    const rows = [
        {verdictCode: "consistent-one", viableClasses: ["multirotor"],
            pathCompatibleClasses: ["bird", "quadcopter", "smallUAS"]},
        {verdictCode: "consistent-several", viableClasses: ["balloon", "fixedWing"], pathCompatibleClasses: []},
        {verdictCode: "insufficient", viableClasses: [], pathCompatibleClasses: []},
        // Circular evidence can still supply a fit; the evidence warning must
        // remain visible without pretending the fit identified an object.
        {verdictCode: "insufficient", viableClasses: ["balloon"], pathCompatibleClasses: ["balloon"]},
        {verdictCode: "unresolved", viableClasses: [], pathCompatibleClasses: ["bird"]},
        {verdictCode: "future-code"},
    ];
    expect(summarizeOutcomeCounts(rows)).toEqual({modelFits: 3, modelAssessed: 5,
        compatiblePaths: 3, compatibilityAssessed: 5, insufficient: 2, maxRangeConflicts: 0});
});

test("legacy rows without recorded compatibility are unknown, not an empty compatible set", () => {
    const result = summarizeOutcomeCounts([
        {verdictCode: "consistent-one"},
        {verdictCode: "probably-balloon", viableClasses: ["balloon"]},
        {viableClasses: [], pathCompatibleClasses: []},
    ]);
    expect(result.modelAssessed).toBe(2);
    expect(result.modelFits).toBe(1);
    expect(result.compatibilityAssessed).toBe(1);
    expect(result.compatiblePaths).toBe(0);
});

test("a selected-path MaxRange conflict is reported independently of other fits", () => {
    const top = {key: "lantern", name: "Balloon"};
    const result = summarizeOutcomeCounts([
        {top, viableClasses: ["balloon", "fixedWing"], maxRangeViolations: [top, top]},
        {top, viableClasses: ["balloon"], maxRangeViolations: [{key: "lantern", name: "Other"}]},
        {maxRangeViolations: [{}]},
    ]);
    expect(result.modelFits).toBe(2);
    expect(result.maxRangeConflicts).toBe(1);
});
