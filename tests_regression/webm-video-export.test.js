import {expect, test} from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

test.describe('WebM Video Export', () => {
    test('should generate a valid WebM video with correct frame count and fps', async ({ page }) => {
        console.log('[TEST:webm:STARTED]');
        try {
            test.setTimeout(120000);

            await page.setViewportSize({ width: 800, height: 600 });

        page.on('console', msg => {
            console.log(`PAGE CONSOLE [${msg.type()}]: ${msg.text()}`);
        });

        page.on('pageerror', err => {
            console.log('PAGE ERROR:', err);
        });

        const response = await page.goto('?sitch=custom&ignoreunload=1', {
            waitUntil: 'load',
            timeout: 30000
        });

        expect(response.ok()).toBe(true);

        await page.waitForFunction(() => {
            return typeof window.Sit !== 'undefined';
        }, { timeout: 30000 });

        const result = await page.evaluate(async () => {
            const width = 640;
            const height = 480;
            const fps = 3;
            const totalFrames = 30;

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');

            if (typeof VideoEncoder === 'undefined') {
                return { error: 'VideoEncoder not supported' };
            }

            const chunks = [];
            let encoderError = null;

            const encoder = new VideoEncoder({
                output: (chunk, meta) => {
                    const buffer = new ArrayBuffer(chunk.byteLength);
                    chunk.copyTo(buffer);
                    chunks.push({
                        buffer,
                        meta,
                        timestamp: chunk.timestamp,
                        type: chunk.type,
                        duration: chunk.duration,
                        byteLength: chunk.byteLength
                    });
                },
                error: (e) => {
                    encoderError = e.message;
                }
            });

            const config = {
                codec: 'vp8',
                width: width,
                height: height,
                framerate: fps,
                bitrate: 1_000_000,
            };

            try {
                const support = await VideoEncoder.isConfigSupported(config);
                if (!support.supported) {
                    return { error: 'VP8 not supported' };
                }

                encoder.configure(config);

                const frameDurationMicros = 1_000_000 / fps;

                for (let frame = 0; frame < totalFrames; frame++) {
                    ctx.fillStyle = '#000080';
                    ctx.fillRect(0, 0, width, height);

                    ctx.fillStyle = '#ffffff';
                    ctx.font = 'bold 120px Arial';
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.fillText(String(frame), width / 2, height / 2);

                    const videoFrame = new VideoFrame(canvas, {
                        timestamp: frame * frameDurationMicros,
                        duration: frameDurationMicros,
                    });

                    encoder.encode(videoFrame, { keyFrame: frame % 10 === 0 });
                    videoFrame.close();
                }

                await encoder.flush();
                encoder.close();

                if (encoderError) {
                    return { error: encoderError };
                }

                const writeUint = (size, value) => {
                    const bytes = new Uint8Array(size);
                    for (let i = 0; i < size; i++) {
                        bytes[size - 1 - i] = (value >> (8 * i)) & 0xff;
                    }
                    return bytes;
                };

                const writeVint = (value) => {
                    if (value < 0x7f) return new Uint8Array([0x80 | value]);
                    if (value < 0x3fff) return new Uint8Array([0x40 | (value >> 8), value & 0xff]);
                    if (value < 0x1fffff) return new Uint8Array([0x20 | (value >> 16), (value >> 8) & 0xff, value & 0xff]);
                    if (value < 0x0fffffff) return new Uint8Array([0x10 | (value >> 24), (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
                    return new Uint8Array([0x08, (value >> 24) & 0xff, (value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
                };

                const writeFloat64 = (value) => {
                    const buffer = new ArrayBuffer(8);
                    new DataView(buffer).setFloat64(0, value, false);
                    return new Uint8Array(buffer);
                };

                const writeString = (str) => new Uint8Array([...str].map(c => c.charCodeAt(0)));

                const concat = (...arrays) => {
                    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
                    const result = new Uint8Array(totalLength);
                    let offset = 0;
                    for (const arr of arrays) {
                        result.set(arr, offset);
                        offset += arr.length;
                    }
                    return result;
                };

                const element = (id, data) => {
                    const idBytes = new Uint8Array(id);
                    const sizeBytes = writeVint(data.length);
                    return concat(idBytes, sizeBytes, data);
                };

                const ebmlHeader = element([0x1a, 0x45, 0xdf, 0xa3], concat(
                    element([0x42, 0x86], new Uint8Array([0x01])),
                    element([0x42, 0xf7], new Uint8Array([0x01])),
                    element([0x42, 0xf2], new Uint8Array([0x04])),
                    element([0x42, 0xf3], new Uint8Array([0x08])),
                    element([0x42, 0x82], writeString('webm')),
                    element([0x42, 0x87], new Uint8Array([0x04])),
                    element([0x42, 0x85], new Uint8Array([0x02])),
                ));

                const timestampScale = 1000000;
                const durationMs = (totalFrames / fps) * 1000;

                const info = element([0x15, 0x49, 0xa9, 0x66], concat(
                    element([0x2a, 0xd7, 0xb1], writeUint(4, timestampScale)),
                    element([0x4d, 0x80], writeString('Sitrec')),
                    element([0x57, 0x41], writeString('Sitrec')),
                    element([0x44, 0x89], writeFloat64(durationMs)),
                ));

                const trackEntry = element([0xae], concat(
                    element([0xd7], new Uint8Array([0x01])),
                    element([0x73, 0xc5], writeUint(8, 1)),
                    element([0x9c], new Uint8Array([0x00])),
                    element([0x22, 0xb5, 0x9c], new Uint8Array([0x00])),
                    element([0x83], new Uint8Array([0x01])),
                    element([0x86], writeString('V_VP8')),
                    element([0xe0], concat(
                        element([0xb0], writeUint(2, width)),
                        element([0xba], writeUint(2, height)),
                    )),
                ));

                const tracks = element([0x16, 0x54, 0xae, 0x6b], trackEntry);

                const clusterParts = [];
                clusterParts.push(element([0xe7], writeUint(4, 0)));

                for (let i = 0; i < chunks.length; i++) {
                    const chunk = chunks[i];
                    const frameData = new Uint8Array(chunk.buffer);
                    const timestampMs = Math.round(chunk.timestamp / 1000);

                    const trackNum = new Uint8Array([0x81]);
                    const timestamp = new Uint8Array([(timestampMs >> 8) & 0xff, timestampMs & 0xff]);
                    const flags = new Uint8Array([chunk.type === 'key' ? 0x80 : 0x00]);

                    const blockData = concat(trackNum, timestamp, flags, frameData);
                    const simpleBlock = element([0xa3], blockData);
                    clusterParts.push(simpleBlock);
                }

                let clusterDataLength = 0;
                for (const part of clusterParts) {
                    clusterDataLength += part.length;
                }
                const clusterData = new Uint8Array(clusterDataLength);
                let offset = 0;
                for (const part of clusterParts) {
                    clusterData.set(part, offset);
                    offset += part.length;
                }

                const cluster = element([0x1f, 0x43, 0xb6, 0x75], clusterData);

                const segmentContent = concat(info, tracks, cluster);
                const segmentHeader = new Uint8Array([
                    0x18, 0x53, 0x80, 0x67,
                    0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff
                ]);
                const segment = concat(segmentHeader, segmentContent);

                const webmData = concat(ebmlHeader, segment);

                const base64 = btoa(String.fromCharCode(...webmData));

                return {
                    success: true,
                    frameCount: chunks.length,
                    width,
                    height,
                    fps,
                    expectedFrames: totalFrames,
                    blobSize: webmData.length,
                    base64: base64,
                    chunkInfo: chunks.map((c, i) => ({
                        index: i,
                        timestamp: c.timestamp,
                        type: c.type,
                        byteLength: c.byteLength
                    }))
                };
            } catch (e) {
                return { error: e.message, stack: e.stack };
            }
        });

        console.log('Video generation result:', JSON.stringify(result, null, 2));

        expect(result.error).toBeUndefined();
        expect(result.success).toBe(true);
        expect(result.frameCount).toBe(30);
        expect(result.width).toBe(640);
        expect(result.height).toBe(480);
        expect(result.fps).toBe(3);

        const webmBuffer = Buffer.from(result.base64, 'base64');
        const outputDir = path.join(__dirname, '..', 'test-results');
        fs.mkdirSync(outputDir, { recursive: true });
        const outputPath = path.join(outputDir, 'test-output-video.webm');
        fs.writeFileSync(outputPath, webmBuffer);
        console.log(`WebM file saved to: ${outputPath} (${webmBuffer.length} bytes)`);

        expect(webmBuffer[0]).toBe(0x1a);
        expect(webmBuffer[1]).toBe(0x45);
        expect(webmBuffer[2]).toBe(0xdf);
        expect(webmBuffer[3]).toBe(0xa3);

        const keyFrames = result.chunkInfo.filter(c => c.type === 'key');
        expect(keyFrames.length).toBeGreaterThanOrEqual(3);

        for (let i = 1; i < result.chunkInfo.length; i++) {
            expect(result.chunkInfo[i].timestamp).toBeGreaterThan(result.chunkInfo[i-1].timestamp);
        }

        const expectedDuration = (30 / 3) * 1_000_000;
            const lastTimestamp = result.chunkInfo[result.chunkInfo.length - 1].timestamp;
            expect(lastTimestamp).toBeGreaterThan(expectedDuration * 0.8);
            console.log('[TEST:webm:PASSED]');
        } catch (error) {
            console.log('[TEST:webm:FAILED]');
            throw error;
        }
    });
});
