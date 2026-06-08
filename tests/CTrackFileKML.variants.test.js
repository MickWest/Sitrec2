/**
 * @jest-environment jsdom
 *
 * Comprehensive, data-driven KML variant test suite.
 *
 * Goal (per Mick): "if Google Earth can load it and time-animate it, Sitrec should
 * import it" — any KML carrying positions + timestamps should yield a track, with only
 * NAME extraction needing source-specific code.
 *
 * This suite was built from an exhaustive sweep of 1,527 real KML/KMZ files
 * (~/Dropbox/Sitrec Resources), which clustered into 37 distinct structural signatures.
 * Each MANIFEST entry below is a representative of one variant family. Fixtures live in:
 *   - data/test/, data/chilean/      (already-committed provider samples)
 *   - tests/kml-fixtures/real/        (small curated copies of real exports)
 *   - tests/kml-fixtures/synthetic/   (hand-authored minimal variants for gaps)
 *
 * Categories:
 *   'track'      - currently imports correctly; asserts invariants.
 *   'not-track'  - correctly recognized as NOT a track (shapes/overlays/empty); must not throw.
 *   'gap'        - SHOULD import but currently does NOT (or imports wrong). Marked test.failing:
 *                  the suite stays green today, and the test FLIPS to failing once the parser
 *                  is made generic — that is the signal to delete the `.failing`.
 */
import fs from 'fs';
import path from 'path';
import {CTrackFileKML} from '../src/TrackFiles/CTrackFileKML';
import {parseXml} from '../src/parseXml';
import {MISB} from '../src/MISBFields';

jest.mock('../src/nodes/CNodeTrack', () => ({
    CNodeTrackFromLLAArray: jest.fn(() => ({setArray: jest.fn(), recalculateCascade: jest.fn()}))
}));
jest.mock('../src/nodes/CNodeDisplayTrack', () => ({CNodeDisplayTrack: jest.fn()}));
jest.mock('../src/LayerMasks', () => ({MASK_WORLD: 1}));
jest.mock('../src/Globals', () => ({
    CustomManager: {shouldIgnore: () => false, ignore: () => {}},
    NodeMan: {getUniqueID: (name) => name},
    Sit: {allowDashInFlightNumber: false},
    Synth3DManager: {addOverlay: jest.fn()},
    FileManager: {kmzImageMap: {}, list: {}},
    // validationMode:true makes assert() a no-op (it skips `debugger`), matching production
    // where assert() is stripped by Terser. Without it, assert() on a false condition would
    // throw (reading .validationMode off an undefined Globals).
    Globals: {validationMode: true},
}));
jest.mock('../src/CFeatureManager', () => ({FeatureManager: {addFeature: jest.fn()}}));

const repo = (rel) => path.join(__dirname, '..', rel);

