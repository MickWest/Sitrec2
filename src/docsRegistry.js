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


import {getEnvBool} from "./envUtils";

/**
 * The URL for one registry doc, built the SAME way the Help menu builds it.
 *
 * Two forms, because a build without LOCAL_DOCS has no docs to serve: locally
 * the rendered .html sits beside the app, otherwise the raw .md on GitHub. Any
 * surface that wants to link a doc must come through here — a hard-coded
 * "./docs/X.html" silently 404s in the second case, which is most deployments.
 *
 * `absolute` resolves against the current page. The analysis report is the
 * reason it exists: it is generated in the browser and then DOWNLOADED, so a
 * relative link in it breaks the moment the file is opened from disk.
 */
export function docUrl(file, {anchor = null, absolute = false} = {}) {
    const frag = anchor ? `#${anchor}` : "";
    if (!getEnvBool("LOCAL_DOCS", process.env.LOCAL_DOCS)) {
        return `https://github.com/MickWest/Sitrec2/blob/main/${file}.md${frag}`;
    }
    const rel = `./${file}.html${frag}`;
    if (!absolute || typeof window === "undefined") return rel;
    try {
        return new URL(rel, window.location.href).href;
    } catch (e) {
        return rel;
    }
}
//
// Each entry:
//   file      - path for the Help-menu link, WITHOUT extension. Usually
//               "docs/<Name>" (linked as docs/<Name>.md or .html); "README" is special.
//   labelKey  - i18n key for the Help-menu label (see menus.help.* in src/i18n/en.js).
//   section   - which group the doc sits in, in the Help menu and the docs index.
//               One of the keys in DOC_SECTIONS below. OMIT it to keep the doc out of
//               the Help menu entirely: it stays listed in README.md and, if it has a
//               chatDesc, stays available to the AI assistant. That is for the bespoke
//               case-study docs, which are of no use to a typical user and only made the
//               menu longer.
//   top       - if true, the link ALSO sits directly under the Help menu (above the
//               Documentation folder), so casual users see it without drilling in.
//   menuId    - id of the app menu this doc explains (the id passed to addGUIMenu in
//               src/index.js: "video", "traverse", "terrain", ...). Drives the
//               contextual "Help" folder at the top of that menu. An array lists a doc
//               under several menus (["camera", "target"]). Omit if the doc doesn't
//               belong to a menu.
//   role      - what KIND of document this is, which is not the same as what it covers:
//                 "tutorial"    - walks you through doing something
//                 "reference"   - look things up in it
//                 "methodology" - how to approach an analysis (no doc uses it at present)
//                 "case-study"  - a worked real-world example
//               Added because gimbal-recreate.md was filed as a worked example when it
//               is really a build tutorial, and nothing in the data said so.
//   chatDesc  - if set, the doc is offered to the AI assistant via getHelpDoc, under
//               the basename derived from `file` (so the name always matches a real
//               docs/<name>.md). Phrase it the way users ask questions so the model
//               knows when to open it. Omit to keep a doc out of the AI list.
//
// Internal architecture docs (docs/dev/, *Internals.md) and other developer-only
// references must NOT be listed here.
//
// Plans, roadmaps and review reports must not be under docs/ AT ALL — they belong in
// private/notes/ — the nested private repo, outside docs/ and gitignored. Everything under docs/ is
// published to the live site both as rendered .html and as raw .md, and the raw .md is
// what getHelpDoc feeds the assistant, so a plan left in docs/ ships and gets quoted.
//
// NOTE ON LENGTH: getHelpDoc (chatbot.php) reads docs/<name>.md and truncates it, so a
// doc past the limit is silently invisible to the assistant from that point on — it does
// not error, it just answers as though the rest of the file doesn't exist. The limit is
// AI_DOC_CHAR_LIMIT below and is asserted by tests/docsRegistry.test.js; keep it in step
// with the constant in sitrecServer/chatbot.php. Front-load AI-facing docs regardless.

