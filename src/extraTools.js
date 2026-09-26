// The public standalone tools under tools/, listed once for the Sitrec > Extra Tools menu
// (built in src/index.js). Labels and tooltips are menus.main.extraTools.tools.<key> in
// src/i18n/en.js.
//
// A tool is public when it has a card on the Tools index page, tools/index.html. When you
// add or remove a card there, add or remove its entry here too. tests/extraTools.test.js
// compares this list with that page, so the two cannot drift apart unnoticed.
//
// `path` is relative to tools/ and names the page itself, never a bare directory, so a
// link does not depend on the server's directory index.
//
// `perBuild` marks a tool that quickship packages with every frontend build (see
// docs/dev/ReleaseChannels.md). Its link resolves against that build's assets, so a Beta
// user gets the Beta copy. Every other tool ships only with a full release, so its link
// resolves against the channel-neutral application entry, which always has it.

export const EXTRA_TOOLS = [
    {key: "losViewer", path: "los-viewer.html"},
    {key: "flowGen", path: "flowgen.html"},
    {key: "px4Viewer", path: "px4-viewer.html"},
    {key: "irBalloon", path: "IRBalloon/index.html"},
    {key: "compass", path: "compass/index.html"},
    {key: "shf", path: "shf/index.html", perBuild: true},
    {key: "psfStudio", path: "psf/index.html"},
    {key: "aircraftDesigner", path: "vehicles/index.html"},
];
