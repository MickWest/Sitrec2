import fs from "node:fs";
import path from "node:path";
import {loadAircraftTypes} from "../src/doppler/DopplerArchive";

// The type list is bundled from the Mictronics aircraft database (ODC-By), not fetched from a
// third-party host, so the user-data egress check sees no new destination.
const ROOT=path.resolve(__dirname,"..");
const TYPES_FILE=path.join(ROOT,"data/aircraft/icao_aircraft_types.json");

test("the bundled aircraft type list marks jets by the last letter of desc",()=>{
    const types=JSON.parse(fs.readFileSync(TYPES_FILE,"utf8"));
    expect(Object.keys(types).length).toBeGreaterThan(2000);
    expect(types.B738.desc.endsWith("J")).toBe(true);
    expect(types.A320.desc.endsWith("J")).toBe(true);
    expect(types.C172.desc.endsWith("J")).toBe(false);
    expect(types.AT76.desc.endsWith("J")).toBe(false);
});

test("the bundled type list keeps its ODC-By license and attribution beside it",()=>{
    const dir=path.dirname(TYPES_FILE);
    expect(fs.readFileSync(path.join(dir,"LICENSE"),"utf8")).toMatch(/ODC Attribution License/);
    expect(fs.readFileSync(path.join(dir,"README.md"),"utf8")).toMatch(/Mictronics aircraft database/);
});

test("loadAircraftTypes reads the URL it is given and refuses to guess one",async()=>{
    const saved=global.fetch;
    const calls=[];
    global.fetch=async url=>{calls.push(url);return {ok:true,json:async()=>({B738:{desc:"L2J"}})};};
    try {
        await expect(loadAircraftTypes("https://example.test/sitrec/data/aircraft/icao_aircraft_types.json"))
            .resolves.toEqual({B738:{desc:"L2J"}});
        expect(calls).toEqual(["https://example.test/sitrec/data/aircraft/icao_aircraft_types.json"]);
        await expect(loadAircraftTypes()).rejects.toThrow(/No aircraft type list/);
        expect(calls.length).toBe(1);
        global.fetch=async()=>({ok:false,status:404});
        await expect(loadAircraftTypes("https://example.test/missing.json")).rejects.toThrow(/404/);
    } finally {
        global.fetch=saved;
    }
});
