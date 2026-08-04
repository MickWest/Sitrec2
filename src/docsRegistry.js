// Single source of truth for Sitrec's user-facing documentation.
//
// Both the Help > Documentation menu (src/index.js) and the in-app AI assistant's
// getHelpDoc doc list (src/nodes/CNodeVIewChat.js) are built from this one array,
// so the two can never drift apart. They previously drifted: the chat list named
// files that didn't exist (e.g. "SavingLoadingSharing" when the file is
// "SavingAndLoading.md", and "ObjectTracking" with no file at all), which made
// getHelpDoc return an error mid-conversation. Deriving the chat doc-name from the
// same `file` the menu links to makes that class of bug structurally impossible.
//
// Each entry:
//   file     - path for the Help-menu link, WITHOUT extension. Usually
//              "docs/<Name>" (linked as docs/<Name>.md or .html); "README" is special.
//   labelKey - i18n key for the Help-menu label (see menus.help.* in src/i18n/en.js).
//   top      - if true, the link sits directly under the Help menu (above the
//              Documentation folder). Default false (inside the folder).
//   chatDesc - if set, the doc is offered to the AI assistant via getHelpDoc, under
//              the basename derived from `file` (so the name always matches a real
//              docs/<name>.md). Phrase it the way users ask questions so the model
//              knows when to open it. Omit to keep a doc out of the AI list.
//
// Internal architecture/plan docs (docs/dev/, docs/plans/, *Internals.md, *Plan.md)
// and other developer-only references must NOT be listed here.
//
// NOTE: getHelpDoc (chatbot.php) reads docs/<name>.md and truncates to the first
// 20000 chars, so only very long docs are cut off — still, front-load AI-facing docs
// with their most useful content. The Getting Started guide, docs/CustomSitchTool.md,
// fits within this limit.

export const helpDocs = [
    { file: "docs/CustomSitchTool", labelKey: "menus.help.gettingStarted", top: true,
        chatDesc: "START HERE for any 'how do I use Sitrec / how do I get started / how do I make a sitch' question. The main getting-started guide: what Sitrec and a 'sitch' are, loading a Featured example to watch, then building your own custom sitch by importing data (drag-and-drop or File → Import File) — setting up the camera (position/heading/FOV) and target, two-track (camera+target) setups, syncing video, setting the date/time (Start Time vs Now Time), setting a location by name (Lookup/Geolocate in the Camera/Target menus), terrain, and adding satellites. Recommend this first for general 'how do I' questions, then point to the more specific docs (Tracks, Starlink, etc.)." },
    { file: "docs/WhatsNew", labelKey: "menus.help.whatsNew", top: true,
        chatDesc: "Recent changes and new features in Sitrec." },
    { file: "README", labelKey: "menus.help.documentation.about" },
    { file: "docs/WhatsNew-Details", labelKey: "menus.help.documentation.whatsNewDetails" },
    { file: "docs/UserInterface", labelKey: "menus.help.documentation.uiBasics",
        chatDesc: "Using the interface: opening/dragging-off/re-docking menus, folders, sliders, color pickers, moving and resizing views/windows, navigating the 3D main view with the mouse, and the Time/Date controls. Read for any 'how do I use the menus / close a popped-off menu / move a view / set the time' question." },
    { file: "docs/SavingAndLoading", labelKey: "menus.help.documentation.savingLoading",
        chatDesc: "Saving, loading, and sharing sitches — versioned server/S3 saves vs fast local-folder saves." },
    { file: "docs/Tracks", labelKey: "menus.help.documentation.tracks",
        chatDesc: "Importing and working with tracks (aircraft ADS-B/KML/KMZ, drone CSV/SRT, MISB/KLV, FlightRadar24, GeoJSON, ASTERIX radar, balloon): how a track is created from data, importing via drag-and-drop or the File menu, the Generic CSV column format, filtering bad data, smoothing, altitude handling, multi-track (camera+target) setups, and exporting. Read this for 'how do I make/have a track of azimuth/elevation (az/el)' — covered under 'Camera Angle Tracks': a CSV of frame-or-time plus az/el/heading/fov columns that drives the camera's pointing angles." },
    { file: "docs/GIS", labelKey: "menus.help.documentation.gis",
        chatDesc: "Coordinate systems and geography: the WGS84 ellipsoid, ECEF/LLA, and altitude datums (HAE vs MSL vs AGL)." },
    { file: "docs/Starlink", labelKey: "menus.help.documentation.starlink",
        chatDesc: "Investigating Starlink satellite flares: loading satellites for a date (Satellite menu, 'Load LEO Satellites For Date'), TLE data, and the flare band / sun-angle tools." },
    { file: "docs/CustomModels", labelKey: "menus.help.documentation.customModels",
        chatDesc: "Displaying and importing 3D models (built-in aircraft/aerostats, simple shapes, or custom GLB/GLTF) and the Model Inspector." },
    { file: "docs/satcam", labelKey: "menus.help.documentation.cameraModes",
        chatDesc: "Look-camera orientation modes (Normal vs Satellite PTZ) — how the camera points and how the look angle is defined." },
    { file: "docs/LongExposure", labelKey: "menus.help.documentation.longExposure",
        chatDesc: "Simulating a long-exposure photograph (Video → Long Exposure) so moving aircraft, satellites, and stars leave trails." },
    { file: "docs/Masking", labelKey: "menus.help.documentation.masking",
        chatDesc: "Masking out part of the video frame (Video → Masking) so analysis ignores it: painting a mask by hand, the automatic ground/sky methods for masking out trees and terrain, auto-masking a burned-in OSD or redactions, and which tools obey the mask (Star Tracker 'Use mask', Point Track 'Use Mask', Motion Analysis, panorama export). Read this for 'how do I stop it detecting the trees as stars', 'how do I ignore the timestamp / on-screen text', 'how do I mask out the ground', or any question about the Masking menu." },
    { file: "docs/StarTracker", labelKey: "menus.help.documentation.starTracker",
        chatDesc: "The Star Tracker (Video → Star Tracker): finding the stars in a video or photograph and working out where the camera was pointing from them. Covers detecting point sources and the detect threshold, tracks and how moving objects are told apart from stars, the lens calibration and why a fisheye needs one, identifying the field against the star catalog with no location or time assumed, masking out the ground so foliage is not detected as stars, syncing the look camera to the solved star field, and the star chart. Read this for 'how do I identify the stars in my video', 'what was the camera pointing at', 'how do I work out the field of view from the stars', or any question about the Star Tracker's controls or overlay." },
    { file: "docs/Wind", labelKey: "menus.help.documentation.wind",
        chatDesc: "The Wind menu: setting wind speed and direction, pulling real-world atmospheric data, and drawing streamlines and arrows." },
    { file: "docs/TraverseMethods", labelKey: "menus.help.documentation.traverseMethods",
        chatDesc: "How the target/UAP path (the 'traverse') is computed from the camera lines of sight — constant distance, constant speed, constant altitude, straight line, and the global fits (CV, CA, Kalman, Monte Carlo, Physics)." },
    { file: "docs/gimbal-recreate", labelKey: "menus.help.documentation.gimbalRecreate",
        chatDesc: "A step-by-step worked example of recreating the Navy 'Gimbal' UAP video." },
];

// Basename used by getHelpDoc (docs/<name>.md). Strips the "docs/" prefix so the
// chat doc-name is always the real filename the Help menu links to.
function chatDocName(file) {
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
