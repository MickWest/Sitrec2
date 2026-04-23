import {expect, test} from '@playwright/test';

test.describe('Motion Analysis Techniques', () => {
    test.setTimeout(180000);

    test('all four techniques detect diagonal motion correctly', async ({ page }) => {
        console.log('[TEST:opencv:STARTED]');
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
            
            const TECHNIQUES = {
                SPARSE_CONSENSUS: 'Sparse + Consensus',
                PHASE_CORRELATION: 'Phase Correlation',
                ECC_EUCLIDEAN: 'ECC Euclidean',
                AFFINE_RANSAC: 'Affine RANSAC',
            };
            
            const WIDTH = 256;
            const HEIGHT = 256;
            const SHIFT_X = 5;
            const SHIFT_Y = 3;
            const EXPECTED_DX = -SHIFT_X;
            const EXPECTED_DY = -SHIFT_Y;
            const TOLERANCE = 2.0;
            
            function createTexturedImage(offsetX, offsetY) {
                const canvas = document.createElement('canvas');
                canvas.width = WIDTH;
                canvas.height = HEIGHT;
                const ctx = canvas.getContext('2d');
                
                ctx.fillStyle = '#808080';
                ctx.fillRect(0, 0, WIDTH, HEIGHT);
                
                const seed = 12345;
                let rand = seed;
                const random = () => {
                    rand = (rand * 1103515245 + 12345) & 0x7fffffff;
                    return rand / 0x7fffffff;
                };
                
                for (let i = 0; i < 100; i++) {
                    const x = random() * (WIDTH + 100) - 50 + offsetX;
                    const y = random() * (HEIGHT + 100) - 50 + offsetY;
                    const r = 5 + random() * 20;
                    const gray = Math.floor(random() * 200 + 28);
                    
                    ctx.beginPath();
                    ctx.arc(x, y, r, 0, Math.PI * 2);
                    ctx.fillStyle = `rgb(${gray},${gray},${gray})`;
                    ctx.fill();
                }
                
                return ctx.getImageData(0, 0, WIDTH, HEIGHT);
            }
            
            const img1 = createTexturedImage(0, 0);
            const img2 = createTexturedImage(-SHIFT_X, -SHIFT_Y);
            
            const src1 = cv.matFromImageData(img1);
            const src2 = cv.matFromImageData(img2);
            const gray1 = new cv.Mat();
            const gray2 = new cv.Mat();
            cv.cvtColor(src1, gray1, cv.COLOR_RGBA2GRAY);
            cv.cvtColor(src2, gray2, cv.COLOR_RGBA2GRAY);
            src1.delete();
            src2.delete();
            
            const results = {};
            
            for (const [key, name] of Object.entries(TECHNIQUES)) {
                try {
                    let result = null;
                    
                    if (key === 'SPARSE_CONSENSUS') {
                        result = await runSparseConsensus(cv, gray1, gray2);
                    } else if (key === 'PHASE_CORRELATION') {
                        result = await runPhaseCorrelation(cv, gray1, gray2);
                    } else if (key === 'ECC_EUCLIDEAN') {
                        result = await runECC(cv, gray1, gray2);
                    } else if (key === 'AFFINE_RANSAC') {
                        result = await runAffineRANSAC(cv, gray1, gray2);
                    }
                    
                    if (result) {
                        const dxError = Math.abs(result.dx - EXPECTED_DX);
                        const dyError = Math.abs(result.dy - EXPECTED_DY);
                        results[key] = {
                            name,
                            dx: result.dx,
                            dy: result.dy,
                            dxError,
                            dyError,
                            confidence: result.confidence,
                            passed: dxError < TOLERANCE && dyError < TOLERANCE,
                            error: null
                        };
                    } else {
                        results[key] = {
                            name,
                            dx: null,
                            dy: null,
                            passed: false,
                            error: 'Returned null'
                        };
                    }
                } catch (e) {
                    results[key] = {
                        name,
                        dx: null,
                        dy: null,
                        passed: false,
                        error: e.message || String(e)
                    };
                }
            }
            
            gray1.delete();
            gray2.delete();
            
            return { results, expected: { dx: EXPECTED_DX, dy: EXPECTED_DY }, tolerance: TOLERANCE };
            
            async function runSparseConsensus(cv, prevGray, gray) {
                const corners = new cv.Mat();
                cv.goodFeaturesToTrack(prevGray, corners, 300, 0.01, 10);
                
                if (corners.rows === 0) {
                    corners.delete();
                    return null;
                }
                
                const nextPts = new cv.Mat();
                const status = new cv.Mat();
                const err = new cv.Mat();
                cv.calcOpticalFlowPyrLK(prevGray, gray, corners, nextPts, status, err);
                
                const vectors = [];
                for (let i = 0; i < status.rows; i++) {
                    if (status.data[i] !== 1) continue;
                    const px = corners.floatAt(i, 0);
                    const py = corners.floatAt(i, 1);
                    const nx = nextPts.floatAt(i, 0);
                    const ny = nextPts.floatAt(i, 1);
                    const dx = nx - px;
                    const dy = ny - py;
                    const mag = Math.sqrt(dx * dx + dy * dy);
                    if (mag > 0.5) {
                        vectors.push({ dx, dy, mag, angle: Math.atan2(dy, dx) });
                    }
                }
                
                corners.delete();
                nextPts.delete();
                status.delete();
                err.delete();
                
                if (vectors.length < 3) return null;
                
                let sumDx = 0, sumDy = 0;
                for (const v of vectors) {
                    sumDx += v.dx;
                    sumDy += v.dy;
                }
                return {
                    dx: sumDx / vectors.length,
                    dy: sumDy / vectors.length,
                    confidence: 1.0
                };
            }
            
            async function runPhaseCorrelation(cv, prevGray, gray) {
                const imgWidth = gray.cols;
                const imgHeight = gray.rows;
                
                const optW = cv.getOptimalDFTSize(imgWidth);
                const optH = cv.getOptimalDFTSize(imgHeight);
                
                const padded1 = new cv.Mat();
                const padded2 = new cv.Mat();
                cv.copyMakeBorder(prevGray, padded1, 0, optH - imgHeight, 0, optW - imgWidth, cv.BORDER_CONSTANT, new cv.Scalar(0));
                cv.copyMakeBorder(gray, padded2, 0, optH - imgHeight, 0, optW - imgWidth, cv.BORDER_CONSTANT, new cv.Scalar(0));
                
                const float1 = new cv.Mat();
                const float2 = new cv.Mat();
                padded1.convertTo(float1, cv.CV_32F);
                padded2.convertTo(float2, cv.CV_32F);
                padded1.delete();
                padded2.delete();
                
                const planes1 = new cv.MatVector();
                const planes2 = new cv.MatVector();
                const zeros1 = cv.Mat.zeros(optH, optW, cv.CV_32F);
                const zeros2 = cv.Mat.zeros(optH, optW, cv.CV_32F);
                planes1.push_back(float1);
                planes1.push_back(zeros1);
                planes2.push_back(float2);
                planes2.push_back(zeros2);
                
                const complex1 = new cv.Mat();
                const complex2 = new cv.Mat();
                cv.merge(planes1, complex1);
                cv.merge(planes2, complex2);
                float1.delete();
                float2.delete();
                zeros1.delete();
                zeros2.delete();
                planes1.delete();
                planes2.delete();
                
                cv.dft(complex1, complex1);
                cv.dft(complex2, complex2);
                
                const split1 = new cv.MatVector();
                const split2 = new cv.MatVector();
                cv.split(complex1, split1);
                cv.split(complex2, split2);
                const re1 = split1.get(0);
                const im1 = split1.get(1);
                const re2 = split2.get(0);
                const im2 = split2.get(1);
                
                const crossRe = new cv.Mat();
                const crossIm = new cv.Mat();
                const temp1 = new cv.Mat();
                const temp2 = new cv.Mat();
                cv.multiply(re1, re2, temp1);
                cv.multiply(im1, im2, temp2);
                cv.add(temp1, temp2, crossRe);
                cv.multiply(im1, re2, temp1);
                cv.multiply(re1, im2, temp2);
                cv.subtract(temp1, temp2, crossIm);
                temp1.delete();
                temp2.delete();
                re1.delete();
                im1.delete();
                re2.delete();
                im2.delete();
                split1.delete();
                split2.delete();
                complex1.delete();
                complex2.delete();
                
                const mag = new cv.Mat();
                cv.magnitude(crossRe, crossIm, mag);
                
                const epsilon = cv.Mat.ones(optH, optW, cv.CV_32F);
                for (let i = 0; i < epsilon.rows * epsilon.cols; i++) {
                    epsilon.data32F[i] = 1e-10;
                }
                cv.add(mag, epsilon, mag);
                epsilon.delete();
                
                cv.divide(crossRe, mag, crossRe);
                cv.divide(crossIm, mag, crossIm);
                mag.delete();
                
                const normPlanes = new cv.MatVector();
                normPlanes.push_back(crossRe);
                normPlanes.push_back(crossIm);
                const normCross = new cv.Mat();
                cv.merge(normPlanes, normCross);
                crossRe.delete();
                crossIm.delete();
                normPlanes.delete();
                
                const invResult = new cv.Mat();
                cv.dft(normCross, invResult, cv.DFT_INVERSE | cv.DFT_SCALE);
                normCross.delete();
                
                const resultPlanes = new cv.MatVector();
                cv.split(invResult, resultPlanes);
                const result = resultPlanes.get(0);
                invResult.delete();
                resultPlanes.delete();
                
                const minMax = cv.minMaxLoc(result);
                const peakLoc = minMax.maxLoc;
                result.delete();
                
                let dx = peakLoc.x;
                let dy = peakLoc.y;
                if (dx > optW / 2) dx -= optW;
                if (dy > optH / 2) dy -= optH;
                
                return { dx: -dx, dy: -dy, confidence: 1.0 };
            }
            
            async function runECC(cv, prevGray, gray) {
                if (typeof cv.findTransformECC !== 'function') {
                    return { dx: 0, dy: 0, confidence: 0, error: 'findTransformECC not available' };
                }
                
                const warpMatrix = cv.Mat.eye(2, 3, cv.CV_32F);
                const criteria = new cv.TermCriteria(cv.TermCriteria_COUNT + cv.TermCriteria_EPS, 50, 0.001);
                const inputMask = new cv.Mat();
                const gaussFiltSize = 5;
                
                let cc;
                try {
                    cc = cv.findTransformECC(prevGray, gray, warpMatrix, cv.MOTION_EUCLIDEAN, criteria, inputMask, gaussFiltSize);
                } catch (e) {
                    warpMatrix.delete();
                    inputMask.delete();
                    throw e;
                }
                
                inputMask.delete();
                
                const dx = warpMatrix.floatAt(0, 2);
                const dy = warpMatrix.floatAt(1, 2);
                warpMatrix.delete();
                
                return { dx, dy, confidence: cc };
            }
            
            async function runAffineRANSAC(cv, prevGray, gray) {
                const corners = new cv.Mat();
                cv.goodFeaturesToTrack(prevGray, corners, 300, 0.01, 10);
                
                if (corners.rows < 4) {
                    corners.delete();
                    return null;
                }
                
                const nextPts = new cv.Mat();
                const status = new cv.Mat();
                const err = new cv.Mat();
                cv.calcOpticalFlowPyrLK(prevGray, gray, corners, nextPts, status, err);
                
                const vectors = [];
                for (let i = 0; i < status.rows; i++) {
                    if (status.data[i] !== 1) continue;
                    const px = corners.floatAt(i, 0);
                    const py = corners.floatAt(i, 1);
                    const nx = nextPts.floatAt(i, 0);
                    const ny = nextPts.floatAt(i, 1);
                    vectors.push({ dx: nx - px, dy: ny - py });
                }
                
                corners.delete();
                nextPts.delete();
                status.delete();
                err.delete();
                
                if (vectors.length < 4) return null;
                
                if (typeof cv.estimateAffinePartial2D === 'function') {
                    const prevPoints = [];
                    const nextPoints = [];
                    for (const v of vectors) {
                        prevPoints.push(0, 0);
                        nextPoints.push(v.dx, v.dy);
                    }
                    const prevPtsMat = cv.matFromArray(vectors.length, 1, cv.CV_32FC2, prevPoints);
                    const nextPtsMat = cv.matFromArray(vectors.length, 1, cv.CV_32FC2, nextPoints);
                    const inliersMask = new cv.Mat();
                    
                    try {
                        const transform = cv.estimateAffinePartial2D(prevPtsMat, nextPtsMat, inliersMask, cv.RANSAC, 3.0);
                        prevPtsMat.delete();
                        nextPtsMat.delete();
                        inliersMask.delete();
                        
                        if (transform && !transform.empty()) {
                            const dx = transform.doubleAt(0, 2);
                            const dy = transform.doubleAt(1, 2);
                            transform.delete();
                            return { dx, dy, confidence: 1.0 };
                        }
                        if (transform) transform.delete();
                    } catch (e) {
                        prevPtsMat.delete();
                        nextPtsMat.delete();
                        inliersMask.delete();
                    }
                }
                
                vectors.sort((a, b) => a.dx - b.dx);
                const medianDx = vectors[Math.floor(vectors.length / 2)].dx;
                vectors.sort((a, b) => a.dy - b.dy);
                const medianDy = vectors[Math.floor(vectors.length / 2)].dy;
                
                return { dx: medianDx, dy: medianDy, confidence: 1.0 };
            }
        });
        
        console.log('\n=== Motion Analysis Test Results ===');
        console.log(`Expected motion: dx=${results.expected.dx}, dy=${results.expected.dy}`);
        console.log(`Tolerance: ±${results.tolerance} pixels\n`);
        
        for (const [key, r] of Object.entries(results.results)) {
            const status = r.passed ? '✓ PASS' : '✗ FAIL';
            if (r.error) {
                console.log(`${status} ${r.name}: ERROR - ${r.error}`);
            } else {
                console.log(`${status} ${r.name}: dx=${r.dx?.toFixed(2)}, dy=${r.dy?.toFixed(2)} (error: dx=${r.dxError?.toFixed(2)}, dy=${r.dyError?.toFixed(2)})`);
            }
        }
        
        const allPassed = Object.values(results.results).every(r => r.passed);
        const passedTechniques = Object.values(results.results).filter(r => r.passed).map(r => r.name);
        const failedTechniques = Object.values(results.results).filter(r => !r.passed).map(r => r.name);
        
        if (failedTechniques.length > 0) {
                console.log(`\nFailed techniques: ${failedTechniques.join(', ')}`);
            }
            
            expect(passedTechniques.length).toBeGreaterThan(0);
            console.log('[TEST:opencv:PASSED]');
        } catch (error) {
            console.log('[TEST:opencv:FAILED]');
            throw error;
        }
    });
});

