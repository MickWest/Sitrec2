/** @jest-environment jsdom */
import {CSatellite} from "../src/nodes/CSatellite";

test("all-category scenes show other loaded constellations and can still filter them", () => {
    const satellites = new CSatellite({showOtherSatellites: true});
    satellites.TLEData = {getMatchingRecords: () => [], satData: [
        {name: "STARLINK-1234", number: 60001}, {name: "ONEWEB-0001", number: 60002},
    ]};
    satellites.filterSatellites();
    expect(satellites.TLEData.satData.map(s => s.visible)).toEqual([true, true]);
    satellites.showOtherSatellites = false;
    satellites.filterSatellites();
    expect(satellites.TLEData.satData.map(s => s.visible)).toEqual([true, false]);
});

test("search intersects category and orbit filters, and clearing it restores categories", () => {
    const satellites = new CSatellite();
    satellites.removeSatelliteArrows = jest.fn();
    satellites.showBrightest = false;
    satellites.showISS = false;
    satellites.TLEData = {
        getMatchingRecords: () => [],
        satData: [
            {name: "STARLINK-1234", number: 60001},
            {name: "STARLINK-9999", number: 60002},
            {name: "ISS (ZARYA)", number: 25544},
        ],
    };
    const visible = () => satellites.TLEData.satData.filter(s => s.visible).map(s => s.number);
    satellites.nameFilter = "SL-1234, 25544";
    satellites.filterSatellites();
    expect(visible()).toEqual([60001]); // Search cannot re-enable an unchecked category.
    satellites.showISS = true;
    satellites.filterSatellites();
    expect(visible()).toEqual([60001, 25544]);
    satellites.tleFilterResults = [false, true, true];
    satellites.filterSatellites();
    expect(visible()).toEqual([25544]);
    satellites.nameFilter = "";
    satellites.tleFilterResults = null;
    satellites.filterSatellites();
    expect(visible()).toEqual([60001, 60002, 25544]);
    satellites.showSatellites = false;
    satellites.filterSatellites();
    expect(visible()).toEqual([]);
});
