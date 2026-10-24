// A DJI SRT whose brackets do not split into neat "key: value" token pairs, such as
// "[iso : 100]" or "[dzoom_ratio: 10000, delta:0]", used to throw, which made
// canHandle reject the whole drone track. A malformed bracket is now skipped and
// the rest of the block still parses; text that is not an SRT is still rejected.

import {CTrackFileSRT} from '../src/TrackFiles/CTrackFileSRT';
import {MISB} from '../src/MISBFields';

function block(n, details) {
    const ms = String(n * 16).padStart(3, '0');
    return [
        String(n),
        `00:00:00,${ms} --> 00:00:00,${String(n * 16 + 16).padStart(3, '0')}`,
        `<font size="28">FrameCnt: ${n}, DiffTime: 16ms`,
        `2023-12-17 15:27:55.${ms}`,
        `${details} </font>`,
        '',
    ].join('\n');
}

const position = (lat, lon) => `[latitude: ${lat}] [longitude: ${lon}] [rel_alt: 17.800 abs_alt: 134.835]`;

const srt = (...blocks) => blocks.map((details, i) => block(i + 1, details)).join('\n') + '\n';

test('a bracket with a space before the colon does not reject the file', () => {
    const data = srt(
        `[iso : 100] [shutter: 1/640.0] [focal_len: 166.00] ${position(36.06571, -119.01938)}`,
        `[iso: 100] [color_md : default] ${position(36.06572, -119.01939)}`);
    expect(CTrackFileSRT.canHandle('drone.SRT', data)).toBe(true);
    const misb = new CTrackFileSRT(data).toMISB();
    expect(misb).toHaveLength(2);
    expect(misb[0][MISB.SensorLatitude]).toBe(36.06571);
    expect(misb[1][MISB.SensorLongitude]).toBe(-119.01939);
    expect(misb[0][MISB.SensorTrueAltitude]).toBe(134.835);
    expect(misb[0][MISB.SensorVerticalFieldofView]).toBeCloseTo(5, 6);
});

test('several comma-separated pairs in one bracket are read', () => {
    const data = srt(`[dzoom_ratio: 10000, delta:0] ${position(36.1, -119.1)}`);
    const misb = new CTrackFileSRT(data).toMISB();
    expect(misb).toHaveLength(1);
    expect(misb[0][MISB.SensorLatitude]).toBe(36.1);
    expect(misb[0][MISB.SensorRelativeAltitude]).toBe(17.8);
});

test('a block with no bracketed telemetry is skipped, not fatal', () => {
    const data = srt(position(36.1, -119.1), 'no telemetry here', position(36.2, -119.2));
    const misb = new CTrackFileSRT(data).toMISB();
    expect(misb.map(row => row[MISB.SensorLatitude])).toEqual([36.1, 36.2]);
});

test('text that is not an SRT is still rejected', () => {
    const csv = Array.from({length: 12}, (_, i) => `${i},alt [m],${i * 10}`).join('\n');
    expect(CTrackFileSRT.canHandle('data.csv', csv)).toBe(false);
    const html = Array.from({length: 12}, (_, i) => `<p>row ${i}</p> <script>a[${i}] = 1</script>`).join('\n');
    expect(CTrackFileSRT.canHandle('page.html', html)).toBe(false);
});
