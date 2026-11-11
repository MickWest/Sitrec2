// Kite flight statics. Pure math with no imports, shared by the designer, the
// model generator and Sitrec's kite track (which must not load the generator).
//
// The model is a steady balance of forces. It does not simulate kite dynamics.
// Lift and drag coefficients are family estimates referred to the lifting area;
// they are not measurements of any particular kite.

export const KITE_AIR_DENSITY = 1.225;      // kg/m³, sea-level standard air
export const KITE_GRAVITY = 9.80665;        // m/s²
export const KITE_REFERENCE_WIND = 6;       // m/s: the wind of the designer preview and of the tail rest shape
const LINE_NORMAL_DRAG = 1.1;               // drag coefficient of a round line across the wind

// Lifting area in m² as a fraction of width × height, by shape. For the octopus
// it is the plan area of the head; the tentacles add drag, not lift.
const AREA_FRACTION = {diamond: 0.5, delta: 0.5, rokkaku: 0.8, sled: 0.8, box: 0.65, parafoil: 1, octopus: Math.PI / 4};

// Estimated lift and drag coefficients by shape, at the flying attitude. Drag
// includes the tails and bridle.
export const KITE_FLIGHT_DEFAULTS = {
    diamond:  {liftCoefficient: 0.85, dragCoefficient: 0.65},
    delta:    {liftCoefficient: 0.90, dragCoefficient: 0.45},
    rokkaku:  {liftCoefficient: 0.90, dragCoefficient: 0.50},
    sled:     {liftCoefficient: 0.80, dragCoefficient: 0.55},
    box:      {liftCoefficient: 0.60, dragCoefficient: 0.50},
    parafoil: {liftCoefficient: 0.80, dragCoefficient: 0.45},
    octopus:  {liftCoefficient: 0.55, dragCoefficient: 0.60},
};

// The properties Sitrec uses when an object on a kite track has no kite design.
export const GENERIC_KITE_FLIGHT = Object.freeze({massKg: 0.25, areaM2: 1, liftCoefficient: 0.9, dragCoefficient: 0.45});

export function kiteLiftingArea(p) {
    if (p.kiteArea > 0) return p.kiteArea;
    return (AREA_FRACTION[p.kiteShape] ?? 0.5) * p.width * p.height;
}

// The four numbers the flight model needs, from a kite design's parameters.
export function kiteFlightProperties(p) {
    return {massKg: p.kiteMass, areaM2: kiteLiftingArea(p),
        liftCoefficient: p.liftCoefficient, dragCoefficient: p.dragCoefficient};
}

// The lowest wind speed (m/s) at which lift equals weight. The line adds weight,
// so a kite on a long line needs more than this.
export function kiteMinimumWind({massKg, areaM2, liftCoefficient}, airDensity = KITE_AIR_DENSITY) {
    return Math.sqrt(2 * massKg * KITE_GRAVITY / (airDensity * areaM2 * liftCoefficient));
}

// The steady shape of the line and the position of the kite, in the vertical
// plane that contains the wind.
//
//   windSpeed          m/s at the kite (also used for the drag of the line)
//   lineLength         m
//   lineMassPerMetre   kg/m
//   lineDiameter       m
//   properties         {massKg, areaM2, liftCoefficient, dragCoefficient}
//   withPoints         false leaves out `points`, for a caller that needs only the kite
//
// Returns {flying, downwind, height, points, lineAngleAtKite, tension, lift, drag}:
//   downwind, height   m, the kite relative to the anchor
//   points             [downwind, height] pairs from the anchor to the kite
//   lineAngleAtKite    radians above the horizontal
//   tension            N, the pull of the line at the kite
//
// The line carries its own weight and drag, so it sags: it is steepest at the
// kite and flattest at the anchor. A part that cannot be held up lies on the
// ground. A kite with less lift than weight is on the ground, downwind.
export function solveKiteLine({windSpeed, lineLength, lineMassPerMetre = 0, lineDiameter = 0, properties,
                                  airDensity = KITE_AIR_DENSITY, segments = 32, withPoints = true}) {
    const {massKg, areaM2, liftCoefficient, dragCoefficient} = properties;
    const pressure = 0.5 * airDensity * windSpeed * windSpeed;      // dynamic pressure, N/m²
    const lift = pressure * areaM2 * liftCoefficient;
    const drag = pressure * areaM2 * dragCoefficient;
    const weight = massKg * KITE_GRAVITY;
    let horizontal = drag, vertical = lift - weight;                // the pull the line must hold, at the kite
    const flying = vertical > 0 && horizontal > 0;
    if (!flying) {
        return {flying, downwind: lineLength, height: 0, points: withPoints ? [[0, 0], [lineLength, 0]] : null,
            lineAngleAtKite: 0, tension: 0, lift, drag};
    }
    const step = lineLength / segments;
    const lineWeight = lineMassPerMetre * KITE_GRAVITY * step;      // N per segment
    const lineDrag = pressure * lineDiameter * LINE_NORMAL_DRAG * step;
    const lineAngleAtKite = Math.atan2(vertical, horizontal);
    // Walk down the line from the kite. Offsets are from the kite, so they are negative.
    const offsets = withPoints ? [[0, 0]] : null;
    let x = 0, y = 0;
    for (let segment = 0; segment < segments; segment++) {
        const angle = Math.max(0, Math.atan2(vertical, horizontal));
        const cos = Math.cos(angle), sin = Math.sin(angle);
        x -= cos * step; y -= sin * step;
        offsets?.push([x, y]);
        // The wind pushes a sloping line downwind and down; its weight pulls it down.
        const normalForce = lineDrag * sin * sin;
        horizontal += normalForce * sin;
        vertical -= normalForce * cos + lineWeight;
    }
    const points = offsets ? offsets.reverse().map(([dx, dy]) => [dx - x, dy - y]) : null;
    return {flying, downwind: -x, height: -y, points, lineAngleAtKite,
        tension: Math.hypot(drag, lift - weight), lift, drag};
}
