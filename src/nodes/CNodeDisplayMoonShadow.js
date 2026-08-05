import {CNode3DGroup} from "./CNode3DGroup";
import * as LAYER from "../LayerMasks";
import {clampAboveGround, dispose, intersectEllipsoid, propagateLayerMaskObject} from "../threeExt";
import {LineGeometry} from "three/addons/lines/LineGeometry.js";
import {Line2} from "three/addons/lines/Line2.js";
import {makeMatLine} from "../MatLines";
import {perpendicularVector} from "../threeUtils";
import {Globals, guiShowHide, GlobalDateTimeNode, NodeMan, setRenderOne} from "../Globals";
import {EventManager} from "../CEventManager";
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
        // The built lines are clamped to the ground, so they go stale when the
        // ground does. Elevation tiles stream in long after the path is first
        // drawn; dropping the geometry key re-clamps it on the next frame.
        this._pathGeomKey = null;
        this._onElevationChanged = () => { this._pathGeomKey = null; };
        EventManager.addEventListener("elevationChanged", this._onElevationChanged);
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
        this.removePathLines();
        EventManager.removeEventListener("elevationChanged", this._onElevationChanged);
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
    }

    // The path lines are NOT part of removeCircles: everything there is redrawn
    // every frame because it depends on the current instant, while the path
    // depends only on the eclipse and the terrain under it. Dropping it with
    // the rest each frame is what forced it to be rebuilt each frame.
    //
    // _pathCache survives regardless — the sweep it holds is still valid for
    // the same eclipse and is the expensive part.
    removePathLines() {
        if (this.pathLines) {
            for (const l of this.pathLines) {
                this.group.remove(l);
                dispose(l.geometry);
            }
        }
        this.pathLines = [];
        this._pathGeomKey = null;
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
        const clearance = this.groundClearance();
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
                    point = clampAboveGround(mslPoint, clearance);
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
    groundLineBetween(p0, p1, samples = 160, clearance = this.groundClearance()) {
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
            const g = clampAboveGround(surface, clearance);
            out.push(g.x, g.y, g.z);
        }
        return out;
    }

    // How far above the ground these lines are drawn.
    //
    // A flat 100 m is not enough to stay out of the terrain, and no amount of
    // extra vertices fixes it: the elevation map the clamp reads is FINER than
    // the terrain MESH that gets rendered at map scale, so the coarse mesh
    // stands above the fine elevation and swallows the line. That is what the
    // path's dashes were — the line broke up the moment it crossed onto land
    // and stayed solid over the Bay of Biscay, which is the giveaway: not a
    // gappy line, a buried one.
    //
    // The mesh's error against the real ground is a screen-space budget, so it
    // grows with viewing distance; the clearance has to grow with it. A
    // thousandth of the camera's height is about a pixel at any zoom — enough
    // to sit on top of the mesh, too little to read as floating. Quantised in
    // octaves so that zooming rebuilds the cached path geometry about ten times
    // over the whole range rather than continuously.
    groundClearance() {
        const cam = NodeMan.exists("mainCamera") ? NodeMan.get("mainCamera").camera : null;
        if (!cam) return 100;
        const alt = cam.position.length() - Globals.equatorRadius;
        const want = Math.min(Math.max(alt * 0.001, 100), 20000);
        return 100 * Math.pow(2, Math.round(Math.log2(want / 100)));
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
                    const part = this.groundLineBetween(seg[i], seg[i + 1], 16);
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
    //
    // The ring is returned SPARSE — one entry per position angle, null where
    // that cone generator misses the Earth — because the misses are the
    // information the limits are read from. Near the ends of an eclipse the
    // umbra footprint hangs off the limb and the ring is an open arc; a dense
    // array of hits alone cannot tell an edge of the shadow from an edge of the
    // Earth. `at` re-evaluates a single generator at an arbitrary position
    // angle, which is how the tangent points are refined off the grid.
    //
    // allowMiss keeps a usable centre after the axis has left the Earth, where
    // the umbra itself has not (see the sweep). It is only a reference point for
    // measuring cross-track distance and travel: the ring does not depend on it,
    // since a cone generator through the Moon's limb is the same line in space
    // whatever distance its cross-section is taken at.
    shadowGroundAt(date, segments = 48, allowMiss = false) {
        const moon = getGeocentricBodyPositionECEF(Astronomy.Body.Moon, date, true);
        const sun = getGeocentricBodyPositionECEF(Astronomy.Body.Sun, date, true);
        if (!moon || !sun) return null;

        const shadowDir = moon.clone().sub(sun).normalize();
        let center = intersectEllipsoid(moon, shadowDir);
        const axisHit = !!center;
        if (!center) {                            // shadow axis misses the Earth
            if (!allowMiss) return null;
            center = this.nearestSurfacePoint(moon, shadowDir);
            if (!center) return null;
        }

        const axisDist = moon.distanceTo(center);
        const sunMoonDistance = sun.distanceTo(moon);
        const radii = this.calculateShadowRadii(axisDist, sunMoonDistance);
        const perp = perpendicularVector(shadowDir).normalize();
        const other = shadowDir.clone().cross(perp);
        const coneEnd = moon.clone().add(shadowDir.clone().multiplyScalar(axisDist));
        const radius = radii.umbraDiameter / 2;

        // One point of the ground ring, traced the same way rebuild() traces
        // it: along the cone generator through the Moon's limb at this position
        // angle. Null when that generator misses the Earth.
        const at = (theta) => {
            if (!(radius > 0)) return null;       // annular: no umbra on the ground
            const edge = coneEnd.clone()
                .add(perp.clone().multiplyScalar(Math.cos(theta) * radius))
                .add(other.clone().multiplyScalar(Math.sin(theta) * radius));
            const limb = moon.clone()
                .add(perp.clone().multiplyScalar(Math.cos(theta) * this.moonRadius))
                .add(other.clone().multiplyScalar(Math.sin(theta) * this.moonRadius));
            return intersectEllipsoid(limb, edge.clone().sub(limb).normalize());
        };

        // No penumbra ring here: its path limits are not drawn (they sweep most
        // of a hemisphere and read as clutter), so tracing it every sample would
        // be ~half the sweep's cost for geometry nothing uses.
        const ring = [];
        for (let i = 0; i < segments; i++) ring.push(at(i / segments * 2 * Math.PI));
        return {center, axisHit, ring, at, segments};
    }

    // Where a line comes closest to the surface, for when it no longer meets it.
    //
    // Scale the ellipsoid to the unit sphere it is, take the nearest point on
    // the line to the centre, push that out to unit length, scale back — the
    // same construction the intersection uses, continued past tangency instead
    // of failing there. Agrees with intersectEllipsoid exactly at tangency.
    nearestSurfacePoint(origin, dir) {
        const a = Globals.equatorRadius, b = Globals.polarRadius;
        const o = new Vector3(origin.x / a, origin.y / a, origin.z / b);
        const d = new Vector3(dir.x / a, dir.y / a, dir.z / b);
        const dd = d.dot(d);
        if (!(dd > 0)) return null;
        const p = o.addScaledVector(d, -o.dot(d) / dd);
        const len = p.length();
        if (!(len > 0)) return null;
        p.divideScalar(len);
        return new Vector3(p.x * a, p.y * a, p.z * b);
    }

    // The northern and southern limits of totality at one instant.
    //
    // The limits are the boundary of the region the umbra sweeps, and for a
    // shape that is translating, that boundary is traced by the point whose
    // outward normal is perpendicular to the motion — i.e. the footprint's
    // extreme point ACROSS the track. Two things about that point matter:
    //
    // NOT EVERY EXTREME IS ONE. Once the footprint runs off the limb the ring is
    // an open arc, and the extreme among the surviving points is wherever the
    // arc was CUT. What separates the two is that a real tangent point is a
    // LOCAL extremum: the cross-track distance turns over there. At a cut end it
    // is still climbing, into the points that are missing. So the test is
    // d[i] >= both neighbours (and the neighbours must exist to compare), not
    // "biggest of what survived".
    //
    // The distinction is not pedantic. By the time the ring is being clipped the
    // footprint is hundreds of km long and lying almost along the track, so
    // cross-track distance along its northern edge is nearly FLAT — the position
    // of the biggest value is then decided by noise, and it jumps hundreds of km
    // back and forth along that edge from one sample to the next. Requiring a
    // genuine turnover is what keeps the limits from flailing; it is also why
    // each limit ends where it does, a couple of hundred km short of the
    // terminator, and why the corridor needs a cap drawn across it.
    //
    // AND IT IS NOT ON THE GRID. Half a step of position angle (3.75 deg at 48
    // segments) is tens of km ALONG the track near the ends, so the limit would
    // step sideways every time the winning index changed — a visible kink.
    // Cross-track distance is smooth and quadratic near a tangency, so a
    // parabola through the winner and its two neighbours gives the position
    // angle to sub-grid accuracy, and the generator is re-traced there.
    limitPoints(s, crossTrack) {
        const n = s.segments, ring = s.ring, step = 2 * Math.PI / n;
        const d = new Array(n).fill(null);
        for (let i = 0; i < n; i++) {
            if (ring[i]) d[i] = ring[i].clone().sub(s.center).dot(crossTrack);
        }
        let hiI = -1, loI = -1, hiD = -Infinity, loD = Infinity;
        for (let i = 0; i < n; i++) {
            const a = d[(i + n - 1) % n], c = d[i], b = d[(i + 1) % n];
            if (a === null || b === null || c === null) continue;
            if (c >= a && c >= b && c > hiD) { hiD = c; hiI = i; }
            if (c <= a && c <= b && c < loD) { loD = c; loI = i; }
        }
        const refine = (i) => {
            if (i < 0) return null;
            const d0 = d[(i + n - 1) % n], d1 = d[i], d2 = d[(i + 1) % n];
            const denom = d0 - 2 * d1 + d2;
            // Flat within rounding — the grid point is already the answer.
            if (Math.abs(denom) < 1e-9) return ring[i];
            const shift = 0.5 * (d0 - d2) / denom;
            if (!(Math.abs(shift) <= 1)) return ring[i];
            return s.at((i + shift) * step) ?? ring[i];
        };
        return {hi: refine(hiI), lo: refine(loI)};
    }

    // The terminal closure: the great circle joining the ends of the two limits.
    //
    // This is the "eclipse begins/ends at sunrise/sunset" line of the published
    // maps, and it is a CHORD BETWEEN THE LIMITS — deliberately not routed
    // through the end of the centreline. The centreline runs on to the axis
    // tangency, which happens after either limit has ended, so joining north end
    // to centreline end to south end puts a ~90 km kink in the closure. The
    // centreline is clipped to this line instead of being left to poke out of
    // the end of the corridor.
    //
    // Known limitation: the umbra goes on grazing the Earth past this line, and
    // the published maps carry their limits a couple of hundred km further along
    // the terminator than these end. Following them out needs the boundary of
    // the swept region where the footprint lies along the track, which the
    // cross-track extreme cannot give — it is ill-conditioned exactly there.
    capBetween(a, b) {
        return (a && b) ? [a, b] : null;
    }

    // Cut a line where it leaves the corridor's two end closures.
    //
    // Each closure is the great circle through its two end points, so the plane
    // through it and the Earth's centre is what to cut against, and the crossing
    // is interpolated rather than snapped to the nearest sample — at the end of
    // the path the samples are up to 80 km apart, which would leave a visible
    // stub short of the line.
    clipToCaps(points, startCap, endCap, inside) {
        if (!startCap || !endCap || points.length < 2) return points;
        const normal = (cap) => {
            // The cap's two TIPS: the great circle through them is the closure.
            const nrm = cap[0].clone().cross(cap[cap.length - 1]);
            if (!(nrm.lengthSq() > 0)) return null;
            nrm.normalize();
            return nrm.dot(inside) < 0 ? nrm.negate() : nrm;
        };
        const n0 = normal(startCap), n1 = normal(endCap);
        if (!n0 || !n1) return points;
        const isIn = (p) => p.dot(n0) >= 0 && p.dot(n1) >= 0;
        let lo = 0, hi = points.length - 1;
        while (lo <= hi && !isIn(points[lo])) lo++;
        while (hi >= lo && !isIn(points[hi])) hi--;
        if (lo > hi) return [];
        const out = points.slice(lo, hi + 1);
        // `out` is the point that IS inside, `p` the neighbour that is not.
        const cross = (p, o) => {
            for (const nrm of [n0, n1]) {
                const dp = p.dot(nrm);
                if (dp < 0) return p.clone().lerp(o, dp / (dp - o.dot(nrm)));
            }
            return null;
        };
        if (lo > 0) {
            const p = cross(points[lo - 1], points[lo]);
            if (p) out.unshift(p);
        }
        if (hi < points.length - 1) {
            const p = cross(points[hi + 1], points[hi]);
            if (p) out.push(p);
        }
        return out;
    }

    // Sweep the eclipse and accumulate the centreline and the two limits.
    // Cached on the eclipse's peak time: update() calls rebuild() every frame,
    // and this is a few thousand ellipsoid intersections that must not run at
    // frame rate.
    computeEclipsePath(peakDate) {
        const key = peakDate.getTime();
        if (this._pathCache && this._pathCache.key === key) return this._pathCache;

        // +/-4 h at 2 min for the coarse pass. Any eclipse crosses the Earth
        // well inside that; this pass only BRACKETS it.
        const SPAN_MIN = 240, STEP_MIN = 2;
        const STEP_MS = STEP_MIN * 60000;
        const MAX_STEP_M = 80000;   // ground distance between samples
        const MAX_DEPTH = 8;        // 2 min / 256, i.e. ~0.5 s at the ends
        const EDGE_TOL_MS = 1000;   // how tightly first/last contact is pinned
        const SEGMENTS = 48;        // position angles the umbra ring is traced at

        const empty = {key, centerLine: [], umbraN: [], umbraS: [],
                       startCap: null, endCap: null, totalSamples: 0};

        let tIn = null, tOut = null, gotBefore = false, gotAfter = false;
        for (let m = -SPAN_MIN; m <= SPAN_MIN; m += STEP_MIN) {
            const t = key + m * 60000;
            if (!this.shadowCenterAt(new Date(t))) continue;
            if (tIn === null) { tIn = t; gotBefore = m > -SPAN_MIN; }
            tOut = t; gotAfter = m < SPAN_MIN;
        }
        if (tIn === null) { this._pathCache = empty; return empty; }

        // First and last contact, to the second. The coarse grid's end samples
        // sit up to a step short of the real ones, and a step at the ends is
        // 500 km of ground — the path visibly stopped in open water.
        const bisect = (hitT, missT) => {
            while (Math.abs(hitT - missT) > EDGE_TOL_MS) {
                const mid = 0.5 * (hitT + missT);
                if (this.shadowCenterAt(new Date(mid))) hitT = mid; else missT = mid;
            }
            return hitT;
        };
        if (gotBefore) tIn = bisect(tIn, tIn - STEP_MS);
        if (gotAfter) tOut = bisect(tOut, tOut + STEP_MS);

        // Samples placed by GROUND distance, not by the clock.
        //
        // The shadow crosses the ground at ~1 km/s near mid-eclipse and without
        // bound as the axis flattens towards the limb. A fixed 2-minute step
        // that gives 150 km of track over Spain gives 525 km over the Balearics
        // — so the last leg, the most curved part of the whole path, was drawn
        // as one straight chord. Splitting any interval longer than MAX_STEP_M
        // puts samples where the geometry needs them and none where it does not.
        const samples = [];
        const split = (t0, g0, t1, g1, depth) => {
            if (depth < MAX_DEPTH && g0.center.distanceTo(g1.center) > MAX_STEP_M) {
                const tm = 0.5 * (t0 + t1);
                const gm = this.shadowGroundAt(new Date(tm), SEGMENTS);
                if (gm) {
                    split(t0, g0, tm, gm, depth + 1);
                    split(tm, gm, t1, g1, depth + 1);
                    return;
                }
            }
            samples.push(g1);
        };
        let gPrev = this.shadowGroundAt(new Date(tIn), SEGMENTS);
        if (!gPrev) { this._pathCache = empty; return empty; }
        samples.push(gPrev);
        let tPrev = tIn;
        const grid = [];
        for (let m = -SPAN_MIN; m <= SPAN_MIN; m += STEP_MIN) {
            const t = key + m * 60000;
            if (t > tIn && t < tOut) grid.push(t);
        }
        grid.push(tOut);
        for (const t of grid) {
            const g = this.shadowGroundAt(new Date(t), SEGMENTS);
            if (!g) continue;
            split(tPrev, gPrev, t, g, 0);
            tPrev = t; gPrev = g;
        }

        // Past the axis, but not past the shadow.
        //
        // The umbra is ~100 km across, so it goes on standing on the Earth for
        // a while after its AXIS has left: at the 2026-08-12 eclipse the last
        // ~250 km of the southern limit — from Valencia out past Ibiza, which
        // the published maps all show — happens entirely after the axis has
        // gone. Stopping the sweep at axis egress cut it off there and left the
        // three lines ending at three unrelated places. So walk on from each end
        // in small steps until neither limit finds a tangent point any more,
        // which is the moment the last of the umbra clears the limb. The
        // centreline does NOT get these samples: with no axis intersection there
        // is no centre to trace, which is why it is the SHORTEST of the three
        // lines at the ends rather than the longest.
        // The direction of travel is CARRIED IN, not measured here. Out here the
        // centre is nearestSurfacePoint's, and once the axis has swung past the
        // Earth that point stalls and then retreats — differencing it reverses
        // the travel direction mid-extension, which flips cross-track, which
        // swaps north for south partway along the cap. The real track turns by
        // about a degree over the minute or two this runs, so the direction from
        // the last pair of real intersections is good for all of it.
        const EXT_STEP_MS = 5000, EXT_MAX_STEPS = 180;
        const extend = (fromT, dir, sign) => {
            const out = [];
            const accept = (dt) => {
                const g = this.shadowGroundAt(new Date(fromT + sign * dt), SEGMENTS, true);
                if (!g) return null;
                const cross = g.center.clone().normalize().cross(dir);
                if (!(cross.lengthSq() > 0)) return null;
                const lim = this.limitPoints(g, cross.normalize());
                if (!lim.hi && !lim.lo) return null;
                g.travelDir = dir;
                return g;
            };
            let k = 1, lo = 0;
            for (; k <= EXT_MAX_STEPS; k++) {
                const g = accept(k * EXT_STEP_MS);
                if (!g) break;
                out.push(g);
                lo = k * EXT_STEP_MS;
            }
            // Close the last interval. A flat 5 s step leaves each limit ending
            // wherever the walk happened to land, up to a step short of where its
            // last tangent point really is; bisecting walks it up to the real end,
            // which is also where the cap is drawn from.
            let hi = k * EXT_STEP_MS;
            for (let j = 0; j < 12; j++) {
                const mid = 0.5 * (lo + hi);
                const g = accept(mid);
                if (g) { out.push(g); lo = mid; } else hi = mid;
            }
            return out;
        };
        const dirBetween = (a, b) => {              // a earlier than b
            const d = b.center.clone().sub(a.center);
            return d.lengthSq() > 1 ? d.normalize() : null;
        };
        const n = samples.length;
        const headDir = n > 1 ? dirBetween(samples[0], samples[1]) : null;
        const tailDir = n > 1 ? dirBetween(samples[n - 2], samples[n - 1]) : null;
        const all = (headDir ? extend(tIn, headDir, -1) : []).reverse()
            .concat(samples, tailDir ? extend(tOut, tailDir, +1) : []);

        // Cross-track needs the direction of travel, which needs the NEXT
        // centre — hence a second pass rather than doing it in the first.
        const centerLine = [], umbraN = [], umbraS = [];
        for (let i = 0; i < all.length; i++) {
            const s = all[i];
            if (s.axisHit) centerLine.push(s.center);

            // Central difference, and always FORWARD in time. Falling back to
            // the previous sample as `next` (as this did) reverses the travel
            // direction at the last sample, which swaps north for south on the
            // one sample that ends the path. Only real axis intersections are
            // differenced — an extension sample's centre is not a track position
            // (see extend), and those samples carry their direction instead.
            let travel = s.travelDir?.clone();
            if (!travel) {
                const before = all[i - 1]?.axisHit ? all[i - 1] : s;
                const after = all[i + 1]?.axisHit ? all[i + 1] : s;
                travel = after.center.clone().sub(before.center);
                if (travel.lengthSq() < 1) continue;
                travel.normalize();
            }
            const up = s.center.clone().normalize();
            const crossTrack = up.clone().cross(travel).normalize();

            const lim = this.limitPoints(s, crossTrack);
            if (lim.hi) umbraN.push(lim.hi);
            if (lim.lo) umbraS.push(lim.lo);
        }

        const last = (a) => a[a.length - 1];
        const startCap = this.capBetween(umbraN[0], umbraS[0]);
        const endCap = this.capBetween(last(umbraN), last(umbraS));
        this._pathCache = {
            key, umbraN, umbraS, startCap, endCap,
            centerLine: this.clipToCaps(centerLine, startCap, endCap,
                                        centerLine[Math.floor(centerLine.length / 2)]),
            totalSamples: all.length,
        };
        return this._pathCache;
    }

    // One terrain-following polyline through a list of ellipsoid-surface points.
    //
    // Subdivided between samples, not joined straight, for two reasons. A
    // straight chord between samples ~80 km apart sinks below the ellipsoid,
    // and — the bigger effect by far — it sinks into the TERRAIN, which over
    // 80 km of Spain moves by far more than the 100 m the line is clamped above
    // the ground. Either way the middle of the segment is hidden and the path
    // draws as a row of dashes. Each interpolated point is pushed back out to
    // the surface and clamped in its own right, exactly as groundLineBetween
    // does for the centre cross, so the whole line follows the ground.
    addPathLine(points, material, clearance) {
        // Null for a cap that has no two ends to join — an annular eclipse
        // traces no umbra ring at all, so there is nothing to cap.
        if (!points || points.length < 2) return;
        const flat = [];
        const SUB = 32;
        for (let i = 0; i < points.length - 1; i++) {
            const seg = this.groundLineBetween(points[i], points[i + 1], SUB, clearance);
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
        if (!eclipse) { this._pathCache = null; this.removePathLines(); return; }

        const path = this.computeEclipsePath(eclipse.peak.date);

        // The GEOMETRY is cached as well as the sweep. rebuild() runs every
        // frame, and these lines are ~13,000 terrain-clamped points: at the
        // ~1.6 us each that clamp costs, rebuilding them per frame is ~20 ms —
        // a whole frame budget for a track that only changes when the eclipse
        // does, when the elevation under it does (see the elevationChanged
        // listener in the constructor, which clears this key), or when the zoom
        // moves it to a different octave of ground clearance.
        const clearance = this.groundClearance();
        const geomKey = path.key + ":" + clearance;
        if (this._pathGeomKey === geomKey && this.pathLines.length) return;
        this.removePathLines();
        this._pathGeomKey = geomKey;

        // Umbra limits and the centreline only. The penumbra's limits are
        // deliberately NOT drawn: it is thousands of km across, so its edges
        // sweep most of a hemisphere and read as clutter across the whole globe
        // rather than as a path. The penumbra's instantaneous ground outline is
        // still there with the shadow, which is where it is actually legible.
        this.addPathLine(path.umbraN, this.umbraMaterial, clearance);
        this.addPathLine(path.umbraS, this.umbraMaterial, clearance);
        this.addPathLine(path.centerLine, this.centerMaterial, clearance);

        // The two ends, closed off across the limits (see capBetween). Without
        // this the path just stops in mid-ocean.
        this.addPathLine(path.startCap, this.umbraMaterial, clearance);
        this.addPathLine(path.endCap, this.umbraMaterial, clearance);
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
        // Every early return here means "nothing of this node is on screen", so
        // the kept path lines have to go with the rest.
        if (!this.visible || !this.showEclipsePath) {
            this.removePathLines();
        }
        if (!this.visible) {
            return;
        }

        if (!Globals.moonPos || !Globals.fromSun) {
            this.removePathLines();
            return;
        }

        const moonCenter = Globals.moonPos.clone();

        if (moonCenter.length() < 100000) {
            this.removePathLines();
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
        const clearance = this.groundClearance();

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
                    point = clampAboveGround(mslPoint, clearance);
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
                    point = clampAboveGround(mslPoint, clearance);
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
