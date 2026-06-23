// Central registry of node ids that have been fully REMOVED from the codebase.
//
// A saved custom sitch serializes its ENTIRE node graph, so deleting a node's
// definition from SitCustom.js does NOT remove it from sitches that were already
// saved — those carry their own embedded copy and would recreate the dead node on
// load (the node defs flow through SituationSetupFromData like any other).
//
// Listing an id here makes the loader:
//   1. skip CREATING the node from any embedded definition (SituationSetupFromData), and
//   2. drop its stale top-level mods entry (CustomManagerSerialize.deserializeMods),
// so the node disappears everywhere — new sitches, built-in sitches, AND old saves.
// (Sub-sitch state snapshots are already safe: restoreSubSitchState only applies a
// mod when NodeMan.get(id, false) finds a live node.)
//
// Because a skipped node is never created, it is also never re-serialized — the next
// save of a previously-saved sitch self-heals and the id drops out of the file for good.
//
// Use this ONLY for nodes removed with NO replacement. For a RENAME (oldId -> newId),
// use the deprecatedIds maps in CustomManagerSerialize.js / CustomManagerSubSitch.js.
export const REMOVED_NODE_IDS = new Set([
    // 2026-06-23: "Camera Position" (CNodeSwitch, id "CameraPositionController").
    // A vestigial one-option ("Follow Track") switch that was never attached to any
    // camera (outputs === [], apply() never called). trackPositionController drives
    // the look camera position directly, so this only ever rendered a dead dropdown.
    "CameraPositionController",
]);
