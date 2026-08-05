import {CNode3DGroup} from "./CNode3DGroup";
import * as LAYER from "../LayerMasks";
import {clampAboveGround, dispose, intersectEllipsoid, propagateLayerMaskObject} from "../threeExt";
import {LineGeometry} from "three/addons/lines/LineGeometry.js";
import {Line2} from "three/addons/lines/Line2.js";
import {makeMatLine} from "../MatLines";
import {perpendicularVector} from "../threeUtils";
import {Globals, guiShowHide, GlobalDateTimeNode, setRenderOne} from "../Globals";
import {getGeocentricBodyPositionECEF} from "../CelestialMath";
import * as Astronomy from "astronomy-engine";
import {BufferAttribute, BufferGeometry, Mesh, MeshBasicMaterial, Vector3} from "three";
import {t} from "../i18n";


export class CNodeDisplayMoonShadow extends CNode3DGroup {
    constructor(v) {
        // MAIN only. The umbra/penumbra cones stretch hundreds of thousands of
        // kilometres and their ground outlines are tens of km across — geometry
        // for looking AT the Earth from outside, not for standing on it. In the
        // look view they are either invisible or a wall of colour across the sky.
        //
        // MASK_MAIN rather than the previous MASK_LOOKRENDER, which was doubly
        // wrong: it named the look view, and because it includes MASK_WORLD (which
        // BOTH cameras render) it actually drew in both. MASK_MAIN appears only in
        // MASK_MAINRENDER, so it is the one mask that means what it says.
        v.layers ??= LAYER.MASK_MAIN;
        super(v);

        this.gui = v.gui ?? guiShowHide;
        
        this.numSegments = 20;

        this.umbraColor = 0xFFD700;      // Gold (umbra)
        this.penumbraColor = 0xFFA500;   // Orange (penumbra)
        
        this.sunRadius = 695700000;   // IAU nominal solar radius
        this.moonRadius = 1737400;
        this.sunMoonDistance = 149597870700;
        
        this.umbraGeometry = null;
        this.centerLines = null;
        this.umbraLine = null;
        this.penumbraGeometry = null;
        this.penumbraLine = null;
        this.umbraConeMesh = null;
        this.umbraConeGeometry = null;
        this.penumbraConeMesh = null;
        this.penumbraConeGeometry = null;
        
        this.umbraMaterial = makeMatLine(this.umbraColor, 2);
        this.penumbraMaterial = makeMatLine(this.penumbraColor, 2);
        // White, and thinner than the outlines: the cross sits inside the gold
        // umbra ring and has to read against it without competing with it.
        this.centerMaterial = makeMatLine(0xFFFFFF, 1.5);
        this.umbraConeMaterial = new MeshBasicMaterial({
            color: this.umbraColor,
            wireframe: false,
            transparent: true,
            opacity: 0.15,
            depthTest: false,
            depthWrite: false,
            side: 2
        });
        this.penumbraConeMaterial = new MeshBasicMaterial({
            color: this.penumbraColor,
            wireframe: false,
            transparent: true,
            opacity: 0.1,
            depthTest: false,
            depthWrite: false,
            side: 2
        });

        this.gui.add(this, "visible").name(t("misc.showMoonShadow.label")).onChange(() => {
            this.show(this.visible);
            this.rebuild();
            setRenderOne(true);
        }).listen()
            .tooltip(t("misc.showMoonShadow.tooltip"));

        // The penumbra CONE only. Off by default because it is the big one — it
        // diverges from the Moon and swallows the umbra inside it, so at any
        // useful zoom it is a translucent wash over everything the umbra cone was
        // there to show. The penumbra's ground OUTLINE is not gated by this and
        // is always drawn with the shadow, since that is the part you actually
        // read a partial-eclipse footprint off.
        this.showPenumbraCone = false;
        this.gui.add(this, "showPenumbraCone").name("Show Moon Penumbra").onChange(() => {
            this.rebuild();
            setRenderOne(true);
        }).listen()
            .tooltip("Also draw the outer (penumbra) cone, not just the umbra. Needs Show Moon's"
                + " Shadow on. The orange penumbra outline on the ground is drawn either way.");
        this.addSimpleSerial("showPenumbraCone");

        // Where the shadow axis actually lands, drawn ON the ground rather than
        // as a screen marker — two lines through the centre spanning the umbra's
        // own extent, so the cross is the size and orientation of the shadow.
        this.showShadowCenter = false;
        this.gui.add(this, "showShadowCenter").name("Moon Shadow Center").onChange(() => {
            this.rebuild();
            setRenderOne(true);
        }).listen()
            .tooltip("Mark where the centre of the Moon's shadow meets the ground: one line along"
                + " the shadow's long axis from edge to edge, one across it. Follows the terrain,"
                + " like the shadow outline. Needs Show Moon's Shadow on.");
        this.addSimpleSerial("showShadowCenter");

        // The track, as opposed to the instant. Swept once per eclipse and
        // cached — see computeEclipsePath, which update() would otherwise re-run
        // at frame rate.
        this.showEclipsePath = false;
        this.pathLines = [];
        this._pathCache = null;
        this.gui.add(this, "showEclipsePath").name("Eclipse Path").onChange(() => {
            this.rebuild();
            setRenderOne(true);
        }).listen()
            .tooltip("If a solar eclipse falls within 24 hours of the current time, draw its track:"
                + " the northern and southern limits of totality in gold, and the centreline in"
                + " white. The penumbra's limits are not drawn — it is thousands of km across, so"
                + " its edges sweep most of the globe. Needs Show Moon's Shadow on.");
        this.addSimpleSerial("showEclipsePath");

        this.gui.add(this, 'numSegments', 5, 50, 1).listen()
            .onChange(() => {
                setRenderOne(true);
                this.rebuild();
            })
            .name(t("misc.shadowSegments.label"))
            .tooltip(t("misc.shadowSegments.tooltip"));

        this.addSimpleSerial("numSegments")

        this.rebuild();
    }

