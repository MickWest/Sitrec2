import {CTrackFile} from "./CTrackFile";
import {MISB, MISBFields} from "../MISBFields";
import {CustomManager, FileManager, NodeMan, Sit, Synth3DManager} from "../Globals";
import {timeStrToEpoch} from "../DateTimeUtils";
import {CNodeTrackFromLLAArray} from "../nodes/CNodeTrack";
import {CNodeDisplayTrack} from "../nodes/CNodeDisplayTrack";
import * as LAYERS from "../LayerMasks";
import {FeatureManager} from "../CFeatureManager";

export class CTrackFileKML extends CTrackFile {
    static canHandle(filename, data) {
        if (!data || typeof data !== 'object') {
            return false;
        }
        try {
            return !!data.kml;
        } catch (e) {
            return false;
        }
    }

    doesContainTrack() {
        const valid = this.getKMLTrackWhenCoord(this.data, 0);
        return valid;
    }

    toMISB(trackIndex = 0) {
        const _times = [];
        const _coord = [];
        const info = {};
        const success = this.getKMLTrackWhenCoord(this.data, trackIndex, _times, _coord, info);

        if (!success) {
            console.warn("KMLToMISB: No track in KML file for index" + trackIndex);
            return false;
        }

        const misb = [];
        for (let i = 0; i < _times.length; i++) {
            misb[i] = new Array(MISBFields);
            misb[i][MISB.UnixTimeStamp] = _times[i];
            misb[i][MISB.SensorLatitude] = _coord[i].lat;
            misb[i][MISB.SensorLongitude] = _coord[i].lon;
            misb[i][MISB.SensorTrueAltitude] = _coord[i].alt;
        }
        return misb;
    }

    getShortName(trackIndex = 0, trackFileName = "") {
        const _times = [];
        const _coord = [];
        const info = {};
        this.getKMLTrackWhenCoord(this.data, trackIndex, _times, _coord, info);
        
        // NOTE: This extracts the track name from inside the KML file structure.
        // Previously, names were only extracted via regex patterns below, and if those
        // failed, tracks were named like "track_<ID>" based on the file/index.
        // This change means tracks may now get different (file-derived) names, which
        // could break older sitches or serialized data that referenced the old ID-based names.
        let shortName = info.name || "Unnamed Track";
        let found = false;

        const kml = this.data;

        if (kml.kml !== undefined && kml.kml.Folder !== undefined && kml.kml.Folder.Folder !== undefined) {
            let indexedTrack = kml.kml.Folder.Folder;
            if (Array.isArray(indexedTrack)) {
                indexedTrack = this.getValidIndexedTrackInFolder(indexedTrack, trackIndex);
                if (!indexedTrack && trackFileName) {
                    shortName = trackFileName + "_" + trackIndex;
                    found = true;
                }
            }

            if (indexedTrack && indexedTrack.name !== undefined) {
                let match;
                if (Sit.allowDashInFlightNumber) {
                    match = indexedTrack.name['#text'].match(/([A-Z0-9\-]+) track/);
                } else {
                    match = indexedTrack.name['#text'].match(/([A-Z0-9]+) track/);
                }
                if (match !== null) {
                    shortName = match[1];
                    found = true;
                }
            }
        }

        if (!found) {
            if (kml.kml !== undefined
                && kml.kml.Document !== undefined
                && kml.kml.Document.name !== undefined
                && kml.kml.Document.name['#text'] !== undefined) {
                const name = kml.kml.Document.name['#text'];
                const match = name.match(/FlightAware ✈ ([A-Z0-9]+) /);
                if (match !== null) {
                    shortName = match[1];
                    found = true;
                } else {
                    const match2 = name.match(/([A-Z0-9]+)\/[A-Z0-9]+/);
                    if (match2 !== null) {
                        shortName = match2[1];
                        found = true;
                    } else {
                        shortName = name;
                        found = true;
                    }
                }
            }
        }

        return shortName;
    }

    hasMoreTracks(trackIndex = 0) {
        return (trackIndex + 1) < this.extractTrackGroups().length;
    }

    getTrackCount() {
        return this.extractTrackGroups().length;
    }

    // KML tracks are always distinct aircraft, never FrameCenter-style supplementaries.
    isSupplementaryTrack(_trackIndex) {
        return false;
    }

    extractObjects() {
        this.extractKMLObjectsInternal(this.data);
    }

