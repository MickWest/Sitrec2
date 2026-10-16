import {chooseDecoderAcceleration} from '../src/VideoDecoderAcceleration';

const config = (codec, supported) => ({codec, codedWidth: 3840, codedHeight: 2160, supported});

beforeEach(() => {
    global.VideoDecoder = {isConfigSupported: jest.fn(async c => ({supported: c.supported.includes(c.hardwareAcceleration)}))};
});

test('hardware decoding is preferred when the browser has it', async () => {
    expect(await chooseDecoderAcceleration(config('avc1.640033', ['prefer-hardware', 'no-preference']))).toBe('prefer-hardware');
});

test('a codec with no decoder of the preferred kind falls back to no-preference', async () => {
    // Chrome has no software HEVC decoder; Noise Pattern asks for software.
    const hevc = config('hvc1.2.4.L150.b0', ['prefer-hardware', 'no-preference']);
    expect(await chooseDecoderAcceleration(hevc, 'prefer-software')).toBe('no-preference');
});

test('an undecodable configuration returns null', async () => {
    expect(await chooseDecoderAcceleration(config('vp09.03.10.10', []))).toBeNull();
});