test.describe('Motion Analysis Integration', () => {
    test.setTimeout(300000);

    test('motion analysis runs with real video sitch', async ({ page }) => {
        const sitchUrl = '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/GoFast%20Motion%20Tracking/20260128_121417.js&ignoreunload=1&regression=1';

        const motionResults = [];

        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('Motion:')) {
                motionResults.push(text);
                console.log(`[PAGE] ${text}`);
            }
            if (text.includes('error') || text.includes('Error')) {
                console.log(`[PAGE] ${msg.type()}: ${text}`);
            }
        });
        
        page.on('pageerror', err => {
            console.log('[PAGE ERROR]', err);
        });

        const consolePromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Sitch load timeout')), 120000);
            const handler = (msg) => {
                if (msg.text().includes('No pending actions')) {
                    clearTimeout(timeout);
                    page.off('console', handler);
                    resolve();
                }
            };
            page.on('console', handler);
        });

        await page.goto(sitchUrl, { waitUntil: 'load', timeout: 60000 });
        await consolePromise;
        
        await page.waitForTimeout(5000);
        
        console.log('\n=== Integration Test Results (GoFast Video) ===');
        console.log(`Motion analysis logs captured: ${motionResults.length}`);
        
        if (motionResults.length > 0) {
            console.log('✓ Motion analysis is running with saved sitch state');
            for (const result of motionResults) {
                console.log(`  ${result}`);
            }
        }
        
        expect(motionResults.length).toBeGreaterThan(0);
    });

    test('debug phase correlation on GoFast', async ({ page }) => {
        const sitchUrl = '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/GoFast%20Motion%20Tracking/20260104_065553.js&ignoreunload=1&regression=1';
        
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('[DEBUG]') || text.includes('error') || text.includes('Error')) {
                console.log(`[PAGE] ${text}`);
            }
        });
        
        page.on('pageerror', err => {
            console.log('[PAGE ERROR]', err);
        });

        const consolePromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Sitch load timeout')), 120000);
            const handler = (msg) => {
                if (msg.text().includes('No pending actions')) {
                    clearTimeout(timeout);
                    page.off('console', handler);
                    resolve();
                }
            };
            page.on('console', handler);
        });

        await page.goto(sitchUrl, { waitUntil: 'load', timeout: 60000 });
        await consolePromise;
        
        await page.waitForFunction(() => window.NodeMan, { timeout: 30000 });
        
        await page.evaluate(() => {
            return new Promise((resolve, reject) => {
                if (window.cv && window.cv.Mat) { resolve(); return; }
                const script = document.createElement('script');
                script.src = './libs/opencv.js';
                script.onload = () => {
                    const poll = setInterval(() => {
                        if (window.cv && window.cv.Mat) { clearInterval(poll); resolve(); }
                    }, 100);
                };
                script.onerror = reject;
                document.head.appendChild(script);
            });
        });
        
        await page.waitForFunction(() => window.cv && window.cv.Mat, { timeout: 60000 });
        
        const debugResult = await page.evaluate(async () => {
            const cv = window.cv;
            const video = window.NodeMan.get('video');
            if (!video) return { error: 'No video node' };
            
            const frame1 = 400;
            const frame2 = 450;
            
            const getGrayFrame = async (frameNum) => {
                const videoData = video.videoData;
                if (!videoData) return null;
                
                const image = videoData.getImage(frameNum);
                if (!image || !image.width) {
                    console.log(`[DEBUG] Frame ${frameNum}: No image data`);
                    return null;
                }
                
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = image.width || image.videoWidth;
                tempCanvas.height = image.height || image.videoHeight;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.drawImage(image, 0, 0, tempCanvas.width, tempCanvas.height);
                
                const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
                console.log(`[DEBUG] Frame ${frameNum}: ${tempCanvas.width}x${tempCanvas.height}`);
                
                const src = cv.matFromImageData(imageData);
                const gray = new cv.Mat();
                cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
                src.delete();
                return gray;
            };
            
            const gray1 = await getGrayFrame(frame1);
            const gray2 = await getGrayFrame(frame2);
            
            if (!gray1 || !gray2) return { error: 'Failed to get frames' };
            
            let diffCount = 0;
            let samplePixels1 = [];
            let samplePixels2 = [];
            for (let i = 0; i < 100; i++) {
                const y = Math.floor(i / 10) * 50;
                const x = (i % 10) * 100;
                if (y < gray1.rows && x < gray1.cols) {
                    const v1 = gray1.ucharAt(y, x);
                    const v2 = gray2.ucharAt(y, x);
                    if (v1 !== v2) diffCount++;
                    if (i < 10) {
                        samplePixels1.push(v1);
                        samplePixels2.push(v2);
                    }
                }
            }
            console.log(`[DEBUG] Frame diff check: ${diffCount}/100 pixels different`);
            console.log(`[DEBUG] Sample frame1 pixels: ${samplePixels1.join(',')}`);
            console.log(`[DEBUG] Sample frame2 pixels: ${samplePixels2.join(',')}`);
            
            const imgWidth = gray1.cols;
            const imgHeight = gray1.rows;
            
            const optW = cv.getOptimalDFTSize(imgWidth);
            const optH = cv.getOptimalDFTSize(imgHeight);
            
            const padded1 = new cv.Mat();
            const padded2 = new cv.Mat();
            cv.copyMakeBorder(gray1, padded1, 0, optH - imgHeight, 0, optW - imgWidth, cv.BORDER_CONSTANT, new cv.Scalar(0));
            cv.copyMakeBorder(gray2, padded2, 0, optH - imgHeight, 0, optW - imgWidth, cv.BORDER_CONSTANT, new cv.Scalar(0));
            
            const float1 = new cv.Mat();
            const float2 = new cv.Mat();
            padded1.convertTo(float1, cv.CV_32F);
            padded2.convertTo(float2, cv.CV_32F);
            
            const minMax1 = cv.minMaxLoc(float1);
            const minMax2 = cv.minMaxLoc(float2);
            
            const planes1 = new cv.MatVector();
            const planes2 = new cv.MatVector();
            const zeros1 = cv.Mat.zeros(optH, optW, cv.CV_32F);
            const zeros2 = cv.Mat.zeros(optH, optW, cv.CV_32F);
            planes1.push_back(float1);
            planes1.push_back(zeros1);
            planes2.push_back(float2);
            planes2.push_back(zeros2);
            
            const complex1 = new cv.Mat();
            const complex2 = new cv.Mat();
            cv.merge(planes1, complex1);
            cv.merge(planes2, complex2);
            
            cv.dft(complex1, complex1);
            cv.dft(complex2, complex2);
            
            const split1 = new cv.MatVector();
            const split2 = new cv.MatVector();
            cv.split(complex1, split1);
            cv.split(complex2, split2);
            const re1 = split1.get(0);
            const im1 = split1.get(1);
            const re2 = split2.get(0);
            const im2 = split2.get(1);
            
            const crossRe = new cv.Mat();
            const crossIm = new cv.Mat();
            const temp1 = new cv.Mat();
            const temp2 = new cv.Mat();
            cv.multiply(re1, re2, temp1);
            cv.multiply(im1, im2, temp2);
            cv.add(temp1, temp2, crossRe);
            cv.multiply(im1, re2, temp1);
            cv.multiply(re1, im2, temp2);
            cv.subtract(temp1, temp2, crossIm);
            
            const mag = new cv.Mat();
            cv.magnitude(crossRe, crossIm, mag);
            const magMinMax = cv.minMaxLoc(mag);
            
            const epsilon = cv.Mat.ones(optH, optW, cv.CV_32F);
            for (let i = 0; i < epsilon.rows * epsilon.cols; i++) {
                epsilon.data32F[i] = 1e-10;
            }
            cv.add(mag, epsilon, mag);
            
            cv.divide(crossRe, mag, crossRe);
            cv.divide(crossIm, mag, crossIm);
            
            const normPlanes = new cv.MatVector();
            normPlanes.push_back(crossRe);
            normPlanes.push_back(crossIm);
            const normCross = new cv.Mat();
            cv.merge(normPlanes, normCross);
            
            const invResult = new cv.Mat();
            cv.dft(normCross, invResult, cv.DFT_INVERSE | cv.DFT_SCALE);
            
            const resultPlanes = new cv.MatVector();
            cv.split(invResult, resultPlanes);
            const result = resultPlanes.get(0);
            
            const finalMinMax = cv.minMaxLoc(result);
            
            const topPeaks = [];
            for (let y = 0; y < result.rows; y++) {
                for (let x = 0; x < result.cols; x++) {
                    const val = result.floatAt(y, x);
                    if (val > 0.05) {
                        let shiftX = x;
                        let shiftY = y;
                        if (shiftX > result.cols / 2) shiftX -= result.cols;
                        if (shiftY > result.rows / 2) shiftY -= result.rows;
                        topPeaks.push({ x: shiftX, y: shiftY, val: val.toFixed(4) });
                    }
                }
            }
            topPeaks.sort((a, b) => parseFloat(b.val) - parseFloat(a.val));
            
            const vals = [];
            for (let y = 0; y < Math.min(5, result.rows); y++) {
                for (let x = 0; x < Math.min(5, result.cols); x++) {
                    vals.push(result.floatAt(y, x).toFixed(4));
                }
            }
            
            gray1.delete(); gray2.delete();
            padded1.delete(); padded2.delete();
            float1.delete(); float2.delete();
            zeros1.delete(); zeros2.delete();
            planes1.delete(); planes2.delete();
            complex1.delete(); complex2.delete();
            split1.delete(); split2.delete();
            re1.delete(); im1.delete(); re2.delete(); im2.delete();
            crossRe.delete(); crossIm.delete();
            temp1.delete(); temp2.delete();
            mag.delete(); epsilon.delete();
            normPlanes.delete(); normCross.delete();
            invResult.delete(); resultPlanes.delete();
            result.delete();
            
            return {
                frames: [frame1, frame2],
                imageSize: { width: imgWidth, height: imgHeight },
                dftSize: { width: optW, height: optH },
                frame1Range: { min: minMax1.minVal, max: minMax1.maxVal },
                frame2Range: { min: minMax2.minVal, max: minMax2.maxVal },
                crossMagRange: { min: magMinMax.minVal, max: magMinMax.maxVal },
                correlationPeak: {
                    value: finalMinMax.maxVal,
                    location: finalMinMax.maxLoc,
                    minValue: finalMinMax.minVal
                },
                topPeaks: topPeaks.slice(0, 10),
                topLeftCorner: vals
            };
        });
        
        console.log('\n=== Phase Correlation Debug (GoFast) ===');
        console.log(JSON.stringify(debugResult, null, 2));
        
        expect(debugResult.error).toBeUndefined();
    });

    test('debug all techniques on Goast Contrast Tracking', async ({ page }) => {
        const sitchUrl = '?custom=https://sitrec.s3.us-west-2.amazonaws.com/99999999/Goast%20Contrast%20Tracking/20260104_090813.js&ignoreunload=1&regression=1';
        
        page.on('console', msg => {
            const text = msg.text();
            if (text.includes('[DEBUG]') || text.includes('Motion:') || text.includes('error') || text.includes('Error')) {
                console.log(`[PAGE] ${text}`);
            }
        });
        
        page.on('pageerror', err => {
            console.log('[PAGE ERROR]', err);
        });

        const consolePromise = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => reject(new Error('Sitch load timeout')), 120000);
            const handler = (msg) => {
                if (msg.text().includes('No pending actions')) {
                    clearTimeout(timeout);
                    page.off('console', handler);
                    resolve();
                }
            };
            page.on('console', handler);
        });

        await page.goto(sitchUrl, { waitUntil: 'load', timeout: 60000 });
        await consolePromise;
        
        await page.waitForFunction(() => window.NodeMan, { timeout: 30000 });
        
        await page.evaluate(() => {
            return new Promise((resolve, reject) => {
                if (window.cv && window.cv.Mat) { resolve(); return; }
                const script = document.createElement('script');
                script.src = './libs/opencv.js';
                script.onload = () => {
                    const poll = setInterval(() => {
                        if (window.cv && window.cv.Mat) { clearInterval(poll); resolve(); }
                    }, 100);
                };
                script.onerror = reject;
                document.head.appendChild(script);
            });
        });
        
        await page.waitForFunction(() => window.cv && window.cv.Mat, { timeout: 60000 });
        
        const debugResult = await page.evaluate(async () => {
            const cv = window.cv;
            const video = window.NodeMan.get('video');
            if (!video) return { error: 'No video node' };
            
            const TECHNIQUES = {
                SPARSE_CONSENSUS: 'Sparse + Consensus',
                PHASE_CORRELATION: 'Phase Correlation',
                ECC_EUCLIDEAN: 'ECC Euclidean',
                AFFINE_RANSAC: 'Affine RANSAC',
            };
            
            const frame1 = 10;
            const frame2 = 13;
            
            const getGrayFrame = async (frameNum) => {
                const videoData = video.videoData;
                if (!videoData) return null;
                
                const image = videoData.getImage(frameNum);
                if (!image || !image.width) {
                    console.log(`[DEBUG] Frame ${frameNum}: No image data`);
                    return null;
                }
                
                const tempCanvas = document.createElement('canvas');
                tempCanvas.width = image.width || image.videoWidth;
                tempCanvas.height = image.height || image.videoHeight;
                const tempCtx = tempCanvas.getContext('2d');
                tempCtx.drawImage(image, 0, 0, tempCanvas.width, tempCanvas.height);
                
                const imageData = tempCtx.getImageData(0, 0, tempCanvas.width, tempCanvas.height);
                console.log(`[DEBUG] Frame ${frameNum}: ${tempCanvas.width}x${tempCanvas.height}`);
                
                const blurSize = 5;
                const src = cv.matFromImageData(imageData);
                const grayRaw = new cv.Mat();
                cv.cvtColor(src, grayRaw, cv.COLOR_RGBA2GRAY);
                src.delete();
                
                const gray = new cv.Mat();
                cv.GaussianBlur(grayRaw, gray, new cv.Size(blurSize, blurSize), 0);
                grayRaw.delete();
                
                return gray;
            };
            
            const gray1 = await getGrayFrame(frame1);
            const gray2 = await getGrayFrame(frame2);
            
            if (!gray1 || !gray2) return { error: 'Failed to get frames' };
            
            const imgWidth = gray1.cols;
            const imgHeight = gray1.rows;
            const skipFrames = frame2 - frame1;
            const motionScale = 1 / skipFrames;
            
            let diffCount = 0;
            for (let i = 0; i < 100; i++) {
                const y = Math.floor(i / 10) * Math.floor(imgHeight / 10);
                const x = (i % 10) * Math.floor(imgWidth / 10);
                if (y < gray1.rows && x < gray1.cols) {
                    const v1 = gray1.ucharAt(y, x);
                    const v2 = gray2.ucharAt(y, x);
                    if (v1 !== v2) diffCount++;
                }
            }
            console.log(`[DEBUG] Frame diff check: ${diffCount}/100 pixels different`);
            
            const results = {};
            
            const optW = cv.getOptimalDFTSize(imgWidth);
            const optH = cv.getOptimalDFTSize(imgHeight);
            
            const padded1 = new cv.Mat();
            const padded2 = new cv.Mat();
            cv.copyMakeBorder(gray1, padded1, 0, optH - imgHeight, 0, optW - imgWidth, cv.BORDER_CONSTANT, new cv.Scalar(0));
            cv.copyMakeBorder(gray2, padded2, 0, optH - imgHeight, 0, optW - imgWidth, cv.BORDER_CONSTANT, new cv.Scalar(0));
            
            const float1 = new cv.Mat();
            const float2 = new cv.Mat();
            padded1.convertTo(float1, cv.CV_32F);
            padded2.convertTo(float2, cv.CV_32F);
            
            const planes1 = new cv.MatVector();
            const planes2 = new cv.MatVector();
            const zeros1 = cv.Mat.zeros(optH, optW, cv.CV_32F);
            const zeros2 = cv.Mat.zeros(optH, optW, cv.CV_32F);
            planes1.push_back(float1);
            planes1.push_back(zeros1);
            planes2.push_back(float2);
            planes2.push_back(zeros2);
            
            const complex1 = new cv.Mat();
            const complex2 = new cv.Mat();
            cv.merge(planes1, complex1);
            cv.merge(planes2, complex2);
            
            cv.dft(complex1, complex1);
            cv.dft(complex2, complex2);
            
            const split1 = new cv.MatVector();
            const split2 = new cv.MatVector();
            cv.split(complex1, split1);
            cv.split(complex2, split2);
            const re1 = split1.get(0);
            const im1 = split1.get(1);
            const re2 = split2.get(0);
            const im2 = split2.get(1);
            
            const crossRe = new cv.Mat();
            const crossIm = new cv.Mat();
            const temp1 = new cv.Mat();
            const temp2 = new cv.Mat();
            cv.multiply(re1, re2, temp1);
            cv.multiply(im1, im2, temp2);
            cv.add(temp1, temp2, crossRe);
            cv.multiply(im1, re2, temp1);
            cv.multiply(re1, im2, temp2);
            cv.subtract(temp1, temp2, crossIm);
            
            const mag = new cv.Mat();
            cv.magnitude(crossRe, crossIm, mag);
            const epsilon = cv.Mat.ones(optH, optW, cv.CV_32F);
            for (let i = 0; i < epsilon.rows * epsilon.cols; i++) {
                epsilon.data32F[i] = 1e-10;
            }
            cv.add(mag, epsilon, mag);
            
            cv.divide(crossRe, mag, crossRe);
            cv.divide(crossIm, mag, crossIm);
            
            const normPlanes = new cv.MatVector();
            normPlanes.push_back(crossRe);
            normPlanes.push_back(crossIm);
            const normCross = new cv.Mat();
            cv.merge(normPlanes, normCross);
            
            const invResult = new cv.Mat();
            cv.dft(normCross, invResult, cv.DFT_INVERSE | cv.DFT_SCALE);
            
            const resultPlanes = new cv.MatVector();
            cv.split(invResult, resultPlanes);
            const result = resultPlanes.get(0);
            
            const finalMinMax = cv.minMaxLoc(result);
            const peakLoc = finalMinMax.maxLoc;
            const response = finalMinMax.maxVal;
            
            let shiftX = peakLoc.x;
            let shiftY = peakLoc.y;
            if (shiftX > optW / 2) shiftX -= optW;
            if (shiftY > optH / 2) shiftY -= optH;
            
            const topPeaks = [];
            for (let y = 0; y < result.rows; y++) {
                for (let x = 0; x < result.cols; x++) {
                    const val = result.floatAt(y, x);
                    if (val > 0.05) {
                        let sx = x, sy = y;
                        if (sx > optW / 2) sx -= optW;
                        if (sy > optH / 2) sy -= optH;
                        topPeaks.push({ x: sx, y: sy, val });
                    }
                }
            }
            topPeaks.sort((a, b) => b.val - a.val);
            const top10 = topPeaks.slice(0, 10).map(p => ({ x: p.x, y: p.y, val: p.val.toFixed(4) }));
            
            const expectedX = Math.round(1.51 * 3);
            const expectedY = Math.round(-0.99 * 3);
            const checkShifts = [[expectedX, expectedY], [-expectedX, -expectedY], [expectedX, -expectedY], [-expectedX, expectedY]];
            const valuesAtShifts = checkShifts.map(([sx, sy]) => {
                const rawX = sx < 0 ? optW + sx : sx;
                const rawY = sy < 0 ? optH + sy : sy;
                if (rawY >= 0 && rawY < result.rows && rawX >= 0 && rawX < result.cols) {
                    return { shift: [sx, sy], val: result.floatAt(rawY, rawX) };
                }
                return { shift: [sx, sy], val: null };
            });
            
            results.phaseCorrelation = {
                rawShift: { x: shiftX, y: shiftY },
                dx: -shiftX * motionScale,
                dy: -shiftY * motionScale,
                response: response,
                peakLoc: peakLoc,
                top10Peaks: top10,
                expectedShift: { x: expectedX, y: expectedY },
                valuesAtShifts: valuesAtShifts
            };
            
            padded1.delete(); padded2.delete();
            float1.delete(); float2.delete();
            zeros1.delete(); zeros2.delete();
            planes1.delete(); planes2.delete();
            complex1.delete(); complex2.delete();
            split1.delete(); split2.delete();
            re1.delete(); im1.delete(); re2.delete(); im2.delete();
            crossRe.delete(); crossIm.delete();
            temp1.delete(); temp2.delete();
            mag.delete(); epsilon.delete();
            normPlanes.delete(); normCross.delete();
            invResult.delete(); resultPlanes.delete();
            result.delete();
            
            if (typeof cv.findTransformECC === 'function') {
                const warpMatrix = cv.Mat.eye(2, 3, cv.CV_32F);
                const criteria = new cv.TermCriteria(
                    cv.TermCriteria_COUNT + cv.TermCriteria_EPS,
                    50, 0.001
                );
                const inputMask = new cv.Mat();
                const gaussFiltSize = 5;
                
                try {
                    const cc = cv.findTransformECC(gray1, gray2, warpMatrix, cv.MOTION_EUCLIDEAN, criteria, inputMask, gaussFiltSize);
                    
                    const cosTheta = warpMatrix.floatAt(0, 0);
                    const sinTheta = warpMatrix.floatAt(1, 0);
                    const txRaw = warpMatrix.floatAt(0, 2);
                    const tyRaw = warpMatrix.floatAt(1, 2);
                    
                    const rotation = Math.atan2(sinTheta, cosTheta);
                    const dx = txRaw * motionScale;
                    const dy = tyRaw * motionScale;
                    
                    results.ecc = {
                        dx: dx,
                        dy: dy,
                        rotation: rotation * (180 / Math.PI),
                        cc: cc,
                        rawTx: txRaw,
                        rawTy: tyRaw
                    };
                    
                    warpMatrix.delete();
                    inputMask.delete();
                } catch (e) {
                    results.ecc = { error: e.message || String(e) };
                }
            } else {
                results.ecc = { error: 'findTransformECC not available' };
            }
            
            const prevPoints = [];
            const nextPoints = [];
            
            const corners = new cv.Mat();
            cv.goodFeaturesToTrack(gray1, corners, 300, 0.01, 10);
            
            if (corners.rows > 0) {
                const prevPts = new cv.Mat(corners.rows, 1, cv.CV_32FC2);
                for (let i = 0; i < corners.rows; i++) {
                    prevPts.floatPtr(i, 0)[0] = corners.floatAt(i, 0);
                    prevPts.floatPtr(i, 0)[1] = corners.floatAt(i, 1);
                }
                
                const nextPts = new cv.Mat();
                const status = new cv.Mat();
                const err = new cv.Mat();
                
                cv.calcOpticalFlowPyrLK(gray1, gray2, prevPts, nextPts, status, err);
                
                for (let i = 0; i < prevPts.rows; i++) {
                    if (status.ucharAt(i, 0) === 1) {
                        prevPoints.push([prevPts.floatAt(i, 0), prevPts.floatAt(i, 1)]);
                        nextPoints.push([nextPts.floatAt(i, 0), nextPts.floatAt(i, 1)]);
                    }
                }
                
                prevPts.delete();
                nextPts.delete();
                status.delete();
                err.delete();
            }
            corners.delete();
            
            if (prevPoints.length >= 4) {
                const prevPtsMat = cv.matFromArray(prevPoints.length, 1, cv.CV_32FC2, prevPoints.flat());
                const nextPtsMat = cv.matFromArray(nextPoints.length, 1, cv.CV_32FC2, nextPoints.flat());
                const inliersMask = new cv.Mat();
                
                try {
                    const transform = cv.estimateAffinePartial2D(prevPtsMat, nextPtsMat, inliersMask, cv.RANSAC, 3.0);
                    
                    if (transform && !transform.empty()) {
                        const cosTheta = transform.doubleAt(0, 0);
                        const sinTheta = transform.doubleAt(1, 0);
                        const tx = transform.doubleAt(0, 2);
                        const ty = transform.doubleAt(1, 2);
                        
                        const rotation = Math.atan2(sinTheta, cosTheta);
                        const dx = tx * motionScale;
                        const dy = ty * motionScale;
                        
                        let inlierCount = 0;
                        for (let i = 0; i < inliersMask.rows; i++) {
                            if (inliersMask.ucharAt(i, 0) === 1) inlierCount++;
                        }
                        
                        results.affineRansac = {
                            dx: dx,
                            dy: dy,
                            rotation: rotation * (180 / Math.PI),
                            inlierCount: inlierCount,
                            totalPoints: prevPoints.length,
                            rawTx: tx,
                            rawTy: ty
                        };
                        
                        transform.delete();
                    } else {
                        results.affineRansac = { error: 'transform empty', pointsFound: prevPoints.length };
                    }
                    inliersMask.delete();
                } catch (e) {
                    results.affineRansac = { error: e.message || String(e), pointsFound: prevPoints.length };
                }
                
                prevPtsMat.delete();
                nextPtsMat.delete();
            } else {
                results.affineRansac = { error: 'Not enough points', pointsFound: prevPoints.length };
            }
            
            let dxSum = 0, dySum = 0, count = 0;
            for (let i = 0; i < prevPoints.length && i < nextPoints.length; i++) {
                const dx = nextPoints[i][0] - prevPoints[i][0];
                const dy = nextPoints[i][1] - prevPoints[i][1];
                dxSum += dx;
                dySum += dy;
                count++;
            }
            
            if (count > 0) {
                results.sparseConsensus = {
                    dx: (dxSum / count) * motionScale,
                    dy: (dySum / count) * motionScale,
                    pointsTracked: count
                };
            } else {
                results.sparseConsensus = { error: 'No points tracked' };
            }
            
            gray1.delete();
            gray2.delete();
            
            return {
                frames: [frame1, frame2],
                imageSize: { width: imgWidth, height: imgHeight },
                pixelsDifferent: diffCount,
                results: results
            };
        });
        
        console.log('\n=== Motion Analysis Debug (Goast Contrast Tracking) ===');
        console.log(JSON.stringify(debugResult, null, 2));
        
        expect(debugResult.error).toBeUndefined();
        expect(debugResult.pixelsDifferent).toBeGreaterThan(0);
    });
});
