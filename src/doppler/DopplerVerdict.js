// Judges the winner of an archive search against the wrong flight pairs that the
// same search scored on the same audio.
//
// Method from dopplertrack (src/dopplertrack/verdict.py), MIT License,
// Copyright (c) 2026 MacCallister Higgins, https://github.com/mjshiggins/dopplertrack.
//
// At most one scored flight pair is right, so the scores of the others show what a
// wrong answer looks like on this recording. Each pair keeps its best score. Pairs
// that share a flight with the winner are left out, because they carry part of its
// signal. Above the k-th best wrong score, the tail is taken as exponential with mean
// excess m. For such a tail, the spacing between its two largest values is also
// exponential with mean m, so p = exp(-gap / m) is the chance that a wrong winner
// leads the best other wrong pair by the observed gap. This is an uncalibrated
// screen, not a location probability.

export const VERDICT_LOCATED_P=0.1;
export const VERDICT_AMBIGUOUS_P=0.5;
// The tail uses at most this many wrong pairs, plus the one above them.
export const VERDICT_TAIL_MAX=100;

export function verdictStatus(p) {
    return p<VERDICT_LOCATED_P ? "located" : p<VERDICT_AMBIGUOUS_P ? "ambiguous" : "no match";
}

// Best score of each flight pair, as [{flights, score}]. Searches split across
// workers merge these lists and keep the larger score of a repeated pair.
export function bestPairScores(candidates) {
    const best=new Map();
    for(const candidate of candidates) {
        if(!Number.isFinite(candidate.score)) continue;
        const flights=candidate.flights ?? candidate.events.map(e=>e.flight),key=flights.join("/"),old=best.get(key);
        if(!old || candidate.score>old.score) best.set(key,{flights,score:candidate.score});
    }
    return [...best.values()];
}

export function rankingVerdict(pairScores,winner,{kFraction=0.05,kMin=15,kMax=VERDICT_TAIL_MAX}={}) {
    if(!winner) return null;
    const own=new Set(winner.flights ?? winner.events.map(e=>e.flight));
    const scores=bestPairScores(pairScores).filter(p=>!p.flights.some(id=>own.has(id))).map(p=>p.score).sort((a,b)=>b-a);
    const k=Math.min(kMax,Math.max(kMin,Math.round(kFraction*scores.length)));
    if(scores.length<k+5) return {status:"insufficient",nullPairs:scores.length};
    const threshold=scores[k];
    let excess=0;
    for(let i=0;i<k;i++) excess+=scores[i]-threshold;
    const tailWidth=excess/k,gap=winner.score-scores[0];
    const p=tailWidth>0 ? Math.exp(-Math.max(gap,0)/tailWidth) : (gap>0 ? 0 : 1);
    return {status:verdictStatus(p),p,gap,tailWidth,k,nullPairs:scores.length};
}

// Saved analyses keep statistics as finite numbers only.
export function verdictStats(verdict) {
    if(!verdict) return {};
    if(verdict.status==="insufficient") return {verdictNullPairs:verdict.nullPairs};
    return {verdictP:verdict.p,verdictGap:verdict.gap,verdictTailWidth:verdict.tailWidth,verdictK:verdict.k,verdictNullPairs:verdict.nullPairs};
}

// rows: [{flights, score, low, high}] for the best flight pairs, where low and high
// are the refined scores with the sound speed lowered and raised by deltaMS.
// Reports the rank of the set-speed winner among those pairs at each speed, and
// how many pairs could not be refined there. Rank 0 means that the winner itself
// could not be refined. A pair that could not be refined has no known score, so
// the winner is only known to stay first when every pair was refined.
export function soundSpeedStats(rows,soundSpeed,deltaMS) {
    if(!rows?.length || !(deltaMS>0)) return {};
    const winner=rows.reduce((best,row)=>row.score>best.score ? row : best);
    const rank=name=>Number.isFinite(winner[name]) ? 1+rows.filter(row=>row!==winner && Number.isFinite(row[name]) && row[name]>winner[name]).length : 0;
    const failed=name=>rows.filter(row=>!Number.isFinite(row[name])).length;
    return {soundSpeedBase:soundSpeed,soundSpeedCheckMS:deltaMS,soundSpeedCheckPairs:rows.length,soundSpeedLowRank:rank("low"),soundSpeedHighRank:rank("high"),
        soundSpeedLowFailed:failed("low"),soundSpeedHighFailed:failed("high")};
}

export function soundSpeedText(stats) {
    if(!stats || !Number.isFinite(stats.soundSpeedCheckMS)) return "";
    const low=stats.soundSpeedBase-stats.soundSpeedCheckMS,high=stats.soundSpeedBase+stats.soundSpeedCheckMS,pairs=stats.soundSpeedCheckPairs;
    const lowFailed=stats.soundSpeedLowFailed ?? 0,highFailed=stats.soundSpeedHighFailed ?? 0;
    if(stats.soundSpeedLowRank===1 && stats.soundSpeedHighRank===1 && !lowFailed && !highFailed) return `Sound speed: the winner stays first among the ${pairs} best flight pairs at ${low} and ${high} m/s.`;
    const at=(rank,failed,speed)=>{
        const others=failed-(rank===0 ? 1 : 0);
        return (rank>0 ? `ranks ${rank} at ${speed} m/s` : `could not be refined at ${speed} m/s`)+(others>0 ? ` (${others} other pair${others===1 ? "" : "s"} could not be refined there)` : "");
    };
    return `Sound speed: among the ${pairs} best flight pairs, the winner ${at(stats.soundSpeedLowRank,lowFailed,low)} and ${at(stats.soundSpeedHighRank,highFailed,high)}. Set the sound speed from the air temperature before trusting it.`;
}

export function verdictText(stats) {
    if(!stats || !Number.isFinite(stats.verdictNullPairs)) return "";
    if(!Number.isFinite(stats.verdictP)) return `Verdict: insufficient (${stats.verdictNullPairs.toLocaleString()} wrong flight pairs is too few to judge the winner against).`;
    return `Verdict: ${verdictStatus(stats.verdictP)} (p = ${stats.verdictP.toPrecision(2)}): the winner leads the best other flight pair by `+
        `${stats.verdictGap.toPrecision(3)} score units; the ${stats.verdictK} best of ${stats.verdictNullPairs.toLocaleString()} wrong pairs spread ${stats.verdictTailWidth.toPrecision(3)}. Uncalibrated.`;
}
