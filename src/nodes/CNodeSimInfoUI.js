import {CNodeVideoInfoUI} from "./CNodeVideoInfoUI";
import {Globals, NodeMan, Sit, Units} from "../Globals";
import {t} from "../i18n";
import {altitudeHAE, getLocalUpVector} from "../SphericalMath";
import {meanSeaLevelOffset} from "../EGM96Geoid";
import {ECEFToLLA_radii} from "../LLA-ECEF-ENU";
import {getTilesPointBelow} from "../threeExt";

// Keep in sync with the same-named constants in CNodeVideoInfoUI so a freshly
// enabled item starts at the shared default position (and isItemMoved works).
const DEFAULT_X = 50;
const DEFAULT_Y = 8;

// Sim Info Display: a date/time text overlay for the look view (or any non-video
// view it is attached to). It reuses ALL of CNodeVideoInfoUI's drawing, dragging
// and auto-positioning machinery, but exposes ONLY the simulation date/time
// readouts plus a set of Traverse readouts (speed / g-force / altitude) and font
// size — no filename / frame number / offset / timecode / timestamp /
// OSD-data-series items, which are inherently video-specific.
//
// The node is attached with `overlayView: "lookView"` (NOT `relativeTo`), so
// `this.in.relativeTo` is undefined. That makes every video-specific code path
// in the base class (live zoom tracking, getVideoRect's source/dest transform,
// source-frame lookups, filename) short-circuit to the plain "percent of the
// canvas" overlay behaviour we want for a 3D view. Hence the small surface area
// of overrides below.
export class CNodeSimInfoUI extends CNodeVideoInfoUI {

    constructor(v) {
        super(v);

        // Traverse readouts — sim-info-only lines derived per-frame from the
        // selected traverse track (LOSTraverseSelect). All default OFF; the user
        // enables them from the Sim Info menu. They follow the same 6-tuple
        // pattern as the base class's date/time items: a showX flag, an X/Y
        // percent position, and a cached _XBbox (set in drawExtraItems).
        this.showTraverseSpeed = v.showTraverseSpeed ?? false;
        this.showTraverseGroundSpeed = v.showTraverseGroundSpeed ?? false;
        this.showTraverseAirSpeed = v.showTraverseAirSpeed ?? false;
        this.showTraverseGForce = v.showTraverseGForce ?? false;
        this.showTraverseAltMSL = v.showTraverseAltMSL ?? false;
        this.showTraverseAltAGL = v.showTraverseAltAGL ?? false;

        this.traverseSpeedX = v.traverseSpeedX ?? DEFAULT_X;
        this.traverseSpeedY = v.traverseSpeedY ?? DEFAULT_Y;
        this.traverseGroundSpeedX = v.traverseGroundSpeedX ?? DEFAULT_X;
        this.traverseGroundSpeedY = v.traverseGroundSpeedY ?? DEFAULT_Y;
        this.traverseAirSpeedX = v.traverseAirSpeedX ?? DEFAULT_X;
        this.traverseAirSpeedY = v.traverseAirSpeedY ?? DEFAULT_Y;
        this.traverseGForceX = v.traverseGForceX ?? DEFAULT_X;
        this.traverseGForceY = v.traverseGForceY ?? DEFAULT_Y;
        this.traverseAltMSLX = v.traverseAltMSLX ?? DEFAULT_X;
        this.traverseAltMSLY = v.traverseAltMSLY ?? DEFAULT_Y;
        this.traverseAltAGLX = v.traverseAltAGLX ?? DEFAULT_X;
        this.traverseAltAGLY = v.traverseAltAGLY ?? DEFAULT_Y;

        this.addSimpleSerial("showTraverseSpeed");
        this.addSimpleSerial("showTraverseGroundSpeed");
        this.addSimpleSerial("showTraverseAirSpeed");
        this.addSimpleSerial("showTraverseGForce");
        this.addSimpleSerial("showTraverseAltMSL");
        this.addSimpleSerial("showTraverseAltAGL");
        this.addSimpleSerial("traverseSpeedX");
        this.addSimpleSerial("traverseSpeedY");
        this.addSimpleSerial("traverseGroundSpeedX");
        this.addSimpleSerial("traverseGroundSpeedY");
        this.addSimpleSerial("traverseAirSpeedX");
        this.addSimpleSerial("traverseAirSpeedY");
        this.addSimpleSerial("traverseGForceX");
        this.addSimpleSerial("traverseGForceY");
        this.addSimpleSerial("traverseAltMSLX");
        this.addSimpleSerial("traverseAltMSLY");
        this.addSimpleSerial("traverseAltAGLX");
        this.addSimpleSerial("traverseAltAGLY");
    }

