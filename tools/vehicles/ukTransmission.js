// Standard-height British double-circuit suspension towers. Dimensions are
// metres; the three tiers give hanger elevation / height and reach / full span.
// Sources: Telcontar, UK electricity pylon series (D elevations), and the
// Pylon Appreciation Society's L2 field guide. Bracing is simplified for LOD.
export const ukTransmission = {
    ukL2: {series:"L2", height:41.6, baseWidth:7.5, armSpan:12.2,
        description:"Three nearly equal crossarms get slightly wider towards the ground. The top of the mast has an inverted V across the crossarms.",
        tiers:[[.945,.450],[.758,.469],[.570,.500]], below:0, above:.034, drop:.090},
    ukL3: {series:"L3", height:36.8, baseWidth:6.4, armSpan:9.1,
        description:"The Blaw Knox L3 has closely stacked phases and X bracing across the upper two crossarms. It is shorter and narrower than the L2.",
        tiers:[[.943,.450],[.778,.465],[.613,.500]], below:0, above:.033, drop:.084},
    ukL4: {series:"L4(m)", height:26.1, baseWidth:4, armSpan:8.4,
        description:"A compact 132 kV tower with a narrow base and shallow, open crossarms. The middle arms reach furthest.",
        tiers:[[.957,.334],[.813,.500],[.668,.380]], below:.023, above:.013, drop:.069},
    ukL6: {series:"L6", height:50, baseWidth:11, armSpan:20.6,
        description:"The Balfour Beatty L6 has widely spaced feet and a broad middle tier. Its standard suspension tower stands 50 metres tall.",
        tiers:[[.898,.330],[.687,.500],[.509,.416]], below:0, above:.043, drop:.091},
    ukL7: {series:"L7(c)", height:26.9, baseWidth:4.9, armSpan:9.4,
        description:"A compact double-circuit tower with braced triangular crossarms and a wider middle tier.",
        tiers:[[.945,.340],[.783,.500],[.644,.375]], below:0, above:.034, drop:.073},
    ukL8: {series:"L8(c)", height:46.4, baseWidth:7.5, armSpan:17.1,
        description:"The broad middle crossarms stagger the conductors on either side of the mast. The earth-wire peak extends well above the top crossarms.",
        tiers:[[.905,.350],[.703,.500],[.530,.395]], below:0, above:.038, drop:.096},
    ukL12: {series:"L12", height:46.5, baseWidth:7.1, armSpan:18.2,
        description:"A tall, narrow-footed tower with a wide middle tier. The crossarms taper from above and below towards each insulator.",
        tiers:[[.905,.350],[.706,.500],[.518,.395]], below:.019, above:.020, drop:.098},
};

// Recognise series names and the standard D suspension designation. Angle
// and terminal designations (e.g. L2 D30, L6 DT) have a different head.
const references = new Map();
for (const [style,{series}] of Object.entries(ukTransmission)) {
    references.set(style.slice(2).toUpperCase(),style);
    references.set(series.replace(/[()]/g,"").toUpperCase(),style);
}
export function ukSuspensionStyle(reference) {
    if (typeof reference !== "string") return;
    const key = reference.trim().toUpperCase().replace(/\s+D(?:\s+STD)?$/,"").replace(/[()\s]/g,"");
    return references.get(key);
}
