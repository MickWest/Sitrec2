// A shortlist is a set of hypotheses, not a probability distribution. Collapse
// only neighbouring solutions for the same ordered aircraft pair and clock.
export function candidateRows(results,tracks,{distinct=true}={}) {
    const identities=new Map(tracks.map(track=>[track.id,track]));
    const rows=[];
    for(const [index,candidate] of results.entries()) {
        const pair=candidate.events.map(event=>event.flight);
        const existing=distinct && rows.find(row=>
            pair.length===row.pair.length && pair.every((id,i)=>id===row.pair[i]) &&
            Math.abs(candidate.recordingStart-row.candidate.recordingStart)<30 &&
            Math.hypot((candidate.lat-row.candidate.lat)*111320,
                (candidate.lon-row.candidate.lon)*111320*Math.cos((candidate.lat+row.candidate.lat)*Math.PI/360))<5000 &&
            !candidate.reviewContext && !row.candidate.reviewContext);
        if(existing) {existing.grouped++;continue;}
        const eventRMS=candidate.events.map(event=>event.rmsHz);
        const rmsHz=Number.isFinite(candidate.rmsHz)?candidate.rmsHz:eventRMS.every(Number.isFinite)?
            Math.sqrt(eventRMS.reduce((sum,value)=>sum+value*value,0)/eventRMS.length):null;
        const reviewNote=candidate.reviewContext==="added_for_post_search_ground_truth_comparison" ?
            "Added for reference comparison; excluded by the original top-100 cutoff." :
            candidate.reviewContext==="original_global_replay_region" ? "Original global replay hypothesis." : candidate.reviewContext ?? "";
        rows.push({candidate,index,rank:index+1,pair,grouped:1,rmsHz,reviewNote,
            originalRank:Number.isInteger(candidate.originalCountryRank)?candidate.originalCountryRank:null,
            flights:pair.map(id=>{
                const track=identities.get(id);
                return [...new Set([track?.callsign,track?.registration,track?.aircraftType,id].filter(Boolean))].join(" · ");
            })});
    }
    return rows;
}