    dispose() {
        this.removeCircles();
        super.dispose();
    }

    removeCircles() {
        if (this.umbraLine) {
            this.group.remove(this.umbraLine);
            dispose(this.umbraGeometry);
        }
        if (this.penumbraLine) {
            this.group.remove(this.penumbraLine);
            dispose(this.penumbraGeometry);
        }
        if (this.umbraConeMesh) {
            this.group.remove(this.umbraConeMesh);
            dispose(this.umbraConeGeometry);
        }
        if (this.penumbraConeMesh) {
            this.group.remove(this.penumbraConeMesh);
            dispose(this.penumbraConeGeometry);
        }
        if (this.centerLines) {
            for (const l of this.centerLines) {
                this.group.remove(l);
                dispose(l.geometry);
            }
            this.centerLines = null;
        }
        // Geometry only — _pathCache survives, since the sweep it holds is
        // still valid for the same eclipse and is the expensive part.
        if (this.pathLines) {
            for (const l of this.pathLines) {
                this.group.remove(l);
                dispose(l.geometry);
            }
            this.pathLines = [];
        }
    }

    calculateShadowRadii(altitude, sunMoonDistance) {
        const MOON_RADIUS = 1737400;
        const SUN_RADIUS = 695700000;   // IAU nominal solar radius

        if (altitude < 0) {
            throw new Error("Altitude must be non-negative");
        }

        // The umbra converges at the rate the Sun's limb closes behind the
        // Moon's: tan(halfAngle) = (Rs - Rm) / d, giving a tip distance of
        // d·Rm/(Rs - Rm). The previous Rs/d form (the Sun's angular size
        // alone) put the tip 0.25% short, which made the 2026-08-12 umbra
        // cross-section ~4 km (5%) too small.
        const umbraTipDistance = MOON_RADIUS * sunMoonDistance / (SUN_RADIUS - MOON_RADIUS);

        let umbraDiameter;
        if (altitude >= umbraTipDistance) {
            umbraDiameter = 0;
        } else {
            umbraDiameter = 2 * MOON_RADIUS * (umbraTipDistance - altitude) / umbraTipDistance;
        }

        // The penumbra diverges at tan(halfAngle) = (Rs + Rm) / d; its
        // virtual apex sits sunward of the Moon (negative distance).
        const penumbraTipDistance = -MOON_RADIUS * sunMoonDistance / (SUN_RADIUS + MOON_RADIUS);
        const penumbraDiameter = Math.abs(2 * MOON_RADIUS * (penumbraTipDistance - altitude) / penumbraTipDistance);
        
        return {
            umbraDiameter: Math.max(umbraDiameter, 0),
            penumbraDiameter: penumbraDiameter,
            altitude: altitude,
            units: 'meters'
        };
    }

    buildSegmentedCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, isUmbra, material, geometryProp, meshProp, renderOrder, sunMoonDistance, coneReferenceDistance) {
        const circleSegments = 32;
        const geometry = new BufferGeometry();
        const vertices = [];
        const indices = [];
        
        const extensionDistance = coneReferenceDistance + 100000000;
        
        const refShadowData = this.calculateShadowRadii(coneReferenceDistance, sunMoonDistance);
        const refRadius = isUmbra ? refShadowData.umbraDiameter / 2 : refShadowData.penumbraDiameter / 2;
        const refCenter = moonCenter.clone().add(shadowDir.clone().multiplyScalar(coneReferenceDistance));
        
        const rayOrigins = [];
        const rayDirs = [];
        const mslDistances = [];
        for (let i = 0; i < circleSegments; i++) {
            const theta = (i / circleSegments) * 2 * Math.PI;
            const refPoint = refCenter.clone();
            refPoint.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * refRadius));
            refPoint.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * refRadius));

            // Cone generators graze the Moon's LIMB at this position angle,
            // not its center — rays from the center add ~a Moon radius of
            // parallax, 1-2 km of ground-track error at grazing incidence.
            const limbPoint = moonCenter.clone();
            limbPoint.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * this.moonRadius));
            limbPoint.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * this.moonRadius));

            const rayDir = refPoint.clone().sub(limbPoint).normalize();
            rayOrigins.push(limbPoint);
            rayDirs.push(rayDir);

            const mslPoint = intersectEllipsoid(limbPoint, rayDir);
            mslDistances.push(mslPoint ? limbPoint.distanceTo(mslPoint) : Infinity);
        }
        
        for (let seg = 0; seg <= this.numSegments; seg++) {
            const t = seg / this.numSegments;
            const distanceFromMoon = extensionDistance * t;
            
            for (let i = 0; i < circleSegments; i++) {
                const rayOrigin = rayOrigins[i];
                const rayDir = rayDirs[i];
                const mslDist = mslDistances[i];

                let point;
                if (mslDist < distanceFromMoon) {
                    const mslPoint = rayOrigin.clone().add(rayDir.clone().multiplyScalar(mslDist));
                    point = clampAboveGround(mslPoint, 100);
                } else {
                    point = rayOrigin.clone().add(rayDir.clone().multiplyScalar(distanceFromMoon));
                }
                
                vertices.push(point.x, point.y, point.z);
            }
        }
        
        for (let seg = 0; seg < this.numSegments; seg++) {
            for (let i = 0; i < circleSegments; i++) {
                const next = (i + 1) % circleSegments;
                const current = seg * circleSegments + i;
                const currentNext = seg * circleSegments + next;
                const nextRing = (seg + 1) * circleSegments + i;
                const nextRingNext = (seg + 1) * circleSegments + next;
                
                indices.push(current, nextRing, currentNext);
                indices.push(currentNext, nextRing, nextRingNext);
            }
        }
        
        geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3));
        geometry.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
        geometry.computeVertexNormals();
        
        this[geometryProp] = geometry;
        this[meshProp] = new Mesh(geometry, material);
        this[meshProp].renderOrder = renderOrder;
        this.group.add(this[meshProp]);
    }

    // A ground-following line between two points that both lie on the ellipsoid.
    //
    // A straight chord between them cuts THROUGH the Earth, so each sample is
    // pushed back out to the ellipsoid before being clamped over the terrain —
    // the same treatment the shadow outline gets, which is what makes the cross
    // sit on the ground with it rather than hovering over or sinking into it.
    groundLineBetween(p0, p1, samples = 40) {
        const a = Globals.equatorRadius, b = Globals.polarRadius;
        const out = [];
        for (let i = 0; i < samples; i++) {
            const t = i / (samples - 1);
            const p = p0.clone().lerp(p1, t);
            const len = p.length();
            if (len < 1) continue;
            const ux = p.x / len, uy = p.y / len, uz = p.z / len;
            // Ellipsoid radius along this direction, so the sample lands on the
            // surface rather than on the chord.
            const r = 1 / Math.sqrt((ux * ux + uy * uy) / (a * a) + (uz * uz) / (b * b));
            const surface = new Vector3(ux * r, uy * r, uz * r);
            const g = clampAboveGround(surface, 100);
            out.push(g.x, g.y, g.z);
        }
        return out;
    }

    // Which way the shadow centre is moving over the ground, as a unit vector
    // in the local horizontal. Finite difference over 30 s — the track turns far
    // too slowly for that to matter, and it needs no state.
    shadowTravelDir(date, center) {
        const DT_MS = 30000;
        const next = this.shadowCenterAt(new Date(date.getTime() + DT_MS));
        if (!next) return null;
        const up = center.clone().normalize();
        // Flatten into the local horizontal so the axis lies along the ground.
        const travel = next.clone().sub(center);
        travel.addScaledVector(up, -travel.dot(up));
        const len = travel.length();
        if (!(len > 1)) return null;
        // Speed too, so the centre-path segment can be sampled over a KNOWN time
        // span (extent / speed) instead of stepping until it leaves the shadow.
        return {dir: travel.divideScalar(len), speed: len / (DT_MS / 1000)};
    }

    // Where the shadow axis meets the ellipsoid at an arbitrary time.
    shadowCenterAt(date) {
        const moon = getGeocentricBodyPositionECEF(Astronomy.Body.Moon, date, true);
        const sun = getGeocentricBodyPositionECEF(Astronomy.Body.Sun, date, true);
        if (!moon || !sun) return null;
        return intersectEllipsoid(moon, moon.clone().sub(sun).normalize());
    }

    // The eclipse centreline, clipped to the part inside the shadow.
    //
    // This is the REAL track — sampled from the shadow axis over time — so it
    // curves with the path, unlike a straight line along the travel direction.
    // The along-track extent is already known in metres and the speed comes
    // from the same finite difference that gave the direction, so the time span
    // to cover is just extent/speed: no searching, and a fixed sample count.
    centerPathSegment(date, travel, loD, hiD) {
        if (!(travel.speed > 0)) return null;
        const t0 = loD / travel.speed, t1 = hiD / travel.speed;
        const N = 24;
        const pts = [];
        for (let i = 0; i < N; i++) {
            const t = t0 + (t1 - t0) * (i / (N - 1));
            const p = this.shadowCenterAt(new Date(date.getTime() + t * 1000));
            if (p) pts.push(p);
        }
        return pts.length >= 2 ? pts : null;
    }

    // Cross through the shadow centre, spanning the umbra's own footprint.
    //
    // Axes are ALONG-TRACK and CROSS-TRACK, taken from the direction the shadow
    // is travelling, not from the shape of the outline. Deriving them from the
    // outline's widest separation looked right for a clean ellipse and flickered
    // badly once the shadow ran off the limb: the footprint is then an open arc,
    // so the farthest-apart pair of points jumps between unrelated chords from
    // one frame to the next. The direction of travel does not care whether the
    // ellipse is truncated, so the cross stays put and keeps its meaning —
    // one line along the path, one across it, which is what the limits use too.
    buildShadowCenterCross(outlinePoints, center, date) {
        if (!center || outlinePoints.length < 4) return;

        const travel = this.shadowTravelDir(date, center);
        if (!travel) return;
        const up = center.clone().normalize();
        const crossTrack = up.clone().cross(travel.dir).normalize();

        // Extent along each fixed axis, projected back ONTO that axis through
        // the centre.
        //
        // Connecting the two extreme outline points directly does not give the
        // axis: on an ellipse those are tangent points, offset sideways, so the
        // chord between them is tilted away from the axis it is meant to be —
        // which is why neither line lay along the track. Taking only the scalar
        // extent and rebuilding the endpoints from the centre keeps each line
        // pointing where it should, one of them straight down the centreline.
        const extentAlong = (axis) => {
            let loD = Infinity, hiD = -Infinity;
            for (const p of outlinePoints) {
                const d = p.clone().sub(center).dot(axis);
                if (d < loD) loD = d;
                if (d > hiD) hiD = d;
            }
            return (hiD - loD > 1) ? {loD, hiD} : null;
        };

        this.centerLines = [];
        const addLine = (flat) => {
            if (!flat || flat.length < 6) return;
            const geom = new LineGeometry();
            geom.setPositions(flat);
            const line = new Line2(geom, this.centerMaterial);
            line.computeLineDistances();
            line.scale.setScalar(1);
            this.group.add(line);
            this.centerLines.push(line);
        };

        // A — the centreline itself, clipped to the shadow. Skipped when the
        // full Eclipse Path is drawn, since that already includes this segment
        // and drawing both just doubles a line onto itself.
        const along = extentAlong(travel.dir);
        if (along && !this.showEclipsePath) {
            const seg = this.centerPathSegment(date, travel, along.loD, along.hiD);
            if (seg) {
                const flat = [];
                for (let i = 0; i < seg.length - 1; i++) {
                    const part = this.groundLineBetween(seg[i], seg[i + 1], 4);
                    flat.push(...(i === 0 ? part : part.slice(3)));
                }
                addLine(flat);
            }
        }

        // B — the cross-track line through the centre, spanning the shadow.
        const across = extentAlong(crossTrack);
        if (across) {
            addLine(this.groundLineBetween(
                center.clone().addScaledVector(crossTrack, across.loD),
                center.clone().addScaledVector(crossTrack, across.hiD)));
        }
    }

    // ---------------------------------------------------------------------
    // Eclipse path
    //
    // Where the shadow GOES, as opposed to where it is: the umbra's northern
    // and southern limits, the same for the penumbra, and the centreline the
    // Moon Shadow Center cross sits on at any one instant.
    //
    // Swept rather than derived from Besselian elements, because the cone-to-
    // ellipsoid intersection this file already does is the same operation the
    // path needs — just at other times. Sampling it keeps one definition of
    // where the shadow lands instead of two that can disagree.
    // ---------------------------------------------------------------------

    // The solar eclipse whose peak is within 24 hours of `date`, or null.
    // Steps back a day first, because an eclipse that peaked this morning is
    // still "within 24 hours" and SearchGlobalSolarEclipse only looks forward.
    findEclipseWithin24h(date) {
        const WINDOW_MS = 24 * 3600 * 1000;
        try {
            let e = Astronomy.SearchGlobalSolarEclipse(
                Astronomy.MakeTime(new Date(date.getTime() - WINDOW_MS)));
            for (let guard = 0; e && guard < 4; guard++) {
                const dt = e.peak.date.getTime() - date.getTime();
                if (Math.abs(dt) <= WINDOW_MS) return e;
                if (dt > WINDOW_MS) return null;      // the next one is too far ahead
                e = Astronomy.NextGlobalSolarEclipse(e.peak);
            }
        } catch (err) {
            return null;
        }
        return null;
    }

    // Shadow geometry on the ground at one instant, independent of the current
    // frame's globals so it can be called for any time in the sweep.
    shadowGroundAt(date, segments = 48) {
        const moon = getGeocentricBodyPositionECEF(Astronomy.Body.Moon, date, true);
        const sun = getGeocentricBodyPositionECEF(Astronomy.Body.Sun, date, true);
        if (!moon || !sun) return null;

        const shadowDir = moon.clone().sub(sun).normalize();
        const center = intersectEllipsoid(moon, shadowDir);
        if (!center) return null;                 // shadow axis misses the Earth

        const axisDist = moon.distanceTo(center);
        const sunMoonDistance = sun.distanceTo(moon);
        const radii = this.calculateShadowRadii(axisDist, sunMoonDistance);
        const perp = perpendicularVector(shadowDir).normalize();
        const other = shadowDir.clone().cross(perp);
        const coneEnd = moon.clone().add(shadowDir.clone().multiplyScalar(axisDist));

        // Ground ring for one cone, traced the same way rebuild() traces it:
        // along the generator through the Moon's limb at each position angle.
        const ring = (radius) => {
            const pts = [];
            for (let i = 0; i < segments; i++) {
                const theta = i / segments * 2 * Math.PI;
                const edge = coneEnd.clone()
                    .add(perp.clone().multiplyScalar(Math.cos(theta) * radius))
                    .add(other.clone().multiplyScalar(Math.sin(theta) * radius));
                const limb = moon.clone()
                    .add(perp.clone().multiplyScalar(Math.cos(theta) * this.moonRadius))
                    .add(other.clone().multiplyScalar(Math.sin(theta) * this.moonRadius));
                const hit = intersectEllipsoid(limb, edge.clone().sub(limb).normalize());
                if (hit) pts.push(hit);
            }
            return pts;
        };

        // No penumbra ring here: its path limits are not drawn (they sweep most
        // of a hemisphere and read as clutter), so tracing it every sample would
        // be ~half the sweep's cost for geometry nothing uses.
        return {
            center,
            umbra: radii.umbraDiameter > 0 ? ring(radii.umbraDiameter / 2) : [],
        };
    }

    // Sweep the eclipse and accumulate the centreline and the two limit pairs.
    // Cached on the eclipse's peak time: update() calls rebuild() every frame,
    // and this is a few hundred ellipsoid intersections that must not run at
    // frame rate.
    computeEclipsePath(peakDate) {
        const key = peakDate.getTime();
        if (this._pathCache && this._pathCache.key === key) return this._pathCache;

        // +/-4 h at 2 min. Any eclipse crosses the Earth well inside that, and
        // samples where the axis misses simply drop out.
        const SPAN_MIN = 240, STEP_MIN = 2;
        const samples = [];
        for (let m = -SPAN_MIN; m <= SPAN_MIN; m += STEP_MIN) {
            const g = this.shadowGroundAt(new Date(key + m * 60000));
            if (g) samples.push(g);
        }

        // Limits are the cross-track extremes of each ring. Cross-track needs
        // the direction of travel, which needs the NEXT centre — hence two
        // passes rather than one.
        const centerLine = [], umbraN = [], umbraS = [];
        for (let i = 0; i < samples.length; i++) {
            const s = samples[i];
            centerLine.push(s.center);

            const nxt = samples[i + 1] ?? samples[i - 1];
            if (!nxt) continue;
            const travel = nxt.center.clone().sub(s.center);
            if (travel.lengthSq() < 1) continue;
            travel.normalize();
            const up = s.center.clone().normalize();
            const crossTrack = up.clone().cross(travel).normalize();

            const extremes = (ring) => {
                if (ring.length < 3) return null;
                let lo = ring[0], hi = ring[0], loD = Infinity, hiD = -Infinity;
                for (const p of ring) {
                    const d = p.clone().sub(s.center).dot(crossTrack);
                    if (d < loD) { loD = d; lo = p; }
                    if (d > hiD) { hiD = d; hi = p; }
                }
                return {lo, hi};
            };
            const u = extremes(s.umbra);
            if (u) { umbraN.push(u.hi); umbraS.push(u.lo); }
        }

        this._pathCache = {key, centerLine, umbraN, umbraS,
                           totalSamples: samples.length};
        return this._pathCache;
    }

    // One terrain-following polyline through a list of ellipsoid-surface points.
    //
    // Subdivided between samples, not joined straight. The sweep steps two
    // minutes at a time, which is ~150 km of track, and a straight chord that
    // long sinks below the ellipsoid — the middle of every segment ends up
    // inside the Earth and hidden, so the path draws as a row of dashes. Each
    // interpolated point is pushed back out to the surface before the terrain
    // clamp, exactly as groundLineBetween does for the centre cross.
    addPathLine(points, material) {
        if (points.length < 2) return;
        const flat = [];
        const SUB = 8;
        for (let i = 0; i < points.length - 1; i++) {
            const seg = this.groundLineBetween(points[i], points[i + 1], SUB);
            // Drop the duplicated joint so segments do not double up a vertex.
            flat.push(...(i === 0 ? seg : seg.slice(3)));
        }
        const geom = new LineGeometry();
        geom.setPositions(flat);
        const line = new Line2(geom, material);
        line.computeLineDistances();
        line.scale.setScalar(1);
        this.group.add(line);
        this.pathLines.push(line);
    }

    buildEclipsePath() {
        const date = GlobalDateTimeNode?.dateNow;
        if (!date) return;
        const eclipse = this.findEclipseWithin24h(date);
        if (!eclipse) { this._pathCache = null; return; }

        const path = this.computeEclipsePath(eclipse.peak.date);
        this.pathLines = [];
        // Umbra limits and the centreline only. The penumbra's limits are
        // deliberately NOT drawn: it is thousands of km across, so its edges
        // sweep most of a hemisphere and read as clutter across the whole globe
        // rather than as a path. The penumbra's instantaneous ground outline is
        // still there with the shadow, which is where it is actually legible.
        this.addPathLine(path.umbraN, this.umbraMaterial);
        this.addPathLine(path.umbraS, this.umbraMaterial);
        this.addPathLine(path.centerLine, this.centerMaterial);
    }

    buildUmbraCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, sunMoonDistance, coneReferenceDistance) {
        this.buildSegmentedCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, true,
                       this.umbraConeMaterial, 'umbraConeGeometry', 'umbraConeMesh', 2, sunMoonDistance, coneReferenceDistance);
    }

    buildPenumbraCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, sunMoonDistance, coneReferenceDistance) {
        this.buildSegmentedCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, false,
                       this.penumbraConeMaterial, 'penumbraConeGeometry', 'penumbraConeMesh', 1, sunMoonDistance, coneReferenceDistance);
    }

    rebuild() {
        this.removeCircles();
        if (!this.visible) {
            return;
        }

        if (!Globals.moonPos || !Globals.fromSun) {
            return;
        }

        const moonCenter = Globals.moonPos.clone();
        
        if (moonCenter.length() < 100000) {
            return;
        }
        
        // Shadow axis is the Sun→Moon line, NOT the geocentric antisolar
        // direction: they differ by the Moon's offset from the geocenter as
        // seen from the Sun (~9 arcsec at the 2026-08-12 eclipse), which
        // displaces the umbra ellipse ~15 km along the ground — about a
        // fifth of that eclipse's umbra width.
        const shadowDir = Globals.sunPos
            ? moonCenter.clone().sub(Globals.sunPos).normalize()
            : Globals.fromSun.clone().normalize();
        
        let coneReferenceDistance;
        // Ellipsoid-correct intersection for the shadow axis with Earth.
        const axisHit = intersectEllipsoid(moonCenter, shadowDir);
        if (axisHit) {
            coneReferenceDistance = moonCenter.distanceTo(axisHit);
        } else {
            // Fallback: spherical approximation using equatorial radius.
            // This should rarely be needed, but keeps rendering robust.
            const oc = moonCenter.clone();
            const b = -oc.dot(shadowDir);
            const c = oc.dot(oc) - Globals.equatorRadius * Globals.equatorRadius;
            const discriminant = b * b - c;
            if (discriminant >= 0) {
                coneReferenceDistance = b - Math.sqrt(discriminant);
            } else {
                const t = -oc.dot(shadowDir);
                coneReferenceDistance = t > 0 ? t : moonCenter.length();
            }
        }
        
        const coneEndPoint = moonCenter.clone().add(shadowDir.clone().multiplyScalar(coneReferenceDistance));
        
        // Use the actual geocentric Sun position at this frame (not fixed 1 AU),
        // because umbra size is sensitive to the Sun's apparent angular radius.
        const sunMoonDistance = Globals.sunPos
            ? Globals.sunPos.distanceTo(moonCenter)
            : Globals.toSun.clone().normalize().multiplyScalar(this.sunMoonDistance).distanceTo(moonCenter);
        
        const perpendicular = perpendicularVector(shadowDir).normalize();
        const otherPerpendicular = shadowDir.clone().cross(perpendicular);
        
        // Cone only — the penumbra's ground outline is built further down and is
        // NOT gated, so the orange footprint stays whenever the shadow is shown.
        if (this.showPenumbraCone) {
            this.buildPenumbraCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, sunMoonDistance, coneReferenceDistance);
        }
        this.buildUmbraCone(moonCenter, shadowDir, perpendicular, otherPerpendicular, sunMoonDistance, coneReferenceDistance);
        const shadowData = this.calculateShadowRadii(coneReferenceDistance, sunMoonDistance);
        const umbraRadius = shadowData.umbraDiameter / 2;
        const penumbraRadius = shadowData.penumbraDiameter / 2;

        const segments = 100;
        
        {
            const line_points = [];
            // Kept as vectors too: the centre cross derives its axes from the
            // real footprint, so it must see the same points the ring is drawn
            // from, at MSL (before the terrain clamp lifts them).
            const umbraGroundMSL = [];

            for (let i = 0; i < segments; i++) {
                const theta = i / (segments - 1) * 2 * Math.PI;
                let point = coneEndPoint.clone();
                point.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * umbraRadius));
                point.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * umbraRadius));

                // Ground outline follows the cone generator through the
                // Moon's limb at this position angle (see buildSegmentedCone).
                const limbPoint = moonCenter.clone();
                limbPoint.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * this.moonRadius));
                limbPoint.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * this.moonRadius));
                const rayDir = point.clone().sub(limbPoint).normalize();
                const mslPoint = intersectEllipsoid(limbPoint, rayDir);

                if (mslPoint) {
                    umbraGroundMSL.push(mslPoint.clone());
                    point = clampAboveGround(mslPoint, 100);
                    line_points.push(point.x, point.y, point.z);
                }
            }

            if (line_points.length > 0) {
                const umbraGeometry = new LineGeometry();
                umbraGeometry.setPositions(line_points);
                this.umbraGeometry = umbraGeometry;
                this.umbraLine = new Line2(this.umbraGeometry, this.umbraMaterial);
                this.umbraLine.computeLineDistances();
                this.umbraLine.scale.setScalar(1);
                this.group.add(this.umbraLine);
            }

            // Only meaningful when the umbra actually reaches the ground —
            // axisHit is null when the shadow misses the Earth entirely.
            if (this.showShadowCenter && axisHit) {
                this.buildShadowCenterCross(umbraGroundMSL, axisHit, GlobalDateTimeNode.dateNow);
            }
        }

        {
            const line_points = [];
            
            for (let i = 0; i < segments; i++) {
                const theta = i / (segments - 1) * 2 * Math.PI;
                let point = coneEndPoint.clone();
                point.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * penumbraRadius));
                point.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * penumbraRadius));
                
                // Ground outline follows the cone generator through the
                // Moon's limb at this position angle (see buildSegmentedCone).
                const limbPoint = moonCenter.clone();
                limbPoint.add(perpendicular.clone().multiplyScalar(Math.cos(theta) * this.moonRadius));
                limbPoint.add(otherPerpendicular.clone().multiplyScalar(Math.sin(theta) * this.moonRadius));
                const rayDir = point.clone().sub(limbPoint).normalize();
                const mslPoint = intersectEllipsoid(limbPoint, rayDir);
                
                if (mslPoint) {
                    point = clampAboveGround(mslPoint, 100);
                    line_points.push(point.x, point.y, point.z);
                }
            }

            if (line_points.length > 0) {
                const penumbraGeometry = new LineGeometry();
                penumbraGeometry.setPositions(line_points);
                this.penumbraGeometry = penumbraGeometry;
                this.penumbraLine = new Line2(this.penumbraGeometry, this.penumbraMaterial);
                this.penumbraLine.computeLineDistances();
                this.penumbraLine.scale.setScalar(1);
                this.group.add(this.penumbraLine);
            }
        }

        if (this.showEclipsePath) {
            this.buildEclipsePath();
        }

        propagateLayerMaskObject(this.group);
    }

    update(f) {
        if (this.visible && Globals.fromSun !== undefined && Globals.moonPos !== undefined) {
            this.rebuild();
        }
    }
}
