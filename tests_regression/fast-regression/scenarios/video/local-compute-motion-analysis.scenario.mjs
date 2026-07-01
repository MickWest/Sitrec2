import {spawn} from 'child_process';
import {createReadStream, statSync} from 'fs';
import {createServer} from 'http';
import net from 'net';
import {resolve} from 'path';

const TRUCK_VIDEO_PATH = resolve(process.cwd(), 'sitrec-videos/public/Truck-test-clip.mp4');
const TRUCK_VIDEO_ROUTE = '/Truck-test-clip.mp4';

const TECHNIQUES = [
    'Linear Tracklet',
    'Sparse + Consensus',
    'Phase Correlation',
    'ECC Euclidean',
    'Affine RANSAC',
];

const ANALYSIS_PARAMS = {
    frameSkip: 3,
    maxFeatures: 220,
    qualityLevel: 0.01,
    minDistance: 8,
    blurSize: 5,
    minMotion: 0.05,
    maxMotion: 80,
    minQuality: 0.2,
    minVectorCount: 3,
    minConsensusConfidence: 0.05,
    rejectMovingObjects: true,
    objectRejectThreshold: 3.0,
    skipDuplicateFrames: true,
};

async function findFreeLocalComputePort() {
    for (let port = 9795; port >= 9788; port--) {
        const free = await new Promise((resolvePort) => {
            const server = net.createServer();
            server.once('error', () => resolvePort(false));
            server.once('listening', () => server.close(() => resolvePort(true)));
            server.listen(port, '127.0.0.1');
        });
        if (free) return port;
    }
    throw new Error('No free Local Compute test port in 9788-9795');
}

function startVideoServer() {
    const size = statSync(TRUCK_VIDEO_PATH).size;
    const server = createServer((req, res) => {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (url.pathname !== TRUCK_VIDEO_ROUTE) {
            res.writeHead(404, {'Access-Control-Allow-Origin': '*'});
            res.end();
            return;
        }

        const baseHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Accept-Ranges': 'bytes',
            'Content-Type': 'video/mp4',
            'Cache-Control': 'no-store',
        };

        if (req.method === 'OPTIONS') {
            res.writeHead(204, {
                ...baseHeaders,
                'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
                'Access-Control-Allow-Headers': 'Range, Content-Type',
            });
            res.end();
            return;
        }

        const range = req.headers.range;
        if (range) {
            const match = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (!match) {
                res.writeHead(416, {...baseHeaders, 'Content-Range': `bytes */${size}`});
                res.end();
                return;
            }
            const start = match[1] ? Number(match[1]) : 0;
            const end = match[2] ? Number(match[2]) : size - 1;
            const clampedEnd = Math.min(end, size - 1);
            if (start >= size || clampedEnd < start) {
                res.writeHead(416, {...baseHeaders, 'Content-Range': `bytes */${size}`});
                res.end();
                return;
            }
            res.writeHead(206, {
                ...baseHeaders,
                'Content-Length': clampedEnd - start + 1,
                'Content-Range': `bytes ${start}-${clampedEnd}/${size}`,
            });
            if (req.method === 'HEAD') res.end();
            else createReadStream(TRUCK_VIDEO_PATH, {start, end: clampedEnd}).pipe(res);
            return;
        }

        res.writeHead(200, {...baseHeaders, 'Content-Length': size});
        if (req.method === 'HEAD') res.end();
        else createReadStream(TRUCK_VIDEO_PATH).pipe(res);
    });

    return new Promise((resolveServer, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const {port} = server.address();
            resolveServer({
                url: `http://127.0.0.1:${port}${TRUCK_VIDEO_ROUTE}`,
                close: () => new Promise((resolveClose) => server.close(resolveClose)),
            });
        });
    });
}

