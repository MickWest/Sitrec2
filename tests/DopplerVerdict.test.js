import {atArrival,nearestApproach,observerTrack} from "../src/doppler/DopplerModel";
import {newEvent,scoreCombination,SEARCH_DEFAULTS} from "../src/doppler/DopplerSearch";
import {validateAnalysis} from "../src/doppler/DopplerAnalysis";
import {bestPairScores,rankingVerdict,soundSpeedStats,soundSpeedText,verdictStats,verdictText} from "../src/doppler/DopplerVerdict";
import {verdictCandidates} from "../src/doppler/DopplerArchiveSearch";

// 200 wrong pairs with evenly spaced scores 0, -0.1, -0.2, ... . k is 5 % of
// them, at least 15, so the tail is the best 15 above the 16th (-1.5) and its
// mean excess is 0.8.
const wrongPairs=()=>Array.from({length:200},(_,i)=>({flights:[`A${i}`,`B${i}`],score:-0.1*i}));

test("the verdict judges the winner's lead against the tail of the wrong pairs",()=>{
    const clear=rankingVerdict([...wrongPairs(),{flights:["W1","W2"],score:2.4}],{flights:["W1","W2"],score:2.4});
    expect(clear).toMatchObject({status:"located",k:15,nullPairs:200});
    expect(clear.tailWidth).toBeCloseTo(0.8,12);expect(clear.gap).toBeCloseTo(2.4,12);
    expect(clear.p).toBeCloseTo(Math.exp(-3),12);
    const close=rankingVerdict(wrongPairs(),{flights:["W1","W2"],score:0.1});
    expect(close.status).toBe("no match");expect(close.p).toBeCloseTo(Math.exp(-0.125),12);
    expect(rankingVerdict(wrongPairs(),{flights:["W1","W2"],score:0.8}).status).toBe("ambiguous");
});

test("pairs that share a flight with the winner are not wrong answers; each pair counts once",()=>{
    const pairs=[...wrongPairs(),{flights:["W1","X"],score:2.3},{flights:["Y","W2"],score:2.2},
        {flights:["A0","B0"],score:-5},{flights:["A1","B1"],score:-0.05}];
    const verdict=rankingVerdict(pairs,{flights:["W1","W2"],score:2.4});
    // The pairs with W1 or W2 are left out; A1/B1 keeps its better score.
    expect(verdict.nullPairs).toBe(200);expect(verdict.gap).toBeCloseTo(2.4,12);
    expect(bestPairScores(pairs).find(p=>p.flights.join("/")==="A1/B1").score).toBe(-0.05);
    // Candidates with events are keyed by their flights in event order.
    expect(bestPairScores([{score:1,events:[{flight:"P"},{flight:"Q"}]},{score:2,events:[{flight:"P"},{flight:"Q"}]}]))
        .toEqual([{flights:["P","Q"],score:2}]);
});

test("too few wrong pairs give no verdict, and saved statistics stay finite",()=>{
    const few=rankingVerdict(wrongPairs().slice(0,19),{flights:["W1","W2"],score:1});
    expect(few).toEqual({status:"insufficient",nullPairs:19});
    expect(verdictStats(few)).toEqual({verdictNullPairs:19});
    expect(verdictText(verdictStats(few))).toMatch(/insufficient/);
    const stats=verdictStats(rankingVerdict(wrongPairs(),{flights:["W1","W2"],score:2.4}));
    expect(Object.values(stats).every(Number.isFinite)).toBe(true);
    expect(verdictText(stats)).toMatch(/^Verdict: located \(p = 0\.050\)/);
    expect(verdictText({passed:3})).toBe("");
});

test("the sound-speed check reports the rank of the winner at the lower and higher speed",()=>{
    const rows=[{flights:["W"],score:-1,low:-1.2,high:-0.9},{flights:["X"],score:-1.1,low:-1.1,high:-1.0},{flights:["Y"],score:-1.3,low:-1.15,high:null}];
    const stats=soundSpeedStats(rows,343,5);
    expect(stats).toEqual({soundSpeedBase:343,soundSpeedCheckMS:5,soundSpeedCheckPairs:3,soundSpeedLowRank:3,soundSpeedHighRank:1,
        soundSpeedLowFailed:0,soundSpeedHighFailed:1});
    expect(soundSpeedText(stats)).toMatch(/ranks 3 at 338 m\/s and ranks 1 at 348 m\/s \(1 other pair could not be refined there\)/);
    expect(soundSpeedText(soundSpeedStats([{flights:["W"],score:1,low:1,high:1},{flights:["X"],score:0,low:0,high:0}],343,5))).toMatch(/stays first/);
    expect(soundSpeedStats(rows,343,0)).toEqual({});
});