    // ---- Generic tree-walk track extraction --------------------------------------------
    // Collect every (time, lon, lat, alt) sample from any time+geometry pairing, at any folder
    // depth, grouping samples into tracks by enclosing-container identity. This subsumes the old
    // shape-specific branch ladder (FR24 Route, FlightAware Placemark[2], ADSBx Folder.Folder,
    // single-Document, and the Folder>Placemark fallback) AND additionally handles tracks in deep
    // sub-folders, multiple data sources in one file, <gx:MultiTrack>, and <TimeSpan>. The exact
    // sample set + per-segment / per-sequence consecutive-duplicate-time dedup of the old branches
    // is preserved (locked by the geometry-parity tests).

    asArray(x) {
        return (x === undefined || x === null) ? [] : (Array.isArray(x) ? x : [x]);
    }

    textOf(node, key) {
        if (node === undefined || node === null) return undefined;
        const v = node[key];
        if (v === undefined) return undefined;
        const item = Array.isArray(v) ? v[0] : v;
        return item ? item["#text"] : undefined;
    }

    // Samples from one <gx:Track>: paired <when>/<gx:coord> (space-separated "lon lat alt"),
    // skipping a sample whose <when> string equals the immediately preceding array element
    // (matches the historical per-segment dedup at the old line 273).
    samplesFromGxTrack(gxTrack) {
        const whenArr = this.asArray(gxTrack["when"]);
        const coordArr = this.asArray(gxTrack["gx:coord"]);
        const len = whenArr.length;
        const out = [];
        for (let i = 0; i < len; i++) {
            if (i > 0 && whenArr[i] && whenArr[i - 1] && whenArr[i]["#text"] === whenArr[i - 1]["#text"]) continue;
            const w = whenArr[i] ? whenArr[i]["#text"] : undefined;
            const c = coordArr[i] ? coordArr[i]["#text"] : undefined;
            const cs = (c === undefined ? "" : c).split(' ');
            out.push({t: timeStrToEpoch(w), lon: Number(cs[0]), lat: Number(cs[1]), alt: Number(cs[2])});
        }
        return out;
    }

    // One sample from a Placemark carrying a DIRECT time primitive (<TimeStamp><when> or
    // <TimeSpan><begin>) plus a <Point> (comma-separated "lon,lat,alt"). Returns null when there
    // is no usable direct time+point — e.g. FR24 Trail segments (MultiGeometry, no TimeStamp),
    // static shapes, or a time primitive nested in <LookAt>/<Camera> (which must NOT count, and
    // does not, since we only read direct children).
    sampleFromTimedPlacemark(pm) {
        const whenText = this.textOf(pm["TimeStamp"], "when") ?? this.textOf(pm["TimeSpan"], "begin");
        if (whenText === undefined) return null;
        const coordText = this.textOf(pm["Point"], "coordinates");
        if (coordText === undefined) return null;
        const cs = coordText.split(',');
        return {whenText, t: timeStrToEpoch(whenText), lon: Number(cs[0]), lat: Number(cs[1]), alt: Number(cs[2])};
    }

    // Walk the parsed tree → ordered track groups (memoized; this.data is immutable per instance).
    // Each group = { samples:[{t,lat,lon,alt}], placemarkName, folderName, documentName }.
    extractTrackGroups() {
        if (this._trackGroups !== undefined) return this._trackGroups;
        const root = this.data && this.data.kml;
        if (!root) return (this._trackGroups = []);
        const documentName = this.textOf(root.Document, "name") ?? this.textOf(root.Folder, "name");
        const groups = [];
        const byContainer = new Map();
        const ensureGroup = (container, folderName, placemarkName) => {
            let g = byContainer.get(container);
            if (!g) {
                g = {samples: [], folderName, placemarkName, documentName, _prevTimedWhen: undefined};
                byContainer.set(container, g);
                groups.push(g);
            } else if (g.placemarkName === undefined && placemarkName !== undefined) {
                g.placemarkName = placemarkName;
            }
            return g;
        };

        const visit = (container, folderName) => {
            for (const pm of this.asArray(container.Placemark)) {
                // gather <gx:Track> segments, directly or via <gx:MultiTrack>
                const segs = [];
                for (const mt of this.asArray(pm["gx:MultiTrack"])) {
                    for (const t of this.asArray(mt["gx:Track"])) segs.push(t);
                }
                for (const t of this.asArray(pm["gx:Track"])) segs.push(t);

                if (segs.length > 0) {
                    const g = ensureGroup(container, folderName, this.textOf(pm, "name"));
                    for (const seg of segs) {
                        const ss = this.samplesFromGxTrack(seg);
                        for (const s of ss) g.samples.push(s);
                    }
                    continue;
                }

                const ts = this.sampleFromTimedPlacemark(pm);
                if (ts) {
                    const g = ensureGroup(container, folderName, this.textOf(pm, "name"));
                    // consecutive-duplicate-time skip across the placemark sequence (matches the
                    // historical FR24 dedup at the old line 171)
                    if (ts.whenText !== undefined && ts.whenText === g._prevTimedWhen) {
                        g._prevTimedWhen = ts.whenText;
                    } else {
                        g._prevTimedWhen = ts.whenText;
                        g.samples.push({t: ts.t, lat: ts.lat, lon: ts.lon, alt: ts.alt});
                    }
                }
                // else: no usable time+geometry → static shape (extractKMLObjectsInternal handles it)
            }
            for (const fld of this.asArray(container.Folder)) visit(fld, this.textOf(fld, "name"));
            for (const doc of this.asArray(container.Document)) visit(doc, this.textOf(doc, "name"));
        };

        visit(root, undefined);
        return (this._trackGroups = groups.filter(g => g.samples.length > 0));
    }

