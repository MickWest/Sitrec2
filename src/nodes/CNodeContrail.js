import {CNode3DGroup} from "./CNode3DGroup";
import * as THREE from "three";
import {GlobalDateTimeNode, setRenderOne, Sit} from "../Globals";
import {dispose} from "../threeExt";
import {V3} from "../threeUtils";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "../SphericalMath";
import {ECEFToLLAVD_radii, RLLAToECEF_radii} from "../LLA-ECEF-ENU";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {radians} from "../utils";
import * as LAYER from "../LayerMasks";

// CNodeContrail renders a flat horizontal white ribbon trailing behind a track,
// drifting with wind over time. Rebuilt every frame based on the current playback position.
// If a dataTrack is provided with time-based lookup (getTime/getIndexAtTime),
// the contrail can extend before the sitch start time into the data track's earlier data.
export class CNodeContrail extends CNode3DGroup {
    constructor(v) {
        v.layers ??= LAYER.MASK_HELPERS | LAYER.MASK_LOOK;
        super(v);

        this.input("track");
        // `windField` (CNodeDisplayWindField) is the preferred wind source —
        // it knows the user-selected wind data (manual / GFS / soundings /
        // openmeteo / track-driven) and supports per-altitude sampling so the
        // contrail reflects wind variation along its length and at its actual
        // flight altitude. `wind` (a CNodeWind such as `targetWind`) is the
        // legacy fallback used when no windField is wired or when the field
        // has no data at the sampled location.
        this.optionalInputs(["wind", "windField", "dataTrack"]);

        this.duration = v.duration ?? 100;         // seconds of trail
        this.sampleInterval = v.sampleInterval ?? 5; // seconds between samples
        this.ribbonWidth = v.ribbonWidth ?? 50;    // meters
        this.spread = v.spread ?? 0;               // m/s width increase over time
        this.rampDistance = v.rampDistance ?? 500; // meters from tip to reach full width
        this.initialWidth = v.initialWidth ?? 15;   // meters width at the very tip

        this.mesh = null;

        this.material = new THREE.MeshBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.7,
            side: THREE.DoubleSide,
            depthWrite: false,
        });
    }

    dispose() {
        this.removeMesh();
        this.material.dispose();
        super.dispose();
    }

    removeMesh() {
        if (this.mesh) {
            this.group.remove(this.mesh);
            dispose(this.mesh.geometry);
            this.mesh = null;
        }
    }

    update(frame) {
        super.update(frame);
        this.rebuildRibbon(frame);
        // rebuildRibbon(frame) is frame-deterministic, so only request a render when
        // the frame actually changed. Calling setRenderOne(true) every frame here
        // re-armed the render loop continuously — once render-on-demand was fixed to
        // actually sleep, a paused contrail-enabled track would peg CPU at ~600%.
        // Parameter edits go through GUI onChange handlers that already setRenderOne.
        if (frame !== this._lastContrailFrame) {
            this._lastContrailFrame = frame;
            setRenderOne(true);
        }
    }

    // Binary search for a float frame index in the data track matching a target time.
    findDataTrackFloatFrame(dataTrack, targetTimeMs) {
        const n = dataTrack.frames;
        if (n < 2) return 0;

        if (targetTimeMs <= dataTrack.getTime(0)) return 0;
        if (targetTimeMs >= dataTrack.getTime(n - 1)) return n - 1;

        let lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (dataTrack.getTime(mid) <= targetTimeMs) {
                lo = mid;
            } else {
                hi = mid;
            }
        }

        const tLo = dataTrack.getTime(lo);
        const tHi = dataTrack.getTime(hi);
        if (tHi <= tLo) return lo;
        const frac = (targetTimeMs - tLo) / (tHi - tLo);
        return lo + frac;
    }

    // Get position for a sitch frame, falling back to data track for pre-sitch frames.
    getPositionAtFrame(frame) {
        const track = this.in.track;

        if (frame >= 0 && frame < track.frames) {
            const sample = track.v(frame);
            const pos = sample?.position ?? sample;
            if (pos?.clone && !isNaN(pos.x)) return pos.clone();
            return null;
        }

        if (frame < 0 && this.in.dataTrack && typeof this.in.dataTrack.getTime === 'function') {
            const dataTrack = this.in.dataTrack;
            const msStart = GlobalDateTimeNode.getStartTimeValue();
            const targetTimeMs = msStart + (frame / Sit.fps) * 1000;

            if (targetTimeMs < dataTrack.getTime(0)) return null;

            const floatFrame = this.findDataTrackFloatFrame(dataTrack, targetTimeMs);

            // Validate bracketing frames before interpolating - data track can have
            // empty slots (filtered/invalid data) that cause assertion failures
            const lo = Math.floor(floatFrame);
            const hi = Math.ceil(floatFrame);
            const loVal = (lo >= 0 && lo < dataTrack.frames) ? dataTrack.v(lo) : null;
            const hiVal = (hi >= 0 && hi < dataTrack.frames) ? dataTrack.v(hi) : null;
            const loOk = loVal && loVal.position && !isNaN(loVal.position.x);
            const hiOk = hiVal && hiVal.position && !isNaN(hiVal.position.x);

            let pos;
            if (loOk && hiOk) {
                pos = dataTrack.p(floatFrame);
            } else if (loOk) {
                pos = loVal.position;
            } else if (hiOk) {
                pos = hiVal.position;
            } else {
                return null;
            }
            if (pos && !isNaN(pos.x)) return pos.clone();
        }

        return null;
    }

    // Clamp an ECEF point to a target altitude (HAE meters), preserving lat/lon.
    clampToAltitude(ecef, targetAlt) {
        const lla = ECEFToLLAVD_radii(ecef); // {x: lat_deg, y: lon_deg, z: alt_m}
        return RLLAToECEF_radii(radians(lla.x), radians(lla.y), targetAlt);
    }

    // Resolve a per-frame ECEF wind vector at `pos`, sampling the windField
    // at the contrail's altitude when available so a long contrail bends with
    // wind variation along its length. Falls back to the legacy `wind` input
    // (a CNodeWind, typically `targetWind`) when the field has no data here
    // — old saves without windField wired keep working unchanged.
    //
    // `trackAltHae` is height above the WGS-84 ellipsoid (what
    // ECEFToLLAVD_radii returns); the wind field samples in MSL-meters so we
    // subtract the geoid offset before sampling.
    _windAt(pos, frame, trackAltHae) {
        const windField = this.in.windField;
        if (windField && windField.windU) {
            const lla = ECEFToLLAVD_radii(pos);
            if (Number.isFinite(lla.x) && Number.isFinite(lla.y)) {
                const altMsl = (Number.isFinite(trackAltHae) ? trackAltHae : lla.z)
                    - meanSeaLevelOffset(lla.x, lla.y);
                const uv = windField.sampleWindAtAltitude(lla.x, lla.y, altMsl);
                if (uv && Number.isFinite(uv.u) && Number.isFinite(uv.v)) {
                    const east = getLocalEastVector(pos);
                    const north = getLocalNorthVector(pos);
                    return east.multiplyScalar(uv.u)
                        .add(north.multiplyScalar(uv.v))
                        .divideScalar(Sit.fps);
                }
            }
        }
        if (this.in.wind) return this.in.wind.getValueFrame(frame, pos);
        return null;
    }

    rebuildRibbon(frame) {
        this.removeMesh();

        const fps = Sit.fps;
        const hasWind = !!(this.in.wind || (this.in.windField && this.in.windField.windU));

        // Collect sample points with elapsed time and original track altitude
        const samples = [];
        const maxOffset = this.duration;
        const step = this.sampleInterval;

        for (let t = maxOffset; t >= 0; t -= step) {
            const sampleFrame = frame - t * fps;
            const pos = this.getPositionAtFrame(sampleFrame);
            if (!pos) continue;

            // Remember the track point's altitude before wind drift
            const trackAlt = ECEFToLLAVD_radii(pos).z;

            // Apply wind drift computed at this point's location (not a shared reference)
            if (hasWind) {
                const windPerFrame = this._windAt(pos, frame, trackAlt);
                if (windPerFrame) pos.add(windPerFrame.multiplyScalar(t * fps));
            }

            samples.push({pos, elapsed: t, trackAlt});
        }

        // Include current position exactly if loop didn't land on t=0
        const lastT = maxOffset % step;
        if (lastT !== 0) {
            const pos = this.getPositionAtFrame(frame);
            if (pos) {
                const trackAlt = ECEFToLLAVD_radii(pos).z;
                samples.push({pos, elapsed: 0, trackAlt});
            }
        }

        if (samples.length < 2) return;

        // Compute midpoint for float precision
        const mid = V3(0, 0, 0);
        for (const s of samples) mid.add(s.pos);
        mid.divideScalar(samples.length);

        // Compute cumulative distance from the leading edge (tip) backwards.
        // Samples are ordered oldest-first, so the tip is the last sample.
        const distFromTip = new Array(samples.length);
        distFromTip[samples.length - 1] = 0;
        for (let i = samples.length - 2; i >= 0; i--) {
            distFromTip[i] = distFromTip[i + 1] + samples[i].pos.distanceTo(samples[i + 1].pos);
        }

        // Subdivide segments in the ramp zone for smooth width transition (~2m spacing)
        if (this.rampDistance > 0) {
            const rampSegLen = 2; // meters
            const subdividedSamples = [];
            for (let i = 0; i < samples.length; i++) {
                subdividedSamples.push(samples[i]);
                if (i < samples.length - 1) {
                    const d0 = distFromTip[i];
                    const d1 = distFromTip[i + 1];
                    if (d0 <= this.rampDistance || d1 <= this.rampDistance) {
                        const segLen = samples[i].pos.distanceTo(samples[i + 1].pos);
                        const subdivs = Math.min(Math.ceil(segLen / rampSegLen), 250);
                        if (subdivs > 1) {
                            for (let s = 1; s < subdivs; s++) {
                                const frac = s / subdivs;
                                const pos = samples[i].pos.clone().lerp(samples[i + 1].pos, frac);
                                const elapsed = samples[i].elapsed + (samples[i + 1].elapsed - samples[i].elapsed) * frac;
                                const trackAlt = samples[i].trackAlt + (samples[i + 1].trackAlt - samples[i].trackAlt) * frac;
                                subdividedSamples.push({pos, elapsed, trackAlt});
                            }
                        }
                    }
                }
            }
            samples.length = 0;
            for (let i = 0; i < subdividedSamples.length; i++) {
                samples.push(subdividedSamples[i]);
            }

            // Recompute distFromTip for subdivided samples
            distFromTip.length = samples.length;
            distFromTip[samples.length - 1] = 0;
            for (let i = samples.length - 2; i >= 0; i--) {
                distFromTip[i] = distFromTip[i + 1] + samples[i].pos.distanceTo(samples[i + 1].pos);
            }
        }

        // Pre-compute per-point left/right edge positions.
        // Shared between adjacent quads so there are no gaps.
        const edges = [];

        for (let i = 0; i < samples.length; i++) {
            const p = samples[i].pos;
            const elapsed = samples[i].elapsed;
            const trackAlt = samples[i].trackAlt;

            // Per-point travel direction: average of adjacent segments for smooth edges
            let dir;
            if (i === 0) {
                dir = samples[1].pos.clone().sub(p);
            } else if (i === samples.length - 1) {
                dir = p.clone().sub(samples[i - 1].pos);
            } else {
                dir = samples[i + 1].pos.clone().sub(samples[i - 1].pos);
            }
            if (dir.lengthSq() < 1e-8) continue;
            dir.normalize();

            const up = getLocalUpVector(p);
            const perp = V3().crossVectors(dir, up).normalize();

            // Attenuate width near the tip: lerp from initialWidth to ribbonWidth
            // over the rampDistance, then use ribbonWidth beyond that.
            const d = distFromTip[i];
            let effectiveWidth;
            if (this.rampDistance > 0 && d < this.rampDistance) {
                const t = d / this.rampDistance;
                effectiveWidth = this.initialWidth + (this.ribbonWidth - this.initialWidth) * t;
            } else {
                effectiveWidth = this.ribbonWidth;
            }

            // Base half-width perpendicular to travel
            const baseHW = effectiveWidth / 2;

            // Spread half-width in wind direction (computed locally at this point)
            const spreadHW = this.spread * elapsed / 2;

            // Sample wind at the contrail sample's flight altitude so a
            // long ribbon spreading across regions with different winds-
            // aloft tracks each region's actual wind, not a single
            // column-average value.
            const windVec = (hasWind && spreadHW > 0)
                ? this._windAt(p, frame, trackAlt) : null;

            let leftOffset, rightOffset;
            if (windVec) {
                let localWindDir = windVec.clone().sub(up.clone().multiplyScalar(windVec.dot(up)));
                if (localWindDir.lengthSq() > 1e-10) {
                    localWindDir.normalize();
                } else {
                    localWindDir = perp; // fallback
                }
                // Project wind direction onto perp axis to get signed shift.
                // Positive windPerp means wind blows in the +perp direction (toward "right").
                const windPerp = localWindDir.dot(perp);
                // Shift the center in the wind direction and expand both edges by spreadHW.
                // Left edge  = center - baseHW - spreadHW  (in perp units)
                // Right edge = center + baseHW + spreadHW
                // where center is shifted by windPerp * spreadHW along perp.
                const centerShift = windPerp * spreadHW;
                const leftDist  = centerShift - baseHW - spreadHW;
                const rightDist = centerShift + baseHW + spreadHW;
                leftOffset = perp.clone().multiplyScalar(leftDist);
                rightOffset = perp.clone().multiplyScalar(rightDist);
            } else {
                leftOffset = perp.clone().multiplyScalar(-baseHW);
                rightOffset = perp.clone().multiplyScalar(baseHW);
            }

            // Compute edge positions in world space, then clamp to track altitude
            const leftWorld = V3(p.x + leftOffset.x, p.y + leftOffset.y, p.z + leftOffset.z);
            const rightWorld = V3(p.x + rightOffset.x, p.y + rightOffset.y, p.z + rightOffset.z);

            const leftClamped = this.clampToAltitude(leftWorld, trackAlt);
            const rightClamped = this.clampToAltitude(rightWorld, trackAlt);

            edges.push({
                left: V3(leftClamped.x - mid.x, leftClamped.y - mid.y, leftClamped.z - mid.z),
                right: V3(rightClamped.x - mid.x, rightClamped.y - mid.y, rightClamped.z - mid.z),
            });
        }

        if (edges.length < 2) return;

        // Build quads from shared edge positions (seamless, no gaps)
        const vertices = [];

        for (let i = 0; i < edges.length - 1; i++) {
            const e1 = edges[i];
            const e2 = edges[i + 1];

            vertices.push(e1.left.x, e1.left.y, e1.left.z);
            vertices.push(e2.left.x, e2.left.y, e2.left.z);
            vertices.push(e2.right.x, e2.right.y, e2.right.z);

            vertices.push(e1.left.x, e1.left.y, e1.left.z);
            vertices.push(e2.right.x, e2.right.y, e2.right.z);
            vertices.push(e1.right.x, e1.right.y, e1.right.z);
        }

        if (vertices.length === 0) return;

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(vertices), 3));
        geometry.computeVertexNormals();

        this.mesh = new THREE.Mesh(geometry, this.material);
        this.mesh.position.set(mid.x, mid.y, mid.z);
        this.group.add(this.mesh);
        this.propagateLayerMask();
    }
}
