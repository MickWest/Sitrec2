// Single source of truth for Sitrec's user-facing documentation.
//
// Three things are built from this one array, so they can never drift apart:
//   1. the Help > Documentation menu                     (src/index.js)
//   2. the per-menu "Help" folders                       (src/index.js, addMenuHelpFolders)
//   3. the in-app AI assistant's getHelpDoc doc list      (src/nodes/CNodeVIewChat.js)
//
// They previously drifted: the chat list named files that didn't exist (e.g.
// "SavingLoadingSharing" when the file is "SavingAndLoading.md", and "ObjectTracking"
// with no file at all), which made getHelpDoc return an error mid-conversation. Deriving
// the chat doc-name from the same `file` the menu links to makes that class of bug
// structurally impossible. tests/docsRegistry.test.js enforces the rest.
//
// Each entry:
//   file      - path for the Help-menu link, WITHOUT extension. Usually
//               "docs/<Name>" (linked as docs/<Name>.md or .html); "README" is special.
//   labelKey  - i18n key for the Help-menu label (see menus.help.* in src/i18n/en.js).
//   section   - which group the doc sits in, in the Help menu and the docs index.
//               One of the keys in DOC_SECTIONS below.
//   top       - if true, the link ALSO sits directly under the Help menu (above the
//               Documentation folder), so casual users see it without drilling in.
//   menuId    - id of the app menu this doc explains (the id passed to addGUIMenu in
//               src/index.js: "video", "traverse", "terrain", ...). Drives the
//               contextual "Help" folder at the top of that menu. Omit if the doc
//               doesn't belong to one menu.
//   role      - what KIND of document this is, which is not the same as what it covers:
//                 "tutorial"    - walks you through doing something
//                 "reference"   - look things up in it
//                 "methodology" - how to reach a defensible conclusion
//                 "case-study"  - a worked real-world example
//               Added because gimbal-recreate.md was filed as a worked example when it
//               is really a build tutorial, and nothing in the data said so.
//   chatDesc  - if set, the doc is offered to the AI assistant via getHelpDoc, under
//               the basename derived from `file` (so the name always matches a real
//               docs/<name>.md). Phrase it the way users ask questions so the model
//               knows when to open it. Omit to keep a doc out of the AI list.
//
// Internal architecture/plan docs (docs/dev/, docs/plans/, *Internals.md, *Plan.md)
// and other developer-only references must NOT be listed here.
//
// NOTE ON LENGTH: getHelpDoc (chatbot.php) reads docs/<name>.md and truncates it, so a
// doc past the limit is silently invisible to the assistant from that point on — it does
// not error, it just answers as though the rest of the file doesn't exist. The limit is
// AI_DOC_CHAR_LIMIT below and is asserted by tests/docsRegistry.test.js; keep it in step
// with the constant in sitrecServer/chatbot.php. Front-load AI-facing docs regardless.

// Must match the truncation limit in sitrecServer/chatbot.php (getHelpDocContent).
export const AI_DOC_CHAR_LIMIT = 60000;

// Help-menu grouping. Order here is the order the sub-folders appear in.
// `labelKey` resolves under menus.help.documentation.sections.* in src/i18n/en.js.
export const DOC_SECTIONS = [
    {id: "start", labelKey: "menus.help.documentation.sections.start"},
    {id: "data", labelKey: "menus.help.documentation.sections.data"},
    {id: "world", labelKey: "menus.help.documentation.sections.world"},
    {id: "video", labelKey: "menus.help.documentation.sections.video"},
    {id: "analysis", labelKey: "menus.help.documentation.sections.analysis"},
    {id: "examples", labelKey: "menus.help.documentation.sections.examples"},
    {id: "advanced", labelKey: "menus.help.documentation.sections.advanced"},
];

