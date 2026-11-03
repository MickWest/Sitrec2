jest.mock("../src/doppler/DopplerArchive",()=>({
    ...jest.requireActual("../src/doppler/DopplerArchive"),readArchiveTrack:jest.fn(),
}));

import {readArchiveTrack} from "../src/doppler/DopplerArchive";
import {archiveTrackLoader} from "../src/doppler/DopplerArchiveSearch";

function fixture() {
    const times=[10000,10010,...Array.from({length:129},(_,i)=>11000+i*60)];
    const dataset={stats:{},samples:{time:times,flight:times.map(()=>0)}};
    readArchiveTrack.mockReset();
    readArchiveTrack.mockImplementation(async(_dataset,_flight,from,to)=>{
        const center=(from+to)/2;
        const points=[{time:center-5,lat:40,lon:-100,altitudeM:1000}];
        if(center!==10010) points.push({time:center+5,lat:40,lon:-99.9999,altitudeM:1000});
        return {id:"synthetic",points};
    });
    return {dataset,load:archiveTrackLoader(dataset,{soundSpeed:343,maxGap:30})};
}

test("different windows within one flight minute cannot share a prepared track",async()=>{
    const {dataset,load}=fixture();
    expect(Math.floor(dataset.samples.time[0]/60)).toBe(Math.floor(dataset.samples.time[1]/60));
    const first=await load(0);
    expect(first).not.toBeNull();
    expect(await load(1)).toBeNull();
    expect(readArchiveTrack).toHaveBeenNthCalledWith(1,dataset,0,9760,10240);
    expect(readArchiveTrack).toHaveBeenNthCalledWith(2,dataset,0,9770,10250);
    expect(await load(0)).toBe(first);
    expect(readArchiveTrack).toHaveBeenCalledTimes(2);
});

test("eviction and reload reproduce the exact source window and preparation validity",async()=>{
    const {dataset,load}=fixture();
    const initial=await load(0);
    expect(await load(1)).toBeNull();
    for(let i=2;i<dataset.samples.time.length;i++) expect(await load(i)).not.toBeNull();
    const reloaded=await load(0);
    expect(reloaded).not.toBe(initial);expect(reloaded).toEqual(initial);
    expect(await load(1)).toBeNull();
    const calls=readArchiveTrack.mock.calls;
    expect(calls[calls.length-2]).toEqual(calls[0]);
    expect(calls[calls.length-1]).toEqual(calls[1]);
});
