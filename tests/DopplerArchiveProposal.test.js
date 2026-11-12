jest.mock("../src/doppler/DopplerArchive",()=>({
    FlightArchive:jest.fn(),scanFlightArchive:jest.fn(),readArchiveTrack:jest.fn(),
}));
jest.mock("../src/doppler/DopplerModel",()=>({
    ...jest.requireActual("../src/doppler/DopplerModel"),
    nearestApproachFromObserver:jest.fn(()=>({time:10060,arrival:10060,range:1000,speed:90})),
    prepareTrack:jest.fn(t=>({id:t.id,segments:[{t0:10060,t1:10070,p0:[0,0,0],p1:[900,0,0],velocity:[90,0,0],speed:90}]})),
}));
jest.mock("../src/doppler/DopplerSearch",()=>({
    ...jest.requireActual("../src/doppler/DopplerSearch"),
    scoreCombination:jest.fn(),makeGrid:jest.fn(()=>[]),searchLocations:jest.fn(async()=>({heat:[]})),
}));
jest.mock("../src/doppler/DopplerElevation",()=>({DopplerElevation:class {
    async initialize() {} async at() {return 100;}
}}));
jest.mock("../src/doppler/DopplerOptimizer",()=>({refineDopplerLocation:jest.fn()}));

import {archiveCoarseSettings,searchFlightArchive} from "../src/doppler/DopplerArchiveSearch";
import {readArchiveTrack,scanFlightArchive} from "../src/doppler/DopplerArchive";
import {newEvent,scoreCombination,SEARCH_DEFAULTS} from "../src/doppler/DopplerSearch";
import {refineDopplerLocation} from "../src/doppler/DopplerOptimizer";
import {ARCHIVE_DEFAULTS} from "../src/doppler/DopplerArchiveOptions";

const measured=()=>({...newEvent(60),trace:[30,45,60,75,90].map(time=>({time,frequency:130}))});

test("trace seeds require valid measurements for every brightness event and leave the requested objective intact",()=>{
    const events=[measured(),measured()],settings={...SEARCH_DEFAULTS,mode:"brightness"};
    const copy=JSON.stringify({events,settings});
    expect(archiveCoarseSettings(events,settings,ARCHIVE_DEFAULTS).mode).toBe("trace");
    expect(JSON.stringify({events,settings})).toBe(copy);
    for(const trace of [undefined,null,[],events[1].trace.slice(0,3),[{time:60,frequency:NaN},...events[1].trace],
        [{time:60,frequency:0},...events[1].trace],[{time:100,frequency:130},...events[1].trace]]) {
        expect(archiveCoarseSettings([events[0],{...events[1],trace}],settings,ARCHIVE_DEFAULTS).mode).toBe("brightness");
    }
    expect(archiveCoarseSettings(events,{...settings,mode:"trace"},ARCHIVE_DEFAULTS).mode).toBe("trace");
});

test("coarse trace fits use a 4 s clock grid with a parabola step; brightness keeps the 2 s grid",()=>{
    const events=[measured(),measured()],settings={...SEARCH_DEFAULTS,mode:"brightness",timeStep:0.5};
    expect(archiveCoarseSettings(events,settings,ARCHIVE_DEFAULTS)).toMatchObject({mode:"trace",timeStep:4,clockRefine:true});
    expect(archiveCoarseSettings(events,{...settings,mode:"trace"},ARCHIVE_DEFAULTS)).toMatchObject({timeStep:4,clockRefine:true});
    expect(archiveCoarseSettings([events[0],{...events[1],trace:[]}],settings,ARCHIVE_DEFAULTS))
        .toMatchObject({mode:"brightness",timeStep:2,clockRefine:false});
    // A coarser requested step is kept.
    expect(archiveCoarseSettings(events,{...settings,mode:"trace",timeStep:6},ARCHIVE_DEFAULTS).timeStep).toBe(6);
});