// ---------------------------------------------------------------------------
// MANIFEST — one representative per variant family discovered in the corpus.
// ---------------------------------------------------------------------------
const MANIFEST = [
    // ---- gx:Track family (ADS-B Exchange) -------------------------------------------------
    {
        cluster: 'C02', family: 'ADSBx multi-aircraft (Folder>Folder[])',
        file: 'data/test/ADSBX - 3 tracks  N2983Z-N410WN-N414WN-track-press_alt_uncorrected.kml',
        category: 'track', trackCount: 3, nameIncludes: 'N2983Z',
    },
    {
        cluster: 'C00', family: 'ADSBx single aircraft, runway(0)+flight(absolute) segments',
        file: 'tests/kml-fixtures/real/adsbx-single-runway-then-flight.kml',
        category: 'track', nameIncludes: 'N410WN',
    },

    // ---- FlightAware (Document, airport markers + gx:Track) --------------------------------
    {
        cluster: 'C04', family: 'FlightAware (Placemark[2] = gx:Track)',
        file: 'data/test/FlightAware_N494SA_KLAX_KIPL_20250602.kml',
        category: 'track', trackCount: 1, nameIncludes: 'N494SA',
    },

    // ---- FR24 Route/Trail (timed Placemark + Point) ---------------------------------------
    {
        cluster: 'C03', family: 'FR24 Route+Trail (2 folders, MultiGeometry)',
        file: 'data/test/FR24 KML WN276-3d7b69c5.kml',
        category: 'track', trackCount: 1,
    },

    // ---- Document-rooted gx:Track ---------------------------------------------------------
    {
        cluster: 'C17', family: 'Document > N gx:Track placemarks (track is Placemark[2] by luck)',
        file: 'data/chilean/Chile Chopper Track from video GPSTime.kml',
        category: 'track',
    },
    {
        cluster: 'C17', family: 'FlightAware "plus Reconstructed" (Document > padded Placemark[2])',
        file: 'tests/kml-fixtures/real/doc-gxtrack-reconstructed.kml',
        category: 'track', nameIncludes: 'IBE6830',
    },
    {
        cluster: 'C24', family: 'Single Document > Placemark > gx:Track',
        file: 'data/chilean/LA330.kml',
        category: 'track',
    },
    {
        cluster: 'F3', family: 'Sitrec own export: Folder > Placemark > gx:Track (fallback branch)',
        file: 'tests/kml-fixtures/synthetic/sitrec-export-single-folder.kml',
        category: 'track',
    },
    {
        cluster: 'docplain', family: 'Document > single Placemark > gx:Track, plain name',
        file: 'tests/kml-fixtures/synthetic/doc-plain-name-single-gxtrack.kml',
        category: 'track', nameIncludes: 'Plain',
    },
    {
        cluster: 'angles', family: 'Spec gx:Track with gx:angles + per-point ExtendedData',
        file: 'tests/kml-fixtures/synthetic/gxtrack-angles-extendeddata.kml',
        category: 'track', nameIncludes: 'N123AB',
    },
    {
        cluster: 'dup', family: 'FR24 Route with duplicate consecutive timestamp',
        file: 'tests/kml-fixtures/synthetic/fr24-duplicate-time.kml',
        category: 'track', trackCount: 1,
    },

    // ---- GroundOverlay (non-track, exercises the overlay extraction path) -----------------
    {
        cluster: 'C10', family: 'GroundOverlay (LatLonBox + Icon)',
        file: 'tests/kml-fixtures/synthetic/ground-overlay.kml',
        category: 'not-track',
    },

    // ---- Non-track content (shapes / overlays / empty) ------------------------------------
    {
        cluster: 'C14', family: 'Buildings/features only (no track)',
        file: 'data/test/Rugeley (Buildings).kml',
        category: 'not-track',
    },
    {
        cluster: 'C23', family: 'Single LineString, no time (static path)',
        file: 'tests/kml-fixtures/real/no-time-single-linestring.kml',
        category: 'not-track',
    },
    {
        cluster: 'C36', family: 'Single elevated LineString, no time',
        file: 'tests/kml-fixtures/real/no-time-elevated-linestring.kml',
        category: 'not-track',
    },
    {
        cluster: 'C35', family: 'Mixed shapes (Point/LineString/Polygon), no time',
        file: 'tests/kml-fixtures/real/no-time-mixed-shapes.kml',
        category: 'not-track',
    },
    {
        cluster: 'C11', family: 'Empty/truncated track export (no placemarks)',
        file: 'tests/kml-fixtures/synthetic/empty-track-export.kml',
        category: 'not-track',
    },

    // ---- GAPS: should import, currently do not (TDD targets) -------------------------------
    {
        cluster: 'C15', family: 'FR24 single "Route" folder, no Trail',
        file: 'tests/kml-fixtures/synthetic/fr24-single-route-no-trail.kml',
        category: 'gap', desiredTrackCount: 1,
    },
    {
        cluster: 'mixed', family: 'Two data sources (gx:Track + FR24 points) in one file',
        file: 'tests/kml-fixtures/synthetic/mixed-sources-one-file.kml',
        category: 'gap', desiredTrackCount: 2,
    },
    {
        cluster: 'deep', family: 'Track nested 3 folders deep',
        file: 'tests/kml-fixtures/synthetic/deep-nested-subfolder-track.kml',
        category: 'gap', desiredTrackCount: 1,
    },
    {
        cluster: 'multitrack', family: '<gx:MultiTrack> with multiple segments',
        file: 'tests/kml-fixtures/synthetic/gx-multitrack.kml',
        category: 'gap', desiredTrackCount: 1,
    },
    {
        cluster: 'timespan', family: '<TimeSpan> timed track (not TimeStamp)',
        file: 'tests/kml-fixtures/synthetic/timespan-track.kml',
        category: 'gap', desiredTrackCount: 1,
    },
    {
        cluster: 'fa2pm', family: 'FlightAware with only 2 placemarks (Placemark[2] undefined)',
        file: 'tests/kml-fixtures/synthetic/flightaware-two-placemark-no-dest.kml',
        category: 'gap', desiredTrackCount: 1,
    },
];