function waitForBridgeReady(proc, port) {
    return new Promise((resolveReady, reject) => {
        let stderr = '';
        const timer = setTimeout(() => {
            reject(new Error(`Timed out waiting for SitrecBridge on ${port}\n${stderr}`));
        }, 15000);

        proc.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            if (stderr.length > 12000) stderr = stderr.slice(-12000);
            if (text.includes(`Listening on ws://127.0.0.1:${port}`)) {
                clearTimeout(timer);
                resolveReady();
            }
        });

        proc.once('exit', (code, signal) => {
            clearTimeout(timer);
            reject(new Error(`SitrecBridge exited before listening: ${signal || code}\n${stderr}`));
        });
    });
}

function startBridge(port, origin) {
    return spawn(process.execPath, ['tools/SitrecBridge/mcp-server.js'], {
        cwd: process.cwd(),
        stdio: ['pipe', 'ignore', 'pipe'],
        env: {
            ...process.env,
            SITREC_BRIDGE_PORT: String(port),
            SITREC_BRIDGE_PAIRED_ORIGIN: origin,
            PYTHONUNBUFFERED: '1',
        },
    });
}

async function stopBridge(proc) {
    if (!proc || proc.killed) return;
    await new Promise((resolveStop) => {
        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            resolveStop();
        };
        proc.once('exit', finish);
        try { proc.stdin.end(); } catch {}
        try { proc.kill('SIGTERM'); } catch { finish(); }
        setTimeout(finish, 2000).unref();
    });
}

const waitForVideoReadyStep = `async () => {
    const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
    const deadline = Date.now() + 120000;
    while (Date.now() < deadline) {
        const video = window.NodeMan?.get?.('video', false);
        const data = video?.videoData;
        const width = data?.videoWidth || data?.width || 0;
        const height = data?.videoHeight || data?.height || 0;
        const frames = window.Sit?.frames || 0;
        const pending = !!window.areVideoFramesPendingForFixedFrame?.();
        const helperReady = typeof window.__sitrecRunMotionAnalysisForTesting === 'function';
        if (helperReady && width > 0 && height > 0 && frames >= 101 && !pending) {
            return {helperReady, width, height, frames};
        }
        await wait(100);
    }
    throw new Error('Timed out waiting for video and motion analysis helper');
}`;

