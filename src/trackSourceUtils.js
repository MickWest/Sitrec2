// Helpers for deciding whether a FileManager entry is still needed after track
// removal. Imported track files are kept in FileManager for save/reload flows,
// so teardown and serialization both need a shared way to distinguish:
// - files still backing at least one live imported track
// - files that used to back a track but are now orphaned and should disappear

/**
 * Collect the file ids that are still referenced by live, non-synthetic tracks.
 *
 * Synthetic tracks do not have a source file in FileManager, so they must never
 * contribute to this set. The returned ids are FileManager keys, not filenames
 * from inside the asset itself.
 *
 * @param {Object} trackManager
 * @returns {Set<string>}
 */
export function collectActiveTrackSourceFileIDs(trackManager) {
    const activeTrackSourceFileIDs = new Set();

    if (!trackManager || typeof trackManager.iterate !== "function") {
        return activeTrackSourceFileIDs;
    }

    trackManager.iterate((id, trackOb) => {
        if (trackOb?.isSynthetic) {
            return;
        }
        if (typeof trackOb?.trackFileName !== "string" || trackOb.trackFileName.length === 0) {
            return;
        }
        activeTrackSourceFileIDs.add(trackOb.trackFileName);
    });

    return activeTrackSourceFileIDs;
}

/**
 * Check whether a source file is still referenced by any other live imported track.
 *
 * This is used during track disposal: the current track is being removed, so its
 * own id is excluded from the search. If no other imported track points at the
 * file, the FileManager entry can be removed as well.
 *
 * @param {Object} trackManager
 * @param {string} trackFileName
 * @param {string|null} excludedTrackID
 * @returns {boolean}
 */
export function hasOtherTrackSourceReference(trackManager, trackFileName, excludedTrackID = null) {
    if (!trackFileName || !trackManager || typeof trackManager.iterate !== "function") {
        return false;
    }

    let stillReferenced = false;
    trackManager.iterate((id, trackOb) => {
        if (stillReferenced || id === excludedTrackID) {
            return;
        }
        if (trackOb?.isSynthetic) {
            return;
        }
        if (trackOb?.trackFileName === trackFileName) {
            stillReferenced = true;
        }
    });

    return stillReferenced;
}

/**
 * Decide whether a FileManager entry should be written into `loadedFiles`.
 *
 * Ordinary non-track assets should always serialize. Entries marked as former
 * track sources are only serialized when they are still referenced by at least
 * one active imported track, which prevents removed KML/CSV assets from coming
 * back on the next sitch load.
 *
 * @param {string} fileID
 * @param {Object} fileEntry
 * @param {Set<string>} activeTrackSourceFileIDs
 * @returns {boolean}
 */
export function shouldSerializeLoadedFileEntry(fileID, fileEntry, activeTrackSourceFileIDs) {
    if (!fileEntry?.usedAsTrackSource) {
        return true;
    }

    return activeTrackSourceFileIDs.has(fileID);
}

/**
 * Import-wiring decision: when a new track auto-selects as the target, should
 * the Camera Heading (CameraLOSController) keep the camera track's recorded
 * sensor angles instead of being forced to "To Target"?
 *
 * Keep the angles ONLY when both hold:
 * - the current heading choice IS the camera track's own recorded-angles
 *   controller ("Angles_<cameraShortName>"), i.e. a real measured attitude; and
 * - the arriving target is a supplementary track from that same source file —
 *   a MISB "Center_" frame-center track, or a BOT interchange file's Truth
 *   track. Aiming the camera at it would RE-derive the sightlines from the
 *   target being studied (circular) and silently discard the measurement.
 *
 * Everything else — STANAG role-hinted targets, ordinary second-track drops —
 * must still force "To Target" exactly as before.
 *
 * The exact-name match handles the common MISB case; the sameSourceFile +
 * isSupplementary relationship survives shortName uniquification (a collision
 * can rename the camera track to "name_1" while its Center stays "Center_name")
 * and covers formats that do not use the "Center_" naming at all. That
 * relationship — not the name — is what makes the aim circular: a BOT Truth
 * track is literally the answer the sightlines are evidence about, so pointing
 * the camera at it is the same mistake wearing a different label. The heading
 * check above already limits this to files that supply measured angles, so no
 * ordinary two-track import can reach it.
 *
 * @param {Object} p
 * @param {string|null} p.headingChoice     current CameraLOSController choice (raw option key)
 * @param {string|null} p.cameraShortName   cameraTrackSwitch.choice (shortName, or "fixedCamera" etc.)
 * @param {string|null} p.arrivingShortName shortName of the track being auto-selected as target
 * @param {boolean} p.sameSourceFile        arriving track comes from the camera track's source file
 * @param {boolean} p.isSupplementary       source file marks the arriving track as a derived/supplementary track
 * @returns {boolean} true = keep the angles heading (skip the To Target clobber)
 */
export function shouldPreserveAnglesHeading({headingChoice, cameraShortName, arrivingShortName,
    sameSourceFile, isSupplementary}) {
    if (!cameraShortName || !headingChoice) return false;
    if (headingChoice !== "Angles_" + cameraShortName) return false;
    if (!arrivingShortName) return false;
    // The camera track's own derived frame-center track, by name.
    if (arrivingShortName === "Center_" + cameraShortName) return true;
    // Otherwise the FILE has to vouch for the relationship. This used to also
    // require a "Center_" prefix, which silently excluded every format that
    // derives its target track under a different name.
    return sameSourceFile === true && isSupplementary === true;
}