test("a winner that cannot be refined at a checked speed does not count as staying first",()=>{
    const stats=soundSpeedStats([{flights:["W"],score:-1,low:-1.1,high:null}],343,5);
    expect(stats).toMatchObject({soundSpeedCheckPairs:1,soundSpeedLowRank:1,soundSpeedHighRank:0});
    expect(soundSpeedText(stats)).toMatch(/ranks 1 at 338 m\/s and could not be refined at 348 m\/s\./);
    expect(soundSpeedText(stats)).not.toMatch(/stays first/);
    // A competitor without a score at a checked speed could have beaten the winner.
    const competitor=soundSpeedStats([{flights:["W"],score:-1,low:-1,high:-1},{flights:["X"],score:-2,low:null,high:-3}],343,5);
    expect(competitor).toMatchObject({soundSpeedLowRank:1,soundSpeedHighRank:1,soundSpeedLowFailed:1,soundSpeedHighFailed:0});
    expect(soundSpeedText(competitor)).not.toMatch(/stays first/);
    expect(soundSpeedText(competitor)).toMatch(/ranks 1 at 338 m\/s \(1 other pair could not be refined there\) and ranks 1 at 348 m\/s\./);
});

test("with silence windows, the verdict's wrong pairs are only candidates that pass the silence check",async()=>{
    const candidate=(flights,score,audible=true)=>({events:flights.map(flight=>({flight})),score,audible});
    const winner=candidate(["W1","W2"],10),blocked=candidate(["A","B"],9,false);
    // 2,000 pairs below the kept results, two regions each in score order: the best
    // region of every third pair fails the silence check, and of those, every second
    // pair's other region fails too.
    const below=[];
    for(let i=0;i<2000;i++) below.push(candidate([`C${i}`,`D${i}`],8-i*0.001,i%3!==0));
    for(let i=0;i<2000;i++) below.push(candidate([`C${i}`,`D${i}`],5-i*0.001,i%6!==0));
    const blockedLower=candidate(["A","B"],4);
    const shortlist=[winner,blocked,...below,blockedLower];
    const checks=[];const passes=async c=>{checks.push(c);return c.audible;};
    const population=await verdictCandidates(shortlist,[winner],[blocked],passes,true);
    // Kept and rejected candidates are not checked again, and a pair is not checked
    // again after one of its regions passed.
    expect(checks).not.toContain(winner);expect(checks).not.toContain(blocked);
    expect(checks).toHaveLength(2000+Math.ceil(2000/3)+1);
    // The whole passing population: every pair with a passing region, at its best
    // passing score. Pairs whose regions all fail drop out.
    expect(population.every(c=>c.audible)).toBe(true);
    expect(population).toHaveLength(1+(2000-Math.ceil(2000/6))+1);
    expect(population.find(c=>c.events[0].flight==="C3").score).toBeCloseTo(5-0.003,12);
    expect(population.find(c=>c.events[0].flight==="A")).toBe(blockedLower);
    // Without silence windows every refined region is used, unchecked.
    expect(await verdictCandidates(shortlist,[winner],[],async()=>{throw new Error("not called");},false)).toBe(shortlist);
});

// A pass with 40 clean trace points and 6 points from a foreign tone 25 Hz higher.
function contaminated() {
    const track=observerTrack({id:"test",segments:[{t0:-200,t1:200,p0:[-18000,1500,0],
        p1:[18000,1500,0],velocity:[90,0,0],speed:90}]},[0,0,0],343);
    const clean=Array.from({length:40},(_,i)=>({time:i*1.5,frequency:110*atArrival(track,i*1.5).factor}));
    const foreign=Array.from({length:6},(_,i)=>({time:20+i,frequency:135}));
    const event={...newEvent(30),start:0,end:60,frequency:110,frequencyTolerance:20,trace:[...clean,...foreign]};
    const settings={...SEARCH_DEFAULTS,mode:"trace",recordingStart:0,timeTolerance:0,cpaTolerance:1e9};
    return {pair:[{track,cpa:nearestApproach(track)}],event,settings};
}

test("robust trace residuals limit the pull of a foreign segment",()=>{
    const {pair,event,settings}=contaminated();
    const squared=scoreCombination(pair,[event],settings).events[0];
    const robust=scoreCombination(pair,[event],{...settings,traceLoss:"robust"}).events[0];
    expect(Math.abs(squared.frequency-110)).toBeGreaterThan(2);
    expect(Math.abs(robust.frequency-110)).toBeLessThan(0.5);
    // The reported RMS stays a plain root mean square in both modes.
    const rms=fit=>Math.sqrt(event.trace.reduce((s,p)=>s+(p.frequency-fit.frequency*atArrival(pair[0].track,p.time).factor)**2,0)/event.trace.length);
    expect(squared.rmsHz).toBeCloseTo(rms(squared),9);expect(robust.rmsHz).toBeCloseTo(rms(robust),9);
    // On a clean trace both losses agree.
    const clean={...event,trace:event.trace.slice(0,40)};
    expect(scoreCombination(pair,[clean],{...settings,traceLoss:"robust"}).events[0].frequency).toBeCloseTo(110,6);
});

test("saved analyses accept both trace losses and the sound-speed options",()=>{
    const {event,settings}=contaminated();
    const analysis={version:1,settings:{...settings,recordingStart:"",traceLoss:"robust"},events:[event],tracks:[],
        archiveOptions:{soundSpeedCheck:0,soundSpeedCheckPairs:10}};
    expect(validateAnalysis(analysis).settings.traceLoss).toBe("robust");
    // An analysis saved before the option existed has no traceLoss key.
    const {traceLoss,...older}=analysis.settings;
    expect(validateAnalysis({...analysis,settings:older}).settings.traceLoss).toBe("squared");
    expect(()=>validateAnalysis({...analysis,settings:{...analysis.settings,traceLoss:"cubic"}})).toThrow();
});