const analyzeStep = `async () => {
    const techniques = ${JSON.stringify(TECHNIQUES)};
    const baseParams = ${JSON.stringify(ANALYSIS_PARAMS)};
    const requireValue = (condition, message) => {
        if (!condition) throw new Error(message);
    };
    const compactForCompare = (summary) => summary.frames.map(frame => ({
        frame: frame.frame,
        good: frame.isGoodFrame,
        duplicate: frame.duplicateFrame,
        synthetic: frame.syntheticFrame,
        fallback: frame.adjacentFallbackFrame,
        dx: frame.dx,
        dy: frame.dy,
        rotation: frame.rotation,
        vectors: frame.vectorCount,
    }));
    const compareSummaries = (technique, browser, compute) => {
        requireValue(compute.ready, technique + ': compute did not finish');
        requireValue(browser.ready, technique + ': browser did not finish');
        requireValue(
            compute.summary.completeCount === browser.summary.completeCount,
            technique + ': complete count mismatch'
        );
        requireValue(
            compute.summary.totalFrames === browser.summary.totalFrames,
            technique + ': total frame count mismatch'
        );
        requireValue(
            compute.summary.duplicateCount === browser.summary.duplicateCount,
            technique + ': duplicate count mismatch'
        );
        requireValue(
            compute.localComputeStats?.technique === technique,
            technique + ': worker technique mismatch'
        );
        requireValue(
            compute.localComputeStats?.frameCount === compute.summary.totalFrames,
            technique + ': worker frame count mismatch'
        );

        const browserFrames = compactForCompare(browser.summary);
        const computeFrames = compactForCompare(compute.summary);
        requireValue(computeFrames.length === browserFrames.length, technique + ': frame length mismatch');

        let dxErrorSum = 0;
        let dyErrorSum = 0;
        let comparable = 0;
        let classificationMismatches = 0;
        for (let i = 0; i < browserFrames.length; i++) {
            const b = browserFrames[i];
            const c = computeFrames[i];
            requireValue(c.frame === b.frame, technique + ': frame index mismatch at ' + i);
            if (b.good !== c.good || b.duplicate !== c.duplicate) classificationMismatches++;
            if (Number.isFinite(b.dx) && Number.isFinite(c.dx) && Number.isFinite(b.dy) && Number.isFinite(c.dy)) {
                dxErrorSum += Math.abs(b.dx - c.dx);
                dyErrorSum += Math.abs(b.dy - c.dy);
                comparable++;
            }
        }

        requireValue(classificationMismatches <= 2, technique + ': too many good/duplicate mismatches');
        requireValue(comparable > browserFrames.length * 0.7, technique + ': too few comparable frames');
        const tolerance = technique === 'ECC Euclidean' || technique === 'Affine RANSAC' ? 0.75 : 0.35;
        const meanDxError = comparable > 0 ? dxErrorSum / comparable : Number.POSITIVE_INFINITY;
        const meanDyError = comparable > 0 ? dyErrorSum / comparable : Number.POSITIVE_INFINITY;
        requireValue(meanDxError < tolerance, technique + ': mean dx error ' + meanDxError + ' >= ' + tolerance);
        requireValue(meanDyError < tolerance, technique + ': mean dy error ' + meanDyError + ' >= ' + tolerance);

        return {
            technique,
            totalFrames: browser.summary.totalFrames,
            completeCount: browser.summary.completeCount,
            duplicateCount: browser.summary.duplicateCount,
            workerFrameCount: compute.localComputeStats.frameCount,
            agreementWithinTolerance: true,
        };
    };

    const results = [];
    for (const technique of techniques) {
        const params = {...baseParams, technique};
        const shared = {
            startFrame: 1,
            endFrame: 100,
            params,
            maskEnabled: true,
            maskRect: {x: 0, y: 0, width: 80, height: 478},
        };
        const browser = await window.__sitrecRunMotionAnalysisForTesting({...shared, useLocalCompute: false});
        const compute = await window.__sitrecRunMotionAnalysisForTesting({...shared, useLocalCompute: true});
        const summary = compareSummaries(technique, browser, compute);
        results.push({summary, browserElapsedMs: browser.elapsedMs, computeElapsedMs: compute.elapsedMs});
    }

    const browserTotal = results.reduce((sum, r) => sum + r.browserElapsedMs, 0);
    const computeTotal = results.reduce((sum, r) => sum + r.computeElapsedMs, 0);
    requireValue(computeTotal < browserTotal, 'Local Compute aggregate time was not faster than browser analysis');

    return {
        techniqueCount: results.length,
        aggregate: {computeFaster: true},
        techniques: results.map(r => r.summary),
    };
}`;

export default {
    id: 'local-compute-motion-analysis',
    sitch: 'video',
    builtin: true,
    frame: 0,
    tier: 'value',
    network: 'none',
    isolated: true,
    beforeLoad: async ({config}) => {
        const origin = new URL(config.base).origin;
        const localComputePort = await findFreeLocalComputePort();
        let bridge = null;
        let videoServer = null;

        try {
            bridge = startBridge(localComputePort, origin);
            await waitForBridgeReady(bridge, localComputePort);
            videoServer = await startVideoServer();
            return {
                target: {
                    builtin: true,
                    sitch: 'video',
                    name: 'video',
                    frame: 0,
                    query: {
                        video: videoServer.url,
                        localComputePort,
                    },
                },
                cleanup: async () => {
                    await stopBridge(bridge);
                    await videoServer.close();
                },
            };
        } catch (e) {
            await stopBridge(bridge);
            if (videoServer) await videoServer.close();
            throw e;
        }
    },
    steps: [
        {
            type: 'eval',
            name: 'videoReady',
            capture: true,
            fn: waitForVideoReadyStep,
        },
        {
            type: 'eval',
            name: 'motionAnalysis',
            capture: true,
            fn: analyzeStep,
        },
    ],
};
