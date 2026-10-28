import {filterSourceItems} from "../src/MeasurementSourceFilter";

const items = [
    {id: "satelliteTrack", name: "Satellite: ICEYE-X36"},
    {id: "satelliteTrack2", name: "Satellite 2: COSMOS 2612"},
    {id: "norad:59103", name: "ICEYE-X36 (59103)"},
    {id: "norad:68762", name: "COSMOS 2612 (68762)"},
];

describe("filterSourceItems", () => {
    test("an empty filter returns every item", () => {
        expect(filterSourceItems(items, "").shown).toEqual(items);
        expect(filterSourceItems(items, "   ").shown).toEqual(items);
        expect(filterSourceItems(items, undefined).hidden).toBe(0);
    });

    test("matches the name in any case", () => {
        const {shown} = filterSourceItems(items, "cosmos");
        expect(shown.map(item => item.id)).toEqual(["satelliteTrack2", "norad:68762"]);
    });

    test("matches a NORAD number in the id", () => {
        const {shown} = filterSourceItems([{id: "norad:25544", name: "ISS (ZARYA)"}, ...items], "25544");
        expect(shown.map(item => item.id)).toEqual(["norad:25544"]);
    });

    test("caps the rows and counts the rest", () => {
        const many = Array.from({length: 1000}, (_, i) => ({id: String(i), name: "STARLINK-" + i}));
        const {shown, hidden} = filterSourceItems(many, "starlink", 300);
        expect(shown).toHaveLength(300);
        expect(hidden).toBe(700);
    });

    test("no match gives an empty list", () => {
        expect(filterSourceItems(items, "zzz")).toEqual({shown: [], hidden: 0});
    });
});