test.each([true,false])("all flight regions and sides reach brightness refinement before ranking (manual traces: %s)",async hasTrace=>{
    jest.clearAllMocks();
    const dataset={flights:[{id:"First",base:10000},{id:"Second",base:10000}],stats:{flights:2},samples:{
        length:2,flight:[0,1],time:[10060,10060],lat:[40,40],lon:[-100,-100],speedMin:[90,90],speedMax:[90,90],flags:[1,1],
    }};
    scanFlightArchive.mockResolvedValue(dataset);
    readArchiveTrack.mockImplementation(async(_dataset,index)=>({id:dataset.flights[index].id,points:[]}));
    scoreCombination.mockImplementation((pair,_events,settings)=>({score:pair[0].track.id==="First" ? 10 : 0,recordingStart:10000,
        events:[{flight:pair[0].track.id,cpaArrival:10060,rangeM:1000,speedMS:90}],proposalMode:settings.mode}));
    refineDopplerLocation.mockImplementation(async({candidate,settings})=>{
        if(settings.mode==="trace") return candidate.events[0].flight==="First" ? null : {...candidate,
            lat:candidate.lat+0.001,lon:candidate.lon-0.002,score:-1e6};
        return {...candidate,score:candidate.events[0].flight==="Second" ? 100 : 1,refinedMode:settings.mode};
    });
    const event=hasTrace ? measured() : {...measured(),trace:undefined};
    const settings={...SEARCH_DEFAULTS,mode:"brightness",recordingStart:10000};
    const spectrogram={test:true};
    const result=await searchFlightArchive({files:[{name:`Synthetic${hasTrace}.tar`,size:1024,lastModified:0}],events:[event],settings,spectrogram,
        archiveOptions:{...ARCHIVE_DEFAULTS,coarseStep:2000,heightBands:[100],keep:1,refineCount:1}});
    expect(scoreCombination.mock.calls.length).toBeGreaterThan(0);
    for(const call of scoreCombination.mock.calls) {
        expect(call[2].mode).toBe(hasTrace ? "trace" : "brightness");
        expect(call[3]).toBe(hasTrace ? null : spectrogram);
        if(hasTrace) expect(call[1][0].trace).toHaveLength(event.trace.length);
    }
    const initializers=refineDopplerLocation.mock.calls.map(([input])=>input).filter(input=>input.settings.mode==="trace");
    const brightness=refineDopplerLocation.mock.calls.map(([input])=>input).filter(input=>input.settings.mode==="brightness");
    const finals=brightness.filter(input=>input.settings.soundSpeed===settings.soundSpeed);
    // The sound-speed check refines the winner again at 343 -/+ 5 m/s, from the
    // refined point, without a new trace initialization.
    const checks=brightness.filter(input=>input.settings.soundSpeed!==settings.soundSpeed);
    expect(checks.map(input=>input.settings.soundSpeed)).toEqual([338,348]);
    for(const input of checks) {
        expect(input.candidate.events[0].flight).toBe("Second");expect(input.candidate.score).toBe(100);
        expect(input.stepM).toBe(200);expect(input.settings).toEqual({...settings,soundSpeed:input.settings.soundSpeed});
    }
    // The verdict's null uses every refined region, not only the kept results:
    // "First" is one wrong pair although keep is 1.
    expect(result.stats).toMatchObject({soundSpeedBase:343,soundSpeedCheckMS:5,soundSpeedCheckPairs:1,soundSpeedLowRank:1,soundSpeedHighRank:1,verdictNullPairs:1});
    expect(result.soundSpeedPairs).toEqual([{flights:["Second"],score:100,low:100,high:100}]);
    expect(refineDopplerLocation).toHaveBeenCalledTimes(hasTrace ? 10 : 6);
    expect(initializers).toHaveLength(hasTrace ? 4 : 0);expect(finals).toHaveLength(4);
    for(const input of initializers) {
        expect(input.settings).toEqual({...settings,mode:"trace"});expect(input.events).toEqual([event]);
        expect(input.spectrogram).toBeNull();expect(input.stepM).toBe(2000);expect(input.maxOffsetM).toBe(8000);
    }
    for(const input of finals) {
        expect(input.settings).toBe(settings);expect(input.spectrogram).toBe(spectrogram);
        expect(input.events).toEqual([event]);expect(input.maxOffsetM).toBe(8000);
        expect(input.stepM).toBe(hasTrace ? 200 : 2000);
        if(hasTrace) {
            const seed=initializers.find(i=>i.candidate.side===input.candidate.side &&
                i.candidate.events[0].flight===input.candidate.events[0].flight).candidate;
            if(input.candidate.events[0].flight==="First") expect(input.candidate).toBe(seed);
            else {
                expect(input.candidate.lat).toBe(seed.lat+0.001);expect(input.candidate.lon).toBe(seed.lon-0.002);
                expect(input.candidate.score).toBe(-1e6);
            }
        }
    }
    expect(result.stats.regions).toBe(4);
    expect(result.results).toHaveLength(1);expect(result.results[0].events[0].flight).toBe("Second");
    expect(result.results[0].refinedMode).toBe("brightness");
});
