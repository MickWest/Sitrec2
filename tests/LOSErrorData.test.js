import {Vector3} from "three";
import {collectLOSErrorSamples, syntheticLOSCSV} from "../src/LOSErrorData";
import {MISB} from "../src/MISBFields";
import {directionWithError} from "../src/LOSErrorModel";

jest.mock("../src/Globals",()=>({Sit:{},GlobalDateTimeNode:{},Globals:{equatorRadius:6378137,polarRadius:6356752.314245}}));

test("recorded 10 Hz attitude is not counted as 30 Hz scene data",()=>{
    const sensor=new Vector3(6378137,0,0),start=1700000000000;
    const rows=Array.from({length:21},(_,i)=>{
        const row=[];
        row[MISB.UnixTimeStamp]=start+i*100;
        for(const key of ["PlatformHeadingAngle","PlatformPitchAngle","PlatformRollAngle","SensorRelativeAzimuthAngle","SensorRelativeElevationAngle","SensorRelativeRollAngle"]) row[MISB[key]]=0;
        return row;
    });
    const data={misb:rows,getTime:i=>rows[i][MISB.UnixTimeStamp],isValid:()=>true};
    const track={in:{misb:data},timeArray:rows.map(r=>r[MISB.UnixTimeStamp]),p:()=>sensor,
        getDataFrameSpan:()=>({first:0,last:60}),getTimeOffsetFrames:()=>0};
    class CNodeLOSTrackMISB {}
    const los=Object.assign(new CNodeLOSTrackMISB(),{id:"Recorded",frames:61,in:{cameraTrack:track,sensorAz:{},platformHeading:{}}});
    const captured=collectLOSErrorSamples({losNode:los,truthNode:{p:()=>sensor.clone().add(new Vector3(0,0,1000))},
        scene:{fps:30,frames:61},clock:{frameToMS:()=>start}});
    expect(captured.samples).toHaveLength(21);
    expect(captured.cadence.hz).toBeCloseTo(10,8);
    expect(captured.samples.at(-1).t).toBe(2);
    expect(captured.recordedCadence).toBe(true);
    expect(captured.samples[0].e[0]).toBeCloseTo(0,10);
});

test("unknown cadence is disclosed and truth coverage excludes held positions",()=>{
    const sensor=new Vector3(6378137,0,0),target=sensor.clone().add(new Vector3(0,1000,0));
    const raw={in:{misb:{misb:[]}},timeArray:[],getDataFrameSpan:()=>({first:5,last:15})};
    const targetNode={in:{data:raw},p:()=>target};
    const los={id:"Pointing",frames:21,v:()=>({position:sensor,heading:new Vector3(0,1,0)})};
    const result=collectLOSErrorSamples({losNode:los,truthNode:targetNode,scene:{fps:10,frames:21}});
    expect(result.samples).toHaveLength(11);
    expect(result.counts.outsideCoverage).toBe(10);
    expect(result.cadenceSource).toMatch(/unverified/);
});

test("synthetic export contains new directions and current geometry, never source pointing",()=>{
    const rows=[{t:0,sensor:[1,2,3],target:[1,102,3],up:[0,0,1]}];
    const csv=syntheticLOSCSV(rows,[{t:0,e:[.2,-.1]}],directionWithError);
    expect(csv.split("\n")[0]).toMatch(/SensorECEF.*TargetECEF.*LOS_ECEF/);
    const values=csv.split("\n")[1].split(",").map(Number);
    expect(values.slice(1,7)).toEqual([1,2,3,1,102,3]);
    expect(values.slice(-3)).not.toEqual([0,1,0]);
    expect(Math.hypot(...values.slice(-3))).toBeCloseTo(1,12);
});

test("PES-paired recording uses record cadence even when video frame timestamps are irregular",()=>{
    const sensor=new Vector3(6378137,0,0),rows=Array.from({length:21},(_,i)=>{
        const row=[];row[MISB.UnixTimeStamp]=1700000000000+i*100;
        for(const key of ["PlatformHeadingAngle","PlatformPitchAngle","PlatformRollAngle","SensorRelativeAzimuthAngle","SensorRelativeElevationAngle","SensorRelativeRollAngle"]) row[MISB[key]]=0;
        return row;
    });
    rows.pesPTSus=rows.map((_,i)=>i*100000);
    const data={misb:rows,getTime:i=>rows[i][MISB.UnixTimeStamp],isValid:()=>true};
    const track={in:{misb:data},timeArray:[],pairingInfo:{mode:"pts"},getTimeOffsetFrames:()=>0,p:()=>sensor};
    const los={id:"PTS LOS",frames:61,in:{cameraTrack:track,sensorAz:{},platformHeading:{}}};
    const framePTSus=Array.from({length:61},(_,i)=>i*100000/3+(i%3===1?1500:0));
    const result=collectLOSErrorSamples({losNode:los,truthNode:{p:()=>sensor.clone().add(new Vector3(0,0,1000))},
        scene:{fps:30,frames:61},videoData:{framePTSus}});
    expect(result.samples).toHaveLength(21);expect(result.cadence.hz).toBeCloseTo(10,8);
    expect(result.cadenceSource).toMatch(/PES timestamps/);
});
