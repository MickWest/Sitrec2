import {assessBrightTripleIdentification, minimumIdentifyObservations,
    unconfirmedIdentificationStatus} from '../src/starTrack/StarIdentificationPolicy';

const width = 1080, height = 1920;
function fieldReport() {
    // A known pinhole field: image y down, with six independently placed stars.
    const points = [[-200, -300], [180, -250], [-150, 230], [210, 300], [-50, 100], [100, -40]];
    const matches = points.map(([x, y], index) => {
        const dir = [1, -x / 1800, -y / 1800], length = Math.hypot(...dir);
        return {star: {x: width / 2 + x, y: height / 2 + y, index},
            object: {raDeg: Math.atan2(dir[1], dir[0]) * 180 / Math.PI,
                decDeg: Math.asin(dir[2] / length) * 180 / Math.PI, label: `star ${index}`}};
    });
    const best = {matches, nMatched: matches.length, nMissing: 0, rmsPx: 0.1};
    return {ok: true, best, candidates: [best], nFitting: 1};
}

test('a consistent field with independent supporting stars can set up the camera', () => {
    expect(assessBrightTripleIdentification(fieldReport(), width, height).accepted).toBe(true);
});

test('a triangle alone does not independently verify its proposed names', () => {
    const report = fieldReport();
    report.best.matches.length = 3;
    report.best.nMatched = 3;
    expect(assessBrightTripleIdentification(report, width, height)).toMatchObject({accepted: false});
});

test('equally plausible patterns remain unconfirmed even if each fits closely', () => {
    const report = fieldReport();
    report.candidates.push({...report.best, rmsPx: 0.11});
    expect(assessBrightTripleIdentification(report, width, height)).toEqual({accepted: false,
        reason: 'multiple star patterns fit about equally well'});
});

test('missing bright stars count against the proposed field', () => {
    const report = fieldReport();
    report.best.nMissing = 7;
    expect(assessBrightTripleIdentification(report, width, height).accepted).toBe(false);
});

test('checks all proposed matches, not just the original three-point fit residual', () => {
    const report = fieldReport();
    report.best.matches[5].star.x += 30;
    expect(assessBrightTripleIdentification(report, width, height).accepted).toBe(false);
});

test('Enough uses the measured duration for persistent candidate eligibility', () => {
    expect(minimumIdentifyObservations(194)).toBe(25);
    expect(minimumIdentifyObservations(100)).toBe(15);
    expect(minimumIdentifyObservations(10)).toBe(2);
    expect(minimumIdentifyObservations(194, true)).toBe(1);
});

test('an incomplete identification gives one outcome, the measured range, and a next step', () => {
    const status = unconfirmedIdentificationStatus({frame0: 0, frame1: 193, stoppedEarly: true},
        'only 3 persistent candidate stars; at least 4 are needed');
    expect(status).toContain('No reliable star identification after 194 frames (Enough)');
    expect(status).toContain('Camera, location and time unchanged');
    expect(status).toContain('Analyze more frames or label known stars');
});
