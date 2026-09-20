// Capture plain source metadata while the analysis is running. Reports must
// not read the mutable scene when they are opened later.
export function captureTraverseSource({sit, files = {}, metadata = {}, tracks = [], cameraHeading,
    cameraTrack, videos = []}) {
    const primary = (cameraHeading && tracks.find(t => t.anglesNode?.id === cameraHeading))
        || (cameraTrack && tracks.find(t => t.trackNode?.id === cameraTrack));
    const ids = [...new Set([primary?.trackFileName, ...tracks.map(t => t.trackFileName)].filter(Boolean))];
    const sources = ids.filter(id => files[id]).map(id => {
        const f = files[id], meta = metadata[id] ?? {}, src = meta.sourceFile ?? {};
        const rows = f.data?.data;
        const columns = Array.isArray(rows?.[0]) && rows[0].every(c => typeof c === "string")
            && rows[0].some(c => /[A-Za-z]/.test(c)) ? [...rows[0]] : [];
        const storedPath = sit.loadedFiles?.[id];
        const relativePath = src.relativePath || (storedPath && !/^(?:[a-z]+:|\/)/i.test(storedPath)
            && storedPath.includes("/") ? storedPath : null);
        const parentVideo = f.tsParentFilename ?? meta.tsParentFilename ?? src.parentVideo;
        return {
            id, name: src.name || f.filename?.split(/[\\/]/).pop() || id,
            primary: id === primary?.trackFileName,
            relativePath, pathBasis: src.pathBasis || (relativePath ? "Imported folder or saved scene" : null),
            bytes: src.size ?? f.original?.byteLength ?? f.original?.size ?? null,
            lastModified: src.lastModified || null, type: src.type || f.dataType || null,
            rows: columns.length ? rows.length - 1 : null, columns,
            trackNames: tracks.filter(t => t.trackFileName === id).map(t => t.shortName || t.menuText || t.trackNode?.id),
            parentVideo: parentVideo || null,
        };
    });
    const media = videos.map(v => ({name: v.fileName || v.videoData?.filename || "Unnamed media",
        isImage: !!v.isImage, frames: v.videoData?.frames ?? null,
        width: v.videoData?.videoWidth ?? null, height: v.videoData?.videoHeight ?? null}));
    return {title: sources.find(s => s.primary)?.name || sources[0]?.name || sit.menuName || sit.name || "Unnamed scene",
        files: sources, media, cameraHeading: cameraHeading || null};
}