    getKMLTrackWhenCoord(kml, trackIndex, when, coord, info) {
        if (info === undefined) info = {};
        const groups = this.extractTrackGroups();
        if (trackIndex < 0 || trackIndex >= groups.length) return false;
        const g = groups[trackIndex];
        // BACK-COMPAT: seed info.name with the EXACT value the old shape-specific branches
        // produced, so getShortName (unchanged) yields byte-identical names and no saved sitch
        // keyed on Track_<name> is orphaned. (Verified by the full-corpus name parity diff.)
        // The Phase-4 name registry will replace this seed behind a version gate.
        info.name = this.legacyTrackName(trackIndex) || "Unnamed Track";
        if (when === undefined) return true;     // probe mode: a track exists at this index
        for (const s of g.samples) {
            when.push(s.t);
            coord.push({lat: s.lat, lon: s.lon, alt: s.alt});
        }
        return true;
    }

    // Reproduces the historical `info.name` assignment from the old branch ladder, used only as
    // getShortName's seed/fallback. Kept faithful (incl. the `.split(' ')[0]`/`[2]` quirks) so
    // names don't drift across the refactor. Index mapping matches getValidIndexedTrackInFolder
    // (the same document-order folder counting the new grouping uses).
    legacyTrackName(trackIndex) {
        const kml = this.data;
        const D = kml.kml.Document;
        if (D !== undefined) {
            if (D.Folder !== undefined && Array.isArray(D.Folder)
                && D.Folder[0] && D.Folder[0].name && D.Folder[0].name["#text"] === "Route") {
                return (D.name && D.name["#text"]) || "FR24 Track";   // FR24
            }
            if (Array.isArray(D.Placemark)) {
                return D.name && D.name["#text"] && D.name["#text"].split(" ")[2];   // FlightAware
            }
            if (D.Placemark !== undefined) {
                return D.Placemark.name && D.Placemark.name["#text"];   // single Document
            }
        } else if (kml.kml.Folder !== undefined) {
            if (kml.kml.Folder.Folder !== undefined) {
                let tf = kml.kml.Folder.Folder;   // ADSBx
                if (Array.isArray(tf)) tf = this.getValidIndexedTrackInFolder(tf, trackIndex);
                return tf && tf.name && tf.name["#text"] && tf.name["#text"].split(" ")[0];
            }
            // Folder>Placemark fallback: old code left info.name unset (-> "Unnamed Track")
        }
        return undefined;
    }

    getValidIndexedTrackInFolder(trackFolder, trackIndex) {
        const numTracks = trackFolder.length;
        let validTracks = 0;
        let possibleTrack = null;
        for (let i=0;i<numTracks;i++) {
            possibleTrack = trackFolder[i];
            if (possibleTrack.Placemark !== undefined) {
                validTracks++;
                if (validTracks-1 === trackIndex) {
                    return possibleTrack;
                }
            }
        }
        return null;
    }

