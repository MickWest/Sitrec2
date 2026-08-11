/**
 * @jest-environment jsdom
 */

jest.mock('../src/DragResizeUtils', () => ({
    blockViewEvents: jest.fn(),
    makeDraggable: jest.fn(),
    clampBelowMenuBar: jest.fn(),
}));

jest.mock('../src/Globals', () => ({
    setRenderOne: jest.fn(),
}));

import {makeDraggable} from '../src/DragResizeUtils';
import {setRenderOne} from '../src/Globals';
import {EXIFInfoPanel} from '../src/EXIFInfoPanel.js';

describe('EXIFInfoPanel', () => {
    const visibilityChanges = [];
    const sampleMetadata = {
        raw: {
            ISO: 200,
            Make: 'DJI',
        },
        camera: {
            make: 'DJI',
            model: 'Mavic 3',
            lensModel: 'Hasselblad',
        },
        capture: {
            date: new Date('2024-05-01T12:34:56.000Z'),
        },
        placement: {
            hasLocation: true,
            latitude: 34.123456,
            longitude: -118.654321,
            altitude: 120.5,
            heading: 123.4,
            pitch: -7.8,
            roll: 2.5,
        },
        optics: {
            focalLengthMm: 24,
            focalLength35mm: 24,
            digitalZoomRatio: 1.5,
            verticalFovDeg: 45.67,
            fNumber: 2.8,
            iso: 200,
        },
    };

    let panel;
    let content;

    beforeEach(() => {
        visibilityChanges.length = 0;
        document.body.innerHTML = '<div id="Content"></div>';
        content = document.getElementById('Content');
        Object.defineProperty(content, 'clientWidth', {
            configurable: true,
            value: 1000,
        });

        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: {
                writeText: jest.fn().mockResolvedValue(undefined),
            },
        });

        panel = new EXIFInfoPanel({
            onVisibilityChange: (visible) => visibilityChanges.push(visible),
        });
    });

    afterEach(() => {
        panel?.destroy();
        jest.clearAllMocks();
        document.body.innerHTML = '';
    });

    test('creates a docked resizable panel without a max-width resize cap', () => {
        expect(content.contains(panel.panel)).toBe(true);
        expect(panel.panel.style.width).toBe('380px');
        expect(panel.panel.style.minWidth).toBe('300px');
        expect(panel.panel.style.maxWidth).toBe('');
        expect(panel.panel.style.resize).toBe('both');
        expect(panel.panel.style.left).toBe('596px');
        expect(makeDraggable).toHaveBeenCalledWith(panel.panel, expect.objectContaining({
            handle: panel.titleRow,
            excludeElements: [panel.closeButton, panel.toolbar],
        }));
    });

    test('renders compact EXIF content and updates button states from metadata', () => {
        panel.setMetadata(sampleMetadata, 'photo.jpg');

        expect(panel.titleElement.textContent).toBe('EXIF/Metadata: photo.jpg');
        expect(panel.content.innerHTML).toContain('DJI Mavic 3');
        expect(panel.content.innerHTML).toContain('34.123456, -118.654321 @ 120.5 m');
        expect(panel.content.innerHTML).toContain('123.4 deg');
        expect(panel.copyGPSButton.disabled).toBe(false);
        expect(panel.copyTimeButton.disabled).toBe(false);
        expect(panel.copyRawButton.disabled).toBe(true);
        expect(panel.modeButton.textContent).toBe('Show Raw');
    });

    test('renders container/stream info for a video with no EXIF at all', () => {
        panel.setMetadata(null, 'clip.mp4', {
            width: 1920,
            height: 1080,
            frames: 86,
            fps: 29.97,
            durationSeconds: 2.8695333,
            container: 'mp42',
            videoCodec: 'avc1.640028',
            videoBitrate: 10542037.5,
            videoBytes: 3781341,
            audioCodec: 'mp4a.40.2',
            audioBitrate: 96000,
            audioSampleRate: 48000,
            audioChannels: 2,
        });

        const html = panel.content.innerHTML;
        expect(html).toContain('1920 x 1080');
        expect(html).toContain('29.97 fps');
        expect(html).toContain('avc1.640028');
        expect(html).toContain('10.54 Mbps');     // Mbps for video...
        expect(html).toContain('96 kbps');        // ...kbps for audio
        expect(html).toContain('3.6 MB');
        expect(html).toContain('2.87 s');
        expect(html).toContain('48000 Hz, 2 ch');
        expect(html).not.toContain('No metadata available');
    });

    test('shows Media and EXIF as separate sections when both are present', () => {
        panel.setMetadata(sampleMetadata, 'photo.jpg', {width: 4032, height: 3024, frames: 1});

        // Source case, not the CSS-uppercased rendering that text-transform produces.
        const text = panel.content.textContent;
        expect(text).toContain('Media');
        expect(text).toContain('EXIF');
        expect(text.indexOf('Media')).toBeLessThan(text.indexOf('EXIF'));
        expect(text).toContain('4032 x 3024');
        expect(text).toContain('DJI Mavic 3');
    });

    test('renders audio-only media without inventing a picture size', () => {
        // What CVideoAudioOnly.getMediaInfo() reports: no width/height/frames/fps, because
        // its videoWidth/videoHeight are the waveform canvas and its fps is synthetic.
        panel.setMetadata(null, 'track.mp3', {
            durationSeconds: 185.5,
            audioCodec: 'mp4a.40.2',
            audioBitrate: 128000,
            audioSampleRate: 44100,
            audioChannels: 2,
        });

        const html = panel.content.innerHTML;
        expect(html).toContain('3:05.50');
        expect(html).toContain('mp4a.40.2');
        expect(html).toContain('128 kbps');
        expect(html).toContain('44100 Hz, 2 ch');
        expect(html).not.toContain('Size');
        expect(html).not.toContain('Frame Rate');
    });

    test('omits frame count and rate for a still image', () => {
        panel.setMetadata(null, 'photo.jpg', {width: 4032, height: 3024, frames: 1});

        const html = panel.content.innerHTML;
        expect(html).toContain('4032 x 3024');
        expect(html).not.toContain('Frames');
        expect(html).not.toContain('Frame Rate');
    });

    test('raw mode carries the media info so Copy Raw is useful without EXIF', () => {
        panel.setMetadata(null, 'clip.mp4', {width: 1920, height: 1080, videoCodec: 'avc1.640028'});
        panel.toggleMode();

        const raw = panel.content.querySelector('pre')?.textContent ?? '';
        expect(raw).toContain('"videoCodec": "avc1.640028"');
        expect(raw).toContain('"exif": null');
        expect(panel.copyRawButton.disabled).toBe(false);
    });

    test('shows and hides, and stays open when the metadata is cleared', () => {
        panel.setMetadata(sampleMetadata, 'photo.jpg');
        panel.show();

        expect(panel.visible).toBe(true);
        expect(panel.panel.style.display).toBe('flex');
        expect(visibilityChanges).toEqual([true]);

        panel.hide();

        expect(panel.visible).toBe(false);
        expect(panel.panel.style.display).toBe('none');
        expect(visibilityChanges).toEqual([true, false]);

        // The panel is a persistent window: losing the metadata reports that it has none,
        // it does not close the panel behind the user's back.
        panel.show();
        panel.setMetadata(null, 'photo.jpg');

        expect(panel.visible).toBe(true);
        expect(panel.panel.style.display).toBe('flex');
        expect(panel.content.innerHTML).toContain('No metadata available');
        expect(visibilityChanges).toEqual([true, false, true]);
        expect(setRenderOne).toHaveBeenCalled();
    });

    test('opens with no metadata at all', () => {
        panel.show();

        expect(panel.visible).toBe(true);
        expect(panel.panel.style.display).toBe('flex');
        expect(panel.content.innerHTML).toContain('No metadata available');
        expect(panel.copyGPSButton.disabled).toBe(true);
        expect(panel.copyTimeButton.disabled).toBe(true);
    });

    test('round-trips its window state through getState/setState', () => {
        panel.setMetadata(sampleMetadata, 'photo.jpg');
        panel.toggleMode();
        panel.panel.style.left = '120px';
        panel.panel.style.top = '64px';
        panel.panel.style.width = '500px';
        panel.panel.style.height = '400px';
        panel.show();

        const state = panel.getState();
        expect(state).toEqual({
            visible: true,
            mode: 'raw',
            left: '120px',
            top: '64px',
            width: '500px',
            height: '400px',
        });

        const restored = new EXIFInfoPanel({});
        restored.setMetadata(sampleMetadata, 'photo.jpg');
        restored.setState(state);

        expect(restored.visible).toBe(true);
        expect(restored.mode).toBe('raw');
        expect(restored.panel.style.left).toBe('120px');
        expect(restored.panel.style.top).toBe('64px');
        expect(restored.panel.style.width).toBe('500px');
        expect(restored.panel.style.height).toBe('400px');
        expect(restored.content.querySelector('pre')).not.toBeNull();
        restored.destroy();
    });

    test('pulls a restored off-screen position back into view', () => {
        // Saved on a wider window than we are opening it in: without clamping the panel
        // lands entirely outside the 1000px container and can never be dragged back.
        panel.setState({visible: true, left: '5000px', top: '20px', width: '380px'});

        expect(panel.visible).toBe(true);
        expect(panel.panel.style.left).toBe('604px');   // 1000 - 380 - 16

        // ...and a negative saved position is pulled back to the left margin.
        panel.setState({visible: true, left: '-800px', top: '20px', width: '380px'});
        expect(panel.panel.style.left).toBe('16px');
    });

    test('leaves an already-visible position alone', () => {
        panel.setState({visible: true, left: '120px', top: '64px', width: '380px'});

        expect(panel.panel.style.left).toBe('120px');
        expect(panel.panel.style.top).toBe('64px');
    });

    test('setState with no saved state leaves the panel closed', () => {
        panel.setState(undefined);

        expect(panel.visible).toBe(false);
        expect(panel.panel.style.display).toBe('none');
        expect(visibilityChanges).toEqual([]);
    });

    test('switches to raw mode and copies raw JSON text', async () => {
        panel.setMetadata(sampleMetadata, 'photo.jpg');

        panel.toggleMode();

        expect(panel.mode).toBe('raw');
        expect(panel.modeButton.textContent).toBe('Show Compact');
        expect(panel.copyRawButton.disabled).toBe(false);
        expect(panel.content.querySelector('pre')?.textContent).toContain('"ISO": 200');

        await panel.copyRaw();

        expect(navigator.clipboard.writeText).toHaveBeenCalledWith(expect.stringContaining('"ISO": 200'));
        expect(panel.status.textContent).toBe('Raw EXIF copied');
    });

    test('copies GPS and capture time from compact metadata', async () => {
        panel.setMetadata(sampleMetadata, 'photo.jpg');

        await panel.copyGPS();
        expect(navigator.clipboard.writeText).toHaveBeenCalledWith('34.123456, -118.654321 @ 120.5 m');
        expect(panel.status.textContent).toBe('GPS copied');

        await panel.copyCaptureTime();
        expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith('2024-05-01T12:34:56.000Z');
        expect(panel.status.textContent).toBe('Capture time copied');
    });
});