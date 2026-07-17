/**
 * Custom-sitch serialize/deserialize, including legacy mod remapping and permalink handling.
 *
 * Extracted from CustomSupport.js as a mixin. Methods are merged into
 * CCustomManager.prototype so `this` references the CCustomManager instance.
 */
import {
    addGUIFolder,
    FileManager,
    getEffectiveUserID,
    GlobalDateTimeNode,
    Globals,
    guiMenus,
    guiShowHideViews,
    infoDiv,
    NodeFactory,
    NodeMan,
    setNewSitchObject,
    setRenderOne,
    setSitchEstablished,
    Sit,
    Synth3DManager,
    TrackManager,
    UndoManager,
    Units,
    withTestUser
} from "./Globals";
import {isKeyHeld, toggler} from "./KeyBoardHandler";
import {ECEFToLLAVD_radii, LLAToECEF} from "./LLA-ECEF-ENU";
import {par} from "./par";
import {GlobalScene} from "./LocalFrame";
import {refreshLabelsAfterLoading} from "./nodes/CNodeLabels3D";
import {assert} from "./assert";
import {getShortURL} from "./urlUtils";
import {REMOVED_NODE_IDS} from "./RemovedNodes";
import {CNode3DObject, ModelAliases} from "./nodes/CNode3DObject";
import {UpdateHUD} from "./JetStuff";
import {degrees, getDateTimeFilename} from "./utils";
import {ViewMan} from "./CViewManager";
import {LayoutMan} from "./CLayoutManager";
import {EventManager} from "./CEventManager";
import {isAdmin, SITREC_APP, SITREC_SERVER} from "./configUtils";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {DebugArrowAB, elevationAtLL} from "./threeExt";
import {FeatureManager} from "./CFeatureManager";
import {CustomGraphManager} from "./CCustomGraphManager";
import {restoreStreetViewPanoFromMod} from "./StreetViewPanoUI";
import {CNodeTrackGUI} from "./nodes/CNodeControllerTrackGUI";
import {forceUpdateUIText} from "./nodes/CNodeViewUI";
import {configParams} from "./runtimeConfig";
import {showError} from "./showError";
import {showPostLoadFilterDialog} from "./TrackFilterDialog";
import {textSitchToObject} from "./RegisterSitches";
import {isResolvableSitrecReference} from "./SitrecObjectResolver";
import {fileSystemFetch} from "./fileSystemFetch";
import {waitForExportFrameSettled} from "./ExportFrameSettler";
import {parseObjectInput as parseObjectInputUtil} from "./utils/parseObjectInput";
import {initializeSettings, SettingsSaver} from "./SettingsManager";
import {CNodeCurveEditor2} from "./nodes/CNodeCurveEdit2";
import {CNodeViewDAG} from "./nodes/CNodeViewDAG";
import {CNodeNotes} from "./nodes/CNodeNotes";
import {createCustomModalWithCopy, saveFilePrompted, saveFileToDirectory, saveFileToHandle} from "./FileUtils";
import {deserializeMotionAnalysis, serializeMotionAnalysis} from "./CMotionAnalysisUI";
import {deserializeAutoTracking, serializeAutoTracking} from "./CObjectTracking";
import {deserializeHorizonExtractor, serializeHorizonExtractor} from "./CHorizonExtractor";
import {deserializeScriptedVideo, serializeScriptedVideo} from "./CScriptedVideo";
import {ScenarioManager} from "./CScenarioManager";
import {deserializeLongExposure, serializeLongExposure} from "./LongExposure";
import {getCursorPositionFromTopView} from "./mouseMoveView";
import {addMenuToLeftSidebar, addMenuToRightSidebar, isInLeftSidebar, isInRightSidebar} from "./PageStructure";
import {CNodeControllerCelestial} from "./nodes/CNodeControllerVarious";
import {CNodeAutoTrackLOS} from "./nodes/CNodeAutoTrackLOS";
import {CNodeVideoInfoUI} from "./nodes/CNodeVideoInfoUI";
import {CNodeOSDDataSeriesController} from "./nodes/CNodeOSDDataSeriesController";
import {CNodeGUIValue} from "./nodes/CNodeGUIValue";
import {meanSeaLevelOffset} from "./EGM96Geoid";
import {collectActiveTrackSourceFileIDs, shouldSerializeLoadedFileEntry} from "./trackSourceUtils";
import {buildAppFlightTrack, applyFlightLightweightGating} from "./fromApp.js";
import {encodeShareParam, resolveURLForFetch, toShareableCustomValue} from "./SitrecObjectResolver";
import {getEnvBool} from "./envUtils";
import {CNodeOrbitTrack} from "./nodes/CNodeOrbitTrack";
import {CNodeTrackSwitch} from "./nodes/CNodeTrackSwitch";
import {getNearbyWeatherBalloons, importSoundingDialog} from "./SondeFetch";
import {getCurrentLanguage, setLanguage, SUPPORTED_LANGUAGE_OPTIONS, t} from "./i18n";
import {CNodeSAPage} from "./nodes/CNodeSAPage";
import {
    gimbalStepAirTrack,
    gimbalStepAirTrackDisplay,
    gimbalStepClouds,
    gimbalStepCommonViews,
    gimbalStepCore,
    gimbalStepFleet,
    gimbalStepGraphs,
    gimbalStepSAHAFU,
    gimbalStepTargetModel,
    gimbalStepTrackLOSNodes,
    gimbalStepTraverse,
} from "./GimbalCustomSetup";
import {Color} from "three";