export const helpDocs = [

    // ── Start here ──────────────────────────────────────────────────────────
    {
        file: "docs/CustomSitchTool", labelKey: "menus.help.gettingStarted",
        section: "start", top: true, role: "tutorial",
        chatDesc: "START HERE for any 'how do I use Sitrec / how do I get started / how do I make a sitch' question. The main getting-started guide: what Sitrec and a 'sitch' are, why a camera gives you a direction but not a distance, then three routes in depending on what the user has — filmed it themselves from the ground, has an aircraft flight track, or has a video with embedded metadata. Covers loading a Featured example to watch first, importing data (drag-and-drop or File → Import File), setting up the camera (position/heading/FOV) and target, two-track (camera+target) setups, syncing video, setting the date/time (Start Time vs Now Time), setting a location by name (Lookup/Geolocate), terrain, and adding satellites. Recommend this first for general 'how do I' questions, then point to the more specific docs.",
    },
    {
        file: "docs/DefensibleAnalysis", labelKey: "menus.help.documentation.defensibleAnalysis",
        section: "start", top: true, role: "methodology",
        chatDesc: "How to reach a conclusion with Sitrec that will survive scrutiny, and how to write it up. Read this for ANY question of the form 'is this conclusion valid', 'how do I know the speed/range/altitude is right', 'what can I claim from this', 'how certain is this', 'how do I put an error bar on it', 'why do different methods disagree', or 'what does the verdict mean'. Covers the fundamental limit that bearings do not determine range, auditing your inputs before fitting (time, field of view, altitude datum, the bad-data filter, smoothing, wind, circular line-of-sight), choosing a method, the sanity checks to run, what a good fit does and does not license, what to do about uncertainty when Sitrec deliberately does not compute an error bar, reading the executive verdict without over-reading it, and a write-up template.",
    },
    {
        file: "docs/WhatsNew", labelKey: "menus.help.whatsNew",
        section: "start", top: true, role: "reference",
        // The changelog is ~200 KB and grows every release, so it will always exceed the
        // truncation limit. That is acceptable HERE and only here, because it is strictly
        // newest-first: the limit buys the assistant many recent releases, which is what
        // "what's new" questions are about. It stopped being a real problem once the
        // epistemic contract (verdict wordings, the not-modelled list) was promoted out of
        // the changelog and into docs/TraverseAnalysis.md and docs/DefensibleAnalysis.md —
        // before that, the changelog was the only place those were written down, and
        // truncating it hid them.
        aiTruncationExpected: true,
        chatDesc: "Recent changes and new features in Sitrec, newest first.",
    },
    {
        file: "README", labelKey: "menus.help.documentation.about",
        section: "start", role: "reference",
        // No chatDesc: README.md lives at the repo root, not docs/, so getHelpDoc
        // could not resolve it. tests/docsRegistry.test.js enforces this.
    },
    {
        file: "docs/UserInterface", labelKey: "menus.help.documentation.uiBasics",
        section: "start", role: "reference",
        chatDesc: "Using the interface: opening/dragging-off/re-docking menus, folders, sliders, color pickers, moving and resizing views/windows (hold the Q key), navigating the 3D main view with the mouse, the Time/Date controls, and changing the terrain imagery and elevation source. Read for any 'how do I use the menus / close a popped-off menu / move a view / set the time' question.",
    },
    {
        file: "docs/KeyboardShortcuts", labelKey: "menus.help.documentation.keyboardShortcuts",
        section: "start", role: "reference",
        chatDesc: "The keyboard shortcuts in Sitrec, grouped by what they do: playback and frame stepping, the In/Out range, view layout (Q) and view presets (1-8), moving the camera and target (C and X), measuring (V and B), walking (WASD), nudging the start time, undo/redo, save/open, and tool-specific keys. Also lists the keys that collide. Not exhaustive — legacy sitches bind extra keys of their own. Read for 'what is the shortcut for X', 'what does key K do', or 'why did pressing O not do what I expected'.",
    },
    {
        file: "docs/Glossary", labelKey: "menus.help.documentation.glossary",
        section: "start", role: "reference",
        chatDesc: "Definitions of Sitrec and UAP-analysis vocabulary: sitch, traverse, line of sight (LOS), node, track, ADS-B, TLE and OMM, MISB and KLV, FMV, PTZ, FOV, azimuth and elevation, frustum, HAE/MSL/AGL, geoid undulation, ECEF/ENU/LLA, QNE/QNH, flight level, parallax, and more. Use when the user asks 'what is a X' or 'what does X mean'.",
    },

    // ── Data and tracks ─────────────────────────────────────────────────────
    {
        file: "docs/Tracks", labelKey: "menus.help.documentation.tracks",
        section: "data", menuId: "contents", role: "reference",
        chatDesc: "Importing and working with tracks (aircraft ADS-B/KML/KMZ, drone CSV/SRT, MISB/KLV, FlightRadar24, GeoJSON, ASTERIX radar, balloon): how a track is created from data, importing via drag-and-drop or the File menu, the Generic CSV column format, filtering bad data and why that filter encodes a physical assumption, what smoothing costs you, altitude handling and the altitude lock's datum, multi-track (camera+target) setups, and exporting. Read this for 'how do I make/have a track of azimuth/elevation (az/el)' — covered under 'Camera Angle Tracks': a CSV of frame-or-time plus az/el/heading/fov columns that drives the camera's pointing angles.",
    },
    {
        file: "docs/KMLDataSources", labelKey: "menus.help.documentation.kmlDataSources",
        section: "data", role: "reference",
        chatDesc: "Where to GET flight data, and which export option to choose. Read this for 'how do I find out if it was a plane', 'how do I get ADS-B data', 'how do I download a flight track', or any question naming ADS-B Exchange, FlightRadar24, FlightAware, Planefinder or RadarBox. Names the exact export button per service, explains ADS-B Exchange's three altitude options and which one to pick, warns that pasting a live map URL does not import a track, and covers the KML/KMZ structures Sitrec understands.",
    },
    {
        file: "docs/SavingAndLoading", labelKey: "menus.help.documentation.savingLoading",
        section: "data", menuId: "file", role: "reference",
        chatDesc: "Saving, loading, and sharing sitches — versioned server/S3 saves vs fast local-folder saves, what a saved sitch does and does not capture, and how to hand an analysis to someone else so they can reproduce it.",
    },
    {
        file: "docs/CustomModels", labelKey: "menus.help.documentation.customModels",
        section: "data", menuId: "objects", role: "reference",
        chatDesc: "Displaying and importing 3D models and the Model Inspector. Sitrec imports two model file formats: GLB (binary glTF) and PLY (mesh, Gaussian splat, or point cloud). Plain .gltf is NOT accepted — export as .glb. Also covers the built-in aircraft/aerostat models, simple shapes, sizing, and preparing a model in Blender.",
    },
    {
        file: "docs/ObjectReferences", labelKey: "menus.help.documentation.objectReferences",
        section: "data", menuId: "objects", role: "reference",
        chatDesc: "Reference objects: placing a known object in the scene to check the reconstruction against something whose position or size you already know.",
    },

    // ── The world ───────────────────────────────────────────────────────────
    {
        file: "docs/GIS", labelKey: "menus.help.documentation.gis",
        section: "world", role: "reference",
        chatDesc: "Coordinate systems, geography and altitude: the WGS84 ellipsoid, the sphere-vs-ellipsoid Earth model setting and its scale error, ECEF/LLA/ENU, the EGM96 geoid, and the altitude datums (HAE vs MSL vs AGL vs barometric pressure altitude). Includes a table of geoid undulation by city and a diagnostic table for recognising a datum error from its signature — read that for 'my track is underground', 'my track is too high', 'the altitude is wrong', or any question about which altitude a data source really reports.",
    },
    {
        file: "docs/Terrain", labelKey: "menus.help.documentation.terrain",
        section: "world", menuId: "terrain", role: "reference",
        chatDesc: "The Terrain menu: map imagery vs elevation source (two different dropdowns), the elevation sources and their real ground resolution, Google Photorealistic and Cesium 3D buildings, which surface a ground or AGL query actually hits and why three different answers are possible, the sea and why bathymetry is discarded, dynamic subdivision, and the settings that silently change elevation accuracy. Read for 'why is my object underground', 'what altitude is the sea', 'why did the ground height change', or anything about terrain accuracy.",
    },
    {
        file: "docs/Refraction", labelKey: "menus.help.documentation.refraction",
        section: "world", role: "reference",
        chatDesc: "Atmospheric refraction: why distant things appear higher than geometry says, the celestial and terrestrial models Sitrec implements, that refraction is OFF by default and where the switch is (View menu), and how much it moves the horizon. Read for any question about the horizon distance, whether something was hidden behind the Earth's curvature, 'could I see X from Y', mirages, or looming.",
    },
    {
        file: "docs/Wind", labelKey: "menus.help.documentation.wind",
        section: "world", menuId: "physics", role: "reference",
        chatDesc: "The Wind menu: setting wind speed and direction, pulling real-world atmospheric data, and drawing streamlines and arrows.",
    },
    {
        file: "docs/AtmosphericAerialPerspective", labelKey: "menus.help.documentation.aerialPerspective",
        section: "world", role: "reference",
        chatDesc: "Atmospheric haze and aerial perspective: how distance washes out contrast and colour, and what that implies about how far away something in a photograph was.",
    },

    // ── Video ───────────────────────────────────────────────────────────────
    {
        file: "docs/Video", labelKey: "menus.help.documentation.video",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "Rendering and exporting video and still frames (Video → Video Render & Export): which view gets rendered, MP4/H.264 vs WebM/VP8, resolution and bitrate, HD/retina export, including audio, looping, 'unique frames only', waiting for background loading, recording the browser window, and exporting a single frame as JPG or PNG. Read for 'how do I export/save/render a video', 'how do I make a movie', or 'how do I save a screenshot'.",
    },
    {
        file: "docs/Masking", labelKey: "menus.help.documentation.masking",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "Masking out part of the video frame (Video → Masking) so analysis ignores it: painting a mask by hand, the automatic ground/sky methods for masking out trees and terrain, auto-masking a burned-in OSD or redactions, and which tools obey the mask (Star Tracker 'Use mask', Point Track 'Use Mask', Motion Analysis, panorama export). Read this for 'how do I stop it detecting the trees as stars', 'how do I ignore the timestamp / on-screen text', 'how do I mask out the ground', or any question about the Masking menu.",
    },
    {
        file: "docs/StarTracker", labelKey: "menus.help.documentation.starTracker",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "The Star Tracker (Video → Star Tracker): finding the stars in a video or photograph and working out where the camera was pointing from them. Covers detecting point sources and the detect threshold, tracks and how moving objects are told apart from stars, the lens calibration and why a fisheye needs one, identifying the field against the star catalog with no location or time assumed, masking out the ground so foliage is not detected as stars, syncing the look camera to the solved star field, and the star chart. Also the way to MEASURE a camera's field of view rather than guessing it. Read this for 'how do I identify the stars in my video', 'what was the camera pointing at', 'how do I work out the field of view', or any question about the Star Tracker's controls or overlay.",
    },
    {
        file: "docs/PointTrack", labelKey: "menus.help.documentation.pointTrack",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "Point Track (Video → Point Track): following an object through the video automatically, and stabilizing the footage on it. Covers the seven tracking methods (template match, optical flow, centroid on bright/dark/colour, high/low peak — an eighth, SAM2, exists only on local development builds), track and search radius, using the mask and which methods actually honour it, seeding a keyframe by DRAGGING the cursor onto the object rather than clicking, advancing the track with ' and rewinding with ; (which deletes as it goes), deleting keyframes, and the Stabilize and Render Stabilized options. Read for 'how do I track the object', 'how do I stabilize the video', or 'how do I get a line of sight from the video'.",
    },
    {
        file: "docs/LongExposure", labelKey: "menus.help.documentation.longExposure",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "Simulating a long-exposure photograph (Video → Long Exposure) so moving aircraft, satellites, and stars leave trails.",
    },
    {
        file: "docs/LensGhost", labelKey: "menus.help.documentation.lensGhost",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "Lens ghosts and internal reflections: recognising when the 'object' in a video is an artefact of the optics rather than something in the sky, and testing that explanation geometrically. Read for 'could this be a lens flare / reflection / internal reflection', or when a light moves opposite to, or mirrored about, a bright source.",
    },

    // ── Analysis ────────────────────────────────────────────────────────────
    {
        file: "docs/TraverseMethods", labelKey: "menus.help.documentation.traverseMethods",
        section: "analysis", menuId: "traverse", role: "reference",
        chatDesc: "How the target/UAP path (the 'traverse') is computed from the camera lines of sight, method by method — constant distance, constant speed, constant altitude, straight line, wind-blown, terrain, and the global fits (constant velocity, constant acceleration, Kalman, Monte Carlo, minimum acceleration, minimum speed, and the physics models for balloons, sky lanterns, fixed-wing aircraft and quadcopters). Each method's entry says what it ASSUMES and what it does NOT establish. Read for 'how does method X work', 'which traverse should I use', or 'why do the methods disagree'.",
    },
    {
        file: "docs/TraverseAnalysis", labelKey: "menus.help.documentation.traverseAnalysis",
        section: "analysis", menuId: "traverse", role: "reference",
        chatDesc: "The Analyze Traverse Methods button and what it produces: the hypothesis gallery, how tiles are ranked, solution families and range bands, the plausibility checks, and the executive verdict — all five verdict wordings, exactly what each one licenses you to say, and the list of causes Sitrec has no model for at all. Read this for 'what does the verdict mean', 'what does Probably a wind-blown balloon mean', 'what does Unresolved mean', 'how do I read the analysis gallery', or 'can I quote this result'.",
    },
    {
        file: "docs/BOTBench", labelKey: "menus.help.documentation.botBench",
        section: "analysis", menuId: "file", role: "reference",
        chatDesc: "The BOTBench window (File → File Analysis → BOTBench...) — BOT = Bearings-Only Traversal: running the traverse analysis over a whole folder of BOT benchmark scenarios or MISB FMV clips and comparing the results in one table. Covers every control, summary tile and table column (the SOURCE quality measurements — baseline, sweep, rcond, the pointing-noise estimate vs the declared sigma — and the ANALYSIS verdict/interpretation columns), what a bulk run deliberately cannot do, how results are scored against truth, the BOT interchange CSV format and its scenario.json sidecar, how the scenario files are generated (bench-bot-interchange, sealed releases), and a glossary of the technical terms used. Read for 'what is BOTBench / BotBench', 'what does the rcond/Base/Sweep/Src column mean', 'how do I run the analysis on many files', or 'where do the bot-NNNN.input.csv files come from'.",
    },
    {
        file: "docs/satcam", labelKey: "menus.help.documentation.cameraModes",
        section: "analysis", menuId: "camera", role: "reference",
        chatDesc: "Look-camera orientation modes (Normal vs Satellite PTZ) — how the camera points and how the look angle is defined.",
    },
    {
        file: "docs/Starlink", labelKey: "menus.help.documentation.starlink",
        section: "analysis", menuId: "satellites", role: "tutorial",
        chatDesc: "Investigating Starlink satellite flares, and more generally recreating a sighting seen from a fixed spot on the ground: loading satellites for a date (Satellite menu, 'Load LEO Satellites For Date'), orbital data and why very recent events need a few days' wait, and the flare band / sun-angle tools. Its step-by-step walkthrough (date and time, camera location by street address, pointing direction, adding the video, refining) applies to any ground-observer case, not just Starlink.",
    },

    // ── Worked examples ─────────────────────────────────────────────────────
    {
        file: "docs/gimbal-recreate", labelKey: "menus.help.documentation.gimbalRecreate",
        section: "examples", role: "tutorial",
        chatDesc: "A step-by-step walkthrough of BUILDING a sitch for the Navy 'Gimbal' UAP video by drag-and-drop. This is a construction tutorial, not an analysis of the case — for what the Gimbal geometry can and cannot establish (it is the classic case where range is not determined by the data), see the traverse analysis docs.",
    },
    {
        file: "docs/Nimitz", labelKey: "menus.help.documentation.nimitz",
        section: "examples", role: "case-study",
        chatDesc: "The Nimitz / 'Tic Tac' 2004 case as a worked example of handling conflicting evidence: a per-parameter table of every reconstruction value with its source and a confidence grade, a catalogue of the conflicts between different tellings, competing hypotheses set up as switchable configurations, and an explicit list of what remains unknown. The best model in the docs for how to document an analysis whose sources disagree.",
    },
    {
        file: "docs/Football", labelKey: "menus.help.documentation.football",
        section: "examples", menuId: "physics", role: "case-study",
        chatDesc: "The football/Spidercam wire-strike scenario: launching a ball with real ballistic physics (drag, Magnus lift from spin, bounces) against a cable-cam rig. Also a worked example of a reconstruction that is partly fitted to the claim it is testing, and what that means for what it can show.",
    },

    // ── Advanced ────────────────────────────────────────────────────────────
    {
        file: "docs/LocalCustomSitches", labelKey: "menus.help.documentation.localCustomSitches",
        section: "advanced", role: "reference",
        chatDesc: "Hand-authoring a sitch as JSON, for setups the drag-and-drop tool cannot express. Covers the file structure, where local sitches live, and how they are loaded.",
    },
    {
        file: "docs/ScriptedVideo", labelKey: "menus.help.documentation.scriptedVideo",
        section: "advanced", menuId: "video", role: "reference",
        chatDesc: "The scripting language for cinematic camera moves and automated video production: writing a script of timed camera moves, cuts and captions, and rendering it out. Read for 'how do I animate the camera', 'how do I make a fly-through', or 'how do I script a video'.",
    },
    {
        file: "docs/WhatsNew-Details", labelKey: "menus.help.documentation.whatsNewDetails",
        section: "advanced", role: "reference",
        // No chatDesc: ~1 MB, so the assistant would only ever see the newest fraction.
        // docs/WhatsNew is the AI-facing changelog.
    },
];

// Basename used by getHelpDoc (docs/<name>.md). Strips the "docs/" prefix so the
// chat doc-name is always the real filename the Help menu links to.
export function chatDocName(file) {
    return file.startsWith("docs/") ? file.slice("docs/".length) : file;
}

// Build the {docName: description} map the chat view sends to chatbot.php as
// `availableDocs`. Only docs with a chatDesc are offered to the AI assistant.
export function getChatAvailableDocs() {
    const docs = {};
    for (const d of helpDocs) {
        if (d.chatDesc) docs[chatDocName(d.file)] = d.chatDesc;
    }
    return docs;
}

// Docs belonging to a given app menu, for that menu's contextual "Help" folder.
export function getDocsForMenu(menuId) {
    return helpDocs.filter(d => d.menuId === menuId);
}
