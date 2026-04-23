import {expect, test} from '@playwright/test';

test.describe('Motion Accumulation Accuracy', () => {
    test.setTimeout(300000);

    test('Linear Tracklet + Consensus accumulation matches expected displacement', async ({ page }) => {
        console.log('[TEST:motion-acc:STARTED]');
        try {
        await page.goto('./');
        
        await page.evaluate(() => {
            return new Promise((resolve, reject) => {
                if (window.cv && window.cv.Mat) {
                    resolve();
                    return;
                }
                
                const script = document.createElement('script');
                script.src = './libs/opencv.js';
                script.async = true;
                
                const timeout = setTimeout(() => reject(new Error('OpenCV load timeout')), 60000);
                
                script.onload = () => {
                    const poll = setInterval(() => {
                        if (window.cv && window.cv.Mat) {
                            clearInterval(poll);
                            clearTimeout(timeout);
                            resolve();
                        }
                    }, 100);
                };
                
                script.onerror = () => {
                    clearTimeout(timeout);
                    reject(new Error('Failed to load opencv.js'));
                };
                
                document.head.appendChild(script);
            });
        });
        
        await page.waitForFunction(() => window.cv && window.cv.Mat, { timeout: 30000 });
        
        const results = await page.evaluate(async () => {
            const cv = window.cv;
            
            const WIDTH = 640;
            const HEIGHT = 480;
            const FPS = 30;
            const SCROLL_SPEED_PX_PER_SEC = 22.5;
            const SCROLL_PX_PER_FRAME = SCROLL_SPEED_PX_PER_SEC / FPS;
            const NUM_FRAMES = 100;
            const FRAME_SKIP = 3;
            
            const PARAMS = {
                maxFeatures: 300,
                qualityLevel: 0.01,
                minDistance: 10,
                maxTrackError: 15,
                minMotion: 0.2,
                maxMotion: 100,
                minQuality: 0.3,
                linearityThreshold: 0.9,
                spacingThreshold: 0.5,
                inlierThreshold: 0.6,
            };
            
            console.log(`Test config: ${WIDTH}x${HEIGHT}, ${FPS}fps, ${SCROLL_SPEED_PX_PER_SEC}px/sec`);
            console.log(`Scroll per frame: ${SCROLL_PX_PER_FRAME.toFixed(4)}px`);
            console.log(`Frame skip (tracklet length): ${FRAME_SKIP}`);
            console.log(`Expected motion over ${FRAME_SKIP} frames: ${(SCROLL_PX_PER_FRAME * FRAME_SKIP).toFixed(4)}px`);
            
            function createTexturedFrame(offsetX, offsetY) {
                const canvas = document.createElement('canvas');
                canvas.width = WIDTH;
                canvas.height = HEIGHT;
                const ctx = canvas.getContext('2d');
                
                ctx.fillStyle = '#404040';
                ctx.fillRect(0, 0, WIDTH, HEIGHT);
                
                const seed = 12345;
                let rand = seed;
                const random = () => {
                    rand = (rand * 1103515245 + 12345) & 0x7fffffff;
                    return rand / 0x7fffffff;
                };
                
                for (let i = 0; i < 200; i++) {
                    const x = random() * (WIDTH + 200) - 100 + offsetX;
                    const y = random() * (HEIGHT + 200) - 100 + offsetY;
                    const r = 8 + random() * 25;
                    const gray = Math.floor(random() * 180 + 40);
                    
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fillStyle = `rgb(${gray},${gray},${gray})`;
                    ctx.fill();
                }
                
                for (let i = 0; i < 50; i++) {
                    const x = random() * (WIDTH + 100) - 50 + offsetX;
                    const y = random() * (HEIGHT + 100) - 50 + offsetY;
                    const r = 3 + random() * 8;
                    const gray = Math.floor(random() * 200 + 30);
                    
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fillStyle = `rgb(${gray},${gray},${gray})`;
                    ctx.fill();
                }
                
                return ctx.getImageData(0, 0, WIDTH, HEIGHT);
            }
            
            function imageDataToGray(imageData) {
                const src = cv.matFromImageData(imageData);
                const gray = new cv.Mat();
                cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
                src.delete();
                return gray;
            }
            
            function findConsensusDirection(vectors) {
                if (vectors.length < 3) return null;
                
                const numBins = 36;
                const binSize = (2 * Math.PI) / numBins;
                const bins = new Array(numBins).fill(null).map(() => []);
                
                for (const v of vectors) {
                    let angle = v.angle;
                    if (angle < 0) angle += 2 * Math.PI;
                    const bin = Math.floor(angle / binSize) % numBins;
                    bins[bin].push(v);
                }
                
                let bestBin = -1;
                let bestScore = 0;
                
                for (let i = 0; i < numBins; i++) {
                    const neighbors = [
                        bins[(i - 1 + numBins) % numBins],
                        bins[i],
                        bins[(i + 1) % numBins]
                    ].flat();
                    
                    const score = neighbors.reduce((sum, v) => sum + v.quality * Math.max(v.mag, 0.1), 0);
                    if (score > bestScore) {
                        bestScore = score;
                        bestBin = i;
                    }
                }
                
                if (bestBin < 0) return null;
                
                const inliers = [
                    bins[(bestBin - 1 + numBins) % numBins],
                    bins[bestBin],
                    bins[(bestBin + 1) % numBins]
                ].flat();
                
                if (inliers.length < 2) return null;
                
                let sumDx = 0, sumDy = 0, sumWeight = 0;
                for (const v of inliers) {
                    const weight = v.quality;
                    sumDx += v.dx * weight;
                    sumDy += v.dy * weight;
                    sumWeight += weight;
                }
                
                if (sumWeight < 0.01) return null;
                
                const dx = sumDx / sumWeight;
                const dy = sumDy / sumWeight;
                const inlierRatio = inliers.length / vectors.length;
                const avgQuality = sumWeight / inliers.length;
                const confidence = Math.min(1, inlierRatio + 0.2) * Math.min(1, avgQuality + 0.3);
                
                return {dx, dy, confidence, inlierCount: inliers.length};
            }
            
            function computeLinearTracklet(grayFrames, skipFrames) {
                if (grayFrames.length < skipFrames + 1) return null;
                
                const firstGray = grayFrames[0];
                const corners = new cv.Mat();
                
                try {
                    cv.goodFeaturesToTrack(firstGray, corners, PARAMS.maxFeatures, PARAMS.qualityLevel, PARAMS.minDistance);
                } catch (e) {
                    corners.delete();
                    return null;
                }
                
                if (corners.rows === 0) {
                    corners.delete();
                    return null;
                }
                
                try {
                    const winSize = new cv.Size(5, 5);
                    const zeroZone = new cv.Size(-1, -1);
                    const criteria = new cv.TermCriteria(cv.TermCriteria_EPS + cv.TermCriteria_COUNT, 30, 0.01);
                    cv.cornerSubPix(firstGray, corners, winSize, zeroZone, criteria);
                } catch (e) {}
                
                const trajectories = [];
                for (let i = 0; i < corners.rows; i++) {
                    const px = corners.floatAt(i, 0);
                    const py = corners.floatAt(i, 1);
                    trajectories.push({points: [[px, py]], valid: true, errors: []});
                }
                corners.delete();
                
                let currentPoints = new cv.Mat(trajectories.length, 1, cv.CV_32FC2);
                for (let i = 0; i < trajectories.length; i++) {
                    currentPoints.floatPtr(i, 0)[0] = trajectories[i].points[0][0];
                    currentPoints.floatPtr(i, 0)[1] = trajectories[i].points[0][1];
                }
                
                for (let step = 0; step < grayFrames.length - 1; step++) {
                    const prevGray = grayFrames[step];
                    const nextGray = grayFrames[step + 1];
                    
                    const nextPtsMat = new cv.Mat();
                    const status = new cv.Mat();
                    const err = new cv.Mat();
                    
                    try {
                        cv.calcOpticalFlowPyrLK(prevGray, nextGray, currentPoints, nextPtsMat, status, err);
                    } catch (e) {
                        nextPtsMat.delete();
                        status.delete();
                        err.delete();
                        break;
                    }
                    
                    let validIdx = 0;
                    for (let i = 0; i < trajectories.length; i++) {
                        if (!trajectories[i].valid) continue;
                        if (status.data[validIdx] !== 1) {
                            trajectories[i].valid = false;
                        } else {
                            const nx = nextPtsMat.floatAt(validIdx, 0);
                            const ny = nextPtsMat.floatAt(validIdx, 1);
                            const trackError = err.floatAt(validIdx, 0);
                            trajectories[i].points.push([nx, ny]);
                            trajectories[i].errors.push(trackError);
                            if (trackError > PARAMS.maxTrackError) {
                                trajectories[i].valid = false;
                            }
                        }
                        validIdx++;
                    }
                    
                    const validTrajectories = trajectories.filter(t => t.valid);
                    if (validTrajectories.length === 0) {
                        nextPtsMat.delete();
                        status.delete();
                        err.delete();
                        break;
                    }
                    
                    currentPoints.delete();
                    currentPoints = new cv.Mat(validTrajectories.length, 1, cv.CV_32FC2);
                    let idx = 0;
                    for (const t of trajectories) {
                        if (t.valid) {
                            const lastPt = t.points[t.points.length - 1];
                            currentPoints.floatPtr(idx, 0)[0] = lastPt[0];
                            currentPoints.floatPtr(idx, 0)[1] = lastPt[1];
                            idx++;
                        }
                    }
                    
                    nextPtsMat.delete();
                    status.delete();
                    err.delete();
                }
                
                currentPoints.delete();
                
                const flowVectors = [];
                const motionScale = 1 / skipFrames;
                
                for (const traj of trajectories) {
                    if (!traj.valid || traj.points.length < skipFrames + 1) continue;
                    
                    const start = traj.points[0];
                    const end = traj.points[traj.points.length - 1];
                    const totalDx = end[0] - start[0];
                    const totalDy = end[1] - start[1];
                    const totalDist = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
                    
                    if (totalDist < 0.001) continue;
                    
                    const expectedStepDx = totalDx / skipFrames;
                    const expectedStepDy = totalDy / skipFrames;
                    const expectedStepMag = totalDist / skipFrames;
                    
                    let maxDeviation = 0;
                    let maxSpacingError = 0;
                    
                    for (let i = 1; i < traj.points.length; i++) {
                        const actualDx = traj.points[i][0] - traj.points[i-1][0];
                        const actualDy = traj.points[i][1] - traj.points[i-1][1];
                        const actualMag = Math.sqrt(actualDx * actualDx + actualDy * actualDy);
                        
                        const expectedX = start[0] + expectedStepDx * i;
                        const expectedY = start[1] + expectedStepDy * i;
                        const deviationX = traj.points[i][0] - expectedX;
                        const deviationY = traj.points[i][1] - expectedY;
                        const deviation = Math.sqrt(deviationX * deviationX + deviationY * deviationY);
                        maxDeviation = Math.max(maxDeviation, deviation);
                        
                        if (expectedStepMag > 0.1) {
                            const spacingError = Math.abs(actualMag - expectedStepMag) / expectedStepMag;
                            maxSpacingError = Math.max(maxSpacingError, spacingError);
                        }
                    }
                    
                    const linearityScore = totalDist > 0 ? Math.max(0, 1 - maxDeviation / totalDist) : 0;
                    const spacingScore = Math.max(0, 1 - maxSpacingError);
                    
                    const adaptedLinearityThreshold = totalDist < 1.0 
                        ? PARAMS.linearityThreshold * 0.6 
                        : PARAMS.linearityThreshold;
                    const adaptedSpacingThreshold = totalDist < 1.0 
                        ? PARAMS.spacingThreshold * 0.6 
                        : PARAMS.spacingThreshold;
                    
                    if (linearityScore < adaptedLinearityThreshold) continue;
                    if (spacingScore < adaptedSpacingThreshold) continue;
                    
                    const dx = totalDx * motionScale;
                    const dy = totalDy * motionScale;
                    const mag = Math.sqrt(dx * dx + dy * dy);
                    
                    if (mag > PARAMS.maxMotion) continue;
                    const noiseFloor = 0.02;
                    if (mag < noiseFloor) continue;
                    
                    const avgError = traj.errors.length > 0 ? traj.errors.reduce((a, b) => a + b, 0) / traj.errors.length : 0;
                    const belowMinMotion = mag < PARAMS.minMotion;
                    const slowMotionPenalty = belowMinMotion ? 0.7 : 1.0;
                    const quality = Math.max(0, 1 - avgError / PARAMS.maxTrackError) * linearityScore * spacingScore * slowMotionPenalty;
                    
                    if (quality < PARAMS.minQuality) continue;
                    
                    flowVectors.push({
                        px: start[0], py: start[1], dx, dy, mag,
                        quality,
                        angle: Math.atan2(dy, dx),
                        trackError: avgError,
                        linearityScore,
                        spacingScore
                    });
                }
                
                if (flowVectors.length < 3) return null;
                
                const consensus = findConsensusDirection(flowVectors);
                return {flowVectors, consensus};
            }
            
            console.log('\n=== Generating frames ===');
            const allFrames = [];
            for (let i = 0; i < NUM_FRAMES; i++) {
                const offsetX = -i * SCROLL_PX_PER_FRAME;
                allFrames.push(imageDataToGray(createTexturedFrame(offsetX, 0)));
            }
            
            console.log('\n=== Computing Linear Tracklet motion ===');
            const rawMotions = [];
            let cumX = 0, cumY = 0;
            
            for (let frame = FRAME_SKIP; frame < NUM_FRAMES; frame++) {
                const grayFrames = [];
                for (let f = frame - FRAME_SKIP; f <= frame; f++) {
                    grayFrames.push(allFrames[f]);
                }
                
                const result = computeLinearTracklet(grayFrames, FRAME_SKIP);
                
                if (result && result.consensus) {
                    rawMotions.push({
                        frame,
                        dx: result.consensus.dx,
                        dy: result.consensus.dy,
                        confidence: result.consensus.confidence,
                        vectorCount: result.flowVectors.length,
                        inlierCount: result.consensus.inlierCount
                    });
                    
                    cumX += result.consensus.dx;
                    cumY += result.consensus.dy;
                } else {
                    rawMotions.push({
                        frame,
                        dx: 0,
                        dy: 0,
                        confidence: 0,
                        vectorCount: 0,
                        failed: true
                    });
                }
            }
            
            for (const gray of allFrames) {
                gray.delete();
            }
            
            const numMotionSamples = rawMotions.length;
            const expectedTotalX = -numMotionSamples * SCROLL_PX_PER_FRAME;
            const actualTotalX = cumX;
            const errorX = actualTotalX - expectedTotalX;
            const errorPct = expectedTotalX !== 0 ? (errorX / expectedTotalX) * 100 : 0;
            
            const successfulMotions = rawMotions.filter(m => !m.failed);
            const avgDx = successfulMotions.length > 0 
                ? successfulMotions.reduce((sum, m) => sum + m.dx, 0) / successfulMotions.length 
                : 0;
            
            console.log('\n=== Per-frame motion samples ===');
            for (let i = 0; i < Math.min(10, rawMotions.length); i++) {
                const m = rawMotions[i];
                console.log(`Frame ${m.frame}: dx=${m.dx?.toFixed(4)}, vectors=${m.vectorCount}, inliers=${m.inlierCount || 0}`);
            }
            
            console.log('\n=== Summary ===');
            console.log(`Expected per-frame dx: ${(-SCROLL_PX_PER_FRAME).toFixed(4)}`);
            console.log(`Average consensus dx: ${avgDx.toFixed(4)}`);
            console.log(`Per-frame error: ${((avgDx / (-SCROLL_PX_PER_FRAME) - 1) * 100).toFixed(2)}%`);
            console.log('');
            console.log(`Expected total X (${numMotionSamples} samples): ${expectedTotalX.toFixed(2)}`);
            console.log(`Actual total X: ${actualTotalX.toFixed(2)}`);
            console.log(`Percentage error: ${errorPct.toFixed(2)}%`);
            
            const failedFrames = rawMotions.filter(m => m.failed).length;
            console.log(`\nFailed frames: ${failedFrames} / ${rawMotions.length}`);
            
            return {
                config: {
                    width: WIDTH,
                    height: HEIGHT,
                    fps: FPS,
                    scrollSpeedPxPerSec: SCROLL_SPEED_PX_PER_SEC,
                    scrollPxPerFrame: SCROLL_PX_PER_FRAME,
                    numFrames: NUM_FRAMES,
                    frameSkip: FRAME_SKIP
                },
                expectedTotalX,
                actualTotalX,
                errorX,
                errorPct,
                expectedPerFrameDx: -SCROLL_PX_PER_FRAME,
                avgDetectedDx: avgDx,
                perFrameErrorPct: ((avgDx / (-SCROLL_PX_PER_FRAME) - 1) * 100),
                failedFrames,
                totalMotionSamples: numMotionSamples,
                rawMotionsSample: rawMotions.slice(0, 20)
            };
        });
        
        console.log('\n========================================');
        console.log('Linear Tracklet + Consensus Test Results');
        console.log('========================================');
        console.log(`Config: ${results.config.width}x${results.config.height} @ ${results.config.fps}fps`);
        console.log(`Scroll: ${results.config.scrollSpeedPxPerSec} px/sec = ${results.config.scrollPxPerFrame.toFixed(4)} px/frame`);
        console.log(`Tracklet length: ${results.config.frameSkip} frames`);
        console.log(`Total frames: ${results.config.numFrames}`);
        console.log('');
        console.log(`Expected per-frame dx: ${results.expectedPerFrameDx.toFixed(4)}`);
        console.log(`Average consensus dx: ${results.avgDetectedDx.toFixed(4)}`);
        console.log(`Per-frame error: ${results.perFrameErrorPct.toFixed(2)}%`);
        console.log('');
        console.log(`Expected total X: ${results.expectedTotalX.toFixed(2)}`);
        console.log(`Actual total X: ${results.actualTotalX.toFixed(2)}`);
        console.log(`Accumulated error: ${results.errorPct.toFixed(2)}%`);
        console.log('');
        console.log(`Failed frames: ${results.failedFrames} / ${results.totalMotionSamples}`);
        console.log('========================================');
        
        expect(Math.abs(results.errorPct)).toBeLessThan(5);
        expect(Math.abs(results.perFrameErrorPct)).toBeLessThan(5);
        console.log('[TEST:motion-acc:PASSED]');
        } catch (error) {
            console.log('[TEST:motion-acc:FAILED]');
            throw error;
        }
    });

    test('motion accumulation simulating real video analysis loop', async ({ page }) => {
        console.log('[TEST:motion-acc2:STARTED]');
        try {
        await page.goto('./');
        
        await page.evaluate(() => {
            return new Promise((resolve, reject) => {
                if (window.cv && window.cv.Mat) { resolve(); return; }
                const script = document.createElement('script');
                script.src = './libs/opencv.js';
                script.async = true;
                const timeout = setTimeout(() => reject(new Error('OpenCV load timeout')), 60000);
                script.onload = () => {
                    const poll = setInterval(() => {
                        if (window.cv && window.cv.Mat) { clearInterval(poll); clearTimeout(timeout); resolve(); }
                    }, 100);
                };
                script.onerror = () => { clearTimeout(timeout); reject(new Error('Failed to load opencv.js')); };
                document.head.appendChild(script);
            });
        });
        
        await page.waitForFunction(() => window.cv && window.cv.Mat, { timeout: 30000 });
        
        const results = await page.evaluate(async () => {
            const cv = window.cv;
            
            const WIDTH = 640;
            const HEIGHT = 480;
            const FPS = 30;
            const SCROLL_SPEED_PX_PER_SEC = 22.5;
            const SCROLL_PX_PER_FRAME = SCROLL_SPEED_PX_PER_SEC / FPS;
            const NUM_FRAMES = 100;
            const FRAME_SKIP = 3;
            
            function createTexturedFrame(offsetX, offsetY) {
                const canvas = document.createElement('canvas');
                canvas.width = WIDTH;
                canvas.height = HEIGHT;
                const ctx = canvas.getContext('2d');
                
                ctx.fillStyle = '#404040';
                ctx.fillRect(0, 0, WIDTH, HEIGHT);
                
                const seed = 12345;
                let rand = seed;
                const random = () => {
                    rand = (rand * 1103515245 + 12345) & 0x7fffffff;
                    return rand / 0x7fffffff;
                };
                
                for (let i = 0; i < 200; i++) {
                    const x = random() * (WIDTH + 200) - 100 + offsetX;
                    const y = random() * (HEIGHT + 200) - 100 + offsetY;
                    const r = 8 + random() * 25;
                    const gray = Math.floor(random() * 180 + 40);
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fillStyle = `rgb(${gray},${gray},${gray})`;
                    ctx.fill();
                }
                
                return ctx.getImageData(0, 0, WIDTH, HEIGHT);
            }
            
            function imageDataToGray(imageData) {
                const src = cv.matFromImageData(imageData);
                const gray = new cv.Mat();
                cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
                src.delete();
                return gray;
            }
            
            function computeMotion(prevGray, gray, skipFrames) {
                const corners = new cv.Mat();
                cv.goodFeaturesToTrack(prevGray, corners, 300, 0.01, 10);
                
                if (corners.rows === 0) { corners.delete(); return null; }
                
                const nextPts = new cv.Mat();
                const status = new cv.Mat();
                const err = new cv.Mat();
                cv.calcOpticalFlowPyrLK(prevGray, gray, corners, nextPts, status, err);
                
                const vectors = [];
                for (let i = 0; i < status.rows; i++) {
                    if (status.data[i] !== 1) continue;
                    if (err.floatAt(i, 0) > 15) continue;
                    
                    const px = corners.floatAt(i, 0);
                    const py = corners.floatAt(i, 1);
                    const nx = nextPts.floatAt(i, 0);
                    const ny = nextPts.floatAt(i, 1);
                    const rawDx = nx - px;
                    const rawDy = ny - py;
                    const dx = rawDx / skipFrames;
                    const dy = rawDy / skipFrames;
                    const mag = Math.sqrt(dx * dx + dy * dy);
                    
                    if (mag >= 0.05 && mag < 50) {
                        vectors.push({ dx, dy, mag, quality: 1 - err.floatAt(i, 0) / 15 });
                    }
                }
                
                corners.delete();
                nextPts.delete();
                status.delete();
                err.delete();
                
                if (vectors.length < 5) return null;
                
                let sumDx = 0, sumDy = 0, sumWeight = 0;
                for (const v of vectors) {
                    const w = v.quality;
                    sumDx += v.dx * w;
                    sumDy += v.dy * w;
                    sumWeight += w;
                }
                
                return { dx: sumDx / sumWeight, dy: sumDy / sumWeight };
            }
            
            const frames = [];
            for (let i = 0; i < NUM_FRAMES; i++) {
                const offsetX = -i * SCROLL_PX_PER_FRAME;
                frames.push(imageDataToGray(createTexturedFrame(offsetX, 0)));
            }
            
            const motionPerFrame = [];
            for (let i = FRAME_SKIP; i < NUM_FRAMES; i++) {
                const result = computeMotion(frames[i - FRAME_SKIP], frames[i], FRAME_SKIP);
                motionPerFrame.push({
                    frame: i,
                    dx: result?.dx ?? 0,
                    dy: result?.dy ?? 0,
                    failed: !result
                });
            }
            
            let cumX = 0;
            for (const m of motionPerFrame) {
                cumX += m.dx;
            }
            
            const expectedTotalX = -(NUM_FRAMES - 1) * SCROLL_PX_PER_FRAME;
            const summedPerFrameDx = cumX;
            
            const correctCumX = motionPerFrame.length * (-SCROLL_PX_PER_FRAME);
            
            for (const gray of frames) { gray.delete(); }
            
            const errorPctVsFrameCount = ((summedPerFrameDx / correctCumX) - 1) * 100;
            const errorPctVsExpected = ((summedPerFrameDx / expectedTotalX) - 1) * 100;
            
            return {
                frameSkip: FRAME_SKIP,
                numFrames: NUM_FRAMES,
                numMotionSamples: motionPerFrame.length,
                expectedPerFrameDx: -SCROLL_PX_PER_FRAME,
                avgDetectedDx: motionPerFrame.reduce((s, m) => s + m.dx, 0) / motionPerFrame.filter(m => !m.failed).length,
                expectedTotalFromFrameCount: correctCumX,
                expectedTotalFromFrames: expectedTotalX,
                actualTotal: summedPerFrameDx,
                errorPctVsFrameCount,
                errorPctVsExpected,
                failedFrames: motionPerFrame.filter(m => m.failed).length,
                sampleMotions: motionPerFrame.slice(0, 10)
            };
        });
        
        console.log('\n========================================');
        console.log('Frame Skip Motion Accumulation Test');
        console.log('========================================');
        console.log(`Frame skip: ${results.frameSkip}`);
        console.log(`Total frames: ${results.numFrames}`);
        console.log(`Motion samples: ${results.numMotionSamples}`);
        console.log('');
        console.log(`Expected per-frame dx: ${results.expectedPerFrameDx.toFixed(4)}`);
        console.log(`Average detected dx: ${results.avgDetectedDx.toFixed(4)}`);
        console.log('');
        console.log(`Expected total (from ${results.numMotionSamples} samples): ${results.expectedTotalFromFrameCount.toFixed(2)}`);
        console.log(`Expected total (from ${results.numFrames} frames): ${results.expectedTotalFromFrames.toFixed(2)}`);
        console.log(`Actual accumulated: ${results.actualTotal.toFixed(2)}`);
        console.log(`Error vs sample count: ${results.errorPctVsFrameCount.toFixed(2)}%`);
        console.log(`Error vs total frames: ${results.errorPctVsExpected.toFixed(2)}%`);
        console.log(`Failed frames: ${results.failedFrames}`);
        console.log('========================================');
        
        expect(Math.abs(results.errorPctVsFrameCount)).toBeLessThan(5);
        console.log('[TEST:motion-acc2:PASSED]');
        } catch (error) {
            console.log('[TEST:motion-acc2:FAILED]');
            throw error;
        }
    });
});
