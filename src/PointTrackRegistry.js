// Shared identities let lazily loaded graph windows keep their own track while
// the editing controls switch to another one. Track lifecycle lives in CObjectTracking.
export const pointTracks = [];

export function findPointTrack(id) {
    return pointTracks.find(track => id == null ? track.editable : track.trackId === id) ?? null;
}
