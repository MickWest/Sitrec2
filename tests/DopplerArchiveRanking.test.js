import {selectAudibleCandidates} from "../src/doppler/DopplerArchiveSearch";

test("silence rejection does not hide a lower-ranked valid candidate",async()=>{
    const ranked=[{score:10,audible:true},{score:9,audible:true},{score:8,audible:false},{score:7,audible:false}];
    const result=await selectAudibleCandidates(ranked,1,async p=>!p.audible);
    expect(result.results).toEqual([ranked[2]]);
    expect(result.rejectedBySilence).toBe(2);
});