    extractKMLObjectsInternal(root, kml=root, depth=0) {
        const defaultStyle = {
            LineStyle: {
                color: {"#text": "ffffffff"},
            },
            PolyStyle: {
                color: {"#text": "ffc0c0c0"},
            }
        };

        let style = defaultStyle;
        let name = "";

        if (kml.styleUrl !== undefined) {
            style = this.getKMLStyle(root, kml.styleUrl["#text"].substring(1), defaultStyle);
        }

        if (kml.name !== undefined) {
            name = kml.name["#text"];
        }

        for (let [key, value] of Object.entries(kml)) {
            if (key === "Folder" && Array.isArray(value) && value.length === 2) {
                if (value[0].name["#text"] === "Route" && value[1].name["#text"] === "Trail") {
                    continue;
                }
            }

            if (key === "LineString") {
                this.extractKMLLineString(value, style, name)
            }
            else if (key === "Polygon") {
                this.extractKMLPolygon(value, style, name)
            }
            else if (key === "GroundOverlay") {
                this.extractKMLGroundOverlay(value, name)
            }
            else if (typeof value === 'object') {
                if (
                    value.name
                    && value.name["#text"]
                    && value.Point
                    && value.Point.coordinates
                ) {
                    const coords = this.extractCoordinates(value.Point)[0];

                    const id = NodeMan.getUniqueID(value.name["#text"]);
                    const ignoreID = value.name["#text"]+coords[0]+","+coords[1]+","+coords[2];
                    if (CustomManager.shouldIgnore(ignoreID)) {
                        console.log("Ignoring KML Point feature "+ignoreID);
                    } else {

                        FeatureManager.addFeature({
                            id: id,
                            text: value.name["#text"],
                            positionLLA: {lat: coords[0], lon: coords[1], alt: coords[2]},
                        })

                        CustomManager.ignore(ignoreID)
                    }

                } else if (value.LatLonBox) {
                    this.extractKMLGroundOverlay(value, name)
                } else {
                    this.extractKMLObjectsInternal(root, value, depth + 1)
                }
            }
        }
    }

    getKMLStyle(kml, id, defaultStyle, type="normal") {
        if (id.startsWith("#")) {
            id = id.substring(1);
        }

        if (kml.kml.Document !== undefined) {
            if (kml.kml.Document.Style !== undefined) {
                let styles = kml.kml.Document.Style;
                if (!Array.isArray(styles)) {
                    styles = [styles];
                }
                for (let style of styles) {
                    if (style.id === id) {
                        const result = {...defaultStyle, ...style};
                        return result;
                    }
                }
            }
        }

        if (kml.kml.Document !== undefined) {
            if (kml.kml.Document.StyleMap !== undefined) {
                let styleMaps = kml.kml.Document.StyleMap;
                if (!Array.isArray(styleMaps)) {
                    styleMaps = [styleMaps];
                }
                for (const key in styleMaps) {
                    const styleMap = styleMaps[key];
                    if (styleMap.id === id) {
                        for (const pairKey in styleMap.Pair) {
                            const pair = styleMap.Pair[pairKey];
                            if (pair.key["#text"] === type) {
                                const styleId = pair.styleUrl["#text"].substring(1);
                                return this.getKMLStyle(kml, styleId, defaultStyle);
                            }
                        }
                    }
                }
            }
        }
        return defaultStyle;
    }

    extractCoordinates(obj) {
        if (obj.coordinates === undefined) {
            return [];
        }
        const coordStr = obj.coordinates["#text"]
        // KML 2.2 spec: coordinate tuples are separated by any whitespace
        // (space, tab, CR, LF). Splitting on a single space breaks on
        // pretty-printed KML where each tuple is on its own line.
        const coords = coordStr.split(/\s+/).filter(s => s.length > 0)
        const coordArray = []
        for (let i = 0; i < coords.length; i++) {
            const c = coords[i].split(',')
            if (c.length < 2) continue;
            const lon = Number(c[0])
            const lat = Number(c[1])
            const alt = c.length >= 3 ? Number(c[2]) : 0
            if (isNaN(lat) || isNaN(lon) || isNaN(alt)) continue;
            coordArray.push([lat, lon, alt])
        }
        return coordArray;
    }

    extractKMLLineString(obj, style, name) {
        const altitudeMode = this.getText(obj, "altitudeMode")
        const coordinates  = this.extractCoordinates(obj)

        this.makeKMLDisplayTrack(coordinates, style, name, altitudeMode, false);
    }