    // Only the date/time and traverse items participate in vertical stacking /
    // auto-positioning and drag hit-testing. The video-only flags stay false and
    // are never shown.
    getAllItemIds() {
        return ['dateLocal', 'timeLocal', 'dateTimeLocal', 'dateUTC', 'timeUTC', 'dateTimeUTC',
            'traverseSpeed', 'traverseGroundSpeed', 'traverseAirSpeed', 'traverseGForce',
            'traverseAltMSL', 'traverseAltAGL'];
    }

    // Map our extra item ids to their show flags (base class handles date/time).
    getShowProp(id) {
        const map = {
            traverseSpeed: 'showTraverseSpeed',
            traverseGroundSpeed: 'showTraverseGroundSpeed',
            traverseAirSpeed: 'showTraverseAirSpeed',
            traverseGForce: 'showTraverseGForce',
            traverseAltMSL: 'showTraverseAltMSL',
            traverseAltAGL: 'showTraverseAltAGL',
        };
        return super.getShowProp(id) ?? map[id];
    }

    // Map our extra item ids to their [Xprop, Yprop] position pair.
    getElementPos(id) {
        const base = super.getElementPos(id);
        if (base) return base;
        const map = {
            traverseSpeed: ['traverseSpeedX', 'traverseSpeedY'],
            traverseGroundSpeed: ['traverseGroundSpeedX', 'traverseGroundSpeedY'],
            traverseAirSpeed: ['traverseAirSpeedX', 'traverseAirSpeedY'],
            traverseGForce: ['traverseGForceX', 'traverseGForceY'],
            traverseAltMSL: ['traverseAltMSLX', 'traverseAltMSLY'],
            traverseAltAGL: ['traverseAltAGLX', 'traverseAltAGLY'],
        };
        return map[id] ?? null;
    }

    // Add our extra items' hit-test boxes on top of the base class's.
    getElementBounds() {
        const bounds = super.getElementBounds();
        const padding = 6;
        const addBbox = (id, show, bbox) => {
            if (show && bbox) {
                bounds.push({
                    id,
                    x: bbox.x - padding,
                    y: bbox.y - padding,
                    w: bbox.w + padding * 2,
                    h: bbox.h + padding * 2,
                });
            }
        };
        addBbox('traverseSpeed', this.showTraverseSpeed, this._traverseSpeedBbox);
        addBbox('traverseGroundSpeed', this.showTraverseGroundSpeed, this._traverseGroundSpeedBbox);
        addBbox('traverseAirSpeed', this.showTraverseAirSpeed, this._traverseAirSpeedBbox);
        addBbox('traverseGForce', this.showTraverseGForce, this._traverseGForceBbox);
        addBbox('traverseAltMSL', this.showTraverseAltMSL, this._traverseAltMSLBbox);
        addBbox('traverseAltAGL', this.showTraverseAltAGL, this._traverseAltAGLBbox);
        return bounds;
    }

    // Visibility (and thus whether the overlay canvas draws at all) depends only
    // on the date/time and traverse items, not on filename/frame/timecode
    // (always off here).
    hasAnyInfoItem() {
        return this.showDateLocal || this.showTimeLocal || this.showDateTimeLocal ||
            this.showDateUTC || this.showTimeUTC || this.showDateTimeUTC ||
            this.showTraverseSpeed || this.showTraverseGroundSpeed || this.showTraverseAirSpeed ||
            this.showTraverseGForce || this.showTraverseAltMSL || this.showTraverseAltAGL;
    }

