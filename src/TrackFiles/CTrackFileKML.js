import {CTrackFile} from "./CTrackFile";
import {MISB, MISBFields} from "../MISBFields";
import {CustomManager, FileManager, NodeMan, Sit, Synth3DManager} from "../Globals";
import {timeStrToEpoch} from "../DateTimeUtils";
import {assert} from "../assert.js";
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
        const kml = this.data;
        if (kml.kml !== undefined && kml.kml.Folder !== undefined && kml.kml.Folder.Folder !== undefined) {
            const indexedTrack = kml.kml.Folder.Folder;
            if (Array.isArray(indexedTrack)) {
                return this.getValidIndexedTrackInFolder(indexedTrack, trackIndex + 1) !== null;
            }
        }
        return false;
    }

    getTrackCount() {
        const kml = this.data;
        if (kml.kml !== undefined && kml.kml.Folder !== undefined && kml.kml.Folder.Folder !== undefined) {
            const trackFolder = kml.kml.Folder.Folder;
            if (Array.isArray(trackFolder)) {
                let validCount = 0;
                for (let i = 0; i < trackFolder.length; i++) {
                    if (trackFolder[i].Placemark !== undefined) {
                        validCount++;
                    }
                }
                return validCount;
            }
        }
        return 1;
    }

    extractObjects() {
        this.extractKMLObjectsInternal(this.data);
    }

    getKMLTrackWhenCoord(kml, trackIndex, when, coord, info) {
        if (info === undefined) {
            info = {}
        }

        if (kml.kml.Document !== undefined) {
            if (kml.kml.Document.Folder !== undefined && Array.isArray(kml.kml.Document.Folder)) {
                const route = kml.kml.Document.Folder[0]
                if (route && route.name && route.name["#text"] === "Route") {
                    if (when === undefined) {
                        console.log("FR24 KML track detected")
                        return true;
                    }
                    info.name = kml.kml.Document.name && kml.kml.Document.name["#text"] || "FR24 Track";
                    const p = route.Placemark
                    for (let i=0;i<p.length;i++) {
                        const date = p[i].TimeStamp.when["#text"]

                        if (i>0 && p[i].TimeStamp.when["#text"] === p[i-1].TimeStamp.when["#text"]) {
                            console.warn("getKMLTrackWhenCoord: FR24 Duplicate time "+p[i].TimeStamp.when["#text"])
                            continue;
                        }

                        when.push(timeStrToEpoch(date))

                        const c = p[i].Point.coordinates["#text"]
                        const cs = c.split(',')
                        const lon = Number(cs[0])
                        const lat = Number(cs[1])
                        const alt = Number(cs[2])
                        coord.push({lat: lat, lon: lon, alt: alt})
                    }

                    return true;

                }
            }
        }

        let tracks;

        if (kml.kml.Document !== undefined) {
            if (Array.isArray(kml.kml.Document.Placemark)) {
                tracks = [kml.kml.Document.Placemark[2]]
                info.name = kml.kml.Document.name["#text"].split(" ")[2];
            } else {
                if (kml.kml.Document.Placemark !== undefined) {
                    tracks = [kml.kml.Document.Placemark]
                    info.name = kml.kml.Document.Placemark.name["#text"];
                }
            }
        } else if (kml.kml.Folder !== undefined) {
            if (kml.kml.Folder.Folder !== undefined) {
                let trackFolder = kml.kml.Folder.Folder
                tracks = trackFolder.Placemark;

                if (Array.isArray(trackFolder)) {
                    console.log("Multiple Track ADSB-Exchange, using index "+trackIndex)

                    const possibleTrack = this.getValidIndexedTrackInFolder(trackFolder, trackIndex);
                    if (!possibleTrack) {
                        console.log("Reached end of getKMLTrackWhenCoord, for track index "+trackIndex+", but found no valid track")
                        return false;
                    }
                    trackFolder = possibleTrack;
                    tracks = possibleTrack.Placemark;

                }

                if (!tracks) {
                    console.log("Reached end of getKMLTrackWhenCoord, for track index "+trackIndex+", but found no valid track")
                    return false;
                }

                info.name = trackFolder.name["#text"].split(" ")[0];
            } else {
                assert(0, "Unknown KML format - no Document or Folder.Folder")
                tracks = kml.kml.Folder.Placemark;
            }
        } else {
            console.log("KML has no Document or Folder - may contain only overlays or other non-track data");
            return false;
        }

        if (tracks === undefined) {
            console.warn("getKMLTrackWhenCoord: No tracks in KML file ")
            return false;
        }

        if (info.name === undefined || info.name === "") {
            info.name = "Unnamed Track";
        }

        if (!Array.isArray(tracks)) {
            tracks = [tracks]
        }

        if (when === undefined) {
            if (tracks[0]["gx:Track"] === undefined) {
                console.warn("getKMLTrackWhenCoord: No gx:Track in KML file ")
                return false;
            }

            return true;
        }

        tracks.forEach(track => {
            assert(track !== undefined, "Missing track in KML")
            assert(track["gx:Track"] !== undefined, "No gx:Track in KML");
            assert(track["gx:Track"].when !== undefined, "No gx:Track.when in KML");
            assert(track["gx:Track"]["gx:coord"] !== undefined, "No gx:Track.gx:coord in KML");

            const gxTrack = track["gx:Track"];
            let whenArray;
            let coordArray;
            whenArray = gxTrack["when"]
            coordArray = gxTrack["gx:coord"]
            const len = whenArray.length;
            for (let i = 0; i < len; i++) {

                if (i>0 && whenArray[i]["#text"] === whenArray[i-1]["#text"]) {
                    continue;
                }

                const w = whenArray[i]["#text"]
                const c = coordArray[i]["#text"]
                const cs = c.split(' ')
                const lon = Number(cs[0])
                const lat = Number(cs[1])
                const alt = Number(cs[2])

                when.push(timeStrToEpoch(w))

                coord.push({lat: lat, lon: lon, alt: alt})
            }
        })

        return true;
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
        const coordStrClean = coordStr.trim()
        const coords = coordStrClean.split(' ')
        const coordArray = []
        for (let i = 0; i < coords.length; i++) {
            const c = coords[i].split(',')
            const lon = Number(c[0])
            const lat = Number(c[1])
            const alt = Number(c[2])
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
            // KML "absolute" altitude is HAE per spec (OGC KML 2.3, §9.1.3.8)
            // altitudeReference defaults to "HAE" which is correct for KML
            const trackOb = new CNodeTrackFromLLAArray({
                id: id,
                altitudeMode: altitudeMode,
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
