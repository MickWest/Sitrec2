// Secure-build stub registry. See docs/dev/Secure-Build.md
//
// The secure build (webpack.secure.js) compiles a set of modules out of the bundle by swapping
// each one for an inert stand-in under src/secureStubs/. This file is the single list of those
// pairs, plus the evidence the bundle audit checks:
//
//   aliases              { absolute original path: absolute stub path }. Both sides are
//                        path.resolve'd. webpack.secure.js applies the map after module
//                        resolution, so a plain relative import, a require.context child and
//                        a dynamic import() of the original all reach the stub.
//   removedMarkers       one "__SITREC_SECURE_STUB__:<Module>" string per stub. Each stub
//                        assigns its marker to an exported constant AND appends it to
//                        globalThis.__SITREC_SECURE_STUBS__, so it survives minification; a
//                        bundle that carries the marker carries the stub, not the original.
//   originalHostLiterals hostnames the ORIGINAL modules contain that no remaining module
//                        contains, so they must be absent from the secure bundle. A hostname
//                        that a remaining module also carries is deliberately NOT listed here
//                        (the check would fail for a reason the stubs cannot fix); those are
//                        recorded in the notes that accompanied this change.
//   gatedHostLiterals    hostnames that stay in the bundle inside modules that are gated at
//                        compile time on isSecureBuild (src/configUtils.js) instead of being
//                        swapped out, because the module has other work to do. Present in the
//                        bundle, but on a code path that returns before any request is made.
//                        The audit treats these as "present but gated".
//
// A stub's own imports resolve against the ORIGINAL module's directory, not the stub's: the
// swap changes which file is read, not the directory webpack uses as the base for that file's
// relative imports. So a stub either has no imports at all (all but one do), or imports only
// through paths that name the same file from both directories (src/secureStubs/ and the
// original's directory are siblings under src/, so "../x" works from both when the stub sits
// flat in src/secureStubs/). tests/secureStubs.test.js checks that for every pair.
//
// Plain CommonJS with no dependency beyond `path`, because webpack.secure.js requires it.
// tests/secureStubs.test.js also checks that every stub exports at least the original's names,
// carries its marker, and contains none of the hostnames listed here.
'use strict';

const path = require('path');

const SRC = path.resolve(__dirname, '..', 'src');
const STUBS = path.resolve(SRC, 'secureStubs');

// [original path relative to src/, stub path relative to src/secureStubs/], both without the
// extension. Sub-directories are mirrored unless the stub has imports of its own (see above).
const STUB_MODULES = [
    // Startup and telemetry.
    ['GeoLocation'],
    ['UILogging'],
    ['TileUsageTracker'],
    // Loopback scan for a local compute helper.
    ['LocalComputeBridge'],
    // Browser-side model clients and the user's own provider keys.
    ['CDirectLLMClient'],
    ['BYOKProviders'],
    ['BYOKKeyStore'],
    ['BYOKKeyDialog'],
    ['BYOKModelCatalog'],
    ['voice/CVoiceSession'],
    // Server-side vision endpoint client.
    ['SkyMaskAI'],
    // Live feeds. livefeeds/LiveFeedFetch.js needs no entry: its only importer is
    // CNodeLiveFeedLayer.js, stubbed here, so the fetcher is never resolved (and an entry
    // that is never resolved makes webpack.secure.js warn).
    ['livefeeds/LiveFeedRegistry'],
    ['livefeeds/LiveFeedOverlay'],
    ['livefeeds/CNodeLiveFeedLayer'],
    // Importers that fetch from public sites.
    ['MetabunkThreadUtils'],
    ['DVIDSUtils'],
    ['WarGovUFOUtils'],
    ['ADSBTraceFetch'],
    ['ADSBLiveFetch'],
    ['SondeFetch'],
    // Commercial 3D-tile authentication and the street-level panorama client. The panorama
    // stub is a node and imports two base modules, so it sits flat (see the header).
    ['GooglePhotorealisticTilesAuth'],
    ['nodes/CNodeStreetViewPano', 'CNodeStreetViewPano'],
    // The OCR library loader: the library fetches its worker, core and language files from
    // a public CDN by default, so the feature is compiled out rather than configured.
    ['tesseractLoader'],
];

const aliases = {};
for (const [original, stub = original] of STUB_MODULES) {
    aliases[path.resolve(SRC, original + '.js')] = path.resolve(STUBS, stub + '.js');
}

const removedMarkers = STUB_MODULES.map(([original]) => '__SITREC_SECURE_STUB__:' + path.basename(original));

const originalHostLiterals = [
    // GeoLocation.js
    'ipapi.co',
    // SondeFetch.js
    'www.ncei.noaa.gov',
    // DVIDSUtils.js, WarGovUFOUtils.js, MetabunkThreadUtils.js
    'www.dvidshub.net',
    // CDirectLLMClient.js, BYOKModelCatalog.js, BYOKProviders.js, voice/CVoiceSession.js
    'api.openai.com',
    'api.anthropic.com',
    'openrouter.ai',
    // BYOKProviders.js (sign-up addresses shown in the key dialog)
    'platform.openai.com',
    'console.anthropic.com',
    'docs.ollama.com',
    'console.cloud.google.com',
    'ion.cesium.com',
    'account.mapbox.com',
    'cloud.maptiler.com',
    'www.space-track.org',
    'developer.tomtom.com',
    'www.adsbexchange.com',
    // BYOKProviders.js and livefeeds/LiveFeedRegistry.js
    'api.windy.com',
    'aisstream.io',
    // livefeeds/LiveFeedRegistry.js
    'api.tomtom.com',
    // Not listed: the OCR library's default worker host (a public CDN). It lives in the
    // library, not in src/tesseractLoader.js, so it cannot be tied to an aliased original;
    // it is kept out of the bundle by the tesseractLoader stub and caught by the allow-list
    // (it has no entry there) if it ever returns.
];

const gatedHostLiterals = [
    // src/nodes/CNodeDisplayWindField.js, fetchOpenMeteoUV (WindSources.js drops the option)
    'api.open-meteo.com',
    'historical-forecast-api.open-meteo.com',
    // src/CClientNLU.js, _geocodeAndGoto
    'nominatim.openstreetmap.org',
];

module.exports = {
    aliases,
    removedMarkers,
    originalHostLiterals,
    gatedHostLiterals,
};
