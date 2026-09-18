/** Factual run counts. No verdict string is interpreted as identification. */
export function summarizeOutcomeCounts(rows) {
    const count = {modelFits: 0, modelAssessed: 0, compatiblePaths: 0,
        compatibilityAssessed: 0, insufficient: 0, maxRangeConflicts: 0};
    for (const row of rows) {
        if (Array.isArray(row.viableClasses)) {
            count.modelAssessed++;
            if (row.viableClasses.length) count.modelFits++;
        }
        if (Array.isArray(row.pathCompatibleClasses)) {
            count.compatibilityAssessed++;
            if (row.pathCompatibleClasses.length) count.compatiblePaths++;
        }
        if (row.verdictCode === "insufficient") count.insufficient++;
        // A conflict is a separate input constraint warning, not a subtraction
        // from an identification count or evidence that every other fit failed.
        if (row.top && (row.maxRangeViolations ?? []).some(v =>
            v.key === row.top.key && v.name === row.top.name)) count.maxRangeConflicts++;
    }
    return count;
}
