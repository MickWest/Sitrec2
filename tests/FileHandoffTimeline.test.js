import {applyHandoffTimeline, traverseHandoffTimeline} from "../src/FileHandoffTimeline";
import {contextTrackCSVs} from "../src/TraverseHandoff";

const epoch = Date.parse("2025-02-01T20:00:00Z");
function receiver() {
    const sit = {frames:900, fps:30, simSpeed:1, aFrame:0, bFrame:899};
    const playback = {frame:625, paused:false};
    const dateTime = {setStartDateTime:jest.fn(), changedFrames:jest.fn(),
        guiSitchFrames:{_max:2000, _elasticMax:2000, max:jest.fn(), updateElasticStep:jest.fn()}};
    return {sit,playback,dateTime};
}

test("a 120-second handoff opens all 3600 samples instead of the default 900", () => {
    const r=receiver();
    const results={clipStartMs:epoch,dataset:{n:3600,fps:30,frame0:0,S:new Float64Array(3600*3)}};
    const timeline=traverseHandoffTimeline(results,30);
    const files=contextTrackCSVs(results,{startMs:epoch,toLLA:()=>[37,-120,2000]});
    const rows=files[0].text.trim().split("\n").slice(1);
    expect(rows).toHaveLength(3600);
    expect(applyHandoffTimeline(timeline,r.sit,r.playback,r.dateTime)).toBe(true);
    expect(r.sit).toMatchObject({frames:3600,fps:30,simSpeed:1,aFrame:0,bFrame:3599});
    expect(r.playback).toEqual({frame:0,paused:true});
    const start=r.dateTime.setStartDateTime.mock.calls[0][0].valueOf();
    const last=start+r.sit.bFrame*1000*r.sit.simSpeed/r.sit.fps;
    expect(start).toBe(Date.parse(rows[0].split(',')[0]));
    expect(Math.abs(last-Date.parse(rows.at(-1).split(',')[0]))).toBeLessThan(1);
    expect(r.dateTime.changedFrames).toHaveBeenCalledTimes(1);
    expect(r.dateTime.guiSitchFrames.max).toHaveBeenCalledWith(3600);
});

test("an A–B selection opens its full window at the exported timestamps", () => {
    const r=receiver();
    const results={clipStartMs:epoch,dataset:{n:1200,fps:30,frame0:900}};
    applyHandoffTimeline(traverseHandoffTimeline(results),r.sit,r.playback,r.dateTime);
    expect(r.sit.frames).toBe(1200);
    expect(r.sit.bFrame).toBe(1199);
    expect(r.dateTime.setStartDateTime).toHaveBeenCalledWith(new Date(epoch+30000));
});

test("a non-unit simulation speed preserves the effective sample interval", () => {
    const r=receiver();
    const results={clipStartMs:epoch,dataset:{n:3600,fps:3,frame0:90}};
    applyHandoffTimeline(traverseHandoffTimeline(results,30),r.sit,r.playback,r.dateTime);
    expect(r.sit.fps).toBe(30);
    expect(r.sit.simSpeed).toBe(10);
    expect(r.dateTime.setStartDateTime).toHaveBeenCalledWith(new Date(epoch+30000));
    expect(r.sit.bFrame*r.sit.simSpeed/r.sit.fps).toBe(3599/3);
});

test("older handoffs without timing leave the receiving scene unchanged", () => {
    const r=receiver(), before={...r.sit};
    expect(applyHandoffTimeline(undefined,r.sit,r.playback,r.dateTime)).toBe(false);
    expect(r.sit).toEqual(before);
    expect(r.dateTime.changedFrames).not.toHaveBeenCalled();
});

test.each([{frames:NaN},{frames:0},{fps:0},{simSpeed:Infinity},{startTime:'invalid'}])(
    "invalid timing is refused before changing the scene: %j", bad => {
        const r=receiver(), before={...r.sit};
        expect(applyHandoffTimeline({frames:3600,fps:30,simSpeed:1,startTime:new Date(epoch).toISOString(),...bad},
            r.sit,r.playback,r.dateTime)).toBe(false);
        expect(r.sit).toEqual(before);
    });
