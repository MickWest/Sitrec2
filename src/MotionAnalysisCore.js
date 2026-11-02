export const MOTION_TECHNIQUES = {
    SPARSE_CONSENSUS: 'Sparse + Consensus',
    PHASE_CORRELATION: 'Phase Correlation',
    ECC_EUCLIDEAN: 'ECC Euclidean',
    AFFINE_RANSAC: 'Affine RANSAC',
};

export class MotionAnalysisCore {
    constructor(cv) {
        this.cv = cv;
        this.params = {
            technique: MOTION_TECHNIQUES.SPARSE_CONSENSUS,
            maxFeatures: 300,
            qualityLevel: 0.01,
            minDistance: 10,
            blurSize: 5,
            minMotion: 0.2,
            maxMotion: 100,
            minQuality: 0.3,
            maxTrackError: 15,
            staticThreshold: 0.3,
            inlierThreshold: 0.6,
            eccIterations: 50,
            eccEpsilon: 0.001,
            ransacThreshold: 3.0,
        };
        this.staticHistory = new Map();
        this._warnings = {};
    }

    setTechnique(technique) {
        this.params.technique = technique;
    }

    analyze(prevGray, gray, skipFrames = 1) {
        const cv = this.cv;
        const imgWidth = gray.cols;
        const imgHeight = gray.rows;

        switch (this.params.technique) {
            case MOTION_TECHNIQUES.PHASE_CORRELATION:
                return this.computePhaseCorrelation(prevGray, gray, imgWidth, imgHeight, skipFrames);
            case MOTION_TECHNIQUES.ECC_EUCLIDEAN:
                return this.computeECC(prevGray, gray, imgWidth, imgHeight, skipFrames);
            case MOTION_TECHNIQUES.AFFINE_RANSAC:
                return this.computeAffineRANSAC(prevGray, gray, imgWidth, imgHeight, skipFrames);
            case MOTION_TECHNIQUES.SPARSE_CONSENSUS:
            default:
                return this.computeSparseConsensus(prevGray, gray, imgWidth, imgHeight, skipFrames);
        }
    }

    computePhaseCorrelation(prevGray, gray, imgWidth, imgHeight, skipFrames) {
        const cv = this.cv;
        
        if (typeof cv.phaseCorrelate === 'function') {
            return this.computePhaseCorrelateNative(prevGray, gray, imgWidth, imgHeight, skipFrames);
        }
        
        if (!this._warnings.phaseCorrelate) {
            console.warn("cv.phaseCorrelate not available, using DFT-based implementation");
            this._warnings.phaseCorrelate = true;
        }
        return this.computePhaseCorrelationDFT(prevGray, gray, imgWidth, imgHeight, skipFrames);
    }

    computePhaseCorrelateNative(prevGray, gray, imgWidth, imgHeight, skipFrames) {
        const cv = this.cv;
        const motionScale = 1 / skipFrames;
        
        const prevFloat = new cv.Mat();
        const grayFloat = new cv.Mat();
        prevGray.convertTo(prevFloat, cv.CV_32F);
        gray.convertTo(grayFloat, cv.CV_32F);
        
        let shift, response = 0.5;
        try {
            shift = cv.phaseCorrelate(prevFloat, grayFloat);
            if (shift.response !== undefined) {
                response = shift.response;
            }
        } catch (e) {
            console.error("Phase correlation error:", e);
            prevFloat.delete();
            grayFloat.delete();
            return null;
        }
        
        prevFloat.delete();
        grayFloat.delete();
        
        const dx = shift.x * motionScale;
        const dy = shift.y * motionScale;
        const confidence = Math.min(1, Math.max(0.5, response));
        
        return { dx, dy, confidence, rotation: 0 };
    }

    computePhaseCorrelationDFT(prevGray, gray, imgWidth, imgHeight, skipFrames) {
        const cv = this.cv;
        const motionScale = 1 / skipFrames;
        
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
        const response = minMax.maxVal;
        result.delete();
        
        let shiftX = peakLoc.x;
        let shiftY = peakLoc.y;
        if (shiftX > optW / 2) shiftX -= optW;
        if (shiftY > optH / 2) shiftY -= optH;
        
        const dx = -shiftX * motionScale;
        const dy = -shiftY * motionScale;
        const confidence = Math.min(1, Math.max(0.3, response * 10));
        
        return { dx, dy, confidence, rotation: 0 };
    }

