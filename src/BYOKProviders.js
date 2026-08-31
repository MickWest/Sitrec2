// BYOKProviders.js
// The registry of services a user can supply their own credentials for.
//
// One place describes every provider, so adding the next one (ADSB Exchange, another tile
// source) is a table entry rather than new UI, new storage, and new usage plumbing. The
// shared key dialog, the usage accounting, and the per-provider limits are all driven from
// here.
//
// Storage lives in BYOKKeyStore under "byok_<id>"; usage and limits live in BYOKUsage and
// BYOKLimits keyed by the same id. Keep ids stable — they are persisted.

import {isAdmin} from "./configUtils";

export const PROVIDER_CATEGORIES = {
    ai: 'AI assistant',
    terrain: 'Maps & terrain',
    data: 'Data feeds',
};

// usage:
//   'spend'    — real per-request cost is derivable (LLM token counts × per-token price)
//   'requests' — only a request count is observable; spend is estimated from a unit price
//   'none'     — nothing worth counting
//
// unitPrice: {per, amount, note} — a DEFAULT only, and deliberately null wherever a
// defensible published figure isn't known. Tile-provider pricing varies by plan, region and
// free-tier allowance, so the dialog lets the user enter their own rate; with no rate set we
// show request counts and no dollar figure rather than inventing one.
//
// auth:
//   'key'      — a single secret string
//   'userpass' — username + password (Space-Track)
//   'none'     — no credential needed, listed so limits/usage still have a home
export const BYOK_PROVIDERS = [
    {
        id: 'anthropic',
        label: 'Anthropic',
        category: 'ai',
        auth: 'key',
        keyHint: 'sk-ant-…',
        unlocks: 'Runs the AI assistant on your own key, billed to you instead of Sitrec. '
            + 'Adds "(your key)" entries to the AI Model list.',
        signupURL: 'https://console.anthropic.com/settings/keys',
        usage: 'spend',
        // Which recorded models count as this provider's spend. A prefix list is no
        // longer enough now the dropdown offers whatever the key exposes, so these are
        // predicates. They partition the id space between the three AI providers:
        // OpenRouter ids always carry a "vendor/" prefix, Anthropic's direct ids always
        // start "claude-", and an OpenAI key reaches everything else it lists (gpt-*, but
        // also o3, o4-mini, chat-latest, the codex variants).
        usageModelMatch: id => id.startsWith('claude-'),
        unitPrice: null,        // priced per model in BYOKUsage, not per request
        limits: [],
    },
    {
        id: 'openai',
        label: 'OpenAI',
        category: 'ai',
        auth: 'key',
        keyHint: 'sk-proj-… or sk-…',
        // This key now drives BOTH the spoken assistant and typed chat. It was voice-only
        // for a real reason that has since expired: api.openai.com used to answer a browser
        // preflight on its completion endpoints with no CORS headers, so only the Realtime
        // API (designed to be reached from a browser) could be called from the page, and the
        // OpenRouter entry below existed to get typed chat to GPT. /v1/chat/completions now
        // allows any origin with an Authorization header, so the aggregator hop is optional.
        // OpenRouter stays for the models OpenAI does not serve.
        unlocks: 'Runs the AI assistant on your own OpenAI key — both typed chat and the '
            + 'spoken voice assistant, billed to you. Adds "(your OpenAI key)" entries to '
            + 'the AI Model list and enables the microphone button in the Assistant window. '
            + 'Chat messages, tool definitions and your microphone audio go straight from '
            + 'this browser to OpenAI.',
        signupURL: 'https://platform.openai.com/api-keys',
        usage: 'spend',
        // Covers gpt-realtime (voice) and the gpt-5 chat models on the one key, which is
        // what the user is billed for as a single line on one account.
        usageModelMatch: id => !id.includes('/') && !id.startsWith('claude-'),
        unitPrice: null,        // priced per model in BYOKUsage, not per request
        limits: [],
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        category: 'ai',
        auth: 'key',
        keyHint: 'sk-or-v1-…',
        unlocks: 'Runs the AI assistant through OpenRouter on your own key — one account '
            + 'across many model vendors. Chat messages, tool definitions, and tool results '
            + 'are sent to OpenRouter and its selected upstream provider.',
        signupURL: 'https://openrouter.ai/settings/keys',
        usage: 'spend',
        // Custom-endpoint usage is banked under a "custom/" key (see sendToLLMDirect), so
        // it has to be excluded here or an OpenRouter row would claim it.
        usageModelMatch: id => id.includes('/') && !id.startsWith('custom/'),
        // OpenRouter returns the exact charged cost with each completion, so no generic
        // per-request rate is needed here. Token-price fallbacks live in BYOKUsage.
        unitPrice: null,
        limits: [],
    },
    {
        id: 'custom',
        label: 'Custom endpoint',
        category: 'ai',
        auth: 'key',
        // The credential is OPTIONAL here, unlike every other provider: a model runner on
        // your own machine usually wants no key at all, and requiring one would make the
        // commonest case impossible to express. The dialog reads this to decide whether a
        // row with no key counts as configured.
        optionalKey: true,
        // Renders the address and wire-format controls. The address IS the configuration
        // for this provider — a key without one reaches nothing.
        endpoint: true,
        // The wire protocols on offer, not the vendors. Nearly every self-hosted server
        // speaks the OpenAI one — Ollama (at /v1), LM Studio, llama.cpp's server, vLLM,
        // LocalAI, Jan and text-generation-webui all do, and LiteLLM proxies anything else
        // into it. The Anthropic one is here because gateways such as LiteLLM can serve
        // that shape too, and Sitrec already has both transports.
        endpointFormats: {
            'OpenAI-compatible (/v1/chat/completions)': 'openai',
            'Anthropic-compatible (/v1/messages)': 'anthropic',
        },
        defaultEndpointFormat: 'openai',
        unlocks: 'Runs the AI assistant against your own server — a model on this machine, '
            + 'or an endpoint inside your network. Enter its address, pick the wire format '
            + 'it speaks, and add a key only if it needs one. Nothing is sent anywhere '
            + 'else, and Sitrec never sees the address.',
        signupURL: 'https://docs.ollama.com/openai',
        usage: 'spend',
        // Banked under "custom/<model>" so a locally-named model cannot be mistaken for a
        // hosted one with the same id.
        usageModelMatch: id => id.startsWith('custom/'),
        unitPrice: null,
        limits: [],
    },
    {
        id: 'google-maps',
        label: 'Google Photorealistic 3D Tiles',
        category: 'terrain',
        auth: 'key',
        unlocks: 'Google 3D buildings and photorealistic terrain, without Sitrec\'s shared quota.',
        signupURL: 'https://console.cloud.google.com/google/maps-apis/credentials',
        // Google bills Photorealistic 3D Tiles per SESSION, not per tile. A session is one
        // request to /v1/3dtiles/root.json; every tile fetched afterwards rides on it for
        // free. Sitrec already models it this way server-side (tile_usage.php tracks
        // google_3d_root under a DAILY limit — 30/day registered, 60 Meta Members, 120
        // Sitrec Plus — while google_3d_tiles is tracked for audit at an unlimited rate).
        // So the meaningful unit here is sessions, and a per-tile cap would be the wrong
        // lever: it would throttle rendering without touching the bill.
        usage: 'sessions',
        unitLabel: 'sessions',
        // How the user is asked for their rate. Providers quote in different denominations,
        // and a generic "per 1000 <unit>" produced "per 1000 bytes" for Cesium, which is
        // meaningless — nobody prices bytes by the thousand.
        rate: {label: 'Your rate per 1000 sessions (USD)', per: 1000, placeholder: 'e.g. 6.00'},
        unitPrice: null,
        limits: ['dailyRootSessions'],
    },
    {
        id: 'cesium-ion',
        label: 'Cesium Ion',
        category: 'terrain',
        auth: 'key',
        unlocks: 'Cesium Ion terrain and building tilesets.',
        signupURL: 'https://ion.cesium.com/tokens',
        // Cesium OSM buildings are metered by BYTES, not request count — which is why
        // tile_usage.php limits cesium_osm_3d_bytes (1 GiB/30 days baseline, 2x and 4x by
        // tier) rather than cesium_osm_3d_tiles.
        usage: 'bytes',
        unitLabel: 'bytes',
        rate: {label: 'Your rate per GB (USD)', per: 1024*1024*1024, placeholder: 'e.g. 0.50'},
        unitPrice: null,
        limits: ['dailyBytes'],
    },
    {
        id: 'mapbox',
        // No consumer reads this key yet — hidden from non-admins so nobody stores a
        // credential that silently does nothing. Drop this line when it is wired up.
        adminOnly: true,
        label: 'Mapbox',
        category: 'terrain',
        auth: 'key',
        keyHint: 'pk.…',
        unlocks: 'Mapbox satellite and terrain tiles.',
        signupURL: 'https://account.mapbox.com/access-tokens/',
        usage: 'requests',
        rate: {label: 'Your rate per 1000 requests (USD)', per: 1000, placeholder: 'e.g. 0.50'},
        unitPrice: null,
        limits: [],   // no consumer wired yet
    },
    {
        id: 'maptiler',
        // No consumer reads this key yet — hidden from non-admins so nobody stores a
        // credential that silently does nothing. Drop this line when it is wired up.
        adminOnly: true,
        label: 'MapTiler',
        category: 'terrain',
        auth: 'key',
        unlocks: 'MapTiler map and terrain tiles.',
        signupURL: 'https://cloud.maptiler.com/account/keys/',
        usage: 'requests',
        rate: {label: 'Your rate per 1000 requests (USD)', per: 1000, placeholder: 'e.g. 0.50'},
        unitPrice: null,
        limits: [],   // no consumer wired yet
    },
    {
        id: 'spacetrack',
        // No consumer reads this key yet — hidden from non-admins so nobody stores a
        // credential that silently does nothing. Drop this line when it is wired up.
        adminOnly: true,
        label: 'Space-Track',
        category: 'data',
        auth: 'userpass',
        unlocks: 'Your own Space-Track account for satellite element sets, with your own rate limit.',
        signupURL: 'https://www.space-track.org/auth/createAccount',
        usage: 'requests',
        rate: {label: 'Your rate per 1000 requests (USD)', per: 1000, placeholder: 'e.g. 0.50'},
        unitPrice: null,
        limits: [],
    },
    {
        id: 'windy',
        label: 'Windy Webcams',
        category: 'data',
        auth: 'key',
        unlocks: 'Worldwide live webcams in the Live Feeds menu. Sitrec asks Windy for '
            + 'cameras near where you are looking; your key and that location go straight '
            + 'from this browser to Windy.',
        signupURL: 'https://api.windy.com/webcams',
        usage: 'requests',
        rate: {label: 'Your rate per 1000 requests (USD)', per: 1000, placeholder: 'free tier: 0'},
        unitPrice: null,
        limits: [],
    },
    {
        id: 'aisstream',
        label: 'AISStream (marine AIS)',
        category: 'data',
        auth: 'key',
        unlocks: 'Worldwide live ship positions in the Live Feeds menu. Opens a websocket '
            + 'from this browser straight to aisstream.io and subscribes to the area you '
            + 'are looking at.',
        signupURL: 'https://aisstream.io/authenticate',
        // A websocket streams continuously rather than making countable requests,
        // so a request tally would be meaningless here.
        usage: 'none',
        unitPrice: null,
        limits: [],
    },
    {
        id: 'tomtom',
        label: 'TomTom Traffic',
        category: 'data',
        auth: 'key',
        unlocks: 'Live road traffic incidents — jams, closures, roadworks — in the Live '
            + 'Feeds menu, worldwide.',
        signupURL: 'https://developer.tomtom.com/user/register',
        usage: 'requests',
        rate: {label: 'Your rate per 1000 requests (USD)', per: 1000, placeholder: 'free tier: 0'},
        unitPrice: null,
        limits: [],
    },
    {
        id: 'adsbx',
        // No consumer reads this key yet — hidden from non-admins so nobody stores a
        // credential that silently does nothing. Drop this line when it is wired up.
        adminOnly: true,
        label: 'ADSB Exchange',
        category: 'data',
        auth: 'key',
        unlocks: 'Live and historical ADS-B aircraft data from your own subscription.',
        signupURL: 'https://www.adsbexchange.com/data/',
        usage: 'requests',
        rate: {label: 'Your rate per 1000 requests (USD)', per: 1000, placeholder: 'e.g. 0.50'},
        unitPrice: null,
        limits: [],
    },
];

