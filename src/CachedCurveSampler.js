import {Vector3} from "three";

// Exact-FP sampler for THREE.CatmullRomCurve3.getPoint that caches the
// per-segment cubic coefficients between calls.
//
// three.js getPoint() recomputes the ENTIRE segment setup on every call —
// three distanceToSquared, three Math.pow, the repeated-point clamps and
// three tangent derivations — even though a monotonic sweep (sampling a
// track frame by frame) lands in the same segment for many consecutive
// calls. Only the final cubic evaluation actually varies within a segment.
//
// This class replicates the three.js r17x implementation ARITHMETICALLY
// EXACTLY (same expressions, same operation order, same repeated-point
// clamps, same endpoint extrapolation including the shared-scratch quirk
// where a 2-point curve's p0 extrapolation is overwritten by the p3
// extrapolation before either is read) and only adds a cache keyed on the
// segment index. Every output double is bit-identical to curve.getPoint().
//
// Coefficients depend only on the segment's four control points plus
// curveType/tension, so the cache is valid as long as the curve's points
// are not mutated between calls — true for the smoothed-track resampling
// loops this is used in (the curve is built immediately before the sweep).
export class CCachedCurveSampler {
    constructor(curve) {
        this.curve = curve;
        this._cachedIntPoint = -1;      // no segment cached yet
        this._c = new Float64Array(12); // c0..c3 for x, y, z
        this._tmp = new Vector3();      // mirrors three.js module-level `tmp`
    }

    // p(s) = c0 + c1*s + c2*s^2 + c3*s^3 with p(0)=x0, p(1)=x1, p'(0)=t0, p'(1)=t1
    // — identical expressions to three.js CubicPoly init()
    _init(off, x0, x1, t0, t1) {
        const c = this._c;
        c[off] = x0;
        c[off + 1] = t0;
        c[off + 2] = - 3 * x0 + 3 * x1 - 2 * t0 - t1;
        c[off + 3] = 2 * x0 - 2 * x1 + t0 + t1;
    }

    // identical expressions to three.js CubicPoly initNonuniformCatmullRom()
    _initNonuniform(off, x0, x1, x2, x3, dt0, dt1, dt2) {
        let t1 = ( x1 - x0 ) / dt0 - ( x2 - x0 ) / ( dt0 + dt1 ) + ( x2 - x1 ) / dt1;
        let t2 = ( x2 - x1 ) / dt1 - ( x3 - x1 ) / ( dt1 + dt2 ) + ( x3 - x2 ) / dt2;
        t1 *= dt1;
        t2 *= dt1;
        this._init(off, x1, x2, t1, t2);
    }

    // identical expressions to three.js CubicPoly initCatmullRom()
    _initCatmullRom(off, x0, x1, x2, x3, tension) {
        this._init(off, x1, x2, tension * ( x2 - x0 ), tension * ( x3 - x1 ));
    }

    getPoint(t, point) {
        const curve = this.curve;
        const points = curve.points;
        const l = points.length;

        const p = ( l - ( curve.closed ? 0 : 1 ) ) * t;
        let intPoint = Math.floor( p );
        let weight = p - intPoint;

        if ( curve.closed ) {
            intPoint += intPoint > 0 ? 0 : ( Math.floor( Math.abs( intPoint ) / l ) + 1 ) * l;
        } else if ( weight === 0 && intPoint === l - 1 ) {
            intPoint = l - 2;
            weight = 1;
        }

        if ( intPoint !== this._cachedIntPoint ) {
            this._cachedIntPoint = intPoint;
            const tmp = this._tmp;

            let p0, p3; // 4 points (p1 & p2 defined below)

            if ( curve.closed || intPoint > 0 ) {
                p0 = points[ ( intPoint - 1 ) % l ];
            } else {
                // extrapolate first point (same shared scratch as three.js `tmp`,
                // so the l===2 case where p3 overwrites it behaves identically)
                tmp.subVectors( points[ 0 ], points[ 1 ] ).add( points[ 0 ] );
                p0 = tmp;
            }

            const p1 = points[ intPoint % l ];
            const p2 = points[ ( intPoint + 1 ) % l ];

            if ( curve.closed || intPoint + 2 < l ) {
                p3 = points[ ( intPoint + 2 ) % l ];
            } else {
                // extrapolate last point
                tmp.subVectors( points[ l - 1 ], points[ l - 2 ] ).add( points[ l - 1 ] );
                p3 = tmp;
            }

            if ( curve.curveType === 'centripetal' || curve.curveType === 'chordal' ) {
                const pow = curve.curveType === 'chordal' ? 0.5 : 0.25;
                let dt0 = Math.pow( p0.distanceToSquared( p1 ), pow );
                let dt1 = Math.pow( p1.distanceToSquared( p2 ), pow );
                let dt2 = Math.pow( p2.distanceToSquared( p3 ), pow );

                // safety check for repeated points
                if ( dt1 < 1e-4 ) dt1 = 1.0;
                if ( dt0 < 1e-4 ) dt0 = dt1;
                if ( dt2 < 1e-4 ) dt2 = dt1;

                this._initNonuniform(0, p0.x, p1.x, p2.x, p3.x, dt0, dt1, dt2);
                this._initNonuniform(4, p0.y, p1.y, p2.y, p3.y, dt0, dt1, dt2);
                this._initNonuniform(8, p0.z, p1.z, p2.z, p3.z, dt0, dt1, dt2);
            } else if ( curve.curveType === 'catmullrom' ) {
                this._initCatmullRom(0, p0.x, p1.x, p2.x, p3.x, curve.tension);
                this._initCatmullRom(4, p0.y, p1.y, p2.y, p3.y, curve.tension);
                this._initCatmullRom(8, p0.z, p1.z, p2.z, p3.z, curve.tension);
            }
        }

        // identical expressions to three.js CubicPoly calc()
        const c = this._c;
        const t2 = weight * weight;
        const t3 = t2 * weight;
        point.set(
            c[0] + c[1] * weight + c[2] * t2 + c[3] * t3,
            c[4] + c[5] * weight + c[6] * t2 + c[7] * t3,
            c[8] + c[9] * weight + c[10] * t2 + c[11] * t3
        );
        return point;
    }
}