function load(rel) {
    const data = fs.readFileSync(repo(rel), 'utf-8');
    const parsed = parseXml(data);
    return {parsed, tf: new CTrackFileKML(parsed)};
}

function assertValidMISB(misb) {
    expect(Array.isArray(misb)).toBe(true);
    expect(misb.length).toBeGreaterThan(1);
    const p = misb[0];
    const lat = p[MISB.SensorLatitude], lon = p[MISB.SensorLongitude], alt = p[MISB.SensorTrueAltitude];
    expect(Number.isFinite(lat)).toBe(true);
    expect(Number.isFinite(lon)).toBe(true);
    expect(Number.isFinite(alt)).toBe(true);
    expect(Math.abs(lat)).toBeLessThanOrEqual(90);
    expect(Math.abs(lon)).toBeLessThanOrEqual(180);
    // time should be non-decreasing across the first samples
    for (let i = 1; i < Math.min(misb.length, 15); i++) {
        expect(misb[i][MISB.UnixTimeStamp]).toBeGreaterThanOrEqual(misb[i - 1][MISB.UnixTimeStamp]);
    }
}

describe('KML variant suite', () => {
    beforeAll(() => {
        ['log', 'warn', 'trace', 'error'].forEach(m => jest.spyOn(console, m).mockImplementation(() => {}));
    });
    afterAll(() => jest.restoreAllMocks());

    test('every fixture exists on disk', () => {
        for (const m of MANIFEST) {
            expect(fs.existsSync(repo(m.file))).toBe(true);
        }
    });

    for (const m of MANIFEST) {
        const title = `[${m.cluster}] ${m.family}`;

        if (m.category === 'track') {
            test(`${title} — imports as a track`, () => {
                const {parsed, tf} = load(m.file);
                expect(CTrackFileKML.canHandle(m.file, parsed)).toBe(true);
                expect(tf.doesContainTrack()).toBe(true);
                assertValidMISB(tf.toMISB(0));
                if (m.trackCount !== undefined) expect(tf.getTrackCount()).toBe(m.trackCount);
                if (m.nameIncludes !== undefined) {
                    expect(tf.getShortName(0)).toEqual(expect.stringContaining(m.nameIncludes));
                }
            });
        } else if (m.category === 'not-track') {
            test(`${title} — recognized as non-track, no throw`, () => {
                const {parsed, tf} = load(m.file);
                expect(CTrackFileKML.canHandle(m.file, parsed)).toBe(true);
                expect(tf.doesContainTrack()).toBe(false);
                expect(() => tf.extractObjects()).not.toThrow();
            });
        } else if (m.category === 'gap') {
            // DESIRED behavior — currently fails. test.failing keeps CI green until the
            // generic importer lands, then this flips to a failure (remove `.failing`).
            test.failing(`${title} — SHOULD import (generic-ingestion target)`, () => {
                const {tf} = load(m.file);
                expect(tf.doesContainTrack()).toBe(true);
                const misb = tf.toMISB(0);
                assertValidMISB(misb);
                if (m.desiredTrackCount !== undefined) {
                    expect(tf.getTrackCount()).toBeGreaterThanOrEqual(m.desiredTrackCount);
                }
            });
        }
    }
});