    computeECC(prevGray, gray, imgWidth, imgHeight, skipFrames) {
        const cv = this.cv;
        
        if (typeof cv.findTransformECC !== 'function') {
            if (!this._warnings.ecc) {
                console.warn("cv.findTransformECC not available, falling back to Affine RANSAC");
                this._warnings.ecc = true;
            }
            return this.computeAffineRANSAC(prevGray, gray, imgWidth, imgHeight, skipFrames);
        }
        
        const motionScale = 1 / skipFrames;
        const warpMatrix = cv.Mat.eye(2, 3, cv.CV_32F);
        
        const criteria = new cv.TermCriteria(
            cv.TermCriteria_COUNT + cv.TermCriteria_EPS,
            this.params.eccIterations,
            this.params.eccEpsilon
        );
        
        const inputMask = new cv.Mat();
        const gaussFiltSize = 5;
        
        let cc;
        try {
            cc = cv.findTransformECC(prevGray, gray, warpMatrix, cv.MOTION_EUCLIDEAN, criteria, inputMask, gaussFiltSize);
        } catch (e) {
            console.error("ECC error:", e.message || e);
            warpMatrix.delete();
            inputMask.delete();
            return null;
        }
        
        inputMask.delete();
        
        const cosTheta = warpMatrix.floatAt(0, 0);
        const sinTheta = warpMatrix.floatAt(1, 0);
        const txRaw = warpMatrix.floatAt(0, 2);
        const tyRaw = warpMatrix.floatAt(1, 2);
        const centerDx = cosTheta * imgWidth / 2 + warpMatrix.floatAt(0, 1) * imgHeight / 2 + txRaw - imgWidth / 2;
        const centerDy = sinTheta * imgWidth / 2 + warpMatrix.floatAt(1, 1) * imgHeight / 2 + tyRaw - imgHeight / 2;
        warpMatrix.delete();
        
        const rotation = Math.atan2(sinTheta, cosTheta) * motionScale;
        const dx = centerDx * motionScale;
        const dy = centerDy * motionScale;
        const confidence = Math.min(1, cc);
        
        return { dx, dy, confidence, rotation };
    }

    computeAffineRANSAC(prevGray, gray, imgWidth, imgHeight, skipFrames) {
        const cv = this.cv;
        const tracked = this.trackFeatures(prevGray, gray, skipFrames);
        
        if (tracked.prevPoints.length < 4) {
            return null;
        }
        
        const prevPtsMat = cv.matFromArray(tracked.prevPoints.length, 1, cv.CV_32FC2, tracked.prevPoints.flat());
        const nextPtsMat = cv.matFromArray(tracked.nextPoints.length, 1, cv.CV_32FC2, tracked.nextPoints.flat());
        const inliersMask = new cv.Mat();
        
        let transform;
        try {
            transform = cv.estimateAffinePartial2D(prevPtsMat, nextPtsMat, inliersMask, cv.RANSAC, this.params.ransacThreshold);
        } catch (e) {
            console.error("RANSAC error:", e);
            prevPtsMat.delete();
            nextPtsMat.delete();
            inliersMask.delete();
            return null;
        }
        
        if (!transform || transform.empty()) {
            prevPtsMat.delete();
            nextPtsMat.delete();
            inliersMask.delete();
            if (transform) transform.delete();
            return null;
        }
        
        const motionScale = 1 / skipFrames;
        const cosTheta = transform.doubleAt(0, 0);
        const sinTheta = transform.doubleAt(1, 0);
        const txRaw = transform.doubleAt(0, 2);
        const tyRaw = transform.doubleAt(1, 2);
        const centerDx = cosTheta * imgWidth / 2 + transform.doubleAt(0, 1) * imgHeight / 2 + txRaw - imgWidth / 2;
        const centerDy = sinTheta * imgWidth / 2 + transform.doubleAt(1, 1) * imgHeight / 2 + tyRaw - imgHeight / 2;
        transform.delete();
        
        let inlierCount = 0;
        for (let i = 0; i < tracked.prevPoints.length; i++) {
            if (inliersMask.data[i] === 1) inlierCount++;
        }
        
        prevPtsMat.delete();
        nextPtsMat.delete();
        inliersMask.delete();
        
        const rotation = Math.atan2(sinTheta, cosTheta) * motionScale;
        const dx = centerDx * motionScale;
        const dy = centerDy * motionScale;
        const confidence = inlierCount / tracked.prevPoints.length;
        
        return { dx, dy, confidence, rotation, inlierCount };
    }