// Must match the truncation limit in sitrecServer/chatbot.php (getHelpDocContent).
export const AI_DOC_CHAR_LIMIT = 80000;

// Help-menu grouping. Order here is the order the sub-folders appear in.
// `labelKey` resolves under menus.help.documentation.sections.* in src/i18n/en.js.
export const DOC_SECTIONS = [
    {id: "start", labelKey: "menus.help.documentation.sections.start"},
    {id: "data", labelKey: "menus.help.documentation.sections.data"},
    {id: "world", labelKey: "menus.help.documentation.sections.world"},
    {id: "video", labelKey: "menus.help.documentation.sections.video"},
    {id: "analysis", labelKey: "menus.help.documentation.sections.analysis"},
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
        file: "docs/WhatsNew", labelKey: "menus.help.whatsNew",
        section: "start", top: true, role: "reference",
        // The changelog is ~200 KB and grows every release, so it will always exceed the
        // truncation limit. That is acceptable HERE and only here, because it is strictly
        // newest-first: the limit buys the assistant many recent releases, which is what
        // "what's new" questions are about. It stopped being a real problem once the
        // epistemic contract (verdict wordings, the not-modelled list) was promoted out of
        // the changelog and into docs/TraverseAnalysis.md ("The executive verdict") —
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
        section: "start", menuId: ["main", "view", "showhide"], role: "reference",
        chatDesc: "Using the interface: opening/dragging-off/re-docking menus, folders, sliders, color pickers, moving and resizing views/windows (hold the Q key), navigating the 3D main view with the mouse, the Time/Date controls, and changing the terrain imagery and elevation source. Read for any 'how do I use the menus / close a popped-off menu / move a view / set the time' question.",
    },
    {
        file: "docs/TimeAndSync", labelKey: "menus.help.documentation.timeAndSync",
        section: "start", menuId: "time", role: "reference",
        chatDesc: "How do I sync my video to a flight track or set the correct date and time? This explains Start Time and Now Time, time zones, fps and 29.97 videos, Sitch Frames and Duration, In/Out frames, Live Mode, Sync Time to and Sync Duration to, and the playback bar and time keys. It also covers how tracks and video frames line up with the timeline.",
    },
    {
        file: "docs/AIAssistant", labelKey: "menus.help.documentation.aiAssistant",
        section: "start", role: "reference",
        chatDesc: "The AI assistant itself (Help → AI Assistant, or Tab): what it is, what it can and cannot do, and how to get good results from it. Covers the range of actions it can take (camera, time, sky and satellites, menus, objects, views, tracks, notes, saving, reading these docs), the simple commands Sitrec matches locally without a model, that its actions are real edits which mark the sitch unsaved and are only partly covered by undo, the confirmation prompt when the sitch came from a link, phrasing advice, choosing a model (Settings → AI Model: Sitrec's own models per account tier, 'Auto (economy)', your own key, your own server) and what changes between those routes, the header bar's model readout, the spoken assistant and its two microphone buttons, and a plain list of what it is bad at. Read for 'what can the assistant do', 'how do I use the chat', 'why did it not do what I asked', 'which AI model should I pick', 'how do I talk to it', or 'can it see the video'. For where API keys are stored and what protects them, read APIKeys instead.",
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
    {
        file: "docs/SceneObjects", labelKey: "menus.help.documentation.sceneObjects",
        section: "data", menuId: "objects", role: "reference",
        chatDesc: "How do I add a building, clouds, a ground overlay image or a measurement grid to my sitch, and how do I edit or delete them? What does each item in the right-click ground menu do, such as Drop Pin, Add 3D Object, Create Track with Object or Add Balloon? How do I line up a map or satellite image with the ground?",
    },

    // ── The world ───────────────────────────────────────────────────────────
    {
        file: "docs/CameraAndTarget", labelKey: "menus.help.documentation.cameraAndTarget",
        section: "world", menuId: ["camera", "target"], role: "reference",
        chatDesc: "Every control in the Camera and Target menus: where the camera is (Manual position, Flight Sim, Orbit, an imported track), which way it points (Manual pan/tilt, To Target, Custom Az/El, Relative Heading, MX-style roll) and its field of view (VFOV/HFOV, 35mm equivalent, Lock Aspect), plus Camera Tweaks, Smoothing, Tracking Wobble, Export Camera as KML, and the target's position, Target Track and Stop At. Read for 'how do I put the camera at a spot', 'how do I point the camera at another plane', 'how do I orbit around something', or 'what does this camera setting do'.",
    },
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
        section: "world", menuId: ["view", "effects"], role: "reference",
        chatDesc: "Atmospheric refraction: why distant things appear higher than geometry says, the celestial and terrestrial models Sitrec implements, that refraction is OFF by default and where the switch is (View menu), and how much it moves the horizon. Read for any question about the horizon distance, whether something was hidden behind the Earth's curvature, 'could I see X from Y', mirages, or looming.",
    },
    {
        file: "docs/Wind", labelKey: "menus.help.documentation.wind",
        section: "world", menuId: "physics", role: "reference",
        chatDesc: "The Wind menu: setting wind speed and direction, pulling real-world atmospheric data, and drawing streamlines and arrows.",
    },
    {
        file: "docs/HistoricSkies", labelKey: "menus.help.documentation.historicSkies",
        section: "world", role: "reference",
        chatDesc: "Reconstructing the sky for dates long before the modern UFO era - the 1896-97 airship waves, the 1909 scareships, and anything else back to 1700. How to reach a historic date (Go To box, the Year field, ?datetime=, a sitch's startTime) and how the Year slider's range extends. What is accurate and to what: Sun/Moon/planet positions, the EQJ-to-ECEF frame transform, precession, and Delta-T. What is not: stellar proper motion (catalogue epoch J1991.25, a few arcminutes by 1897), UT1-UTC, and the legacy sidereal helpers that skip precession. Time zones before standard time, and why daylight saving did not exist before 1916/1918. What is anachronistic (modern imagery and buildings, no satellites before 1957). Read for 'can Sitrec do historic dates', 'how far back does it go', 'why is the year slider limited', 'is the sky accurate for 1897', or any question about a 19th- or early-20th-century sighting.",
    },
    {
        file: "docs/Lighting", labelKey: "menus.help.documentation.lighting",
        section: "world", menuId: "lighting", role: "reference",
        chatDesc: "Reference for every control in the Lighting menu: sun, ambient and scattered light, exposure, shadows, atmosphere and haze, the look-view tone mapping, halos and the Brocken spectre, city lights, and eclipses. Read for 'why is my night scene so bright/dark', 'how do I turn on shadows', 'how do I match the video's exposure', or 'are the city lights real'.",
    },
    {
        file: "docs/LunarEclipse", labelKey: "menus.help.documentation.lunarEclipse",
        section: "world", menuId: "lighting", role: "reference",
        chatDesc: "Lunar eclipses (Lighting menu -> Lunar Eclipse): the Earth's shadow on the Moon. What the penumbra and umbra are and why the umbral edge is soft, why a totally eclipsed Moon turns red (sunlight refracted through the Earth's atmosphere, with the blue scattered out) and why there is a turquoise fringe at the umbral edge (ozone). The controls: Atmospheric Clarity and how it walks the Danjon L0-L4 scale of how dark an eclipse looks, why exposure has to be raised at all when totality is ten magnitudes below a full Moon, and Shadow Outlines, which rings the whole umbra and penumbra at the Moon's distance. Also the 88 km shadow enlargement and the Chauvenet/Danjon dispute behind it. Includes dates of recent and forthcoming eclipses, and what is and is not modelled. Read this for 'why is the Moon red', 'blood moon', 'how do I show a lunar eclipse', 'what is the umbra', 'what is the Danjon scale', or any question about eclipses of the Moon. NOT for solar eclipses or for the Moon's shadow on the Earth.",
    },
    {
        file: "docs/AtmosphericAerialPerspective", labelKey: "menus.help.documentation.aerialPerspective",
        section: "world", menuId: "lighting", role: "reference",
        chatDesc: "Atmospheric haze and aerial perspective: how distance washes out contrast and colour, and what that implies about how far away something in a photograph was.",
    },

    // ── Video ───────────────────────────────────────────────────────────────
    {
        file: "docs/LoadingVideo", labelKey: "menus.help.documentation.loadingVideo",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "How do I load a video into Sitrec, and which formats work? How do I fix the frame rate, rotate the video, or zoom and pan in the video view? What do Video Adjustments, Video Processing, the Grid, Annotations, Error Level Analysis and Noise Analysis do?",
    },
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
        chatDesc: "Point Tracking (Video \u2192 Point Track): following an object through the video automatically, then using the track as a line of sight and to stabilize the footage. Covers the standard procedure (drag the cursor onto the object, choose Motion (Background), press Analyse Object, then Start Point Track), recovering a track that goes wrong (Clear from Here, user points, analysing again inside a hard section), the tracking methods and when each is right, how Motion (Background) and Analyse Object work, Show Motion Field, the Traverse LOS Source Camera + Point Track and how Point Track differs from Manual Tracking (Camera + Object Track) and Ground Track (Camera + Ground Track), the field-of-view caveat, Stabilize and Render Stabilized Video / Expanded, and a symptom-by-symptom troubleshooting table for every setting (radii, Feature Size, polarity, frame gap, parallax slack, threshold, mask, smoothing, Edit Head Only, analysis resolution). Read for 'how do I track the object', 'why did the track jump or get lost', 'how do I stabilize the video', or 'how do I get a line of sight from the video'.",
    },
    {
        file: "docs/MotionAnalysis", labelKey: "menus.help.documentation.motionAnalysis",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "How do I measure camera or background motion in a video, stabilize a shaky pan, or stitch a pan into a panorama? Covers Video > Motion Analysis (Analyze Motion, Export Motion CSV, Create Track from Motion, Stabilize Video, Motion and Feature panoramas, De-Fence). Also covers Camera Motion (Background), Horizon Extractor and OSD Tracker.",
    },
    {
        file: "docs/LongExposure", labelKey: "menus.help.documentation.longExposure",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "Simulating a long-exposure photograph (Video → Long Exposure) so moving aircraft, satellites, and stars leave trails.",
    },
    {
        file: "docs/VideoTonalRange", labelKey: "menus.help.documentation.videoTonalGraph",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "The Video Tonal Range graph: per-frame brightness percentiles and a temporal histogram, using the enabled video mask. Also compares a Point Track object's brightness with its local background. Recorded intensity is not temperature. Read for brightness distribution, dynamic range, thermal contrast, or possible global gain changes.",
    },
    {
        file: "docs/VideoQPGraph", labelKey: "menus.help.documentation.videoQPGraph",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "The video QP graph (Video → Forensics → QP Graph): a graph of the H.264 quantization parameter (QP) of the loaded video, with the maximum, mean and minimum macroblock QP of every frame, read from the bitstream itself (the same values as FFmpeg -debug qp). Covers what QP means for compression loss, how to read the three lines, which streams it cannot read (non-H.264 codecs, CAVLC, interlaced), and why one QP number does not describe a whole video. Read for 'how compressed is this video', 'what QP was this encoded at', 'how much did the compression change during the clip', or questions about compression quality of on-screen text.",
    },
    {
        file: "docs/MQ9TrackingSimulation", labelKey: "menus.help.documentation.mq9Tracking",
        section: "video", menuId: "camera", role: "reference",
        chatDesc: "The MQ9 tracking simulation (Camera > MQ9 Tracking): simulating an operator acquiring and following a rendered scene object behind the MQ9 sensor overlay. Covers the acquisition gate and how its metre label is estimated from where the boresight meets the terrain, the handoff to tracking corners, temporary loss and reacquisition, and operator control. Read for 'how do I simulate tracking an object', 'what do the tracking corners mean', or questions about the acquisition box. Note this simulates an operator tracking a SCENE object - it does not do computer vision on a loaded video, which is Point Track.",
    },
    {
        file: "docs/LensGhost", labelKey: "menus.help.documentation.lensGhost",
        section: "video", menuId: "video", role: "reference",
        chatDesc: "The Lens Ghost tool: how a bright source such as the Sun can make a ghost image through internal reflection in the optics, what the tool models, every control, and what Fit computes and outputs. Read for 'could this be a lens flare / reflection / internal reflection', or when a light moves opposite to, or mirrored about, a bright source.",
    },

    // ── Analysis ────────────────────────────────────────────────────────────
    {
        file: "docs/TraverseConcepts", labelKey: "menus.help.documentation.traverseConcepts",
        section: "analysis", menuId: "traverse", role: "tutorial",
        chatDesc: "The ideas a reader needs before the traverse analysis, one picture each, in the order they build: a ray gives direction not distance; the exact-ray family; residual; parallax and why a turning platform prices wrong ranges; conditioning and rcond; priors; the ordinariness cost and object classes; search box versus envelope; the verdict as a survivor count; relSep, rank-1 and blind; the Nelder-Mead simplex and its stop rule; IFOV and sub-pixel size bounds; the two ladders and slant versus horizontal range; the existence test; dynamics order and the fast-far trap; the benchmark botsets. Read this for 'what is a residual', 'what is a prior', 'what is a simplex', 'what does rcond mean', 'what is relSep', 'what is the exact-ray family', 'what is a bound hit', or any other term the analysis pages use without defining.",
    },
    {
        file: "docs/GroundTrack", labelKey: "menus.help.documentation.groundTrack",
        section: "analysis", menuId: "traverse", role: "reference",
        chatDesc: "Ground Track (Traverse \u2192 Ground Track): placing points ON THE GROUND behind the object \u2014 the hillside or coast it is silhouetted against \u2014 to get a line of sight that needs no field of view, and a hard ceiling on the object's range. Covers the Ctrl+click (Cmd+click) and click gestures in the look and main views, why a plain click still orbits, Spline vs Linear interpolation, why a rooftop point stays on the roof, why the track HOLDS rather than extrapolates outside the keyframes, Limit A/B to Track, placing against 3D tiles and objects, the Ground Range readout, and the 'Camera + Ground Track' LOS Source. Read for 'how far away could it have been', 'it passed in front of that hill', 'how do I get a line of sight without knowing the FOV', or any question about the Ground Track menu.",
    },
    {
        file: "docs/TraverseMethods", labelKey: "menus.help.documentation.traverseMethods",
        section: "analysis", menuId: "traverse", role: "reference",
        chatDesc: "How the target/UAP path (the 'traverse') is computed from the camera lines of sight, method by method — constant distance, constant speed, constant altitude, straight line, wind-blown, terrain, and the global fits (constant velocity, constant acceleration, Kalman, Monte Carlo, minimum acceleration, minimum speed, and the physics models for balloons, sky lanterns, fixed-wing aircraft and quadcopters). Each method's entry says what it ASSUMES and what it does NOT establish. Read for 'how does method X work', 'which traverse should I use', or 'why do the methods disagree'.",
    },
    {
        file: "docs/TraverseAnalysis", labelKey: "menus.help.documentation.traverseAnalysis",
        section: "analysis", menuId: "traverse", role: "reference",
        chatDesc: "The Analyze Traverse Methods button and what it produces: the hypothesis gallery, how tiles are ranked, solution families and range bands, the plausibility checks, the Ordinariness and Implied object size disclosure lines, and the executive verdict: its five codes, every headline wording, what sets each one, and the list of causes Sitrec has no model for. Read this for 'how do I read the analysis gallery', 'what do the tile badges mean', 'what is a solution family', 'what does the verdict mean', or 'why does a good fit read Unresolved'.",
    },
    {
        file: "docs/BOTBench", labelKey: "menus.help.documentation.botBench",
        section: "analysis", menuId: "file", role: "reference",
        chatDesc: "The BOTBench window (File → File Analysis → BOTBench...) — BOT = Bearings-Only Traversal: running the traverse analysis over a whole folder of BOT benchmark scenarios or MISB FMV clips and comparing the results in one table. Covers every control, summary tile and table column (the SOURCE quality measurements — baseline, sweep, rcond, the pointing-noise estimate vs the declared sigma — and the ANALYSIS verdict/interpretation columns), what a bulk run deliberately cannot do, how results are scored against truth, the BOT interchange CSV format and its scenario.json sidecar, and a glossary of the technical terms used. Where the scenario files come from is its own page — see docs/BOTBenchScenarios. Read for 'what is BOTBench / BotBench', 'what does the rcond/Base/Sweep/Src column mean', or 'how do I run the analysis on many files'.",
    },
    {
        // Split out of docs/BOTBench when that page passed the AI truncation
        // limit: a doc read past the limit is cut off mid-document and the model
        // cannot see what was removed. Provenance is the self-contained half, so
        // it separates cleanly and leaves the main page room to grow.
        file: "docs/BOTBenchScenarios", labelKey: "menus.help.documentation.botBenchScenarios",
        section: "analysis", menuId: "file", role: "reference",
        chatDesc: "Where BOTBench's scenario files come from: how the BOT benchmark scenarios are generated in the Sitrec source repository rather than shipped with it, the curated interchange set (bench-bot-interchange) versus the swept botsets and the single question each set was built to answer, the Input/Truth/All folder layout with its index.json and MANIFEST.json, sealed releases and their hash commitment, and the npm commands that build and export each set. Read for 'where do the bot-NNNN.input.csv files come from', 'how do I regenerate the benchmark scenarios', 'what is a botset', or 'what is a sealed release'.",
    },
    {
        file: "docs/BuildingMotionDatasets", labelKey: "menus.help.documentation.buildingMotionDatasets",
        section: "analysis", menuId: "file", role: "reference",
        chatDesc: "How to build the Mundane (mundane_v1), Extreme and Anomalies motion datasets for BOTBench and the Track Browser from the Sitrec source repository: the npm build commands and their parameters (--fps, --duration, --error, --generic-names, --out), full sets versus single sets, the 20 Extreme target maneuvers and 8 hypothetical Anomalies motions, the ten shared platform paths (two straight controls and eight curved), clean-machine setup, and the output folder layout with its README, manifest.json and timing.json. Read for 'how do I build the extreme / anomalies / mundane dataset', 'what motions are in the Anomalies set', or 'what platform paths do the datasets use'.",
    },
    {
        file: "docs/BOTBenchCharts", labelKey: "menus.help.documentation.botBenchCharts",
        section: "analysis", menuId: "file", role: "reference",
        chatDesc: "The Result Charts window (File \u2192 File Analysis \u2192 Result Charts...): interactive charts of a BOTBench result set, and the same figures exported for a paper. Covers the nine figures and what each answers, how to get data in (drop a joined results JSONL, or open it from a finished run), how to read a box plot whose whiskers use Tukey's rule applied in log space, why the exact Clopper-Pearson confidence intervals are wider than the usual ones, exporting SVG or a 300 dpi PNG from the browser with no extra tool, and the optional command-line renderer (npm run bot-charts) with every option. Read for 'how do I chart the BOTBench results', 'what do the whiskers mean', 'how do I export a figure for a paper', or 'why is the chart library downloaded separately'.",
    },
    {
        file: "docs/satcam", labelKey: "menus.help.documentation.cameraModes",
        section: "analysis", menuId: "camera", role: "reference",
        chatDesc: "Look-camera orientation modes (Normal vs Satellite PTZ) — how the camera points and how the look angle is defined. Also the two spellings of Pan (Az): signed -180..180 by default, or a 0-360 compass bearing via the 'Use 0-360 for Pan' checkbox, which changes the display only. Read for 'why is my pan negative', 'can I enter a heading of 270', or 'how do I show pan as a compass bearing'.",
    },
    {
        file: "docs/Fisheye", labelKey: "menus.help.documentation.fisheye",
        section: "analysis", menuId: "camera", role: "reference",
        chatDesc: "The fisheye / allsky projection for the look view (Camera → FOV (Zoom) → Fisheye): rendering fields of view of 180° and beyond through real lens curves (equidistant, equisolid, stereographic, orthographic), the image circle size/centre controls for matching a cropped 16:9 allsky frame, Roll, and the Point Straight Up allsky orientation (north up, east on the LEFT). Read this for 'how do I recreate an allsky/meteor camera video', 'why can't the FOV go past 170', 'the whole sky in one view', or any question about the Fisheye sub-menu.",
    },
    {
        file: "docs/PanoramicCamera", labelKey: "menus.help.documentation.panoramicCamera",
        section: "analysis", menuId: "camera", role: "reference",
        chatDesc: "Panoramic Camera mode under Camera → FOV (Zoom): horizontal FOV from 1 to 360 degrees, with a read-only vertical FOV derived from the horizontal FOV and the view's shape so both axes have the same scale (letterboxed at 180 degrees), wheel zoom, saved settings, and matching a swept panorama photograph. Equirectangular rendering with panorama-aware terrain and 3D tile detail.",
    },
    {
        file: "docs/Satellites", labelKey: "menus.help.documentation.satellites",
        section: "analysis", menuId: "satellites", role: "reference",
        chatDesc: "Reference for the Satellites menu: loading TLE/OMM satellite data for a date or from a file, choosing which satellites show, the Filter TLEs window, brightness and flare settings, arrows and labels, Satellite to Track, and the Satellite Ephemeris, Sky Plot and Star Chart views. Read for 'why don't I see any satellites', 'how do I load satellites for a past date', 'how do I show only one satellite', or 'which satellite made this flare'.",
    },
    {
        file: "docs/Starlink", labelKey: "menus.help.documentation.starlink",
        section: "analysis", menuId: "satellites", role: "tutorial",
        chatDesc: "Investigating Starlink satellite flares, and more generally recreating a sighting seen from a fixed spot on the ground: loading satellites for a date (Satellite menu, 'Load LEO Satellites For Date'), orbital data and why very recent events need a few days' wait, and the flare band / sun-angle tools. Its step-by-step walkthrough (date and time, camera location by street address, pointing direction, adding the video, refining) applies to any ground-observer case, not just Starlink.",
    },

    // ── Bespoke examples (not typical) ──────────────────────────────────────
    // Deliberately NOT in the Help menu — no `section`, and no `menuId`. These are
    // one-off case studies rather than things a typical user needs, so they are linked
    // from README.md under "Bespoke examples (not typical)" and offered to the AI
    // assistant, but they no longer take up a folder in Help > Documentation.
    {
        file: "docs/gimbal-recreate", labelKey: "menus.help.documentation.gimbalRecreate",
        role: "tutorial",
        chatDesc: "A step-by-step walkthrough of BUILDING a sitch for the Navy 'Gimbal' UAP video by drag-and-drop. This is a construction tutorial, not an analysis of the case — for what the Gimbal geometry can and cannot establish (it is the classic case where range is not determined by the data), see the traverse analysis docs.",
    },
    {
        file: "docs/Nimitz", labelKey: "menus.help.documentation.nimitz",
        role: "case-study",
        chatDesc: "The Nimitz / 'Tic Tac' 2004 case as a worked example of handling conflicting evidence: a per-parameter table of every reconstruction value with its source and a confidence grade, a catalogue of the conflicts between different tellings, competing hypotheses set up as switchable configurations, and an explicit list of what remains unknown.",
    },
    {
        file: "docs/LensGhostCaseStudy", labelKey: "menus.help.documentation.lensGhostCaseStudy",
        role: "case-study",
        chatDesc: "A worked example of the Lens Ghost tool on the Pr055 thermal clip: the sitch setup, the Sun geometry, and the fit outputs (R², magnifications, Roll Coupling) the tool reported. It records what the fit tests and what it does not, and gives no conclusion about what the object is.",
    },

    // ── Advanced ────────────────────────────────────────────────────────────
    {
        file: "docs/URLParameters", labelKey: "menus.help.documentation.urlParameters",
        section: "advanced", role: "reference",
        chatDesc: "Every query parameter you can add to a Sitrec address: opening a sitch (sitch, custom, mod), loading a file from a URL (drop), setting the location, map and elevation source (latlon, mapType, elevationType), setting the start time or pinning a frame (datetime, frame), and startup actions (action=new, trackbrowser, botbench). Read for 'how do I link to a location or time', 'what does ?custom= accept', 'why does ?latlon= do nothing', or 'what URL do I share'.",
    },
    {
        file: "docs/APIKeys", labelKey: "menus.help.documentation.apiKeys",
        section: "advanced", role: "reference",
        chatDesc: "How Sitrec stores the user's own API keys (Anthropic, Google 3D tiles, Cesium Ion, Mapbox, MapTiler, Space-Track) and what protects them. Read for any question about where a key is kept, whether a key is sent to the Sitrec server, whether keys are encrypted, who can read them, how to remove one, or whether it is safe to enter one. Also covers the recommended practice of scoping a key and setting a spending cap at the provider, and states plainly what is NOT protected.",
    },
    {
        file: "docs/WebMCP", labelKey: "menus.help.documentation.webmcp",
        section: "advanced", role: "reference",
        chatDesc: "Using ChatGPT desktop site tools (WebMCP) to inspect and control the same open Sitrec page without an OpenAI API key, SitrecBridge, Chrome extension, local WebSocket, or separate MCP server. Covers setup, the thirteen available tools, example prompts, current model/workspace/browser limitations, local-file restrictions, safety boundaries, and when Codex CLI/IDE or Claude users should use SitrecBridge instead.",
    },
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
        file: "docs/DiffractionGlare", labelKey: "menus.help.documentation.diffractionGlare",
        section: "advanced", menuId: "camera", role: "reference",
        chatDesc: "Diffraction spikes and starburst glare: why a bright point of light grows spikes in a camera, what the aperture geometry that causes them looks like, and how to build a camera's point spread function in the Diffraction PSF Studio (tools/psf) and import it into a Sitrec camera. Read for 'why does that light have spikes', 'what causes a starburst', 'is that shape the object or the camera', 'diffraction', 'point spread function', 'PSF', 'spider vanes', 'aigrette', or any question about whether a spiked or star-shaped object in footage is a camera artefact.",
    },
    {
        file: "docs/WhatsNew-Details", labelKey: "menus.help.documentation.whatsNewDetails",
        section: "advanced", role: "reference",
        // No chatDesc: ~1 MB, so the assistant would only ever see the newest fraction.
        // docs/WhatsNew is the AI-facing changelog.
    },
    // A single fringe scenario (Physics → Scenarios → Football). Reference only: kept out
    // of the Help menu, and not presented as an example of anything.
    {
        file: "docs/Football", labelKey: "menus.help.documentation.football",
        role: "reference",
        chatDesc: "The Football scenario (Physics → Scenarios → Football): its controls for launching a ball with ballistic physics (drag, Magnus lift from spin, bounces) near a cable-cam rig.",
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

// The menus a doc is listed under: `menuId` may be one id or an array of ids.
export function docMenuIds(d) {
    return d.menuId == null ? [] : [].concat(d.menuId);
}

// Docs belonging to a given app menu, for that menu's contextual "Help" folder.
export function getDocsForMenu(menuId) {
    return helpDocs.filter(d => docMenuIds(d).includes(menuId));
}
