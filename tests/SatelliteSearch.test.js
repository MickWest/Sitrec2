/** @jest-environment jsdom */
import {CSatellite} from "../src/nodes/CSatellite";

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
