// A trace records measured narrow lines. Harmonic numbers are user assignments,
// not detections. Older analyses assign one harmonic to the whole event.
// A family groups the lines that share one emitted fundamental. One source can
// carry several families, such as an engine and a rotor. Each family receives
// its own fitted fundamental; all families share the event's geometry and clock.
export const traceHarmonic=(event,point)=>point.harmonic===undefined ? event.harmonic : point.harmonic;
export const validTraceHarmonic=value=>Number.isInteger(value) && value>=1 && value<=16;
export const traceFamily=point=>point?.family===undefined ? 0 : point.family;
export const validTraceFamily=value=>Number.isInteger(value) && value>=0 && value<=7;
export const hasTaggedTrace=event=>Array.isArray(event.trace) && event.trace.some(point=>point?.harmonic!==undefined || point?.family!==undefined);
// An event without traced points (brightness scoring) still has its main family.
export const tracedFamilies=event=>event.trace?.length ? [...new Set(event.trace.map(traceFamily))].sort((a,b)=>a-b) : [0];
export const tracedHarmonics=(event,family)=>[...new Set(event.trace?.length
    ? event.trace.filter(point=>family===undefined || traceFamily(point)===family).map(point=>traceHarmonic(event,point)) : [event.harmonic])].sort((a,b)=>a-b);
// A scored event keeps its main family's fundamental in `frequency`. Further
// families are listed separately, so older results and consumers keep working.
export const familyFrequency=(scored,family)=>family===0 || !Array.isArray(scored?.families) ? scored?.frequency :
    scored.families.find(f=>f.family===family)?.frequency;

export function thinTrace(event) {
    if(!Array.isArray(event.trace)) return [];
    if(!hasTaggedTrace(event)) return event.trace.filter((_,i)=>i%2===0);
    const key=point=>`${traceFamily(point)}/${traceHarmonic(event,point)}`;
    const totals=new Map(),seen=new Map();
    for(const point of event.trace) {const k=key(point);totals.set(k,(totals.get(k) ?? 0)+1);}
    return event.trace.filter(point=>{
        const k=key(point),i=seen.get(k) ?? 0;seen.set(k,i+1);
        return i%2===0 || i===totals.get(k)-1;
    });
}
