import {candidateRows} from "../src/doppler/DopplerCandidates";

const candidate=(values={})=>({lat:37,lon:-122,recordingStart:1000,score:-1,
    events:[{flight:"first",rmsHz:1},{flight:"second",rmsHz:3}],...values});

test("shortlist groups nearby duplicates while retaining different aircraft and clocks",()=>{
    const results=[candidate(),candidate({lat:37.001}),candidate({recordingStart:1040}),
        candidate({events:[{flight:"second",rmsHz:2},{flight:"first",rmsHz:2}]})];
    const rows=candidateRows(results,[]);
    expect(rows.map(row=>row.index)).toEqual([0,2,3]);expect(rows[0].grouped).toBe(2);
    expect(rows[0].rmsHz).toBeCloseTo(Math.sqrt(5));
    expect(candidateRows(results,[],{distinct:false})).toHaveLength(4);
});

test("review additions preserve their original rank and are never hidden by grouping",()=>{
    const added=candidate({originalCountryRank:713,reviewContext:"Added for reference comparison"});
    const rows=candidateRows([candidate(),added],[{id:"first",registration:"Example",aircraftType:"Test"}]);
    expect(rows).toHaveLength(2);expect(rows[1].originalRank).toBe(713);
    expect(rows[1].flights[0]).toBe("Example · Test · first");
    expect(rows[1].candidate).toBe(added);
});
