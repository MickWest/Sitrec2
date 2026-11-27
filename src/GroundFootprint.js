// Ground overlays, regions and building footprints use geographic corners.
// Keep the caller's winding and corner indices when converting from world space.
import {ECEFToLLAVD_radii, LLAToECEF} from "./LLA-ECEF-ENU";

export function footprintLatLon(points) {
    return points.map(point => {
        const lla = ECEFToLLAVD_radii(point);
        return {lat: lla.x, lon: lla.y};
    });
}

export function footprintBounds(corners) {
    const lats = corners.map(c => c.lat), lons = corners.map(c => c.lon);
    return {south: Math.min(...lats), west: Math.min(...lons), north: Math.max(...lats), east: Math.max(...lons)};
}

export function boundsCorners({north, south, east, west}) {
    return [{lat: north, lon: west}, {lat: north, lon: east}, {lat: south, lon: east}, {lat: south, lon: west}];
}

// Accept saved bounds or a center and two dimensions in metres.
export function resolveFootprintBounds(v) {
    if (v.north !== undefined || v.centerLat === undefined) return v;
    const mPerDeg = metersPerDegreeAt(v.centerLat, v.centerLon);
    const halfLat = (v.height ?? 1000) / 2 / mPerDeg.lat;
    const halfLon = (v.width ?? 1000) / 2 / mPerDeg.lon;
    return {
        ...v,
        north: v.centerLat + halfLat,
        south: v.centerLat - halfLat,
        east: v.centerLon + halfLon,
        west: v.centerLon - halfLon,
    };
}

export function metersPerDegreeAt(lat, lon) {
    return {
        lat: LLAToECEF(lat + 0.5, lon, 0).distanceTo(LLAToECEF(lat - 0.5, lon, 0)),
        lon: LLAToECEF(lat, lon + 0.5, 0).distanceTo(LLAToECEF(lat, lon - 0.5, 0)),
    };
}

// Resizing a rectangular footprint fixes the opposite corner and slides each
// neighboring corner along its own horizontal edge, even on sloping terrain.
export function resizeFootprintNeighbor(neighbor, opposite, displacement, up) {
    const edge = neighbor.clone().sub(opposite).projectOnPlane(up).normalize();
    return neighbor.clone().addScaledVector(edge, displacement.dot(edge));
}
