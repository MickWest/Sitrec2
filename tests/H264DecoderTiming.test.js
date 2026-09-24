import {H264Decoder} from '../src/H264Decoder';

jest.mock('../src/showError', () => ({showError: jest.fn()}));

const hex = text => new Uint8Array(text.trim().split(/\s+/).map(byte => parseInt(byte, 16)));

test('reads 30 fps from an escaped H.264 SPS without changing the decoder bytes', () => {
    const sps = hex('67 42 c0 1f da 02 80 f6 9a 83 03 03 20 00 00 03 00 20 00 00 07 81 e3 06 54');
    const original = sps.slice();

    expect(H264Decoder.parseVUIFromSPS(sps)).toMatchObject({
        timing_info_present: 1,
        num_units_in_tick: 1,
        time_scale: 60,
        calculated_fps: 30,
    });
    expect(H264Decoder.parseDimensionsFromSPS(sps)).toEqual({width: 640, height: 480});
    expect(sps).toEqual(original);
});
