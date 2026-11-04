// Keep drawing and pointer coordinates in CSS pixels while matching the canvas
// backing store to the display. The worker detail budget bounds the FFT columns.
export function spectrumLayout(width,height,devicePixelRatio=1) {
    const w=Math.max(1,Math.round(width)),h=Math.max(1,Math.round(height));
    const dpr=Number.isFinite(devicePixelRatio) ? Math.max(1,Math.min(2,devicePixelRatio)) : 1;
    const left=Math.min(54,w*0.15),right=Math.min(18,w*0.05),top=Math.min(15,h*0.08),bottom=Math.min(35,h*0.2);
    const plotWidth=w-left-right,plotHeight=h-top-bottom;
    return {width:w,height:h,dpr,left,top,plotWidth,plotHeight,nativeWidth:Math.round(w*dpr),nativeHeight:Math.round(h*dpr),
        columns:Math.max(2,Math.ceil(plotWidth*dpr))};
}

export function spectrumTracePoint(layout,event,x,y,low,high) {
    if(x<layout.left || x>layout.left+layout.plotWidth || y<layout.top || y>layout.top+layout.plotHeight) return null;
    return {time:event.start+(x-layout.left)/layout.plotWidth*(event.end-event.start),
        frequency:high-(y-layout.top)/layout.plotHeight*(high-low)};
}

// Frequency inspection is independent of the source-frequency hypothesis.
export function spectrumFrequencyRange(spec,view,fallbackMaximum=750) {
    const recordedMaximum=spec && Number.isFinite(spec.binHz) && spec.binHz>0 && spec.bins>1 ? (spec.bins-1)*spec.binHz :
        Number.isFinite(fallbackMaximum) && fallbackMaximum>0 ? fallbackMaximum : 750;
    const low=Number.isFinite(view?.low) ? Math.max(0,Math.min(recordedMaximum,view.low)) : 0;
    const high=Number.isFinite(view?.high) ? Math.max(0,Math.min(recordedMaximum,view.high)) : recordedMaximum;
    return low<high ? {low,high,recordedMaximum} : {low:0,high:recordedMaximum,recordedMaximum};
}

export function materializeTraceHarmonics(event) {
    for(const point of event.trace) if(point.harmonic===undefined) point.harmonic=event.harmonic;
}

// A point without a family tag belongs to the main family 0, so older traces
// need no rewriting. Only points of another tone family carry the tag.
export function addHarmonicTracePoint(event,point,separation) {
    if(!Number.isFinite(point.time)||!Number.isFinite(point.frequency)||point.frequency<=0) return false;
    if(!Number.isInteger(event.harmonic)||event.harmonic<1||event.harmonic>16) return false;
    const family=event.family ?? 0;
    if(!Number.isInteger(family)||family<0||family>7) return false;
    materializeTraceHarmonics(event);
    event.trace=event.trace.filter(p=>p.harmonic!==event.harmonic||(p.family ?? 0)!==family||Math.abs(p.time-point.time)>separation);
    event.trace.push({...point,harmonic:event.harmonic,...(family ? {family} : {})});return true;
}

export function spectrumHarmonicCounts(event) {
    const counts=new Map();
    for(const point of event.trace) {
        const harmonic=point.harmonic ?? event.harmonic,family=point.family ?? 0,key=family*100+harmonic;
        counts.set(key,{...(family ? {family} : {}),harmonic,count:(counts.get(key)?.count ?? 0)+1});
    }
    return [...counts].sort(([a],[b])=>a-b).map(([,value])=>value);
}
