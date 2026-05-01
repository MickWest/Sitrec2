// Predicates for the altitudeLock / altitudeLockAGL property pair used by
// track-like nodes that support a fixed-altitude or ground-relative lock.
// Three distinct node classes carry these fields without a shared base:
//   - CNodeMISBDataTrack  (KLV/MISB tracks)
//   - CNodeOSDDataSeriesTrack  (OSD-derived tracks)
//   - CNodeSplineEdit  (manually edited spline tracks)
// so the checks live as free functions rather than methods on a base class.
//
// Schema:
//   altitudeLock     — number. -1 (or undefined) means the lock is OFF;
//                      values >= 0 are the lock's altitude in meters.
//   altitudeLockAGL  — boolean. true → lock is terrain-relative (height above
//                      ground); false → lock is HAE (absolute altitude).

// True iff the altitude lock is currently active (not the -1 sentinel).
export function isAltitudeLockActive(node) {
    return node.altitudeLock !== undefined && node.altitudeLock >= 0;
}

// True iff the altitude lock is active AND in ground-relative mode. This is
// the predicate that determines whether the track's positions depend on
// terrain — the most common reason callers need this check.
export function isAGLLockActive(node) {
    return isAltitudeLockActive(node) && !!node.altitudeLockAGL;
}