    // OSD Data Series readouts are a video-analysis feature with no meaning on the
    // look view. Suppress both their contribution to visibility and their drawing
    // (the latter keeps this._osdDataSeriesBboxes empty so getElementBounds and
    // drag hit-testing only ever see the date/time and traverse items).
    hasAnyOSDDataSeries() {
        return false;
    }

    // The master "Show Sim Info" toggle is a GLOBAL (Globals.showSimInfo), like
    // the other Show-menu master toggles, rather than the per-node showInfo the
    // base class uses. So gate visibility on the global here.
    shouldBeVisible() {
        if (!Globals.showSimInfo) return false;
        return this.hasAnyInfoItem();
    }

    drawOSDDataSeries(c, widthPx, heightPx, padding) {
        // no-op for the sim info overlay
    }

    // ---- Traverse readouts --------------------------------------------------
    // All values are derived directly from the selected traverse position track,
    // matching the formulas used by the Graphs / Traverse Speed, Traverse
    // Altitude and Object g-force graphs (JetGraphs.js / CNodeGForce). Reading
    // the node fresh each frame (rather than holding a reference) keeps us robust
    // to the traverse being rebuilt when the sitch or method changes.

    getTraverseNode() {
        // The traverse-method switch id varies by sitch flavor: legacy jet
        // sitches use "LOSTraverseSelect", the data-driven/custom setup uses
        // "LOSTraverseSelectTrack".
        const node = NodeMan.get("LOSTraverseSelect", false)
            ?? NodeMan.get("LOSTraverseSelectTrack", false)
            ?? null;
        return (node && typeof node.p === "function") ? node : null;
    }

    // Shared speed helper. `mode` selects which of the Traverse Speed graph's
    // series to reproduce, all in the current speed units (kt / mph / km/h):
    //   'object' — total 3D speed          (black "Object Speed")
    //   'ground' — horizontal ground speed (green, move projected onto ground)
    //   'air'    — horizontal air speed     (blue, wind subtracted then projected)
    // See JetGraphs.AddSpeedGraph for the reference formulas.
    traverseSpeedText(frame, mode) {
        const src = this.getTraverseNode();
        if (!src || !Units) return null;
        const fps = (src.fps ?? Sit.fps ?? 30) / (Sit.simSpeed ?? 1);
        const frames = src.frames ?? Sit.frames;
        let f = Math.max(1, Math.min(frame, frames - 1));
        const move = src.p(f).clone().sub(src.p(f - 1));
        if (mode === 'air') {
            // Air speed subtracts the (per-frame) wind displacement. No wind
            // track => air speed is undefined, so don't draw the line.
            const wind = NodeMan.get("targetWind", false);
            if (!wind || typeof wind.p !== "function") return null;
            move.sub(wind.p(f));
        }
        if (mode === 'ground' || mode === 'air') {
            // Horizontal component: drop the vertical (ellipsoid-up) part.
            move.projectOnPlane(getLocalUpVector(src.p(f)));
        }
        const speed = move.length() * fps * Units.m2Speed;
        return `${speed.toFixed(0)} ${Units.speed.abbrev}`;
    }

    getTraverseSpeedText(frame) { return this.traverseSpeedText(frame, 'object'); }
    getTraverseGroundSpeedText(frame) { return this.traverseSpeedText(frame, 'ground'); }
    getTraverseAirSpeedText(frame) { return this.traverseSpeedText(frame, 'air'); }

    // Total 3D g-force (second difference of position / 9.81), matching the black
    // "Object g-force" series. Clamp near the end like CNodeGForce (final frames
    // are often corrupt).
    getTraverseGForceText(frame) {
        const src = this.getTraverseNode();
        if (!src) return null;
        const fps = (src.fps ?? Sit.fps ?? 30) / (Sit.simSpeed ?? 1);
        const frames = src.frames ?? Sit.frames;
        let f = Math.max(0, Math.min(frame, frames - 4));
        const p0 = src.p(f);
        const p1 = src.p(f + 1);
        const p2 = src.p(f + 2);
        const s1 = p1.clone().sub(p0);
        const s2 = p2.clone().sub(p1);
        const a = s2.sub(s1);
        const g = a.length() * fps * fps / 9.81;
        return `${g.toFixed(2)} g`;
    }

