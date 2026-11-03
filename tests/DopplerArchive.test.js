import {gzipSync} from "node:zlib";
import {FlightArchive,readArchiveTrack,scanFlightArchive,traceFix} from "../src/doppler/DopplerArchive";
import {newEvent} from "../src/doppler/DopplerSearch";
import {archivePairs,silenceChecker} from "../src/doppler/DopplerArchiveSearch";
import {ARCHIVE_DEFAULTS} from "../src/doppler/DopplerArchiveOptions";

function tar(files) {
    const parts=[];
    for(const [name,data] of files) {
        const bytes=gzipSync(Buffer.from(JSON.stringify(data))),header=Buffer.alloc(512);
        header.write(name);header.write(bytes.length.toString(8).padStart(11,"0")+"\0",124);
        parts.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
    }
    return Buffer.concat([...parts,Buffer.alloc(1024)]);
}
const file=(bytes,name)=>Object.assign(new Blob([bytes]),{name});
const fixture=(id,type)=>({icao:id,t:type,r:"Test registration",timestamp:100000,
    trace:[0,10,30,40,60].map((t,i)=>[t,37,-122+i*.001,3000,200,90,0,0,{flight:"TEST"},"adsb_icao",3500])});

test("split tar reads cross part boundaries without extracting file paths",async()=>{
    const bytes=tar([["./traces/00/trace_full_abc000.json",fixture("abc000","PROP")]]);
    const archive=new FlightArchive([file(bytes.subarray(517),"Archive.tar.ab"),file(bytes.subarray(0,517),"Archive.tar.aa")]);
    const entries=[];for await(const e of archive.entries()) entries.push(e);
    expect(entries).toHaveLength(1);
    expect((await archive.json(entries[0])).icao).toBe("abc000");
    const truncated=new FlightArchive([file(bytes.subarray(0,520),"Archive.tar.aa")]);
    await expect(async()=>{for await(const e of truncated.entries()) await truncated.json(e);}).rejects.toThrow(/truncated/);
});

test("archive scanning keeps jets for silence, excludes them from events, and preserves labels",async()=>{
    const bytes=tar([["traces/00/trace_full_abc000.json",fixture("abc000","PROP")],
        ["traces/01/trace_full_abc001.json",fixture("abc001","JET")],
        ["traces/02/trace_full_abc002.json",fixture("abc002","UNKNOWN")]]);
    const archive=new FlightArchive([file(bytes,"Archive.tar")]);
    const dataset=await scanFlightArchive(archive,[newEvent()],{excludeJets:true,types:{JET:{desc:"L2J"}},sampleStep:30});
    expect(dataset.flights.map(f=>f.id)).toEqual(["abc000","abc001","abc002"]);
    expect(dataset.flights.map(f=>f.eventEligible)).toEqual([true,false,true]);
    expect(dataset.samples.length).toBe(9);
    for(let i=0;i<dataset.samples.length;i++) {
        expect(dataset.samples.flags[i]).toBe(dataset.samples.flight[i]===1 ? 0 : 1);
    }
    const track=await readArchiveTrack(dataset,0,100010,100040);
    expect(track.callsign).toBe("TEST");expect(track.aircraftType).toBe("PROP");
    expect(track.points).toHaveLength(3);expect(track.points[0].altitudeM).toBeCloseTo(3500*.3048,8);
});

test("pressure altitude fallback is explicit and counted, with correct source units",()=>{
    const row=[1,37,-122,3000,200,90,0];
    expect(traceFix(row,1000)).toBeNull();
    const fix=traceFix(row,1000,{allowBarometric:true});
    expect(fix.time).toBe(1001);expect(fix.altitudeM).toBeCloseTo(914.4,8);
    expect(fix.speed).toBeCloseTo(102.8888888888,7);expect(fix.approximateAltitude).toBe(true);
});

test("silence uses the event type filter unless all-aircraft checking is selected",async()=>{
    const data=fixture("jet","JET");
    data.trace=[0,10,20].map(t=>[t,37,-122+(t-10)*.001,3000,200,90,0,0,{},"adsb_icao",3500]);
    const dataset=await scanFlightArchive(new FlightArchive([file(tar([["trace_full_jet.json",data]]),"Archive.tar")]),
        [newEvent()],{excludeJets:true,types:{JET:{desc:"L2J"}},sampleStep:5});
    const settings={silence:[[5,25]],silenceRadiusM:2000,soundSpeed:343,maxGap:30};
    const candidate={lat:37,lon:-122,altitudeM:0,recordingStart:100000,events:[{rangeM:2000}]};
    const options={...ARCHIVE_DEFAULTS,sampleStep:5};
    expect(await silenceChecker(dataset,[newEvent()],settings,options)(candidate)).toBe(true);
    expect(await silenceChecker(dataset,[newEvent()],settings,{...options,silenceAllAircraft:true})(candidate)).toBe(false);
});

test("archive pairing uses source geometry and delayed-event timing across the whole selected area",async()=>{
    const second={...fixture("abc001","PROP"),timestamp:100920};
    const far={...fixture("abc002","PROP"),timestamp:100920,trace:fixture("abc002","PROP").trace.map(r=>{const copy=[...r];copy[2]=-80;return copy;})};
    const bytes=tar([["trace_full_abc000.json",fixture("abc000","PROP")],
        ["trace_full_abc001.json",second],["trace_full_abc002.json",far]]);
    const events=[newEvent(60),newEvent(980)];
    const data=await scanFlightArchive(new FlightArchive([file(bytes,"Archive.tar")]),events,{sampleStep:30});
    const pairs=await archivePairs(data,events,{recordingStart:null,soundSpeed:343,cpaTolerance:8,timeTolerance:3},ARCHIVE_DEFAULTS);
    expect(pairs.length).toBeGreaterThan(0);
    for(const [i,j] of pairs) {
        expect(data.samples.flight[i]).toBe(0);expect(data.samples.flight[j]).toBe(1);
        expect(Math.abs(data.samples.time[j]-data.samples.time[i]-920)).toBeLessThan(120);
    }
});


test("speed changes within a sparse bucket remain eligible before pair pruning",async()=>{
    const event={...newEvent(),speedMin:95,speedMax:105};
    const data={...fixture("changing","PROP"),trace:[0,10,30].map((t,i)=>[t,37,-122,3000,i===1 ? 194.38445 : 150,90,0,0,{},"adsb_icao",3500])};
    const dataset=await scanFlightArchive(new FlightArchive([file(tar([["trace_full_changing.json",data]]),"Archive.tar")]),[event],{sampleStep:30});
    expect(dataset.samples.flags[0]&1).toBe(1);
    expect(dataset.samples.speedMin[0]).toBeLessThan(event.speedMin);
    expect(dataset.samples.speedMax[0]).toBeGreaterThan(event.speedMin);
});
