import {CVideoByteStream} from '../src/CVideoByteStream';
import {H264StreamParser} from '../src/H264StreamParser';
import {H264Decoder} from '../src/H264Decoder';
import {CStreamingAudio} from '../src/CStreamingAudio';
import {canStreamVideo, isVideoRestoredByStreaming} from '../src/VideoStreaming';

describe('progressive H.264 boundaries', () => {
    // Two multi-slice keyframes, delta frames, and mixed three/four-byte start codes.
    const data = new Uint8Array([
        0, 0, 0, 1, 0x67, 0x42, 0, 30, 0x80,
        0, 0, 1, 0x68, 0x80,
        0, 0, 0, 1, 0x65, 0x80, 23,
        0, 0, 1, 0x65, 0x40, 24,
        0, 0, 1, 0x41, 0x80, 25,
        0, 0, 0, 1, 0x09, 0xf0,
        0, 0, 1, 0x65, 0x80, 26,
        0, 0, 1, 0x65, 0x40, 27,
        0, 0, 0, 1, 0x41, 0x80, 28,
    ]);
    const frames = buffer => H264Decoder.groupNALUnitsIntoFrames(H264Decoder.extractNALUnits(new Uint8Array(buffer)))
        .map(frame => ({type: frame.type, bytes: Array.from(H264Decoder.createAVCCFrame(frame.nalUnits))}));

    test('every network split produces identical frames to complete-file parsing', () => {
        const expected = frames(data);
        for (let split = 1; split < data.length; split++) {
            const parser = new H264StreamParser();
            const groups = [...parser.append(data.subarray(0, split)), ...parser.append(data.subarray(split)), ...parser.finish()];
            expect(groups.flatMap(frames)).toEqual(expected);
            expect(groups).toHaveLength(2);
        }
    });

    test('one-byte reads publish a complete first group before EOF without publishing its continuation slices separately', () => {
        const parser = new H264StreamParser();
        const groups = [];
        for (const byte of data) groups.push(...parser.append(new Uint8Array([byte])));
        expect(groups).toHaveLength(1);
        expect(frames(groups[0])).toHaveLength(2);
        expect(parser.finish()).toHaveLength(1);
    });
});

describe('streaming byte transport', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });
    const partial = (data, range, etag = 'one') => new Response(new Uint8Array(data), {
        status: 206, headers: {'content-range': range, etag},
    });

    test('delivers bytes before EOF and returns an exact complete original', async () => {
        let release;
        let reads = 0;
        let receivedFirst;
        const first = new Promise(resolve => { receivedFirst = resolve; });
        global.fetch = jest.fn(async () => new Response(new ReadableStream({
            async pull(controller) {
                if (reads++ === 0) controller.enqueue(new Uint8Array([1, 2]));
                else {
                    await new Promise(resolve => { release = resolve; });
                    controller.enqueue(new Uint8Array([3, 4]));
                    controller.close();
                }
            },
        }), {status: 206, headers: {'content-range': 'bytes 0-3/4'}}));
        const chunks = [];
        const source = new CVideoByteStream('https://example.com/video', {onChunk: bytes => { chunks.push(...bytes); receivedFirst(); }});
        const download = source.download();
        await first;
        expect(chunks).toEqual([1, 2]);
        expect(source.status).not.toBe('complete');
        release();
        expect(Array.from(new Uint8Array(await download))).toEqual([1, 2, 3, 4]);
        expect(source.status).toBe('complete');
    });

    test('resumes a truncated response at the last delivered byte', async () => {
        global.fetch = jest.fn().mockResolvedValueOnce(partial([1, 2], 'bytes 0-3/4'))
            .mockResolvedValueOnce(partial([3, 4], 'bytes 2-3/4'));
        const received = [];
        const source = new CVideoByteStream('video', {onChunk: (bytes, offset) => received.push([offset, ...bytes])});
        expect(Array.from(new Uint8Array(await source.download()))).toEqual([1, 2, 3, 4]);
        expect(received).toEqual([[0, 1, 2], [2, 3, 4]]);
        expect(global.fetch.mock.calls[1][1].headers.Range).toBe('bytes=2-');
    });

    test('a server ignoring Range on retry cannot duplicate the prefix', async () => {
        global.fetch = jest.fn().mockResolvedValueOnce(partial([1, 2], 'bytes 0-3/4'))
            .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3, 4])));
        const chunks = [];
        const source = new CVideoByteStream('video', {onChunk: bytes => chunks.push(...bytes)});
        await source.download();
        expect(chunks).toEqual([1, 2, 3, 4]);
    });

    test.each(['bytes 1-3/4', 'bytes 0-4/4', 'unreadable'])('rejects invalid ranges: %s', async range => {
        global.fetch = jest.fn().mockResolvedValue(partial([1, 2], range));
        const onChunk = jest.fn();
        const source = new CVideoByteStream('video', {onChunk});
        await expect(source.download()).rejects.toThrow('Invalid video byte-range');
        expect(onChunk).not.toHaveBeenCalled();
    });

    test('rejects a changed object on resume', async () => {
        global.fetch = jest.fn().mockResolvedValueOnce(partial([1, 2], 'bytes 0-3/4'))
            .mockResolvedValueOnce(partial([3, 4], 'bytes 2-3/4', 'two'));
        const source = new CVideoByteStream('video', {onChunk: () => {}});
        await expect(source.download()).rejects.toThrow('Video changed');
        expect(source.canResume).toBe(false);
    });

    test('a parser error is never retried as a network error', async () => {
        global.fetch = jest.fn().mockResolvedValue(partial([1], 'bytes 0-0/1'));
        const source = new CVideoByteStream('video', {onChunk: () => { throw new TypeError('bad slice'); }});
        await expect(source.download()).rejects.toThrow('Cannot parse streamed video');
        expect(global.fetch).toHaveBeenCalledTimes(1);
        expect(source.canResume).toBe(false);
    });

    test('stalled response headers time out, retry once, and allow a later resume', async () => {
        global.fetch = jest.fn((_url, {signal}) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
        }));
        const source = new CVideoByteStream('video', {onChunk: () => {}, timeoutMs: 5});
        await expect(source.download()).rejects.toMatchObject({name: 'TimeoutError'});
        expect(source.status).toBe('failed');
        expect(source.canResume).toBe(true);
        expect(global.fetch).toHaveBeenCalledTimes(2);
        global.fetch.mockResolvedValueOnce(partial([1, 2], 'bytes 0-1/2'));
        expect(Array.from(new Uint8Array(await source.download()))).toEqual([1, 2]);
    });

    test('cancellation aborts a stalled fetch and does not retry', async () => {
        global.fetch = jest.fn((_url, {signal}) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason));
        }));
        const source = new CVideoByteStream('video', {onChunk: () => {}});
        const download = source.download();
        source.dispose();
        await expect(download).rejects.toMatchObject({name: 'AbortError'});
        expect(global.fetch).toHaveBeenCalledTimes(1);
    });
});

