// Level platform paths made from exact straight lines and circular arcs.
// Segment fractions span the entire clip at any positive duration; the turn
// rate stays fixed in physical seconds instead of scaling with clip length.
const DEG = Math.PI / 180;
const G = 9.80665;

function advance(x, y, heading, speed, rate, seconds) {
    const angle = rate * seconds, half = angle / 2;
    const distance = speed * seconds * (Math.abs(half) < 1e-8 ? 1 - half * half / 6 : Math.sin(half) / half);
    return {x: x + distance * Math.sin(heading + half),
        y: y + distance * Math.cos(heading + half), headingRad: heading + angle};
}

export function buildTurnProgram(spec, durationSeconds) {
    if (spec.masterDurationSeconds != null) {
        const {masterDurationSeconds, timeOffsetSeconds = 0, centerSeconds = 0, ...base} = spec;
        if (timeOffsetSeconds < 0 || timeOffsetSeconds + durationSeconds > masterDurationSeconds) {
            throw new Error("turn-program: crop outside master timeline");
        }
        const master = buildTurnProgram(base, masterDurationSeconds);
        const origin = master.state(centerSeconds);
        const segments = master.profile.segments
            .filter(s => s.endSeconds > timeOffsetSeconds && s.startSeconds < timeOffsetSeconds + durationSeconds)
            .map(s => {
                const start = Math.max(timeOffsetSeconds, s.startSeconds);
                const end = Math.min(timeOffsetSeconds + durationSeconds, s.endSeconds);
                const state = master.state(start);
                return {...s, startSeconds: start - timeOffsetSeconds, endSeconds: end - timeOffsetSeconds,
                    durationSeconds: end - start, startX: state.x - origin.x, startY: state.y - origin.y,
                    startHeadingDeg: state.headingRad / DEG, endHeadingDeg: master.state(end).headingRad / DEG};
            });
        const turns = segments.filter(s => s.kind === "turn");
        return {state(t, frame, fps) {
            // Integer frame arithmetic gives bit-identical shared samples at 1 and 10 Hz.
            const time = frame == null ? t + timeOffsetSeconds : (timeOffsetSeconds * fps + frame) / fps;
            const s = master.state(time);
            return {...s, x: s.x - origin.x, y: s.y - origin.y};
        }, minimumRadiusM: master.minimumRadiusM,
        profile: {...master.profile, durationSeconds, masterDurationSeconds, timeOffsetSeconds, centerSeconds,
            segments, turnCount: turns.length, straightCount: segments.length - turns.length,
            turnDurationSeconds: turns.reduce((sum, s) => sum + s.durationSeconds, 0),
            totalHeadingChangeDeg: segments.reduce((sum, s) => sum + s.turnRateDegS * s.durationSeconds, 0),
            totalAbsoluteHeadingChangeDeg: segments.reduce((sum, s) => sum + Math.abs(s.turnRateDegS) * s.durationSeconds, 0),
            model: "Centered crop of one fixed master straight/arc trajectory; physical timing and turn rates are unchanged."}};
    }
    const speed = spec.speedMS ?? 70, headingDeg = spec.headingDeg ?? 90;
    if (!(Number.isFinite(durationSeconds) && durationSeconds > 0)
        || !(Number.isFinite(speed) && speed > 0) || !Number.isFinite(headingDeg)
        || !Array.isArray(spec.segments) || !spec.segments.length
        || spec.segments.some(s => !(Number.isFinite(s.fraction) && s.fraction > 0) || !Number.isFinite(s.turnRateDegS))) {
        throw new Error("turn-program: needs positive duration/speed and finite weighted segments");
    }
    const total = spec.segments.reduce((sum, s) => sum + s.fraction, 0);
    let fraction = 0, time = 0, state = {x: 0, y: 0, headingRad: headingDeg * DEG};
    const segments = spec.segments.map((s, i) => {
        fraction += s.fraction;
        const endSeconds = i === spec.segments.length - 1 ? durationSeconds : durationSeconds * fraction / total;
        const rate = s.turnRateDegS * DEG;
        const segment = {startSeconds: time, endSeconds, durationSeconds: endSeconds - time,
            kind: rate === 0 ? "straight" : "turn", turnRateDegS: s.turnRateDegS,
            bankDeg: Math.atan(speed * rate / G) / DEG,
            startHeadingDeg: state.headingRad / DEG, startX: state.x, startY: state.y};
        state = advance(state.x, state.y, state.headingRad, speed, rate, segment.durationSeconds);
        segment.endHeadingDeg = state.headingRad / DEG;
        time = endSeconds;
        return segment;
    });
    const turns = segments.filter(s => s.kind === "turn");
    const maxRateDegS = Math.max(...segments.map(s => Math.abs(s.turnRateDegS)));
    return {
        state(t) {
            const seconds = Math.max(0, Math.min(durationSeconds, t));
            const s = segments.find(segment => seconds < segment.endSeconds) ?? segments[segments.length - 1];
            return advance(s.startX, s.startY, s.startHeadingDeg * DEG, speed,
                s.turnRateDegS * DEG, seconds - s.startSeconds);
        },
        minimumRadiusM: maxRateDegS ? speed / (maxRateDegS * DEG) : Infinity,
        profile: {variant: spec.variant, category: spec.category, speedMS: speed,
            headingDeg, durationSeconds, segments, turnCount: turns.length,
            straightCount: segments.length - turns.length,
            turnDurationSeconds: turns.reduce((sum, s) => sum + s.durationSeconds, 0),
            totalHeadingChangeDeg: segments.reduce((sum, s) => sum + s.turnRateDegS * s.durationSeconds, 0),
            totalAbsoluteHeadingChangeDeg: segments.reduce((sum, s) => sum + Math.abs(s.turnRateDegS) * s.durationSeconds, 0),
            maxTurnRateDegS: maxRateDegS,
            maxBankDeg: Math.max(...segments.map(s => Math.abs(s.bankDeg))),
            model: "Exact level straight/arc segments; velocity continuous, bank changes at joins. Segment timing scales with duration; turn rates do not."},
    };
}