// Limit definitions, shared so the dialog can render them generically.
//
// "Unlimited by default when you supply a key" is the rule the maintainer set: a shared
// Sitrec key is a common resource worth protecting, but a user's own key is their own
// budget and Sitrec should not second-guess it. A limit is therefore opt-in, and null
// means unlimited.
export const LIMIT_DEFS = {
    dailyRootSessions: {
        label: 'Max Google 3D sessions per day',
        help: 'A session is one root-tileset request; all the tiles it then loads are '
            + 'included. This is the unit Google actually bills, so it is the only cap worth '
            + 'setting. Sitrec\'s own shared key allows 30–120 a day depending on tier. '
            + 'Blank = unlimited, the default on your own key.',
        unit: 'sessions/day',
        min: 1,
    },
    dailyBytes: {
        label: 'Max Cesium data per day',
        help: 'Cesium OSM buildings are metered by bytes downloaded, not by request count. '
            + 'Blank = unlimited, the default on your own key.',
        unit: 'MB/day',
        min: 1,
        // Stored in MB for a sane input box; converted at the enforcement point.
        scale: 1024 * 1024,
    },
};

export function getProvider(id) {
    return BYOK_PROVIDERS.find(p => p.id === id) || null;
}

// Providers the current user should be offered. `adminOnly` entries are registered and fully
// functional as far as storage, usage and limits go, but nothing reads their key yet — showing
// them would invite a user to paste a credential that then does nothing, which is worse than
// not offering it. Admins still see them so the plumbing can be exercised end to end.
export function visibleProviders() {
    const admin = isAdmin();
    return BYOK_PROVIDERS.filter(p => admin || !p.adminOnly);
}

export function providersByCategory() {
    const grouped = {};
    for (const key of Object.keys(PROVIDER_CATEGORIES)) grouped[key] = [];
    for (const p of visibleProviders()) {
        (grouped[p.category] = grouped[p.category] || []).push(p);
    }
    return grouped;
}