// Targeted unit tests for code paths the manifest doesn't reach (error handling,
// getShortName fallbacks, GroundOverlay extraction). Raises branch coverage.
describe('code-path coverage', () => {
    beforeAll(() => {
        ['log', 'warn', 'trace', 'error'].forEach(m => jest.spyOn(console, m).mockImplementation(() => {}));
    });
    afterAll(() => jest.restoreAllMocks());

    const ADSBX = 'data/test/ADSBX - 3 tracks  N2983Z-N410WN-N414WN-track-press_alt_uncorrected.kml';

    test('canHandle returns false when .kml access throws (catch path)', () => {
        const evil = {};
        Object.defineProperty(evil, 'kml', {get() { throw new Error('boom'); }});
        expect(CTrackFileKML.canHandle('x.kml', evil)).toBe(false);
    });

    test('isSupplementaryTrack is always false', () => {
        const {tf} = load('tests/kml-fixtures/synthetic/doc-plain-name-single-gxtrack.kml');
        expect(tf.isSupplementaryTrack(0)).toBe(false);
    });

    test('getShortName falls back to "<file>_<index>" when the track index is not found', () => {
        const {tf} = load(ADSBX);
        expect(tf.getShortName(99, 'myfile.kml')).toBe('myfile.kml_99');
    });

    test('getShortName honors Sit.allowDashInFlightNumber (dash regex branch)', () => {
        const {Sit} = require('../src/Globals');
        const prev = Sit.allowDashInFlightNumber;
        Sit.allowDashInFlightNumber = true;
        try {
            const {tf} = load(ADSBX);
            expect(typeof tf.getShortName(0)).toBe('string');
        } finally {
            Sit.allowDashInFlightNumber = prev;
        }
    });

    test('GroundOverlay is extracted via Synth3DManager.addOverlay', () => {
        const {Synth3DManager} = require('../src/Globals');
        Synth3DManager.addOverlay.mockClear();
        const {tf} = load('tests/kml-fixtures/synthetic/ground-overlay.kml');
        expect(tf.doesContainTrack()).toBe(false);
        expect(() => tf.extractObjects()).not.toThrow();
        expect(Synth3DManager.addOverlay).toHaveBeenCalled();
    });

    // FROZEN NAMES — orphan-prevention guard. Track node IDs are "Track_"+getShortName(...),
    // and saved sitches made before the 2026-04-06 shortNames-serialization mitigation re-derive
    // the name via getShortName on reload. So the generic-ingestion refactor MUST reproduce these
    // EXACT (even quirky/wrong) names for every currently-importing file, or those saves orphan.
    // Name corrections (e.g. "GPS"->"Chopper", "0033"->"86-0033") must be a separate, opt-in step.
    describe('frozen names (do not change without an opt-in migration)', () => {
        const FROZEN = [
            ['data/chilean/Chile Chopper Track from video GPSTime.kml', 'GPS'],            // slash-regex artifact, NOT "Chopper"
            ['data/laxuap/86-0033-track-press_alt_uncorrected.kml', '0033'],               // hyphen prefix dropped, NOT "86-0033"
            ['data/laxuap/82-0193-track-press_alt_uncorrected.kml', '0193'],
            ['data/chilean/IB6830 - Incorporating Radar Positions.kml', 'IB6830 - Incorporating Radar Positions.kml'], // whole filename
            ['data/chilean/IBE6830 FlightAware plus Reconstructed.kml', 'IBE6830 FlightAware plus Reconstructed'],
            ['data/chilean/LA330.kml', 'LA330'],
            ['data/test/FR24 KML WN276-3d7b69c5.kml', 'WN276'],
            ['data/maussan/VB7083-32eca57a-1.kml', 'VB7083'],
            ['data/29palms/N891UA-track-EGM96.kml', 'N891UA'],
            ['data/test/FlightAware_N494SA_KLAX_KIPL_20250602.kml', 'N494SA'],
            ['tests/kml-fixtures/real/adsbx-single-runway-then-flight.kml', 'N410WN'],
        ];
        for (const [file, expected] of FROZEN) {
            test(`${file.split('/').pop()} -> "${expected}"`, () => {
                const {tf} = load(file);
                expect(tf.getShortName(0, file.split('/').pop())).toBe(expected);
            });
        }
        test('ADSBX multi-track per-index names are stable (N2983Z / N410WN / N414WN)', () => {
            const {tf} = load('data/test/ADSBX - 3 tracks  N2983Z-N410WN-N414WN-track-press_alt_uncorrected.kml');
            expect(tf.getShortName(0)).toBe('N2983Z');
            expect(tf.getShortName(1)).toBe('N410WN');
            expect(tf.getShortName(2)).toBe('N414WN');
        });
    });

    test('CustomManager.shouldIgnore=true suppresses point features and overlays', () => {
        const G = require('../src/Globals');
        const prev = G.CustomManager.shouldIgnore;
        G.CustomManager.shouldIgnore = () => true;
        G.Synth3DManager.addOverlay.mockClear();
        try {
            const {tf: pts} = load('data/test/Rugeley (Buildings).kml');
            expect(() => pts.extractObjects()).not.toThrow();   // Point feature ignored
            const {tf: ovl} = load('tests/kml-fixtures/synthetic/ground-overlay.kml');
            ovl.extractObjects();
            expect(G.Synth3DManager.addOverlay).not.toHaveBeenCalled();  // overlay ignored
        } finally {
            G.CustomManager.shouldIgnore = prev;
        }
    });
});