    computeSparseConsensus(prevGray, gray, imgWidth, imgHeight, skipFrames) {
        const tracked = this.trackFeatures(prevGray, gray, skipFrames);
        const motionScale = 1 / skipFrames;
        
        const flowVectors = [];
        
        for (let i = 0; i < tracked.prevPoints.length; i++) {
            const [px, py] = tracked.prevPoints[i];
            const [nx, ny] = tracked.nextPoints[i];
            const dx = (nx - px) * motionScale;
            const dy = (ny - py) * motionScale;
            const mag = Math.sqrt(dx * dx + dy * dy);
            
            if (mag < this.params.minMotion || mag > this.params.maxMotion) continue;
            if (tracked.qualities[i] < this.params.minQuality) continue;
            
            flowVectors.push({
                px, py, dx, dy, mag,
                quality: tracked.qualities[i],
                angle: Math.atan2(dy, dx)
            });
        }
        
        if (flowVectors.length < 3) {
            return null;
        }
        
        return this.findConsensusDirection(flowVectors);
    }

    trackFeatures(prevGray, gray, skipFrames) {
        const cv = this.cv;
        const prevPoints = [];
        const nextPoints = [];
        const qualities = [];
        const trackErrors = [];
        
        const corners = new cv.Mat();
        try {
            cv.goodFeaturesToTrack(prevGray, corners, this.params.maxFeatures, this.params.qualityLevel, this.params.minDistance);
        } catch (e) {
            corners.delete();
            return { prevPoints, nextPoints, qualities, trackErrors };
        }
        
        if (corners.rows === 0) {
            corners.delete();
            return { prevPoints, nextPoints, qualities, trackErrors };
        }
        
        const nextPtsMat = new cv.Mat();
        const status = new cv.Mat();
        const err = new cv.Mat();
        
        try {
            cv.calcOpticalFlowPyrLK(prevGray, gray, corners, nextPtsMat, status, err);
        } catch (e) {
            corners.delete();
            nextPtsMat.delete();
            status.delete();
            err.delete();
            return { prevPoints, nextPoints, qualities, trackErrors };
        }
        
        const motionScale = 1 / skipFrames;
        
        for (let i = 0; i < status.rows; i++) {
            if (status.data[i] !== 1) continue;
            
            const px = corners.floatAt(i, 0);
            const py = corners.floatAt(i, 1);
            const nx = nextPtsMat.floatAt(i, 0);
            const ny = nextPtsMat.floatAt(i, 1);
            const trackError = err.floatAt(i, 0);
            
            if (trackError > this.params.maxTrackError) continue;
            
            const dx = (nx - px) * motionScale;
            const dy = (ny - py) * motionScale;
            const mag = Math.sqrt(dx * dx + dy * dy);
            
            const errorQuality = Math.max(0, 1 - trackError / this.params.maxTrackError);
            const magQuality = Math.min(1, mag / 1.0);
            const quality = errorQuality * magQuality;
            
            prevPoints.push([px, py]);
            nextPoints.push([nx, ny]);
            qualities.push(quality);
            trackErrors.push(trackError);
        }
        
        corners.delete();
        nextPtsMat.delete();
        status.delete();
        err.delete();
        
        return { prevPoints, nextPoints, qualities, trackErrors };
    }

    findConsensusDirection(vectors) {
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
            ];
            const count = neighbors.reduce((sum, b) => sum + b.length, 0);
            const qualitySum = neighbors.reduce((sum, b) => sum + b.reduce((s, v) => s + v.quality, 0), 0);
            const score = count + qualitySum * 0.5;
            
            if (score > bestScore) {
                bestScore = score;
                bestBin = i;
            }
        }

        if (bestBin < 0) return null;

        const inliers = [
            ...bins[(bestBin - 1 + numBins) % numBins],
            ...bins[bestBin],
            ...bins[(bestBin + 1) % numBins]
        ];

        if (inliers.length < 3) return null;

        const inlierRatio = inliers.length / vectors.length;
        if (inlierRatio < this.params.inlierThreshold) return null;

        let sumDx = 0, sumDy = 0, sumWeight = 0;
        for (const v of inliers) {
            const w = v.quality;
            sumDx += v.dx * w;
            sumDy += v.dy * w;
            sumWeight += w;
        }

        const dx = sumDx / sumWeight;
        const dy = sumDy / sumWeight;
        const confidence = inlierRatio;

        return { dx, dy, confidence, rotation: 0, inlierCount: inliers.length };
    }
}