    // MSL altitude = HAE - geoid offset, in the current small units (ft / m).
    getTraverseAltMSLText(frame) {
        const src = this.getTraverseNode();
        if (!src || !Units) return null;
        const frames = src.frames ?? Sit.frames;
        let f = Math.max(0, Math.min(frame, frames - 1));
        const pos = src.p(f);
        const lla = ECEFToLLA_radii(pos.x, pos.y, pos.z);
        const mslM = lla[2] - meanSeaLevelOffset(lla[0], lla[1]);
        return Units.smallWithUnits(mslM, 0);
    }

    // AGL altitude = object HAE - ground-surface HAE directly below. Using the
    // HAE of both points makes this datum-independent. Mirrors Sitrec's own AGL
    // convention (CNodePositionLLA._aglGroundPoint): ride the actual 3D-tile
    // surface when a believable tile is loaded directly below (buildings /
    // photogrammetry the elevation map ignores), otherwise the smooth elevation
    // map, otherwise the geoid (sea level) when no terrain model exists.
    getTraverseAltAGLText(frame) {
        const src = this.getTraverseNode();
        if (!src || !Units) return null;
        const frames = src.frames ?? Sit.frames;
        let f = Math.max(0, Math.min(frame, frames - 1));
        const pos = src.p(f);
        const posHAE = altitudeHAE(pos);
        let groundHAE;
        const terrain = NodeMan.get("TerrainModel", false);
        if (terrain && typeof terrain.getPointBelow === "function") {
            const elevGround = terrain.getPointBelow(pos);
            const tilesGround = getTilesPointBelow(elevGround);
            groundHAE = altitudeHAE(tilesGround !== null ? tilesGround : elevGround);
        } else {
            const lla = ECEFToLLA_radii(pos.x, pos.y, pos.z);
            groundHAE = meanSeaLevelOffset(lla[0], lla[1]);
        }
        return Units.smallWithUnits(posHAE - groundHAE, 0);
    }

    // Draw the traverse readouts, reusing the base class's drawTextWithBg closure
    // so they share the same font/positioning/background-box layout. Store each
    // bbox for drag hit-testing (getElementBounds); null it out when not drawn
    // (e.g. no traverse track) so a stale box can't be grabbed.
    drawExtraItems(drawTextWithBg, frame) {
        this._traverseSpeedBbox = null;
        this._traverseGroundSpeedBbox = null;
        this._traverseAirSpeedBbox = null;
        this._traverseGForceBbox = null;
        this._traverseAltMSLBbox = null;
        this._traverseAltAGLBbox = null;

        if (this.showTraverseSpeed) {
            const txt = this.getTraverseSpeedText(frame);
            if (txt !== null) this._traverseSpeedBbox = drawTextWithBg(txt, this.traverseSpeedX, this.traverseSpeedY);
        }
        if (this.showTraverseGroundSpeed) {
            const txt = this.getTraverseGroundSpeedText(frame);
            if (txt !== null) this._traverseGroundSpeedBbox = drawTextWithBg(txt, this.traverseGroundSpeedX, this.traverseGroundSpeedY);
        }
        if (this.showTraverseAirSpeed) {
            const txt = this.getTraverseAirSpeedText(frame);
            if (txt !== null) this._traverseAirSpeedBbox = drawTextWithBg(txt, this.traverseAirSpeedX, this.traverseAirSpeedY);
        }
        if (this.showTraverseGForce) {
            const txt = this.getTraverseGForceText(frame);
            if (txt !== null) this._traverseGForceBbox = drawTextWithBg(txt, this.traverseGForceX, this.traverseGForceY);
        }
        if (this.showTraverseAltMSL) {
            const txt = this.getTraverseAltMSLText(frame);
            if (txt !== null) this._traverseAltMSLBbox = drawTextWithBg(txt, this.traverseAltMSLX, this.traverseAltMSLY);
        }
        if (this.showTraverseAltAGL) {
            const txt = this.getTraverseAltAGLText(frame);
            if (txt !== null) this._traverseAltAGLBbox = drawTextWithBg(txt, this.traverseAltAGLX, this.traverseAltAGLY);
        }
    }