test('restore only bypasses the whole-file gate for media owned by video restore', () => {
    const ref = 'https://example.com/clip.h264';
    const sitch = {frames: 900, videos: [{fileName: 'clip.h264', staticURL: ref}], loadedFiles: {'clip.h264': ref}};
    expect(isVideoRestoredByStreaming(ref, sitch)).toBe(true);
    expect(isVideoRestoredByStreaming('https://example.com/other.h264', sitch)).toBe(false);
    expect(canStreamVideo('local/clip.h264', sitch)).toBe(false);
    expect(canStreamVideo(ref, {...sitch, frames: undefined})).toBe(false);
    sitch.loadedFilesMetadata = {'clip.h264': {pesSidecarURL: 'clip.pts.json'}};
    expect(isVideoRestoredByStreaming(ref, sitch)).toBe(false);
});

test('progressive audio schedules new samples and discards scheduled sources on seek/pause', () => {
    const sources = [];
    const context = {currentTime: 0, state: 'running',
        createBuffer: (_channels, length, rate) => ({duration: length / rate, getChannelData: () => new Float32Array(length)}),
        createBufferSource: () => {
            const source = {playbackRate: {}, connect: jest.fn(), start: jest.fn(), stop: jest.fn(), disconnect: jest.fn()};
            sources.push(source);
            return source;
        },
    };
    const owner = {audioContext: context, originalFps: 30, isMuted: false, volume: 1, isInitialized: true, gainNode: {gain: {}}};
    const audio = new CStreamingAudio(owner);
    const append = timestamp => audio.append({numberOfChannels: 1, numberOfFrames: 48000, sampleRate: 48000, timestamp, copyTo: () => {}});
    append(0);
    expect(audio.isReady(15, 30)).toBe(true);
    expect(audio.isReady(45, 30)).toBe(false);
    audio.play(0, 30);
    expect(sources[0].start).toHaveBeenCalledWith(0, 0);
    append(1000000);
    context.currentTime = 0.5;
    audio.play(15, 30);
    expect(sources[1].start).toHaveBeenCalledWith(1, 0);
    audio.play(45, 30);
    expect(sources[0].stop).toHaveBeenCalled();
    expect(sources[1].stop).toHaveBeenCalled();
    expect(sources[2].start).toHaveBeenCalledWith(0.5, 0.5);
    audio.pause();
    expect(sources[2].stop).toHaveBeenCalled();
    expect(owner.isPlaying).toBe(false);
});
