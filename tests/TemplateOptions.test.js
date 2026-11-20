import {applyTemplateInference, beginTemplateSession, normalizeTemplateOptions,
    noteTemplateLocationChange, prepareTemplateSitch, shouldAnalyzeTemplateMedia,
    templateConstraints, templateOptions} from '../src/TemplateOptions';

test('named legacy presets enable star analysis and defer satellite catalogs', () => {
    expect(templateOptions({templateSource: {name: 'Star Tracker'}})).toMatchObject({
        analyzeImages: true, analyzeVideos: true, findNightView: true, frameStars: true, satellites: 'manual',
    });
    expect(templateOptions({templateSource: {name: 'Starlink Horizon Flares'}})).toMatchObject({
        analyzeImages: false, satellites: 'manual',
    });
    expect(templateOptions({sitchName: 'Star Tracker'}).analyzeImages).toBe(false);
    expect(normalizeTemplateOptions({analyzeImages: false, findNightView: false}, 'Star Tracker'))
        .toMatchObject({analyzeImages: false, findNightView: false, analyzeVideos: true});
    expect(normalizeTemplateOptions({analyzeImages: 'yes', satellites: 'execute', script: 'anything'}))
        .toMatchObject({analyzeImages: false, satellites: 'inherit'});
    expect(normalizeTemplateOptions({script: 'anything'})).not.toHaveProperty('script');
});

test('template load applies explicit options before old node settings and omits only satellite catalogs', () => {
    const sitch = {templateOptions: {satellites: 'manual'},
        NightSkyNode: {kind: 'DisplayNightSky', autoloadSatellites: true},
        mods: {NightSkyNode: {autoloadSatellites: true, satelliteCatalogRequest: {key: 'old'}}},
        loadedFiles: {stars: 'stars.bin', sats: 'sats.parquet', video: 'photo.jpg'},
        loadedFilesMetadata: {sats: {dataType: 'tle'}, video: {dataType: 'videoImage'}}};
    prepareTemplateSitch(sitch, 'Star Tracker');
    expect(sitch.NightSkyNode.autoloadSatellites).toBe(false);
    expect(sitch.mods.NightSkyNode).toEqual({autoloadSatellites: false});
    expect(sitch.loadedFiles).toEqual({stars: 'stars.bin', video: 'photo.jpg'});
    expect(sitch.loadedFilesMetadata).toEqual({video: {dataType: 'videoImage'}});
    expect(JSON.parse(JSON.stringify(sitch)).templateOptions).toMatchObject({analyzeImages: true, satellites: 'manual'});
    const automatic = {templateOptions: {satellites: 'automatic'}, mods: {NightSkyNode: {autoloadSatellites: false}}};
    prepareTemplateSitch(automatic, 'Starlink Horizon Flares');
    expect(automatic.mods.NightSkyNode.autoloadSatellites).toBe(true);
});

test('time and location are independent constraints, including metadata and edits during analysis', () => {
    const sitch = {templateSource: {name: 'Star Tracker'}};
    let snapshot = {timeSerial: 4, location: [32, -118, 10000], cameraChoice: 'fixedCamera'};
    beginTemplateSession(sitch, snapshot);
    expect(templateConstraints(sitch, snapshot)).toEqual({timeKnown: false, locationKnown: false});
    snapshot = {...snapshot, timeSerial: 5};
    expect(templateConstraints(sitch, snapshot)).toEqual({timeKnown: true, locationKnown: false});
    noteTemplateLocationChange(sitch);
    expect(templateConstraints(sitch, snapshot)).toEqual({timeKnown: true, locationKnown: true});
    const knownLocation = {templateSource: {name: 'Star Tracker'}};
    beginTemplateSession(knownLocation, snapshot);
    expect(templateConstraints(knownLocation, {...snapshot, location: [45, 10, 2]}))
        .toEqual({timeKnown: false, locationKnown: true});
});

test('inferred values do not become known inputs on the next import', () => {
    const sitch = {templateSource: {name: 'Star Tracker'}};
    let snapshot = {timeSerial: 4, location: [32, -118, 10000], cameraChoice: 'fixedCamera'};
    beginTemplateSession(sitch, snapshot);
    applyTemplateInference(sitch, () => {
        noteTemplateLocationChange(sitch);
        snapshot = {timeSerial: 5, location: [40, -100, 2], cameraChoice: 'fixedCamera'};
    }, () => snapshot);
    expect(templateConstraints(sitch, snapshot)).toEqual({timeKnown: false, locationKnown: false});
    expect(JSON.stringify(sitch)).not.toContain('timeSerial');
    snapshot = {...snapshot, timeSerial: 6};
    expect(templateConstraints(sitch, snapshot).timeKnown).toBe(true);
});

test('known template values and pre-existing scenes remain protected', () => {
    const sitch = {templateSource: {name: 'Star Tracker'}, templateOptions: {keepTime: true, keepLocation: true}};
    const snapshot = {timeSerial: 4, location: [42, -80, 100], cameraChoice: 'fixedCamera'};
    beginTemplateSession(sitch, snapshot);
    expect(templateConstraints(sitch, snapshot)).toEqual({timeKnown: true, locationKnown: true});
    expect(templateConstraints({}, snapshot)).toEqual({timeKnown: true, locationKnown: true});
});

test('template media actions run independently of user role and previous time or location edits', () => {
    const sitch = {templateSource: {name: 'Star Tracker'}};
    for (const image of [true, false]) {
        expect(shouldAnalyzeTemplateMedia(sitch, {primary: true, image})).toBe(true);
        expect(shouldAnalyzeTemplateMedia(sitch, {primary: true, image, restoring: true})).toBe(false);
        expect(shouldAnalyzeTemplateMedia(sitch, {primary: false, image})).toBe(false);
    }
    expect(shouldAnalyzeTemplateMedia(sitch, {primary: true, audio: true})).toBe(false);
    expect(shouldAnalyzeTemplateMedia({...sitch, templateOptions: {analyzeVideos: false}}, {primary: true})).toBe(false);
    expect(shouldAnalyzeTemplateMedia({templateOptions: {analyzeImages: true}}, {primary: true, image: true})).toBe(false);
});