    makeKMLDisplayTrack(coordinates, style, name, altitudeMode, showCap) {
        if (coordinates.length > 1) {
            let id = NodeMan.getUniqueID(name)
            // KML "absolute" altitude is MSL (EGM96 geoid) per OGC KML 2.2/2.3, matching
            // how the gx:Track import path treats it. Pass "MSL" so the +N geoid
            // conversion is applied on the way to ECEF. Ground-relative/clamped modes
            // use the altitude as a terrain offset, where no datum conversion applies.
            // (CNodeTrackFromLLAArray defaults a missing altitudeMode to "absolute",
            // so mirror that default when choosing the reference.)
            const effectiveAltitudeMode = altitudeMode ?? "absolute";
            const trackOb = new CNodeTrackFromLLAArray({
                id: id,
                altitudeMode: effectiveAltitudeMode,
                altitudeReference: effectiveAltitudeMode === "absolute" ? "MSL" : "HAE",
                showCap: showCap,
            })
            trackOb.setArray(coordinates);

            const lineColor = "#" + style.LineStyle.color["#text"]
            const polyColor = "#" + style.PolyStyle.color["#text"]

            const lineOpacity = parseInt(lineColor.substring(1, 3), 16) / 255
            const polyOpacity = parseInt(polyColor.substring(1, 3), 16) / 255

            const trackDisplay = new CNodeDisplayTrack({
                id: id + "-display",
                track: id,
                color: lineColor,
                dropColor: polyColor,
                lineOpacity: lineOpacity,
                polyOpacity: polyOpacity,
                width: 2,
                toGround: true,
                extendToGround: true,
                showCap: showCap,
                depthFunc: "LessDepth",
                depthWrite: true,
                layers: LAYERS.MASK_WORLD,
                minWallStep: 0,

            });

            trackOb.recalculateCascade()

        }
    }

    extractKMLPolygon(obj, style, name) {
        const altitudeMode = this.getText(obj, "altitudeMode")
        const coordinates = this.extractCoordinates(obj.outerBoundaryIs.LinearRing)
        this.makeKMLDisplayTrack(coordinates, style, name, altitudeMode, true);
    }

    extractKMLGroundOverlay(obj, name) {
        if (!Synth3DManager) {
            console.warn("Synth3DManager not available, skipping GroundOverlay");
            return;
        }

        const latLonBox = obj.LatLonBox;
        if (!latLonBox) {
            console.warn("GroundOverlay missing LatLonBox, skipping");
            return;
        }

        const north = latLonBox.north ? parseFloat(latLonBox.north["#text"]) : 0;
        const south = latLonBox.south ? parseFloat(latLonBox.south["#text"]) : 0;
        const east = latLonBox.east ? parseFloat(latLonBox.east["#text"]) : 0;
        const west = latLonBox.west ? parseFloat(latLonBox.west["#text"]) : 0;
        const rotation = latLonBox.rotation ? parseFloat(latLonBox.rotation["#text"]) : 0;

        let imageURL = "";
        let imageFileID = null;
        if (obj.Icon && obj.Icon.href) {
            const href = obj.Icon.href["#text"];
            // Check if this image was loaded from a KMZ file
            if (FileManager.kmzImageMap && FileManager.kmzImageMap[href]) {
                imageURL = FileManager.kmzImageMap[href];
                // Find the corresponding fileID for rehosting
                for (const id in FileManager.list) {
                    if (FileManager.list[id].kmzHref === href) {
                        imageFileID = id;
                        break;
                    }
                }
                console.log(`KML: Resolved href "${href}" to blobURL, fileID: ${imageFileID}`);
            } else {
                imageURL = href;
            }
        }

        const overlayName = obj.name ? obj.name["#text"] : name || "KML Overlay";

        const ignoreID = `overlay_${north}_${south}_${east}_${west}_${rotation}_${overlayName}`;
        if (CustomManager.shouldIgnore(ignoreID)) {
            console.log("Ignoring KML GroundOverlay " + ignoreID);
            return;
        }

        Synth3DManager.addOverlay({
            north: north,
            south: south,
            east: east,
            west: west,
            rotation: rotation,
            imageURL: imageURL,
            imageFileID: imageFileID,
            name: NodeMan.getUniqueID(overlayName, 18),
            gotoOnCreate: true,
            lockShape: true,
        });

        CustomManager.ignore(ignoreID);
        console.log(`Added KML GroundOverlay: ${overlayName}`);
    }

    getBoolean(obj, key) {
        if (obj[key] === undefined) {
            return false;
        }
        return obj[key]["#text"] === "1";
    }

    getText(obj, key) {
        if (obj[key] === undefined) {
            return "";
        }
        return obj[key]["#text"];
    }
}