    setupMenu(parentFolder) {
        const folder = parentFolder.addFolder(t("simInfo.folderTitle.label")).close()
            .tooltip(t("simInfo.folderTitle.tooltip"));

        if (Globals.showSimInfo === undefined) Globals.showSimInfo = true;
        folder.add(Globals, "showSimInfo").name(t("simInfo.showSimInfo.label"))
            .tooltip(t("simInfo.showSimInfo.tooltip"))
            .listen()
            .onChange(() => this.updateVisibility());

        // Date/time rows reuse the videoInfo i18n strings (identical labels).
        folder.add(this, "showDateLocal").name(t("videoInfo.dateLocal.label"))
            .tooltip(t("videoInfo.dateLocal.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateLocal'); this.updateVisibility(); });

        folder.add(this, "showTimeLocal").name(t("videoInfo.timeLocal.label"))
            .tooltip(t("videoInfo.timeLocal.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('timeLocal'); this.updateVisibility(); });

        folder.add(this, "showDateTimeLocal").name(t("videoInfo.dateTimeLocal.label"))
            .tooltip(t("videoInfo.dateTimeLocal.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateTimeLocal'); this.updateVisibility(); });

        folder.add(this, "showDateUTC").name(t("videoInfo.dateUTC.label"))
            .tooltip(t("videoInfo.dateUTC.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateUTC'); this.updateVisibility(); });

        folder.add(this, "showTimeUTC").name(t("videoInfo.timeUTC.label"))
            .tooltip(t("videoInfo.timeUTC.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('timeUTC'); this.updateVisibility(); });

        folder.add(this, "showDateTimeUTC").name(t("videoInfo.dateTimeUTC.label"))
            .tooltip(t("videoInfo.dateTimeUTC.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('dateTimeUTC'); this.updateVisibility(); });

        // Traverse readouts (speed / g-force / altitude), derived from the
        // selected traverse track. Shown even when no traverse exists yet — the
        // readout simply stays hidden until the track is available.
        folder.add(this, "showTraverseSpeed").name(t("simInfo.traverseSpeed.label"))
            .tooltip(t("simInfo.traverseSpeed.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('traverseSpeed'); this.updateVisibility(); });

        folder.add(this, "showTraverseGroundSpeed").name(t("simInfo.traverseGroundSpeed.label"))
            .tooltip(t("simInfo.traverseGroundSpeed.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('traverseGroundSpeed'); this.updateVisibility(); });

        folder.add(this, "showTraverseAirSpeed").name(t("simInfo.traverseAirSpeed.label"))
            .tooltip(t("simInfo.traverseAirSpeed.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('traverseAirSpeed'); this.updateVisibility(); });

        folder.add(this, "showTraverseGForce").name(t("simInfo.traverseGForce.label"))
            .tooltip(t("simInfo.traverseGForce.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('traverseGForce'); this.updateVisibility(); });

        folder.add(this, "showTraverseAltMSL").name(t("simInfo.traverseAltMSL.label"))
            .tooltip(t("simInfo.traverseAltMSL.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('traverseAltMSL'); this.updateVisibility(); });

        folder.add(this, "showTraverseAltAGL").name(t("simInfo.traverseAltAGL.label"))
            .tooltip(t("simInfo.traverseAltAGL.tooltip"))
            .listen()
            .onChange(v => { if (v) this.positionItemToAvoidOverlaps('traverseAltAGL'); this.updateVisibility(); });

        folder.add(this, "fontSize", 10, 80, 1).name(t("videoInfo.fontSize.label"))
            .tooltip(t("videoInfo.fontSize.tooltip"))
            .listen();

        return folder;
    }
}