export const serializeMethods = {
    getCustomSitchString(local = false) {
        // the output object
        // since we are going to use JSON.stringify, then when it is loaded again we do NOT need
        // the ad-hox parse functions that we used to have
        // and can just use JSON.parse directly on the string
        // any existing one that loads already will continue to work
        // but this allows us to use more complex objects without updating the parser

        // process.env.VERSION is a string number like "1.0.0"
        // convert it into an integer like 10000


        assert(process.env.BUILD_VERSION_NUMBER !== undefined, "BUILD_VERSION_NUMBER must be defined in the environment");
        const versionParts = process.env.BUILD_VERSION_NUMBER.split('.').map(Number);
        const versionNumber = versionParts[0] * 1000000 + versionParts[1] * 1000 + versionParts[2];

        let out = {
            stringified: true,
            isASitchFile: true,
        }

        // merge in the current Sit object
        // which might have some changes?

        if (Sit.canMod) {
            // for a modded sitch, we just need to store the name of the sitch we are modding
            // plus any Sit-level properties that the user can change via the UI
            out = {
                ...out,
                modding: Sit.name,
                useEllipsoid: Sit.useEllipsoid,
            }

            // Serialize terrain UI overrides (buildings, etc.) for modded sitches.
            // checkForModding does a shallow merge, so this TerrainModel replaces the base sitch's.
            // We spread the original Sit.TerrainModel first to preserve base values.
            if (Sit.TerrainModel !== undefined && NodeMan.exists("terrainUI")) {
                const terrainModel = NodeMan.get("terrainUI");
                out.TerrainModel = {
                    ...Sit.TerrainModel,
                    showBuildings: terrainModel.showBuildings,
                    buildingsSource: terrainModel.buildingsSource,
                    showBuildingEdges: terrainModel.showBuildingEdges,
                    showTileEdges: terrainModel.showTileEdges,
                    showOceanSurface: terrainModel.showOceanSurface,
                    buildingsMaterialMode: terrainModel.buildingsMaterialMode,
                    buildingsFlatColor: terrainModel.buildingsFlatColor,
                }
            }
        }
        else {
            // but for a custom sitch, we need to store the whole Sit object (which automatically stores changes)
            out = {
                ...out,
                ...Sit
            }
        }

        // Serialize video state for any sitch with a video node
        // (applies to both custom and modded sitches like the video viewer)
        if (NodeMan.exists("video")) {
            console.log("Exporting: Found video node")
            const videoNode = NodeMan.get("video")

            // Serialize multiple videos if present
            if (videoNode.videos && videoNode.videos.length > 0) {
                videoNode.updateCurrentVideoEntry();
                const videosToExport = videoNode.videos.map(entry => {
                    const exported = {
                        fileName: entry.fileName,
                        isImage: entry.isImage || false
                    };
                    if (local && entry.localStaticURL) {
                        exported.staticURL = entry.localStaticURL;
                    } else if (entry.staticURL) {
                        exported.staticURL = entry.staticURL;
                    } else if (local && entry.fileName) {
                        exported.staticURL = entry.fileName;
                    }
                    if (entry.imageFileID) {
                        exported.imageFileID = entry.imageFileID;
                    }
                    return exported;
                });
                out.videos = videosToExport;
                out.currentVideoIndex = videoNode.currentVideoIndex;
                console.log("Exporting: videos array with", videosToExport.length, "entries");
            } else if (local && videoNode.localStaticURL) {
                console.log("Exporting: LOCAL Found video node with localStaticURL = ", videoNode.localStaticURL)
                out.videoFile = videoNode.localStaticURL;
            } else if (videoNode.staticURL) {
                // Fallback for legacy single video
                console.log("Exporting: Found video node with staticURL = ", videoNode.staticURL)
                out.videoFile = videoNode.staticURL;
            } else {
                console.log("Exporting: Found video node, but no staticURL")
                if (local && videoNode.fileName) {
                    console.log("Exporting: LOCAL Found video node with filename = ", videoNode.fileName)
                    out.videoFile = videoNode.fileName;
                }
            }
        } else {
            console.log("Exporting: No video node found")
        }

        // Serialize the secondary video view (twovid) the same way as the primary,
        // into videos2 / currentVideoIndex2 / videoFile2 so it round-trips on reload.
        // The view's own position/visibility round-trips via its view mod.
        if (NodeMan.exists("video2")) {
            const videoNode2 = NodeMan.get("video2");
            if (videoNode2.videos && videoNode2.videos.length > 0) {
                videoNode2.updateCurrentVideoEntry();
                out.videos2 = videoNode2.videos.map(entry => {
                    const exported = {
                        fileName: entry.fileName,
                        isImage: entry.isImage || false
                    };
                    if (local && entry.localStaticURL) {
                        exported.staticURL = entry.localStaticURL;
                    } else if (entry.staticURL) {
                        exported.staticURL = entry.staticURL;
                    } else if (local && entry.fileName) {
                        exported.staticURL = entry.fileName;
                    }
                    if (entry.imageFileID) {
                        exported.imageFileID = entry.imageFileID;
                    }
                    return exported;
                });
                out.currentVideoIndex2 = videoNode2.currentVideoIndex;
                console.log("Exporting: videos2 array with", out.videos2.length, "entries");
            } else if (local && videoNode2.localStaticURL) {
                out.videoFile2 = videoNode2.localStaticURL;
            } else if (videoNode2.staticURL) {
                out.videoFile2 = videoNode2.staticURL;
            }
        }

        if (Sit.isCustom) {

            // modify the terrain model directly, as we don't want to load terrain twice
            // For a modded sitch this has probably not changed
            if (out.TerrainModel !== undefined) {
                // note we now get these from the TerrainUI node
                // previously they were duplicated in both nodes, but now just in the TerrainUI node
                // the naming convention is to support historical saves.
                const terrainModel = NodeMan.get("terrainUI");
                out.TerrainModel = {
                    ...out.TerrainModel,
                    lat: terrainModel.lat,
                    lon: terrainModel.lon,
                    zoom: terrainModel.zoom,
                    nTiles: terrainModel.nTiles,
                    tileSegments: Globals.settings.tileSegments,  // Now always from global settings
                    mapType: terrainModel.mapType,
                    layer: terrainModel.layer,
                    elevationType: terrainModel.elevationType,
                    elevationScale: terrainModel.elevationScale,
                    dynamic: terrainModel.dynamic,
                    showBuildings: terrainModel.showBuildings,
                    buildingsSource: terrainModel.buildingsSource,
                    showBuildingEdges: terrainModel.showBuildingEdges,
                    showTileEdges: terrainModel.showTileEdges,
                    showOceanSurface: terrainModel.showOceanSurface,
                    buildingsMaterialMode: terrainModel.buildingsMaterialMode,
                    buildingsFlatColor: terrainModel.buildingsFlatColor,
                }
            }

            // the files object is the rehosted files
            // files will be reference in sitches using their original file names
            // we have rehosted them, so we need to create a new "files" object
            // that uses the rehosted file names
            // maybe special case for the video file ?
            let files = {}
            const activeTrackSourceFileIDs = collectActiveTrackSourceFileIDs(TrackManager);
            for (let id in FileManager.list) {
                const file = FileManager.list[id]

                // Skip files marked for no serialization (e.g. original NITF archives
                // replaced by converted products)
                if (file.skipSerialization) {
                    continue;
                }

                // The previous `!file.isMultiple` filter skipped TS-extracted
                // substreams on the assumption that the parent TS would be
                // re-uploaded and re-demuxed on load. Under the unified
                // persistence model the parent TS is dropped (skipSerialization
                // above) and substreams are the canonical persisted form, so
                // they MUST be included here. The skipSerialization gate above
                // catches the parent TS archive entry.
                if (!shouldSerializeLoadedFileEntry(id, file, activeTrackSourceFileIDs)) {
                    console.log("Skipping orphaned track source file from serialization:", id, file.filename);
                    continue;
                }
                if (local) {
                    // if we are saving locally, then we don't need to rehost the files
                    // so use localStaticURL if available, otherwise original filename
                    files[id] = file.localStaticURL || file.filename
                } else {
                    // Only include files that have been successfully rehosted
                    if (file.staticURL) {
                        files[id] = file.staticURL
                    } else if (!file.dynamicLink) {
                        // For non-dynamic links (external static URLs), use filename directly
                        // Note: External static URLs should have staticURL = filename set at load time,
                        // so this is primarily a defensive fallback
                        console.error("No static link, falling back to filename", id, file.filename);
                        files[id] = file.filename
                    } else {
                        console.warn("File not rehosted but should be - skipping:", id, file.filename);
                    }
                    // else: skip files without staticURL - they weren't rehosted
                }
            }
            out.loadedFiles = files;

            // Build metadata for files that need special handling on reload
            let filesMetadata = {};
            for (let id in FileManager.list) {
                const file = FileManager.list[id];
                if (file.dataType === "kmzImage") {
                    filesMetadata[id] = { dataType: file.dataType, kmzHref: file.kmzHref };
                } else if (file.dataType === "videoImage") {
                    filesMetadata[id] = { dataType: file.dataType };
                } else if (file.dataType === "groundOverlayImage") {
                    filesMetadata[id] = { dataType: file.dataType };
                } else if (file.isTLE && file.tleMerged) {
                    filesMetadata[id] = { dataType: file.dataType, tleAction: "merge" };
                }

                // PES timing sidecar reference for TS-extracted substreams.
                // Reload fetches the sidecar in parallel and threads pesEntries
                // into parseKLVFile so pesPTSus[] is reconstructed without
                // re-demuxing the (dropped) parent TS. The local and server
                // save paths each set their own URL; pick whichever is present.
                const sidecarURL = local
                    ? (file.localPesSidecarURL || null)
                    : (file.pesSidecarStaticURL || null);
                if (sidecarURL) {
                    if (!filesMetadata[id]) filesMetadata[id] = {};
                    filesMetadata[id].pesSidecarURL = sidecarURL;
                    if (typeof file.videoFirstPESus === "number") {
                        filesMetadata[id].videoFirstPESus = file.videoFirstPESus;
                    }
                    if (file.tsParentFilename) {
                        filesMetadata[id].tsParentFilename = file.tsParentFilename;
                    }
                }
            }

            // Save track import metadata per file:
            // - selectedTracks: skip multi-track picker on reload
            // - shortNames: preserve stable track IDs across parser differences
            //   (notably NITF first-load names vs MISB CSV reload names)
            const trackInfoPerFile = {};
            TrackManager.iterate((trackId, metaTrack) => {
                if (metaTrack.isSynthetic || !metaTrack.trackFileName) return;
                // Skip files excluded from serialization (e.g. the regenerable App Flight
                // MISB) — its source file isn't saved, so don't emit a dangling
                // selectedTracks/shortNames entry pointing at a file that won't reload.
                if (FileManager.list[metaTrack.trackFileName]?.skipSerialization) return;
                if (!trackInfoPerFile[metaTrack.trackFileName]) {
                    trackInfoPerFile[metaTrack.trackFileName] = {
                        selectedTracks: [],
                        shortNames: {},
                    };
                }
                trackInfoPerFile[metaTrack.trackFileName].selectedTracks.push(metaTrack.trackIndex);
                const shortName = metaTrack.trackNode?.shortName || metaTrack.menuText;
                if (shortName) {
                    trackInfoPerFile[metaTrack.trackFileName].shortNames[String(metaTrack.trackIndex)] = shortName;
                }
            });
            for (const [fileId, info] of Object.entries(trackInfoPerFile)) {
                if (!filesMetadata[fileId]) filesMetadata[fileId] = {};
                filesMetadata[fileId].selectedTracks = info.selectedTracks;
                if (Object.keys(info.shortNames).length > 0) {
                    filesMetadata[fileId].shortNames = info.shortNames;
                }
            }

            // Save autoSelectAsCamera flag for track files that define their own camera
            // (e.g. NITF tracks converted to MISB CSV)
            for (let id in FileManager.list) {
                const file = FileManager.list[id];
                if (file.autoSelectAsCamera) {
                    if (!filesMetadata[id]) filesMetadata[id] = {};
                    filesMetadata[id].autoSelectAsCamera = true;
                }
            }

            if (Object.keys(filesMetadata).length > 0) {
                out.loadedFilesMetadata = filesMetadata;
            }
        }

        // calculate the modifications to be applied to nodes AFTER the files are loaded
        // anything with a modSerialize function will be serialized
        let mods = {}
        NodeMan.iterate((id, node) => {

            if (node.modSerialize !== undefined) {
                const nodeMod = node.modSerialize()

                // check it has rootTestRemove, and remove it if it's empty
                // this is a test to ensure serialization of an object incorporates he parents in the hierarchy
                assert(nodeMod.rootTestRemove !== undefined, "Not incorporating ...super.modSerialzie.  rootTestRemove is not defined for node:" + id + "Class name " + node.constructor.name)
                // remove it
                delete nodeMod.rootTestRemove

                // check if empty {} object, don't need to store that
                if (Object.keys(nodeMod).length > 0) {

                    // if there's just one, and it's "visible: true", then don't store it
                    // as it's the default
                    if (Object.keys(nodeMod).length === 1 && nodeMod.visible === true) {
                        // skip
                    } else {
                        mods[node.id] = nodeMod;
                    }
                }
            }
        })
        out.mods = mods;

        // now the "par" values, which are deprecated, but still used in some places
        // so we need to serialize some of them
        const parNeeded = [
            "frame",
            "paused",
            "mainFOV",


            // these are JetGUI.js specific, form SetupJetGUI
            // VERY legacy stuff which most sitching will not have
            "pingPong",

            "podPitchPhysical",
            "podRollPhysical",
            "deroFromGlare",
            "jetPitch",

            "el",
            "glareStartAngle",
            "initialGlareRotation",
            "scaleJetPitch",
            "speed",  // this is the video speed
            "podWireframe",
            "showVideo",
            "showChart",
            "showKeyboardShortcuts",
            "showPodHead",
            "showPodsEye",
            "showCueData",

            "jetOffset",
            "TAS",
            "integrate",
            "trackToTrackStopAt",

            // Wind state (source / sourceLocal / sourceSeparate / windAltFt /
            // lineOpacity / seedSpacing / maxWindSpeed / nearbyOnly /
            // nearbyRadiusKm / showArrows / inspect / visible /
            // lockAltitudeTo / inspectPoints) all live on the wind node
            // and are persisted via its modSerialize — par doesn't double
            // them. Only par-only state stays here:
            //   windShow — back-compat alias for wind node visibility
            //   balloonCount — sounding-loader knob (not part of the node)
            "windShow",
            "balloonCount",
        ]

        const SitNeeded = [
            "file",
            "starScale",
            "planetScale",
            "satScale",
            "flareScale",
            "satCutOff",
            "markerIndex",
            "sitchName",  // the same for the save file of the custom sitch
            "aFrame",
            "bFrame",
            "ignores",
            "refractionEnabled",
            "refractionPressure",
            "refractionTemp",
        ]

        const globalsNeeded = [
            "showMeasurements",
            "showLabelsMain",
            "showLabelsLook",
            "showFeaturesMain",
            "showFeaturesLook",
            "objectScale",
            "showAllTracksInLook"
        ]

        let pars = {}
        for (let key of parNeeded) {
            if (par[key] !== undefined) {
                pars[key] = par[key]
            }
        }

        // add any "showHider" par toggles
        // see KeyBoardHandler.js, function showHider
        // these are three.js objects that can be toggled on and off
        // so iterate over all the objects in the scene, and if they have a showHiderID
        // then store the visible state using that ID (which is what the variable in pars will be)
        // traverse GlobalScene.children recursively to do the above
        const traverse = (object) => {
            if (object.showHiderID !== undefined) {
                pars[object.showHiderID] = object.visible;
            }
            for (let child of object.children) {
                traverse(child);
            }
        }

        traverse(GlobalScene);
        out.pars = pars;

        let globals = {}
        for (let key of globalsNeeded) {
            if (Globals[key] !== undefined) {
                globals[key] = Globals[key]
            }
        }
        out.globals = globals;

        // this will be accessible in Sit.Sit, eg. Sit.Sit.file
        let SitVars = {}
        for (let key of SitNeeded) {
            if (Sit[key] !== undefined) {
                SitVars[key] = Sit[key]
            }
        }
        out.Sit = SitVars;





        // MORE STUFF HERE.......

        out.modUnits = Units.modSerialize()

        out.guiMenus = Globals.menuBar.modSerialize()

        // Serialize synthetic tracks from TrackManager
        // This must be done before mods, as the tracks need to be recreated
        // before mods are applied to their nodes
        out.syntheticTracks = TrackManager.serialize()

        // Balloon tracks: compact generator params (the appFlight pattern) —
        // deserializeBalloons recreates identical node ids before the mods pass
        out.balloonTracks = TrackManager.serializeBalloons()

        // Synthetic fromApp flight: persist ONLY the compact generator params
        // (origin/dest lat-lon, cruise altitude, flight start/duration). The generated
        // MISB file is flagged skipSerialization, so it's never rehosted — on reload
        // buildAppFlightTrack regenerates an identical track from these ~8 numbers.
        if (Sit.appFlight) out.appFlight = Sit.appFlight;
        if (Sit.appFromApp) out.appFromApp = true;   // fromApp scene marker (drives lightweight gating on reload)

        // Serialize feature markers from FeatureManager
        out.featureMarkers = FeatureManager.serialize()

        // Serialize user-created custom graphs
        out.customGraphs = CustomGraphManager.serialize()

        // Serialize synthetic 3D buildings from Synth3DManager
        out.syntheticBuildings = Synth3DManager.serialize()

        // Serialize motion analysis state
        out.motionAnalysis = serializeMotionAnalysis()

        // Serialize auto tracking state (tracked positions + stabilization)
        // Fall back to Sit.autoTracking (from previous load) if the objectTracker
        // is no longer active but previously-serialized data exists
        out.autoTracking = serializeAutoTracking() ?? Sit.autoTracking ?? null

        // Horizon extractor keyframes — manual horizon-angle markups.
        // Falls back to Sit.horizonExtractor (from previous load) if the
        // extractor is no longer instantiated but old data exists.
        out.horizonExtractor = serializeHorizonExtractor() ?? Sit.horizonExtractor ?? null

        // Scripted Video script text, so a saved sitch carries its scripted video.
        // Falls back to Sit.scriptedVideoScript (from a previous load) if the
        // editor holds nothing save-worthy (e.g. the unmodified demo script).
        out.scriptedVideoScript = serializeScriptedVideo() ?? Sit.scriptedVideoScript ?? null

        // Long Exposure / Camera Nudge parameters (null when all defaults)
        out.longExposure = serializeLongExposure() ?? Sit.longExposure ?? null

        // Split-tree tiling layout (UI redesign Phase 2): the optional view-tiling tree (view
        // ids + seam sizes). null when not tiled ⇒ legacy free-floating behaviour on reload.
        // Each leaf's fractions are already serialized per-view (toSerialCNodeView), so an
        // older build that ignores this field still renders the views at ~the same rects.
        out.layout = LayoutMan.serialize()

        // Serialize sub sitches
        out.subSitchesData = this.serializeSubSitches()

        // do the export version tracking last, so none of the combining sitches overwrites it
        out.exportVersion = process.env.BUILD_VERSION_STRING
        out.exportTag = process.env.VERSION;
        out.exportTagNumber = versionNumber; // this is an integer like 1000000 for 1.0.0


        // convert to a string
        const str = JSON.stringify(out, null, 2)
        return str;
    },

    // Site ignores is a list of id strings to ignore next time a file is loaded
    // like if you load a KMZ with pins in it, it will create editable pins
    // which will be saved automatically
    // so reloading the same KMZ will create duplicates
    // so we need to ignore those IDs next time
    // this mostly is for serialization.
    ignore(id) {
        if (Sit.ignores === undefined) {
            Sit.ignores = [];
        }
        if (!Sit.ignores.includes(id)) {
            Sit.ignores.push(id);
        }
    },

    shouldIgnore(id) {
        if (Sit.ignores === undefined) {
            return false;
        }
        return Sit.ignores.includes(id);
    },

    unignore(id) {
        if (Sit.ignores === undefined) {
            return;
        }
        const index = Sit.ignores.indexOf(id);
        if (index !== -1) {
            Sit.ignores.splice(index, 1);
        }
    },

    // For saving a modified legacy sitch, like Gimbal, use the original name, with _mod
    // and make the version from the datetime as normal
    serializeMod() {
        const name = Sit.name + "_mod";
        const todayDateTimeFilename = getDateTimeFilename();
        return this.serialize(name, todayDateTimeFilename);
    },

    /**
     * Serializes and saves the current sitch.
     *
     * Reference-aware behavior for server saves:
     * - Any current `FileManager.loadURL` is resolved to a fetchable URL before content comparison.
     * - Newly rehosted sitches store/share the stable object reference returned by the backend
     *   (not a storage-host-specific URL), and the generated `?custom=` / `?mod=` link uses
     *   the share-safe object key value.
     *
     * @param {string} name - Logical sitch name (without version suffix).
     * @param {string} version - Version token (typically datetime-based).
     * @param {boolean} [local=false] - If true, save locally without server rehosting.
     * @param {FileSystemDirectoryHandle} [directoryHandle=null] - If provided (and local=true), save directly into this directory.
     * @param {FileSystemFileHandle} [fileHandle=null] - If provided (and local=true), save directly into this file.
     * @returns {Promise<{savedName?: string, fileHandle?: FileSystemFileHandle}|void>}
     */
    async serialize(name, version, local = false, directoryHandle = null, fileHandle = null) {
        console.log("Serializing custom sitch")

        assert(Sit.canMod || Sit.isCustom, "one of Sit.canMod or Sit.isCustom must be true to serialize a sitch")

        // we now allow serialization of legacy Sitchs that are marked with isCustom
        // Gimbal for example
   //     assert(!Sit.canMod || !Sit.isCustom, "one of Sit.canMod or Sit.isCustom must be false to serialize a sitch")

        if (local) {

            // For working-folder local saves, copy dynamic/imported assets into the folder first.
            // This enables portable local sitches without manual file shuffling.
            if (directoryHandle) {
                await FileManager.rehostDynamicLinksLocal(directoryHandle, true);
            }

            // Save the stringified sitch using localStaticURL paths when present.
            // Under the unified persistence model, TS substreams are persisted
            // independently with .pts.json sidecars carrying MISB ST 0604 PES
            // timing — so no special TS rewriting is needed here. Reload
            // fetches the substreams + sidecars and reconstructs pesPTSus[]
            // without ever re-demuxing the parent TS.
            const str = this.getCustomSitchString(true);

            const blob = new Blob([str]);
            const filename = name + ".json";

            if (fileHandle) {
                // Save directly into a previously selected file
                return saveFileToHandle(blob, fileHandle).then(() => {
                    Sit.sitchName = fileHandle.name.replace(".json", "");
                    console.log("Saved to existing local file handle as " + fileHandle.name);
                    return {savedName: fileHandle.name, fileHandle};
                });
            }

            if (directoryHandle) {
                // Save directly into the working folder
                return saveFileToDirectory(blob, directoryHandle, filename).then(() => {
                    Sit.sitchName = name;
                    console.log("Saved to working folder as " + filename);
                    return {savedName: filename};
                });
            }

            // Fall back to save-file picker dialog
            return new Promise((resolve, reject) => {
                saveFilePrompted(blob, filename).then(({name: savedName, fileHandle: savedFileHandle}) => {
                    console.log("Saved as " + savedName)
                    // change sit.name to the filename
                    // with .sitch.js removed
                    Sit.sitchName = savedName.replace(".json", "")

                    console.log("Setting Sit.sitchName to " + Sit.sitchName)
                    resolve({savedName, fileHandle: savedFileHandle});
                }).catch((error) => {
                    console.log("Error or cancel in saving file local:", error);
                    reject(error);
                })
            })

        }

        console.log("ABOUT TO REHOST DYNAMIC LINKS FOR SERIALIZE")
        return FileManager.rehostDynamicLinks(true).then(async () => {

            console.log("GETTING CUSTOM SITCH STRING AFTER REHOSTING DYNAMIC LINKS")
            // get the string again, now that dynamic links have been rehosted
            const str = this.getCustomSitchString();
            //            console.log(str)

            if (name === undefined) {
                name = "Custom.js"
            }

            if (FileManager.loadURL) {
                try {
                    const currentFetchURL = await resolveURLForFetch(FileManager.loadURL);
                    const currentResponse = await fetch(currentFetchURL);
                    const currentContent = await currentResponse.text();
                    if (currentContent === str) {
                        console.log("No changes to save - content identical to current version");
                        return;
                    }
                } catch (e) {
                    console.log("Could not fetch current version for comparison, proceeding with save");
                }
            }

            return FileManager.rehoster.rehostFile(name, str, version + ".js").then((staticRef) => {
                console.log("✓ Sitch rehosted as " + staticRef);

                // Defensive check: detect if we got a cached response from a previous upload
                // This can happen if rehost.php was called multiple times rapidly
                // and the browser's fetch cache returned a stale response
                if (staticRef.endsWith('.mp4') || staticRef.endsWith('.mov')) {
                    console.error("ERROR: Sitch URL contains VIDEO indicator - likely a CACHED response!");
                    console.error("  This happens when rehost.php is called rapidly and browser caches POST responses");
                    console.error("  Expected: .js file URL (e.g., /sitrec/custom/...Custom.js.1.js)");
                    console.error("  Got:", staticRef);
                    // Log current state for debugging
                    if (NodeMan.exists("video")) {
                        const videoNode = NodeMan.get("video");
                        console.error("  VideoNode.staticURL:", videoNode.staticURL);
                    }
                    // This should now be prevented by cache: 'no-store' in CRehoster.js
                    console.error("  If this persists, check browser DevTools Network tab for 304 responses");
                }

                this.staticURL = staticRef;
                FileManager.loadURL = staticRef;

                // and make a URL that points to the new sitch
                let paramName = "custom"
                if (Sit.canMod) {
                    name = Sit.name + "_mod.js"
                    paramName = "mod"
                }
                this.customLink = SITREC_APP + "?" + paramName + "=" + encodeShareParam(toShareableCustomValue(staticRef));
                console.log("  Custom link created:", this.customLink);

                //
                window.history.pushState({}, null, this.customLink);

            }).finally(() => {
                // Clean up accumulated promises in CRehoster to prevent cross-talk between saves
                if (FileManager.rehoster.rehostPromises && FileManager.rehoster.rehostPromises.length > 0) {
                    console.log("Clearing " + FileManager.rehoster.rehostPromises.length + " accumulated rehost promises");
                    FileManager.rehoster.rehostPromises = [];
                }
            })
        })
    },


    getPermalink() {
        // Return the Promise chain
        return getShortURL(this.customLink).then((shortURL) => {
            // Ensure the short URL starts with 'http' or 'https'
            if (!shortURL.startsWith("http")) {
                shortURL = "https://" + shortURL;
            }
            createCustomModalWithCopy(shortURL)();
        }).catch((error) => {
            console.log("Error in getting permalink:", error);
        });
    },



    /**
     * Fetch and parse a `.pts.json` sidecar for a TS-extracted substream.
     * Returns `{pesEntries, videoFirstPESus}` ready to pass as the metadata
     * override to `FileManager.loadAsset`, or null if the sidecar is empty
     * or malformed.
     *
     * The sidecar URL may be:
     *   - a sitrec://obj-ref → resolve and HTTP fetch
     *   - an absolute http(s) URL → HTTP fetch
     *   - a working-folder relative path (e.g. "Truck.ts_klv.klv.pts.json")
     *     → read via FileManager.readWorkingFolderFile (matches how the
     *       substream itself loads — see loadAsset working-folder branch)
     */
    async _fetchPesSidecar(sidecarURL) {
        let text;
        if (isResolvableSitrecReference(sidecarURL)) {
            const resolved = await resolveURLForFetch(sidecarURL);
            const response = await fileSystemFetch(resolved);
            if (!response.ok) {
                throw new Error(`Sidecar fetch returned ${response.status} for ${sidecarURL}`);
            }
            text = await response.text();
        } else if (sidecarURL.startsWith("http://") || sidecarURL.startsWith("https://")) {
            const response = await fileSystemFetch(sidecarURL);
            if (!response.ok) {
                throw new Error(`Sidecar fetch returned ${response.status} for ${sidecarURL}`);
            }
            text = await response.text();
        } else {
            // Working-folder relative path. The substream loaded the same way
            // (loadAsset → readWorkingFolderFile), so symmetric resolution.
            const buffer = await FileManager.readWorkingFolderFile(sidecarURL);
            text = new TextDecoder().decode(buffer);
        }
        const sidecar = JSON.parse(text);
        if (!sidecar || !Array.isArray(sidecar.pesEntries) || sidecar.pesEntries.length === 0) {
            return null;
        }
        return {
            pesEntries: sidecar.pesEntries,
            videoFirstPESus: typeof sidecar.videoFirstPESus === "number" ? sidecar.videoFirstPESus : null,
        };
    },

    // after setting up a custom scene, call this to perform the mods
    // i.e. load the files, and then apply the mods
    deserialize(sitchData) {
//        console.log("Deserializing text-base sitch")

        Globals.exportTagNumber = sitchData.exportTagNumber ?? 0;

        console.log("Sitch exportTagNumber: " + Globals.exportTagNumber)

        Globals.deserializing = true;

        // Restore Sit.ignores early, BEFORE files are loaded.
        // extractKMLObjectsInternal checks shouldIgnore() to avoid recreating
        // features that are already saved in featureMarkers.
        if (sitchData.Sit && sitchData.Sit.ignores) {
            Sit.ignores = sitchData.Sit.ignores;
        }

        // Store file metadata for special handling during loading
        if (sitchData.loadedFilesMetadata) {
            FileManager.loadedFilesMetadata = sitchData.loadedFilesMetadata;
        } else {
            FileManager.loadedFilesMetadata = {};
        }

        const loadingPromises = [];
        if (sitchData.loadedFiles) {
            // Remap any old/renamed file paths in loadedFiles (e.g. renamed model .glb files)
            for (const oldId of Object.keys(sitchData.loadedFiles)) {
                if (ModelAliases[oldId]) {
                    const newPath = ModelAliases[oldId];
                    const oldValue = sitchData.loadedFiles[oldId];
                    // Remap the value: replace old filename with new in the URL/path
                    const oldFilename = oldId.split('/').pop();
                    const newFilename = newPath.split('/').pop();
                    const newValue = oldValue.includes(oldFilename)
                        ? oldValue.replace(oldFilename, newFilename)
                        : oldValue;
                    console.log(`Remapped old model path in loadedFiles: ${oldId} -> ${newPath}`);
                    sitchData.loadedFiles[newPath] = newValue;
                    Sit.loadedFiles[newPath] = newValue;
                    delete sitchData.loadedFiles[oldId];
                    delete Sit.loadedFiles[oldId];
                }
            }
            // load the files as if they have been drag-and-dropped in
            for (let id in sitchData.loadedFiles) {
                const sidecarMeta = sitchData.loadedFilesMetadata?.[id];
                const sidecarURL = sidecarMeta?.pesSidecarURL;
                // For TS-extracted substreams: fetch the .pts.json sidecar in
                // parallel with the substream itself, then thread the parsed
                // pesEntries + videoFirstPESus into loadAsset's metadataOverride.
                // parseKLVFile uses these to reconstruct pesPTSus[] without
                // the parent TS being present. If the sidecar fetch fails the
                // load still proceeds (without PES sync) — UnixTimeStamp
                // wall-clock fallback in CNodeTrackFromMISB takes over.
                const overridePromise = sidecarURL
                    ? this._fetchPesSidecar(sidecarURL).catch(err => {
                        // Sidecar failure ⇒ silent sync degradation. Make this
                        // loud at load time AND record it on FileManager so the
                        // Timing Analysis report can surface "the override was
                        // expected but never arrived."
                        console.error(`[PES sidecar] FAILED for ${id} (${sidecarURL}):`, err);
                        if (!FileManager.pesSidecarFailures) FileManager.pesSidecarFailures = {};
                        FileManager.pesSidecarFailures[id] = {
                            url: sidecarURL,
                            error: err && err.message ? err.message : String(err),
                        };
                        return null;
                    })
                    : Promise.resolve(null);
                loadingPromises.push(overridePromise.then(metadataOverride => FileManager.loadAsset(Sit.loadedFiles[id], id, metadataOverride)).then(
                    (parsedResult) => {
                        Globals.dontAutoZoom = true;

                        // Skip files that failed to parse (e.g. corrupt KLV)
                        if (parsedResult === null) {
                            return;
                        }

                        assert(parsedResult !== undefined, "Parsed result should not be undefined for loaded file id: " + id);

                        // since it might be a container that parse to multiple files
                        // we need to handle an array of parsed results
                        // if a single file, then make it an array of one
                        if (!Array.isArray(parsedResult)) {
                            parsedResult.id = id; // assign the id to the single file parsed result
                            parsedResult = [parsedResult]
                        }
                        // might need to use filename as id here?

                        // for each parsed result, handle it just like it was drag-and-dropped
                        for (const x of parsedResult) {
                            const parsedFile = x.parsed;
                            const filename = x.filename;
                            const fileID = x.id ?? x.filename; // use filename as fallback id
                            console.log("HANDLING LOADED FILE ID: " + id + " filename: " + filename);
                            // Restore dataType and other metadata if available
                            const metadata = FileManager.loadedFilesMetadata[fileID];
                            if (metadata?.dataType) {
                                FileManager.list[fileID].dataType = metadata.dataType;
                                // For kmzImage files, restore kmzHref and populate kmzImageMap
                                if (metadata.dataType === "kmzImage" && metadata.kmzHref) {
                                    FileManager.list[fileID].kmzHref = metadata.kmzHref;
                                    // Create blobURL from buffer if not already set
                                    if (!FileManager.list[fileID].blobURL) {
                                        // Use .original which contains the ArrayBuffer
                                        const buffer = FileManager.list[fileID].original;
                                        const ext = metadata.kmzHref.split('.').pop().toLowerCase();
                                        const mimeType = ext === 'png' ? 'image/png' :
                                            ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                                ext === 'gif' ? 'image/gif' : 'image/webp';
                                        const blob = new Blob([buffer], { type: mimeType });
                                        FileManager.list[fileID].blobURL = URL.createObjectURL(blob);
                                    }
                                    if (!FileManager.kmzImageMap) FileManager.kmzImageMap = {};
                                    FileManager.kmzImageMap[metadata.kmzHref] = FileManager.list[fileID].blobURL;
                                }
                            }
                            // Restore autoSelectAsCamera on track files that had it
                            if (metadata?.autoSelectAsCamera) {
                                if (parsedFile) parsedFile.autoSelectAsCamera = true;
                                if (FileManager.list[fileID]) FileManager.list[fileID].autoSelectAsCamera = true;
                            }
                            // Pass saved track selections to skip the multi-track dialog on reload
                            const trackOptions = {};
                            if (metadata?.selectedTracks) {
                                trackOptions.showDialog = false;
                                trackOptions.selectedTracks = metadata.selectedTracks;
                            }
                            if (metadata?.shortNames) {
                                // Preserve original shortName->nodeID mapping on reload.
                                // Without this, re-parsing converted track files can generate
                                // different names and break saved mod IDs.
                                trackOptions.shortNames = metadata.shortNames;
                            }
                            // Pass TLE merge/replace action to skip the choice dialog on reload.
                            // The saved sitch already encodes the user's chosen final state —
                            // every TLE present in the save is meant to coexist — so default
                            // to "merge" whenever no explicit action was recorded (e.g. older
                            // saves predating tleAction metadata, or first-loaded TLEs that
                            // were never marked tleMerged). Scoped to TLE files only.
                            if (metadata?.tleAction) {
                                trackOptions.tleAction = metadata.tleAction;
                            } else if (FileManager.list[fileID]?.dataType === "tle") {
                                trackOptions.tleAction = "merge";
                            }
                            FileManager.handleParsedFile(fileID, parsedFile, trackOptions);
                        }

                        Globals.dontAutoZoom = false;


                    }
                ).catch((err) => {
                    // Don't let one missing/failed asset crash the rest of
                    // the sitch reload. Log and move on; the affected node
                    // will reload from source on first interaction (e.g.
                    // the wind node re-fetches via windProxy on modDeserialize).
                    console.warn(`Failed to load asset ${id}:`, err?.message ?? err);
                }))
            }
        }


        // wait for the files to load
        Promise.all(loadingPromises).then(async () => {

            // We supress recalculation while we apply the mods
            // otherwise we get multiple recalculations of the same thing
            // here we are applying the mods, and then we will recalculate everything
            Globals.dontRecalculate = true;

            // Stash the saved split-tree tiling layout (if any) on Sit; it's applied at the end
            // of setupFunctions once all views + their positions are established (a tree must be
            // installed AFTER the views it references exist).
            Sit.layout = sitchData.layout ?? null;

            // apply the units first, as some controllers are dependent on them
            // i.e. Target Speed, which use a GUIValue for speed in whatever units
            // if the set the units later, then it will convert the speed to the new units
            if (sitchData.modUnits) {
                Units.modDeserialize(sitchData.modUnits)
            }

            // Deserialize synthetic tracks BEFORE applying mods
            // This recreates the track nodes so that mods can be applied to them
            if (sitchData.syntheticTracks) {
                TrackManager.deserialize(sitchData.syntheticTracks)
            }

            // Recreate balloon tracks BEFORE applying mods — same contract:
            // deterministic node ids, then the mods pass restores their state
            if (sitchData.balloonTracks) {
                TrackManager.deserializeBalloons(sitchData.balloonTracks)
            }

            // Regenerate the fromApp synthetic flight track from its saved params.
            // Same shared builder as the live launch, so Track_Flight (and TrackData_Flight,
            // the display tracks, the GUI nodes) are recreated with identical, deterministic
            // IDs — which lets the mods pass below attach to them. Must run BEFORE mods.
            // Guarded so legacy saves that still embed the file (loaded above) don't
            // double-create it.
            if (sitchData.appFlight && !FileManager.list["App Flight.kml"]) {
                await buildAppFlightTrack(sitchData.appFlight)
            }
            // Restore the fromApp marker (fixed mode has no flight track to rebuild it),
            // so applyFlightLightweightGating() below gates the LOS-analysis machinery.
            if (sitchData.appFromApp) Sit.appFromApp = true;

            // Deserialize feature markers BEFORE applying mods
            // This creates the necessary feature marker nodes
            if (sitchData.featureMarkers) {
                FeatureManager.deserialize(sitchData.featureMarkers)
            }

            // Recreate custom graphs BEFORE applying mods, so each graph view
            // exists with its deterministic id and its saved geometry/visibility
            // mod can re-attach.
            if (sitchData.customGraphs) {
                CustomGraphManager.deserialize(sitchData.customGraphs)
            }

            // Deserialize synthetic 3D buildings BEFORE applying mods
            // This recreates the building nodes so that mods can be applied to them
            if (sitchData.syntheticBuildings) {
                Synth3DManager.deserialize(sitchData.syntheticBuildings)
            }

            // now we've either got
            // console.log("Promised files loaded in Custom Manager deserialize")
            if (sitchData.mods) {
                // apply the mods
                this.deserializeMods(sitchData.mods).then((completed) => {
                    // deserializeMods returns false when a newer sitch load superseded
                    // this one mid-flight. finishDeserialization applies pars, restores
                    // fullscreen-from-mods, etc. — all of which would land on the NEW
                    // sitch's graph/views, so skip it for a dead load.
                    if (completed === false) {
                        console.warn("Deserialization superseded by a newer sitch load; skipping finishDeserialization for the stale load.");
                        return;
                    }
                    setSitchEstablished(true); // flag that we've done some editing, so any future drag-and-drop will not mess with the sitch
                    this.finishDeserialization(sitchData);
                }).catch((err) => {
                    // Last-resort guard so the app is never wedged in "deserializing" state.
                    // Part 1 (per-node try/catch in deserializeMods) already tolerates a single
                    // bad mod; this additionally covers an unexpected throw in the post-mods
                    // recalcs inside finishDeserialization.
                    console.error("Deserialization did not complete cleanly:", err);
                    Globals.deserializing = false;
                    Globals.sitchDirty = false;
                    setRenderOne(3);
                });
                return; // Exit early, finishDeserialization will continue the process
            } else {
                this.finishDeserialization(sitchData);
            }

        })


    },

    /**
     * If a legacy switch choice no longer exists, try to resolve it to the
     * current single matching option with the same prefix.
     * This is intentionally conservative: only auto-resolve when unambiguous.
     * @param {string} switchId
     * @param {string|undefined} legacyChoice
     * @param {string} prefix
     * @returns {string|null}
     */
    resolveLegacySwitchChoice(switchId, legacyChoice, prefix) {
        if (typeof legacyChoice !== "string" || legacyChoice.length === 0) return null;
        if (prefix && !legacyChoice.startsWith(prefix)) return null;

        const switchNode = NodeMan.get(switchId, false);
        if (!switchNode?.inputs) return null;

        if (switchNode.inputs[legacyChoice] !== undefined) {
            return legacyChoice;
        }

        const candidates = Object.keys(switchNode.inputs).filter(key => key.startsWith(prefix));
        if (candidates.length === 1) {
            return candidates[0];
        }

        return null;
    },

    /**
     * Build a legacy track-root remap from switch choices, then remap matching
     * mod IDs so old custom saves can still target newly-generated track IDs.
     * This is a migration path for pre-metadata saves; new saves should keep
     * stable IDs via loadedFilesMetadata.shortNames.
     * @param {Object} mods
     */
    remapLegacyTrackMods(mods) {
        const rootMap = {};

        const remapRoot = (oldRoot, newRoot) => {
            if (!oldRoot || !newRoot || oldRoot === newRoot) return;
            if (!rootMap[oldRoot]) {
                rootMap[oldRoot] = newRoot;
            }
        };

        const legacyFovChoice = mods?.fovSwitch?.choice;
        const resolvedFovChoice = this.resolveLegacySwitchChoice("fovSwitch", legacyFovChoice, "Track_");
        if (resolvedFovChoice && resolvedFovChoice !== legacyFovChoice) {
            const oldRoot = legacyFovChoice.substring("Track_".length);
            const newRoot = resolvedFovChoice.substring("Track_".length);
            remapRoot(oldRoot, newRoot);
            mods.fovSwitch.choice = resolvedFovChoice;
            console.warn(`CustomSupport: remapping legacy fovSwitch choice '${legacyFovChoice}' -> '${resolvedFovChoice}'`);
        }

        // Per-track angle sources ("Angles_<name>") now live on the unified
        // CameraLOSController — the legacy anglesSwitch was flattened into it on
        // load (migrateCameraHeadingReorg, RegisterSitches.js), which also moved
        // this choice across. Remap a legacy track-root here too so very old saves
        // whose track shortNames changed still resolve their angle source.
        const anglesChoiceMod = mods?.CameraLOSController;
        const legacyAnglesChoice = anglesChoiceMod?.choice;
        const resolvedAnglesChoice = this.resolveLegacySwitchChoice("CameraLOSController", legacyAnglesChoice, "Angles_");
        if (resolvedAnglesChoice && resolvedAnglesChoice !== legacyAnglesChoice) {
            const oldRoot = legacyAnglesChoice.substring("Angles_".length);
            const newRoot = resolvedAnglesChoice.substring("Angles_".length);
            remapRoot(oldRoot, newRoot);
            anglesChoiceMod.choice = resolvedAnglesChoice;
            console.warn(`CustomSupport: remapping legacy Camera Heading angles choice '${legacyAnglesChoice}' -> '${resolvedAnglesChoice}'`);
        }

        // The "Auto Tracking" menu folder + LOS dropdown option were renamed to "Point Track"
        // in 2.58.x. Saves predating the rename recorded JetLOS.choice as "Camera + Auto Track";
        // rewrite to the new key so modDeserialize finds it in jetLOS.inputs.
        if (mods?.JetLOS?.choice === "Camera + Auto Track") {
            mods.JetLOS.choice = "Camera + Point Track";
            console.warn("CustomSupport: remapping legacy JetLOS choice 'Camera + Auto Track' -> 'Camera + Point Track'");
        }

        const legacyCameraChoice = mods?.cameraTrackSwitch?.choice;
        const cameraSwitch = NodeMan.get("cameraTrackSwitch", false);
        if (typeof legacyCameraChoice === "string" && cameraSwitch?.inputs && cameraSwitch.inputs[legacyCameraChoice] === undefined) {
            let resolvedCameraChoice = rootMap[legacyCameraChoice] ?? null;
            if (!resolvedCameraChoice) {
                const cameraCandidates = Object.keys(cameraSwitch.inputs).filter(key => key !== "fixedCamera" && key !== "flightSimCamera");
                if (cameraCandidates.length === 1) {
                    resolvedCameraChoice = cameraCandidates[0];
                    remapRoot(legacyCameraChoice, resolvedCameraChoice);
                }
            }
            if (resolvedCameraChoice && cameraSwitch.inputs[resolvedCameraChoice] !== undefined) {
                mods.cameraTrackSwitch.choice = resolvedCameraChoice;
                console.warn(`CustomSupport: remapping legacy cameraTrackSwitch choice '${legacyCameraChoice}' -> '${resolvedCameraChoice}'`);
            }
        }

        const mappings = Object.entries(rootMap);
        if (mappings.length > 0) {
            const originalKeys = Object.keys(mods);
            for (const oldId of originalKeys) {
                let newId = oldId;
                for (const [oldRoot, newRoot] of mappings) {
                    if (newId.includes(oldRoot)) {
                        newId = newId.replaceAll(oldRoot, newRoot);
                    }
                }
                if (newId !== oldId) {
                    if (mods[newId] === undefined) {
                        mods[newId] = mods[oldId];
                    }
                    delete mods[oldId];
                    console.warn(`CustomSupport: remapped legacy mod id '${oldId}' -> '${newId}'`);
                }
            }
        }

        // Orphan-root heuristic for pre-metadata saves where no switch references
        // the track. The `<X>_ob` sphere ID is a unique marker for a track-derived
        // node; if X doesn't match any current track shortName and there is exactly
        // one current track unclaimed by mods, pair them. Then targeted-remap only
        // mod keys whose substituted form resolves to an existing node, so we don't
        // accidentally rewrite unrelated keys when the legacy root is a common word
        // (e.g. an old CSV parser returning "null").
        // Use menuText: the source of truth for the `<X>_ob` sphere ID is
        // `trackOb.menuText ?? shortName` (see TrackManager.makeMotionTrack).
        // trackOb.shortName is not set; the local shortName variable in
        // addTracks becomes menuText on the persisted CMetaTrack instance.
        const currentShortNames = new Set();
        TrackManager.iterate((id, track) => {
            const name = track?.menuText ?? track?.shortName;
            if (name) currentShortNames.add(name);
        });

        const resolvedOldRoots = new Set(Object.keys(rootMap));
        const resolvedNewRoots = new Set(Object.values(rootMap));

        const orphanRoots = new Set();
        for (const key of Object.keys(mods)) {
            const m = key.match(/^(.+?)_ob(?:_.*)?$/);
            if (!m) continue;
            const root = m[1];
            if (currentShortNames.has(root)) continue;
            if (resolvedOldRoots.has(root)) continue;
            if (NodeMan.exists(root + "_ob")) continue;
            orphanRoots.add(root);
        }

        if (orphanRoots.size === 0) return;

        const unclaimed = [];
        for (const sn of currentShortNames) {
            if (resolvedNewRoots.has(sn)) continue;
            if (mods[sn + "_ob"] !== undefined) continue;
            if (!NodeMan.exists(sn + "_ob")) continue;
            unclaimed.push(sn);
        }

        if (orphanRoots.size !== 1 || unclaimed.length !== 1) return;

        const oldRoot = [...orphanRoots][0];
        const newRoot = unclaimed[0];
        for (const oldId of Object.keys(mods)) {
            if (!oldId.includes(oldRoot)) continue;
            const newId = oldId.replaceAll(oldRoot, newRoot);
            if (newId === oldId) continue;
            if (!NodeMan.exists(newId)) continue;
            if (mods[newId] === undefined) {
                mods[newId] = mods[oldId];
            }
            delete mods[oldId];
            console.warn(`CustomSupport: orphan-root remap '${oldId}' -> '${newId}'`);
        }
    },

    /**
     * Asynchronously deserialize mods, waiting for any pending actions to complete
     * @param {Object} mods - The mods object from sitchData
     * @returns {Promise<boolean>} - Resolves true when all mods were applied; false if a
     *          newer sitch load superseded this one mid-flight (mods were NOT fully applied).
     */
    async deserializeMods(mods) {
        // Snapshot the load generation. This loop awaits waitForPendingActions()
        // between mods (e.g. when a mod kicks off an async model/video load), so it
        // can be parked across a sitch transition. If the user switches sitches
        // before a slow load finishes, NodeMan is disposed and rebuilt for the new
        // sitch; resuming this loop would then apply THIS sitch's mods (e.g. a
        // doubled/fullscreen mainView) onto the NEW sitch's nodes — black look/video
        // views + a half-applied graph. Bail out if the generation changed. See
        // Globals.loadGeneration and disposeEverything().
        const myGeneration = Globals.loadGeneration;

        // If a wind field mod exists, auto-create the node before the standard
        // deserialize loop so its modDeserialize can restore source/altitude/
        // grids. The wind node is otherwise created lazily on first "Show Wind"
        // toggle, so without this branch the mod would be silently dropped.
        if (mods.windField && !NodeMan.exists("windField")) {
            this._windNode = NodeFactory.create("DisplayWindField", {id: "windField"});
        }

        // Street View pano is created lazily (not part of the sitch graph), so it isn't
        // recreated by the standard mod loop. Restore it explicitly — syncs the menu params
        // and re-fetches the image — then drop the mod so the loop doesn't warn about a
        // "missing" node (the restore is a no-op in serverless builds where the menu is absent).
        if (mods.streetViewPano) {
            restoreStreetViewPanoFromMod(mods.streetViewPano);
            delete mods.streetViewPano;
        }

        const deprecatedIds = {
            // Typo fix retained for backward compatibility with existing saved sitches.
            "angelsSwitch": "anglesSwitch",
            "osdTrackController": "osdDataSeriesController",
        };
        for (const [oldId, newId] of Object.entries(deprecatedIds)) {
            if (oldId === newId) continue;
            if (mods[oldId] !== undefined) {
                const oldExists = NodeMan.exists(oldId);
                const newExists = NodeMan.exists(newId);
                if (!newExists || oldExists) {
                    continue;
                }
                if (mods[newId] === undefined) {
                    mods[newId] = mods[oldId];
                }
                delete mods[oldId];
            }
        }

        // Drop mods for nodes that were fully REMOVED from the codebase. The node is
        // skipped at creation time (see RemovedNodes.js / SituationSetupFromData), so
        // without this its stale mod would just hit the "node does not exist" warning
        // below. Removing it keeps the console clean on legacy saves. Removal-only —
        // renames are handled by the deprecatedIds map above.
        for (const removedId of REMOVED_NODE_IDS) {
            if (mods[removedId] !== undefined) delete mods[removedId];
        }

        // Migration for older custom sitches saved before stable shortName metadata
        // existed for track files.
        // Scenario nodes (Football / Nimitz / Flood Sim ...) only exist after
        // their scenario is activated, and mods for missing node ids are
        // dropped below — so first activate any scenario this save was
        // actually using (see CScenarioManager.activateForMods). Must run
        // BEFORE remapLegacyTrackMods: that migration rewrites switch choices
        // it doesn't recognize, and a scenario-provided choice (e.g.
        // cameraTrackSwitch = "Fravor's Jet") only becomes recognizable once
        // the scenario has been activated.
        await ScenarioManager.activateForMods(mods);

        this.remapLegacyTrackMods(mods);

        // some things are required to be deserialized before others, so we force them to the top.
        // Here the osdDataSeriesController is used by tracks, and track selector swithches, which normally come early in the order,
        // So we push osdDataSeriesController to the top of the list
        const priorityIds = ["osdDataSeriesController"];
        const modIds = [
            ...priorityIds.filter(id => mods[id] !== undefined),
            ...Object.keys(mods).filter(id => !priorityIds.includes(id)),
        ];

        for (let i = 0; i < modIds.length; i++) {
            const id = modIds[i];

            // A newer sitch load has superseded this one (we were parked on an
            // await below). Stop applying this dead sitch's mods to the live graph.
            if (Globals.loadGeneration !== myGeneration) {
                console.warn(`deserializeMods: sitch load superseded mid-deserialize (gen ${myGeneration} -> ${Globals.loadGeneration}); aborting stale mod application at mod ${i}/${modIds.length}`);
                return false;
            }

            if (!NodeMan.exists(id)) {
                console.warn("Node " + id + " does not exist in the current sitch (deprecated?), so cannot apply mod");
                continue;
            }

            const node = NodeMan.get(id);
            if (node.modDeserialize !== undefined) {
                //                console.log("Applying mod to node:" + id + " with data:" + mods[id]);

                // bit of a patch, don't deserialise the dateTimeStart node
                // if we've overridden the time in the URL
                // see the check for urlParams.get("datetime") in index.js
                if (id !== "dateTimeStart" || !Globals.timeOverride) {
                    // A single bad mod must NOT abort the whole deserialize. If it threw
                    // (e.g. an object referencing a model no longer in ModelFiles, so
                    // CNode3DObject.rebuild dereferences an undefined model.file), the promise
                    // this loop returns would reject, the .then() that clears
                    // Globals.deserializing would never run, and the app would be wedged in
                    // "deserializing" state forever — the settle gate hangs to its 90s cap and
                    // deserializing-gated behavior (markSitchDirty, controller setup) stays
                    // suppressed. Skip the offending node and keep loading the rest.
                    try {
                        node.modDeserialize(mods[id]);
                    } catch (e) {
                        console.error(`Error applying mod to node "${id}" — skipping it:`, e);
                    }

                    // if this has triggered an async action, wait for it to finish
                    // e.g. Like the CNode3DModel.loadGLTFModel method
                    // which won't need to load the file, but the parsing is async
                    if (Globals.pendingActions > 0) {
                        console.log("Actions pending = " + Globals.pendingActions + ", waiting...");
                        await this.waitForPendingActions();
                        console.log("Pending actions completed, continuing deserialization");
                    }
                }
            }
        }
        return true; // all mods applied for this (still-current) sitch load
    },

    /**
     * Wait for all pending actions to complete
     * @returns {Promise} - Promise that resolves when Globals.pendingActions === 0
     */
    waitForPendingActions() {
        return new Promise((resolve) => {
            const checkPending = () => {
                if (Globals.pendingActions === 0) {
                    resolve();
                } else {
                    // Check again in the next frame
                    requestAnimationFrame(checkPending);
                }
            };
            checkPending();
        });
    },

    /**
     * Complete the deserialization process after mods have been applied
     * @param {Object} sitchData - The complete sitch data
     */
    async finishDeserialization(sitchData) {
        // apply the pars
        if (sitchData.pars) {
            for (let key in sitchData.pars) {
                par[key] = sitchData.pars[key];
            }
        }

        // Wind state is authoritatively held by the wind node — its
        // modSerialize/modDeserialize round-trips source / sourceLocal /
        // sourceSeparate / windAltFt / nearbyOnly / nearbyRadiusKm /
        // showArrows / inspect / visible / lineOpacity / seedSpacing /
        // maxWindSpeed / lockAltitudeTo / inspectPoints. The wind GUI
        // binds directly to those fields with .listen(), so no post-
        // deserialize par sync is needed; only par.windStatus needs a
        // refresh from the node's transient statusText.
        if (NodeMan.exists("windField")) {
            const windNode = NodeMan.get("windField");
            // Trigger any deferred reload now that every other node has
            // been deserialized — see CNodeDisplayWindField.modDeserialize.
            // Manual / sounding sources read live values from targetWind,
            // localWind, atmospheric profiles, etc., and would otherwise
            // race the deserialize loop's awaits.
            if (windNode._needsPostDeserializeFetch) {
                windNode._needsPostDeserializeFetch = false;
                windNode.fetchWindForAltitude(windNode.windAltFt).catch(err => {
                    console.warn("Non-GFS wind reload failed:", err);
                });
            } else if (Array.isArray(windNode._needsPostDeserializeReloadGFS)) {
                const savedLevels = windNode._needsPostDeserializeReloadGFS;
                windNode._needsPostDeserializeReloadGFS = null;
                windNode._reloadGFSAfterDeserialize(savedLevels).catch(err => {
                    console.warn("GFS wind reload failed:", err);
                });
            }
            if (windNode.statusText) par.windStatus = windNode.statusText;
        }

        // Reconcile targetWind/localWind track-source overrides against the
        // restored wn.source / wn.sourceLocal keys. The wind GUI's onChange
        // handlers do this during user interaction, but .listen() poll-
        // updates skip onChange — so without this hook, a sitch saved with
        // a track-derived source loads with .trackSource still null.
        this._reconcileWindTrackSources?.();

        // and the globals
        if (sitchData.globals) {
            for (let key in sitchData.globals) {
                //console.warn("Applying global "+key+" with value "+sitchData.globals[key])
                Globals[key] = sitchData.globals[key];
            }
        }

        // and Sit
        if (sitchData.Sit) {
            for (let key in sitchData.Sit) {
                //console.log("Applying Sit "+key+" with value "+sitchData.Sit[key])
                Sit[key] = sitchData.Sit[key];
            }
        }

        // Restore video state for modded sitches.
        // Custom sitches handle this during SituationSetup (pendingVideoRestore is already set).
        // For modded sitches (e.g., saved video viewer), the video node exists but has no video.
        if (sitchData.videos && sitchData.videos.length > 0 && NodeMan.exists("video")) {
            const videoNode = NodeMan.get("video");
            if (!videoNode.videoData && !videoNode.pendingVideoRestore) {
                videoNode.pendingVideoRestore = {
                    videos: sitchData.videos,
                    targetIndex: sitchData.currentVideoIndex ?? 0
                };
                videoNode.loadVideoFromEntry(sitchData.videos[0]);
            }
        }

        // Same restore for the secondary video view (twovid).
        if (sitchData.videos2 && sitchData.videos2.length > 0 && NodeMan.exists("video2")) {
            const videoNode2 = NodeMan.get("video2");
            if (!videoNode2.videoData && !videoNode2.pendingVideoRestore) {
                videoNode2.pendingVideoRestore = {
                    videos: sitchData.videos2,
                    targetIndex: sitchData.currentVideoIndex2 ?? 0
                };
                videoNode2.loadVideoFromEntry(sitchData.videos2[0]);
            }
        }

        refreshLabelsAfterLoading();
        this.refreshLookViewTracks();

        if (sitchData.guiMenus) {
            Globals.menuBar.modDeserialize(sitchData.guiMenus);
        }

        if (sitchData.motionAnalysis) {
            await deserializeMotionAnalysis(sitchData.motionAnalysis);
        }

        if (sitchData.autoTracking) {
            await deserializeAutoTracking(sitchData.autoTracking);
        }

        if (sitchData.horizonExtractor) {
            deserializeHorizonExtractor(sitchData.horizonExtractor);
        }

        if (sitchData.scriptedVideoScript) {
            deserializeScriptedVideo(sitchData.scriptedVideoScript);
        }

        if (sitchData.longExposure) {
            deserializeLongExposure(sitchData.longExposure);
        }

        if (sitchData.subSitchesData) {
            this.deserializeSubSitches(sitchData.subSitchesData);
        }

        // Now that all mods are applied, restore fullscreen state if exactly
        // one view was saved as doubled. Corrupted saves with multiple doubled
        // views are detected and un-doubled here.
        ViewMan.restoreFullscreenFromMods();

        Globals.dontRecalculate = false;

        // Lightweight flight scene: hide the unused target/traverse/measurement leaves
        // BEFORE the final recalcs below, so the checkDisplayOutputs gate skips their
        // expensive per-frame bakes on reload too (mirrors the live-launch finishFromApp,
        // and — running pre-recalc here — keeps the reload itself fast). No-op unless
        // Sit.appFlight is set.
        applyFlightLightweightGating();

        // recalculate everything after the mods
        // in case there's some missing dependency
        // like the CSwitches turning off if they are not used
        // which they don't know immediately
        // Note: terrain is excluded (withTerrain=false) because maps may not be loaded yet.
        // Terrain updates resume naturally via CNodeTerrainUI.update() on the next frame.
        NodeMan.recalculateAllRootFirst();

        // and we do it twice as sometimes there's initialization ordering issues
        // like the Tracking overlay depending on the FOV, but coming before the lookCamera
        NodeMan.recalculateAllRootFirst();

        // Ensure camera controllers (PTZ/FOV/etc.) are applied immediately after mod load.
        // recalculateAllRootFirst() runs recalculate(), but does not run controller apply().
        // In static/no-logic sitches this can leave camera state stale until the user touches a control.
        for (const entry of Object.values(NodeMan.list)) {
            const node = entry.data;
            if (!node?.isCamera || typeof node.applyControllers !== "function") continue;
            node.applyControllers(par.frame);
            if (node.camera) {
                node.camera.updateMatrix();
                node.camera.updateMatrixWorld();
                node.camera.updateProjectionMatrix();
            }
        }

        Globals.deserializing = false;
        Globals.sitchDirty = false;
        setRenderOne(3);
    },




};
