import {interpolate} from "../utils";
import {GlobalDateTimeNode, Globals, NodeMan, Sit} from "../Globals";
import {meanSeaLevelOffset} from "../EGM96Geoid";

import {MISB} from "../MISBUtils";
import {saveAs} from "file-saver";
import {CNodeTrack} from "./CNodeTrack";
import {assert} from "../assert";
import {CGeoJSON} from "../geoJSONUtils";
import {isLocal} from "../configUtils"
import stringify from "json-stringify-pretty-compact";
import {Vector3} from "three";
import {LLAToECEF, ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";

export class CNodeTrackFromMISB extends CNodeTrack {
    constructor(v) {

        const exportable = v.exportable ?? false;
        v.exportable = false; // we don't want the export button on the array

        super(v);
    //    this.kml = FileManager.get(v.cameraFile)

        this._columns = v.columns || ["SensorLatitude", "SensorLongitude", "SensorTrueAltitude", "AltitudeAGL"]

//        console.log("CNodeTrackFromMISB:constructor(): columns[2] = ",this._columns[2])

        this.input("misb")
        this.optionalInputs(["terrain"])

        this.frameRelativeTime = v.frameRelativeTime ?? false; // if true, the start time is fixed to the first time calculated

        this.cacheValues();


        this.addInput("startTime",GlobalDateTimeNode)
        this.recalculate()

        // Note: no separate elevationChanged listener here. CNodeMISBData (the
        // upstream data node) already listens for that event and triggers a
        // recalculateCascade for AGL tracks — which calls our recalculate(),
        // which calls getPointBelowCached, which auto-detects stale cache
        // entries via elevationTileHasHigherZoom and re-samples them. Adding a
        // listener here would just double every cascade.

        this.exportable = exportable;
        if (this.exportable) {
            NodeMan.addExportButton(this, "exportTrackCSV")
            NodeMan.addExportButton(this, "exportTrackKML")
            NodeMan.addExportButton(this, "exportMISBCompliantCSV")
            if (isLocal) {
                if (Sit.isCustom) {
                    // limited to local custom use, as it triggers "more than one export button" warning
                    NodeMan.addExportButton(this, "exportGEOJSON")
                    NodeMan.addExportButton(this, "exportALLGEO")
                    NodeMan.addExportButton(this, "exportCustom1")
                }
            }
        }
    }


    cacheValues() {
        const misb = this.in.misb;
        misb.selectSourceColumns(this._columns);
        this.latArray = [];
        this.lonArray = [];
        this.rawAltArray = [];
        this.timeArray = [];
        this.validArray = [];

        const len = this.inputs.misb.misb.length;
        for (let i = 0; i < len; i++) {
            this.latArray.push(misb.getLat(i));
            this.lonArray.push(misb.getLon(i));
            this.rawAltArray.push(misb.getRawAlt(i)); // TODO: needs alt adjustments. add a getAlt function to this

            this.timeArray.push(misb.getTime(i));
            this.validArray.push(misb.isValid(i));
        }
    }

    // Pick the terrain node we'll cache against. Optional input wins; otherwise
    // fall back to the global TerrainModel. Returns null if no terrain available
    // — callers must handle that (the recalculate loop falls back to the
    // existing per-vertex elevationAtLL path in that case).
    _resolveTerrainNode() {
        return this.in.terrain ?? NodeMan.get("TerrainModel", false) ?? null;
    }

    // Per-frame AGL offset: altitudeLockAGL takes precedence (display-driven
    // override). Otherwise use the per-frame interpolated raw column value as
    // an AGL height (the useAGL=true case). For useAGL we have to pass the
    // *interpolated* offset in to the cache lookup, so we compute it inline.
    _aglOffsetForFrame(misb, slot, fraction) {
        if (misb.isAGLLockActive()) {
            return misb.altitudeLock;
        }
        if (misb.useAGL) {
            // Read the column value directly. Don't go through getRawAlt — that
            // pre-bakes terrain via uncached elevationAtLL, which is what the
            // cached path is meant to replace.
            const a0 = Number(misb.misb[slot][misb.altCol]);
            const a1 = Number(misb.misb[slot + 1][misb.altCol]);
            return interpolate(a0, a1, fraction);
        }
        return 0; // not used for non-AGL paths
    }

    modSerialize() {
        const result = {
            ...super.modSerialize(),
        };
        // Persist the elevation cache so a sitch that's already been viewed at
        // high zoom hands out correct ground altitudes on first reload, with
        // zero dependence on tile-build timing. Sparse-by-construction: only
        // frames that have been queried have entries.
        const elevCache = this.serializeElevationCache();
        if (elevCache) result.elevationCache = elevCache;
        return result;
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.elevationCache !== undefined) {
            this.deserializeElevationCache(v.elevationCache);
            // No explicit recalculateCascade here. The constructor's recalculate
            // already populated this.array from current terrain; the upstream
            // CNodeMISBData listener will fire a cascade when terrain settles
            // (or has already), and that cascade re-runs our recalculate which
            // hits the now-restored cache entries via getPointBelowCached.
        }
    }


    // export the track as a CSV file (only used for testing Custom1 import functionality
    exportCustom1(inspect = false) {
        let csv = "TIME,MGRS,LAT_DMS,LON_DMS,LAT,LONG,LAT_DDM,LON_DDM,ALTITUDE,AIRCRAFT,CALLSIGN,SPEED_KTS\n"
        const misb = this.in.misb;
        misb.selectSourceColumns(this._columns);
        var points = misb.misb.length
        const id = this.shortName ?? this.id;
        for (let slot = 0; slot < points; slot++) {
            const time = misb.getTime(slot);
            const date = new Date(time)
            // we want one with the seconds, not the milliseconds
            const dateStr = date.toISOString().slice(0,19)+"Z";
            csv += dateStr + ","
                + "," + "," + ","
                + misb.getLat(slot) + "," + misb.getLon(slot) + ","
                + "," + ","
                + misb.getAltMSL(slot) + ","
                + "F-15" + ","+ id + ","
                + 0 + "\n" // speed is currently ignored


        }
        if (inspect) {
            return {
                desc: "Custom1 Export",
                csv: csv,
            }
        }
        else {
            saveAs(new Blob([csv]), "Custom1-" + this.id + ".csv")
        }

    }

    getValue(frameFloat) {
        // Apply time offsets to the frame before retrieving value
        // - timeOffset: manual fine-tuning slider (seconds)
        // - trackStartTime: absolute start time override (computed to seconds)
        const misb = this.in.misb;
        const manualOffset = misb.timeOffset ?? 0;
        const startTimeOffset = misb.getTrackStartTimeOffsetSeconds?.() ?? 0;
        const totalOffsetFrames = (manualOffset + startTimeOffset) * Sit.fps;
        return super.getValue(frameFloat + totalOffsetFrames);
    }


    exportGEOJSON(inspect=false) {
        const geo = new CGeoJSON()

        const json = JSON.stringify(geo.json)

        console.log("CNodeTrackFromMISB:exportGEOJSON(): json = ", json)

        if (inspect) {
            return {
                desc: "GEOJason Export",
                json: json,
            }
        }
        else {
            saveAs(new Blob([json]), "trackFromMISB-" + this.id + ".json")
        }
    }


    addToGeoJSON(geo) {
        const misb = this.in.misb;
        misb.selectSourceColumns(this._columns);
        var points = misb.misb.length
        const id = this.id;
        for (let slot = 0; slot < points; slot++) {
            geo.addPoint(id, misb.getLat(slot), misb.getLon(slot), misb.getAltMSL(slot), misb.getTime(slot))
        }
    }

    // export ALL the misb derived tracks as GEOJSON
    exportALLGEO(inspect=false) {
        if (inspect) {
            return {
                desc: "ALL GEOJason Export",
                json: "{... all the tracks in GeoJSON format ...}",
            }
        }
        const geo = new CGeoJSON();
        let name = "";
        NodeMan.iterate((key, node) => {
            if (node instanceof CNodeTrackFromMISB) {
                name += node.id + "_";
                node.addToGeoJSON(geo);
            }
        })

        const json = stringify(geo.json, {maxLength: 180, indent: 2})
        console.log("CNodeTrackFromMISB:exportGEOJSON(): json = ", json)
        saveAs(new Blob([json]), name+".json")
    }


    exportTrackCSV(inspect=false) {
       return this.exportArray(inspect);
    }


    patchColumn(misb, column, test, defaultValue)
    {
        // first find the first valid value (if any)
        const points = misb.misb.length;
        let validValue;
        for (let slot = 0; slot < points; slot++) {
            const value = misb.misb[slot][column]
            if (value !== undefined && value !== null) {
                const valueNumber = Number(value)
                // use only valid FOV values
                if (test(valueNumber)) {
                    validValue = value
//                    console.log("CNodeTrackFromMISB:recalculate(): FIRST validValue = " + validValue);
                    break
                }
            }
        }

        if (validValue === undefined) {
            if (defaultValue !== undefined) {
                validValue = defaultValue
            } else {
//                console.log(this.id + " CNodeTrackFromMISB:recalculate(): No valid patch values found, column = " + column);
                return false
            }
        }

        // // now go over all the slots, if invalid, then patch with validValue
        // // if valid, then update validValue
        for (let slot = 0; slot < points; slot++) {
            const value = misb.misb[slot][column]
            if (value !== undefined && value !== null) {
                const valueNumber = Number(value)
                // use only valid values, so if this is valid, we'll use it for subsequent invalid rows
                if (test(valueNumber)) {
                    validValue = value
                } else {
                    console.log("Replacing invalid "+column + " value: " + value + " with validValue = " + validValue)
                    misb.misb[slot][column] = validValue;
                }
            } else {
                misb.misb[slot][column] = validValue;
            }

          //  console.log("CNodeTrackFromMISB:recalculate(): slot = " + slot + " misb.misb[slot][column] = " + misb.misb[slot][column]);
        }
        return (validValue !== undefined)
    }
    

    // the data track is no more, and now we will make this direcly from the MISB data
    // and add gettor function to the MISB data node in CNodeMISBData.js
    // start with the postin and FOV.

    recalculate() {
       // var startTime = this.in.startTime.getStartTimeString()
        let msStart = this.in.startTime.getStartTimeValue()

        if (this.frameRelativeTime) {
            // tracks that have a fixed start time used the first time they were calculated
            // this ensure they don't move around if the start time changes
            if (this.fixedStartTime !== undefined) {
                // if we have a fixed start time, use that instead
                msStart = this.fixedStartTime;
            } else {
                this.fixedStartTime = msStart; // cache it for later use
            }
        }



        const misb = this.in.misb;
        misb.selectSourceColumns(this._columns);

        this.array = [];
        this.frames = Sit.frames;
        this.useSitFrames = true; // flag to say we need recalculate if Sit.frames changes

        // Re-cache values when AGL is used, as elevation may have changed
        if (misb.useAGL) {
            this.cacheValues();
        }

        assert(this.frames === Math.floor(this.frames),`Frames must be an integer, it's ${this.frames}`)

     //   const data = this.in.timedData.data;

        // now find the first time pair that our start time falls in

//        console.log("Start time: "+ startTime+" = "+msStart+" ms")
        var points = misb.misb.length
        assert(points > 1, "Not enough data to make a track for " + this.id)
        var slot = 0;
        var msNeeded = Sit.frames*Sit.fps*1000;
        var msEnd = msStart+msNeeded
        var frameTime = 0 // keep count for time for this frame in seconds


        // patch the fov values in the misb column, overwriting any ilegal or missing values

        // EXTRACT as not changing
        let validFOV = this.patchColumn(misb, MISB.SensorVerticalFieldofView,
            (n) => {return !isNaN(n) && n > 0 && n < 180;}
        )

        let validWindDirection = this.patchColumn(misb, MISB.WindDirection,
            (n) => {return !isNaN(n) && n >= 0 && n < 360}
        )

        let validWindSpeed = this.patchColumn(misb, MISB.WindSpeed,
            (n) => {return !isNaN(n) && n >= 0 && n < 400} // 400 knots is a bit much, but it's a reasonable limit
        )


        const rSitLat = Sit.lat * Math.PI / 180
        const rSitLon = Sit.lon * Math.PI / 180

        // convert ECEF (ecefX, ecefY, ecefZ) to ENU (east, north, up)
        const cosSitLat = Math.cos(rSitLat)
        const sinSitLat = Math.sin(rSitLat)
        const cosSitLon = Math.cos(rSitLon)
        const sinSitLon = Math.sin(rSitLon)

        const lon1 = rSitLon
        const lat1 = rSitLat




        // Pre-compute ellipsoid constants for per-vertex ECEF conversion
        const eqR = Globals.equatorRadius;
        const polR = Globals.polarRadius;
        const _e2 = (eqR * eqR - polR * polR) / (eqR * eqR);
        const _ratio = (polR * polR) / (eqR * eqR);

        // Resolve a terrain node once if we'll need it. AGL paths route through
        // the inherited per-frame elevation cache (CNodeTrack.getPointBelowCached)
        // for two reasons: (1) lookups are O(1) hash hits after the cache fills,
        // and (2) the cache is serialized in modSerialize, so reloading a sitch
        // gives correct ground altitudes immediately — eliminating the load-order
        // race where elevationAtLL() returned a too-low value because terrain
        // tiles for the track region hadn't built yet at first recalculate.
        const useAGLPath = misb.isTerrainDependent();
        const terrainNode = useAGLPath ? this._resolveTerrainNode() : null;

        // If frame count changed (e.g., Sit.frames updated), drop a stale cache
        // rather than risk frame-vs-cache index drift.
        if (this.elevationCache && this.elevationCache.length !== Sit.frames) {
            this.elevationCache = null;
        }

        // PES-PTS-based KLV lookup (MISB ST 0604 synchronous-mode pairing).
        // When the KLV substream came through Sitrec's TS demuxer, every
        // KLV record retains the PES PTS the encoder stamped on it, on the
        // same PCR-locked timeline as the video frame PTS values. Pairing
        // by PES PTS gives the per-frame association the standard intends
        // — eliminates wall-clock vs. encoder-clock divergence entirely,
        // including the gap-stretch issue that affects this kind of file.
        // Falls back to the wall-clock-based lookup when either side lacks
        // PES timing (KLV from a flat .klv file, image-source video, etc.).
        let usePESPTS = false;
        let pesTimeArray = null;
        const videoView = NodeMan.get("video", false);
        const videoData = videoView?.videoData;
        // Two conditions for PES PTS pairing to be valid:
        //   1. The video's framePTSus is real (from PES headers) — not synthetic
        //      uniform i × frameDuration. Synthetic stamps lie about dropped-frame
        //      timing, which silently corrupts pairing past the first frame loss.
        //   2. The KLV records have PES PTS too (from a TS-demuxed sync-mode source).
        // Without (1) we'd be matching real KLV PCR timestamps to a fake video
        // timeline; without (2) we have no per-record PCR anchor on the KLV side.
        const ptsAvailable = videoData &&
            typeof videoData.getFrameTimeMs === "function" &&
            videoData.getFrameTimeMs(0) !== null &&
            (typeof videoData.hasRealFramePTS !== "function" || videoData.hasRealFramePTS());
        if (ptsAvailable && this.in.misb.hasRecordPTS && this.in.misb.hasRecordPTS()) {
            // KLV pesPTSus is already shifted to share the video's PCR
            // origin (parseKLVFile subtracts videoFirstPESus when the TS
            // demuxer provides it). So values are "ms since first video
            // frame on the PCR clock," matching the normalized
            // framePTSus axis. Negative values are valid — they indicate
            // KLV records emitted *before* video frame 0, which the
            // binary search handles correctly.
            pesTimeArray = new Array(points);
            for (let i = 0; i < points; i++) {
                const us = this.in.misb.misb.pesPTSus[i];
                pesTimeArray[i] = (typeof us === "number") ? us / 1000 : null;
            }
            // Require monotonically increasing PES PTS values for binary
            // search to work. If any are null/non-monotonic, abandon the
            // PES path and fall back to wall-clock.
            let monotonic = true;
            for (let i = 1; i < points; i++) {
                if (pesTimeArray[i] === null || pesTimeArray[i-1] === null ||
                    pesTimeArray[i] < pesTimeArray[i-1]) {
                    monotonic = false; break;
                }
            }
            if (monotonic) {
                usePESPTS = true;
                const wrappedTag = (videoData && typeof videoData.getPatchStats === "function") ? " [wrapped]" : "";
                console.log(`CNodeTrackFromMISB(${this.id}): using MISB ST 0604 PES PTS pairing${wrappedTag} for ${points} records (klv span ${(pesTimeArray[points-1]/1000).toFixed(3)}s)`);
            } else {
                console.warn(`CNodeTrackFromMISB(${this.id}): PES PTS not monotonic; falling back to wall-clock lookup`);
            }
        }

        // Reference array used by the binary search / interpolation. Either
        // the existing UnixTimeStamp-based timeArray (wall-clock path) or
        // the PES-PTS-derived array (synchronous-mode path).
        const lookupTimes = usePESPTS ? pesTimeArray : this.timeArray;

        // Cache the first video PTS for relative-to-stream-start computation
        // in PES mode. framePTSus is already normalized to start at 0 in the
        // WebCodec pipeline, but we subtract explicitly to be safe against
        // any future change.
        const videoFirstPTSus = (usePESPTS && videoData.framePTSus) ? videoData.framePTSus[0] : 0;

        // Use real per-frame video PTS in the wall-clock path too, when available.
        // Without this, msNow advances at synthetic frame/fps rate even when the
        // video had dropped-frame jumps (real PTS is non-uniform). Looking up KLV
        // by synthetic time then mis-pairs frames after every burst — which
        // visually presents as the sim lagging the video by the cumulative
        // dropped-frame interval. With real PTS, msNow advances with real PCR
        // time even when the KLV has no PES PTS.
        const useRealVideoPTSForWallClock = !usePESPTS &&
            videoData &&
            typeof videoData.hasRealFramePTS === "function" &&
            videoData.hasRealFramePTS() &&
            Array.isArray(videoData.framePTSus);
        const wallClockVideoFirstPTSus = useRealVideoPTSForWallClock ? videoData.framePTSus[0] : 0;
        if (useRealVideoPTSForWallClock) {
            console.log(`CNodeTrackFromMISB(${this.id}): using real video PTS for wall-clock pairing (KLV has no PES PTS, video does)`);
        }

        for (var f=0;f<Sit.frames;f++) {
            // For PES-PTS mode, msNow is the video frame's PTS in ms,
            // relative to the first frame — same origin as pesTimeArray.
            // For wall-clock mode it's msStart + real-video-PTS-since-start
            // (or synthesized frame_time if real PTS unavailable).
            var msNow;
            if (usePESPTS) {
                const us = videoData.framePTSus[f];
                if (typeof us === "number") {
                    msNow = (us - videoFirstPTSus) / 1000;
                } else {
                    msNow = msStart + Math.floor(frameTime * 1000);
                }
            } else if (useRealVideoPTSForWallClock) {
                const us = videoData.framePTSus[f];
                if (typeof us === "number") {
                    msNow = msStart + (us - wallClockVideoFirstPTSus) / 1000;
                } else {
                    msNow = msStart + Math.floor(frameTime * 1000);
                }
            } else {
                msNow = msStart + Math.floor(frameTime*1000);
            }
            // advance the slot if needed
            while (slot < points-1) {
                // we need at least two good consecutive slots
                if (this.validArray[slot] && this.validArray[slot+1]) {
                    const nextDataTime = lookupTimes[slot + 1];
                    if (nextDataTime > msNow) {
                        break
                    }
                }
                slot++;
            }

          //  if (slot < points-1) {

              if (slot < points-1) {
                  // for the in-range slots, check the time is increasing
                  // which means the data is good and we can interpolate
                  assert(lookupTimes[slot + 1] > lookupTimes[slot], "Time data is not increasing slot =" + slot + " time=" + lookupTimes[slot] + " next time=" + lookupTimes[slot+1]);
              } else {
                  // use the last two slots and interpolate (extrapolate) the position
                  slot = points - 2

              }


            // is either is invalid, then go back until we find a valid pair
            // this should only kick in at the end of the track
            while ((!this.validArray[slot] || !this.validArray[slot+1]) && slot > 0) {
                slot--
            }

            // note the extrapolation will work for slot <0 as well as slot > points-1
            // however we might want to do something different for out or range
            // as the first and last pairs of data points might not be good

            assert(this.validArray[slot], "slot " + slot + " is not valid, id=" + this.id)
            assert(this.validArray[slot+1], "slot+1 " + (slot+1) + " is not valid, id=" + this.id)


            assert(lookupTimes[slot+1] > lookupTimes[slot], "Time data is not increasing slot =" + slot + " time=" + lookupTimes[slot] + " next time=" + lookupTimes[slot+1]);

           // assert(slot < points, "not enough data, or a bug in your code - Time wrong? id=" + this.id)
            const fraction = (msNow - lookupTimes[slot]) / (lookupTimes[slot + 1] - lookupTimes[slot])

     //       assert(fraction >= 0 && fraction <= 1, "CNodeTrackFromMISB:recalculate(): fraction out of range: " + fraction + " slot = " + slot + " msNow = " + msNow + " timeArray[slot] = " + this.timeArray[slot] + " timeArray[slot+1] = " + this.timeArray[slot+1] + " id=" + this.id)

            const lat = interpolate(this.latArray[slot], this.latArray[slot +1], fraction);
            const lon = interpolate(this.lonArray[slot], this.lonArray[slot +1], fraction);

            let pos;
            let alt;
            if (useAGLPath && terrainNode) {
                // Cached AGL path. Probe the cache to get the ground point at
                // (lat, lon) plus the per-frame AGL offset. The cache hands out
                // monotonic-upgrade values (always the highest-zoom terrain seen),
                // and is persisted across saves — so this branch is deterministic
                // even on a cold reload before any terrain tile finishes building.
                const aglOffset = this._aglOffsetForFrame(misb, slot, fraction);
                const probe = LLAToECEF(lat, lon, 0);
                pos = this.getPointBelowCached(terrainNode, probe, aglOffset, f);
                // Recover HAE altitude for diagnostics / lla[] export.
                const lla = ECEFToLLAVD_radii(pos);
                alt = lla.z;
            } else {
                // Non-AGL path (or terrain not yet available). MSL altitude from
                // the column data, converted to HAE via geoid offset. Inlined
                // ECEF math to keep this hot loop tight for KML/aircraft tracks.
                // SensorTrueAltitude is MSL (orthometric); convert to HAE (h = H + N).
                const altMSL = misb.adjustAlt(interpolate(this.rawAltArray[slot], this.rawAltArray[slot +1], fraction), lat, lon);
                alt = altMSL + meanSeaLevelOffset(lat, lon);

                const rLat = lat * Math.PI / 180
                const rLon = lon * Math.PI / 180
                const cosLat = Math.cos(rLat)
                const sinLat = Math.sin(rLat)
                const cosLon = Math.cos(rLon)
                const sinLon = Math.sin(rLon)
                const N = eqR / Math.sqrt(1 - _e2 * sinLat * sinLat);

                const ecefX = (N + alt) * cosLat * cosLon;
                const ecefY = (N + alt) * cosLat * sinLon;
                const ecefZ = (_ratio * N + alt) * sinLat;

                pos = new Vector3(ecefX, ecefY, ecefZ);
            }
            // const posY = pos.y;
            // pos.y = pos.z;
            // pos.z = -posY;
            //const pos = new Vector3(ecef_enu.x, ecef_enu.z, -ecef_enu.y)


            // end expanded LLAToECEF
            ///////////////////////////////////////////////////////////////////////



            // end product, a per-frame array of positions
            // that is a track.

            assert(!Number.isNaN(pos.x),"CNodeTrackFromMISB:recalculate(): pos.x NaN " + "lat = " + lat + " lon = " + lon + " alt = " + alt)

            // minumum data that is needed (no clone need as it's done in the expanded LLAToECEF)
            const product = {position: pos, lla:[lat,lon,alt]}

            // // uniterpolated extra fields
            // const extraFields = [
            //     "focal_len",
            //     "heading",
            //     "pitch",
            //     "roll",
            //     "gHeading",
            //     "gPitch",
            //     "gRoll",
            // ]

            // only copy the vFov if it's actually there
            // need this check for drag-and-drop
            if (validFOV) {
                const misbFOV = misb.misb[slot][MISB.SensorVerticalFieldofView]
                if (misbFOV !== undefined) {
                    const misbFOVNumber = Number(misbFOV)
                    // use only valid FOV values
                    if (!isNaN(misbFOVNumber) && misbFOVNumber > 0 && misbFOVNumber < 180) {
                        product["vFOV"] = misbFOVNumber;
//                        console.log("CNodeTrackFromMISB:recalculate(): product[\"vFOV\"] = ", product["vFOV"])
                    } else {
                        assert(0, "CNodeTrackFromMISB:recalculate(): invalid FOV value: " + misbFOV)
                    }
                }
            }

            // store the interpolated LLA for exporting
            product["lla"] = [lat,lon,alt];

            // we store a reference to the misb row for later use
            // so we can extract other data from it as needed
            product["misbRow"] = misb.misb[slot];


            this.array.push(product)

            frameTime += Sit.simSpeed/Sit.fps
        }


    }

}




