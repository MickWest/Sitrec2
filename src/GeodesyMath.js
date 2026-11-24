// Scalar coordinate math shared by the scene and calculation workers.
// Iterative Bowring conversion; angles in radians, altitude in metres.
// The caller may supply an output array to avoid allocating for every vertex.
export function ecefToGeodetic(X, Y, Z, a, b, out = [0, 0, 0]) {
    const asqr = a*a;
    const bsqr = b*b;
    const e2 = (asqr - bsqr) / asqr;
    const eprime2 = (asqr - bsqr) / bsqr;

    const p = Math.sqrt(X*X + Y*Y);
    const theta = Math.atan((Z*a) / (p*b));
    const sintheta = Math.sin(theta);
    const costheta = Math.cos(theta);
    let latitude = Math.atan2(
        Z + eprime2 * b * sintheta * sintheta * sintheta,
        p - e2 * a * costheta * costheta * costheta
    );
    for (let i = 0; i < 5; i++) {
        const sinLat = Math.sin(latitude);
        const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
        const newLat = Math.atan2(Z + e2 * N * sinLat, p);
        if (Math.abs(newLat - latitude) < 1e-15) break;
        latitude = newLat;
    }

    const longitude = Math.atan2(Y, X);
    const sinLat = Math.sin(latitude);
    const N = a / Math.sqrt(1 - e2 * sinLat * sinLat);
    const cosLat = Math.cos(latitude);
    // Near the poles the radial formula divides two values approaching zero.
    const altitude = Math.abs(cosLat) > 1e-10
        ? (p / cosLat) - N
        : Math.abs(Z) / Math.abs(Math.sin(latitude)) - N * (1 - e2);
    out[0] = latitude;
    out[1] = longitude;
    out[2] = altitude;
    return out;
}
