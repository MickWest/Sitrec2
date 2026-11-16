import {SatelliteCatalogLoader, satelliteCatalogRequest, satelliteAutoloadDefault} from "../src/SatelliteCatalogLoader";

const date = text => new Date(text + "T12:00:00Z");
const buffer = new ArrayBuffer(10);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; };

function setup(automatic = true) {
    let clock = +date("2026-11-15");
    const fetchCatalog = jest.fn(async () => buffer), installCatalog = jest.fn();
    const loader = new SatelliteCatalogLoader({automatic, fetchCatalog, installCatalog, now: () => clock});
    return {loader, fetchCatalog, installCatalog, advance: milliseconds => { clock += milliseconds; }};
}
const settle = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("historical queries use the viewing date, while today and future dates use the full current catalog", () => {
    expect(satelliteCatalogRequest(date("2025-09-19"), date("2026-11-15"))).toMatchObject({date: "2025-09-18", type: "ALL", days: 2});
    expect(satelliteCatalogRequest(date("2004-09-19"), date("2026-11-15"))).toMatchObject({date: "2004-09-16", days: 6});
    for (const viewing of ["2026-11-15", "2027-06-01"]) expect(satelliteCatalogRequest(date(viewing), date("2026-11-15"))).toMatchObject({date: "2026-11-15", type: "CURRENT"});
});

test("focus delays a load for 15 seconds on the same date, without restarting the timer", async () => {
    const {loader, fetchCatalog, advance} = setup();
    loader.observe(date("2025-09-18"), {timeFocused: true}); advance(14000);
    loader.observe(date("2025-09-18"), {timeFocused: true});
    expect(fetchCatalog).not.toHaveBeenCalled();
    advance(1001); loader.observe(date("2025-09-18"), {timeFocused: true}); await settle();
    loader.observe(new Date("2025-09-18T14:55:26Z"), {timeFocused: true});
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(loader.state.phase).toBe("loaded");
});

test("a new date restarts the focus delay; leaving Time loads immediately", async () => {
    const {loader, fetchCatalog, advance} = setup();
    loader.observe(date("2025-09-18"), {timeFocused: true}); advance(14000);
    loader.observe(date("2025-09-19"), {timeFocused: true}); advance(2000);
    loader.observe(date("2025-09-19"), {timeFocused: true});
    expect(fetchCatalog).not.toHaveBeenCalled();
    loader.observe(date("2025-09-19")); await settle();
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(loader.state.request.viewingDate).toBe("2025-09-19");
});

test("loading a scene or hiding satellites prevents autoload even after 15 seconds", async () => {
    const {loader, fetchCatalog, advance} = setup();
    loader.observe(date("2025-09-18"), {busy: true}); advance(20000);
    loader.observe(date("2025-09-18"), {busy: true});
    loader.observe(date("2025-09-18"), {visible: false});
    expect(fetchCatalog).not.toHaveBeenCalled();
    loader.observe(date("2025-09-18")); await settle();
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
});

test("pending and installed sets are reused across focus, time and Autoload toggles", async () => {
    const {loader, fetchCatalog, installCatalog} = setup();
    const pending = deferred(); fetchCatalog.mockImplementationOnce(() => pending.promise);
    const first = loader.refresh(date("2025-09-19"));
    const second = loader.refresh(date("2025-09-19"));
    loader.observe(date("2025-09-19"));
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    pending.resolve(buffer); await Promise.all([first, second]);
    loader.setAutomatic(false); loader.setAutomatic(true);
    loader.observe(new Date("2025-09-19T15:20:00Z")); await settle();
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
    expect(installCatalog).toHaveBeenCalledTimes(1);
});

test("defaults enable blank scenes and the two templates, while other saved scenes stay manual", () => {
    expect(new SatelliteCatalogLoader({}).automatic).toBe(false);
    expect(satelliteAutoloadDefault({name: "custom"})).toBe(true);
    expect(satelliteAutoloadDefault({name: "starlink"})).toBe(true);
    for (const name of ["Star Tracker", "Starlink"]) {
        expect(satelliteAutoloadDefault({name: "custom", mods: {}, templateSource: {name}})).toBe(true);
    }
    expect(satelliteAutoloadDefault({name: "custom", mods: {}})).toBe(false);
    expect(satelliteAutoloadDefault({name: "custom", mods: {}, templateSource: {name: "Aircraft"}})).toBe(false);
});

test("a slow cancelled request cannot install after a newer date", async () => {
    const {loader, fetchCatalog, installCatalog} = setup();
    const old = deferred(); fetchCatalog.mockImplementationOnce(() => old.promise);
    const first = loader.refresh(date("2025-09-18"));
    await loader.refresh(date("2025-09-19")); old.resolve(buffer); await first;
    expect(installCatalog).toHaveBeenCalledTimes(1);
    expect(installCatalog.mock.calls[0][1].viewingDate).toBe("2025-09-19");
    expect(fetchCatalog.mock.calls[0][1].aborted).toBe(true);
});

test("a saved full catalog does not load twice when Autoload is restored", async () => {
    const {loader, fetchCatalog} = setup();
    loader.restoreLoadedRequest(satelliteCatalogRequest(date("2025-09-19"), date("2026-11-15")));
    loader.observe(date("2025-09-19")); await settle();
    expect(fetchCatalog).not.toHaveBeenCalled();
    loader.observe(date("2025-09-20")); await settle();
    expect(fetchCatalog).toHaveBeenCalledTimes(1);
});

test("saved scenes require refresh and importing a catalog cancels automatic replacement", async () => {
    const {loader, fetchCatalog, installCatalog, advance} = setup(false);
    loader.observe(date("2025-09-19")); advance(5000); loader.observe(date("2025-09-19"));
    expect(fetchCatalog).not.toHaveBeenCalled();
    await loader.refresh(date("2025-09-19")); expect(installCatalog).toHaveBeenCalledTimes(1);
    expect(loader.automatic).toBe(false);
    const old = deferred(); fetchCatalog.mockImplementationOnce(() => old.promise);
    const task = loader.refresh(date("2025-09-20")); loader.protectCatalog(); old.resolve(buffer); await task;
    expect(installCatalog).toHaveBeenCalledTimes(1);
});

test("cancel and failure do not loop; revisiting a date uses the bounded cache", async () => {
    const {loader, fetchCatalog, advance} = setup();
    await loader.refresh(date("2025-09-19")); await loader.refresh(date("2025-09-20"));
    loader.observe(date("2025-09-19")); advance(1000); loader.observe(date("2025-09-19")); await settle();
    expect(fetchCatalog).toHaveBeenCalledTimes(2);
    fetchCatalog.mockRejectedValueOnce(new Error("Offline"));
    await loader.refresh(date("2025-09-21"));
    advance(5000); loader.observe(date("2025-09-21"));
    expect(fetchCatalog).toHaveBeenCalledTimes(3);
    expect(loader.state).toMatchObject({phase: "error", error: "Offline"});
    const old = deferred(); fetchCatalog.mockImplementationOnce(() => old.promise);
    const task = loader.refresh(date("2025-09-22")); loader.cancel(); old.resolve(buffer); await task;
    advance(5000); loader.observe(date("2025-09-22"));
    expect(fetchCatalog).toHaveBeenCalledTimes(4);
    expect(loader.state.phase).toBe("cancelled");
});
