// Version the browser URL when the server starts retaining additional columns.
// The server keeps its durable cache key and upgrades that entry on demand.
export function satelliteCatalogURL(server, date, type = "", days) {
    const params = new URLSearchParams({request: date, type});
    if (days !== undefined) params.set("days", String(days));
    params.set("schema", "3");
    params.set("format", "parquet");
    return server + "proxyStarlink.php?" + params;
}

export function isSatelliteParquet(buffer) {
    const bytes = new Uint8Array(buffer);
    return bytes.length >= 4 && bytes[0] === 80 && bytes[1] === 65 && bytes[2] === 82 && bytes[3] === 49;
}

export async function satelliteCatalogText(buffer) {
    if (isSatelliteParquet(buffer)) {
        const {satelliteParquetToCSV} = await import(/* webpackChunkName: "satellite-parquet" */ './SatelliteParquet');
        return satelliteParquetToCSV(buffer);
    }
    return new TextDecoder().decode(buffer);
}
