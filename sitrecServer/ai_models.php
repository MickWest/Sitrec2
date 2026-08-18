<?php

// Which LLM a given user is allowed to run, and which key pays for it.
//
// Shared by every server endpoint that spends money on an AI provider - chatbot.php and
// aimask.php today. It lives in its own file for one reason: the permission table IS the
// paywall, and a second copy of it would drift, quietly handing a premium model to a tier
// that is not supposed to reach one. Endpoints ask this file; they never carry their own list.

// Load API keys from environment
$OPENAI_API_KEY = getenv("OPENAI_API");
$ANTHROPIC_API_KEY = getenv("ANTHROPIC_API");
$GROQ_API_KEY = getenv("GROQ_API");
$GROK_API_KEY = getenv("GROK_API");
$GEMINI_API_KEY = getenv("GEMINI_API"); // Google Gemini; models hidden until this is set

// SECURITY: Derive API key from provider name so we never store keys in session
function getApiKeyForProvider($provider) {
    global $OPENAI_API_KEY, $ANTHROPIC_API_KEY, $GROQ_API_KEY, $GROK_API_KEY, $GEMINI_API_KEY;
    return match($provider) {
        'anthropic' => $ANTHROPIC_API_KEY,
        'groq' => $GROQ_API_KEY,
        'grok' => $GROK_API_KEY,
        'gemini' => $GEMINI_API_KEY,
        default => $OPENAI_API_KEY
    };
}

// Model permissions by user group
// Groups: admin=3, registered=2, verified=9, sitrec=14, sitrec-plus=19
$MODEL_PERMISSIONS = [
    // NOTE on cost/value (per 1M tokens, in/out, mid-2026): gpt-5-mini $0.25/$2 is the
    // best-value default (big upgrade over the old gpt-4o at lower cost); gpt-5-nano
    // $0.05/$0.40 and gemini-2.5-flash-lite $0.10/$0.40 are the cheapest capable models;
    // claude-haiku-4-5 $1/$5 is higher quality with strong prompt caching; sonnet 4.6
    // ($3/$15) and opus 4.8 ($5/$25) are admin-only premium. The FIRST entry in a user's
    // highest tier is their default model. grok-4-fast may alias to pricier Grok-4.3 —
    // kept admin-only. Gemini entries are hidden until GEMINI_API is set (see shared.env).
    3 => [ // admin - all models
        ['provider' => 'openai', 'model' => 'gpt-5-mini', 'label' => 'GPT-5 Mini'],
        ['provider' => 'openai', 'model' => 'gpt-5-nano', 'label' => 'GPT-5 Nano'],
        ['provider' => 'gemini', 'model' => 'gemini-2.5-flash-lite', 'label' => 'Gemini 2.5 Flash-Lite'],
        ['provider' => 'anthropic', 'model' => 'claude-haiku-4-5-20251001', 'label' => 'Claude Haiku 4.5'],
        ['provider' => 'anthropic', 'model' => 'claude-sonnet-4-6', 'label' => 'Claude Sonnet 4.6'],
        ['provider' => 'anthropic', 'model' => 'claude-opus-4-8', 'label' => 'Claude Opus 4.8'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
        ['provider' => 'grok', 'model' => 'grok-4-fast', 'label' => 'Grok 4 Fast'],
    ],
    19 => [ // sitrec-plus - same models as sitrec, 10x rate limits
        ['provider' => 'openai', 'model' => 'gpt-5-mini', 'label' => 'GPT-5 Mini'],
        ['provider' => 'gemini', 'model' => 'gemini-2.5-flash-lite', 'label' => 'Gemini 2.5 Flash-Lite'],
        ['provider' => 'anthropic', 'model' => 'claude-haiku-4-5-20251001', 'label' => 'Claude Haiku 4.5'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
    ],
    14 => [ // sitrec - premium models
        ['provider' => 'openai', 'model' => 'gpt-5-mini', 'label' => 'GPT-5 Mini'],
        ['provider' => 'gemini', 'model' => 'gemini-2.5-flash-lite', 'label' => 'Gemini 2.5 Flash-Lite'],
        ['provider' => 'anthropic', 'model' => 'claude-haiku-4-5-20251001', 'label' => 'Claude Haiku 4.5'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
    ],
    9 => [ // verified - cheapest capable models (default = cheapest available)
        ['provider' => 'gemini', 'model' => 'gemini-2.5-flash-lite', 'label' => 'Gemini 2.5 Flash-Lite'],
        ['provider' => 'openai', 'model' => 'gpt-5-nano', 'label' => 'GPT-5 Nano'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
    ],
    2 => [ // registered - same as verified
        ['provider' => 'gemini', 'model' => 'gemini-2.5-flash-lite', 'label' => 'Gemini 2.5 Flash-Lite'],
        ['provider' => 'openai', 'model' => 'gpt-5-nano', 'label' => 'GPT-5 Nano'],
        ['provider' => 'groq', 'model' => 'llama-3.3-70b-versatile', 'label' => 'Llama 3.3 70B (Groq)'],
    ],
];

// Get available models for a user based on their groups
function getAvailableModels($userGroups) {
    global $MODEL_PERMISSIONS, $OPENAI_API_KEY, $ANTHROPIC_API_KEY, $GROQ_API_KEY, $GROK_API_KEY, $GEMINI_API_KEY;

    $models = [];
    $seen = [];

    // Collect models from all user groups (higher privilege groups first)
    $groupOrder = [3, 19, 14, 9, 2]; // admin, sitrec-plus, sitrec, verified, registered
    foreach ($groupOrder as $group) {
        if (in_array($group, $userGroups) && isset($MODEL_PERMISSIONS[$group])) {
            foreach ($MODEL_PERMISSIONS[$group] as $model) {
                $key = $model['provider'] . ':' . $model['model'];
                if (!isset($seen[$key])) {
                    // Only include if we have the API key for this provider
                    $hasKey = match($model['provider']) {
                        'openai' => !empty($OPENAI_API_KEY),
                        'anthropic' => !empty($ANTHROPIC_API_KEY),
                        'groq' => !empty($GROQ_API_KEY),
                        'grok' => !empty($GROK_API_KEY),
                        'gemini' => !empty($GEMINI_API_KEY),
                        default => false
                    };
                    if ($hasKey) {
                        $models[] = $model;
                        $seen[$key] = true;
                    }
                }
            }
        }
    }

    return $models;
}

// True if the user's groups permit exactly this provider+model. The endpoints call this
// rather than trusting the provider/model the browser sent - the browser picked them from
// a menu the server built, but nothing stops a hand-made request naming a pricier one.
function isModelAllowed($userGroups, $provider, $model) {
    if (!$provider || !$model) return false;
    foreach (getAvailableModels($userGroups) as $m) {
        if ($m['provider'] === $provider && $m['model'] === $model) return true;
    }
    return false;
}

// ─── PRICING ─────────────────────────────────────────────────────────────────────────
//
// USD per MILLION tokens, from the providers' published list prices. This lives beside the
// permission table for the same reason that table lives here: both describe a model, and a
// second copy would drift - a model added to a tier but not to this table silently logs as
// free, which is worse than not logging at all because it looks like a real number.
//
// Every model named anywhere in $MODEL_PERMISSIONS must appear here. modelsMissingPrices()
// below is the check; admin_dashboard.php surfaces any it finds on the AI Spend card.
//
// `promo` is a temporary rate with an end date. Hardcoding either rate alone is wrong half
// the time, so the rate in effect is chosen by date and the resulting cost is banked at the
// time of use (see logAIRequest) rather than re-derived later at whatever rate is current
// then. This mirrors src/BYOKUsage.js, which does the same for the browser BYOK path.
$MODEL_PRICES = [
    // OpenAI
    'openai:gpt-5-mini'                 => ['input' => 0.25, 'output' => 2.00],
    'openai:gpt-5-nano'                 => ['input' => 0.05, 'output' => 0.40],
    // Google
    'gemini:gemini-2.5-flash-lite'      => ['input' => 0.10, 'output' => 0.40],
    // Anthropic
    'anthropic:claude-haiku-4-5-20251001' => ['input' => 1.00, 'output' => 5.00],
    'anthropic:claude-sonnet-4-6'       => ['input' => 3.00, 'output' => 15.00],
    'anthropic:claude-opus-4-8'         => ['input' => 5.00, 'output' => 25.00],
    // Groq. Priced per-token like the rest; kept here so a Groq turn is not logged as free.
    'groq:llama-3.3-70b-versatile'      => ['input' => 0.59, 'output' => 0.79],
    // xAI. grok-4-fast may alias to a pricier Grok-4.3, so this is a FLOOR, not a promise -
    // another reason the model stays admin-only.
    'grok:grok-4-fast'                  => ['input' => 0.20, 'output' => 0.50],
];

// How a cached input token is billed relative to a full-price one.
//
// Anthropic's are exact and load-bearing: chatbot.php sets three cache breakpoints, so most
// input on that path is a cache READ, and folding those tokens in at the full rate would
// overstate an Anthropic turn several-fold.
//
// The others are best-effort list-price estimates for providers whose caching is automatic
// and not separately itemised on the invoice. They are applied only to tokens the provider
// itself reported as cached, so an error here moves the cost estimate, never the token
// counts - which is why the raw counts are stored alongside the money.
const AI_CACHE_MULTIPLIERS = [
    'anthropic' => ['read' => 0.1,  'write' => 1.25],  // documented, 5-minute TTL
    'openai'    => ['read' => 0.1,  'write' => 1.0],   // automatic caching, no write premium
    'gemini'    => ['read' => 0.25, 'write' => 1.0],   // implicit caching
    'groq'      => ['read' => 1.0,  'write' => 1.0],   // no prompt caching
    'grok'      => ['read' => 1.0,  'write' => 1.0],   // no prompt caching
];

// The per-million rates in effect at $atTs (defaults to now), or null for an unpriced model.
function pricesForModel($provider, $model, $atTs = null) {
    global $MODEL_PRICES;
    $entry = $MODEL_PRICES[$provider . ':' . $model] ?? null;
    if (!$entry) return null;
    $at = $atTs === null ? time() : $atTs;
    if (isset($entry['promo']) && $at < $entry['promo']['until']) {
        return ['input' => $entry['promo']['input'], 'output' => $entry['promo']['output']];
    }
    return ['input' => $entry['input'], 'output' => $entry['output']];
}

// USD for one normalised usage record. $usage uses the shape every provider is converted to
// in chatbot.php: inputTokens is the FULL-PRICE portion only, with cached tokens counted
// separately, because that is the only split that can be priced correctly.
//
// Returns null - not 0 - when the model has no price on file. A missing price is unknown
// cost, and silently calling it zero is how an unpriced model hides in a total.
function aiCostUSD($usage, $provider, $model, $atTs = null) {
    $prices = pricesForModel($provider, $model, $atTs);
    if (!$prices) return null;
    $mult = AI_CACHE_MULTIPLIERS[$provider] ?? ['read' => 1.0, 'write' => 1.0];

    $in  = (int)($usage['inputTokens'] ?? 0);
    $out = (int)($usage['outputTokens'] ?? 0);
    $cr  = (int)($usage['cacheReadTokens'] ?? 0);
    $cw  = (int)($usage['cacheWriteTokens'] ?? 0);

    return ($in  * $prices['input']
          + $cr  * $prices['input'] * $mult['read']
          + $cw  * $prices['input'] * $mult['write']
          + $out * $prices['output']) / 1000000.0;
}

// Models that a tier can reach but that have no price on file, so their spend would be
// logged as unknown. Surfaced in admin_info.php so adding a model to a tier without adding
// its price is visible rather than discovered later in a total that reads too low.
function modelsMissingPrices() {
    global $MODEL_PERMISSIONS, $MODEL_PRICES;
    $missing = [];
    foreach ($MODEL_PERMISSIONS as $models) {
        foreach ($models as $m) {
            $key = $m['provider'] . ':' . $m['model'];
            if (!isset($MODEL_PRICES[$key]) && !in_array($key, $missing, true)) {
                $missing[] = $key;
            }
        }
    }
    return $missing;
}

// Pick the lowest estimated-cost model from an already permission- and key-filtered list.
// The weighting reflects this assistant's measured shape: a large cached/system input and
// a comparatively short reply. Unknown-price models lose to every priced model and are
// used only if the list contains nothing priceable.
function economyModelFor($models, $estimatedInputTokens = 25000, $estimatedOutputTokens = 1000) {
    if (empty($models)) return null;
    $best = null;
    $bestScore = INF;
    foreach ($models as $candidate) {
        $prices = pricesForModel($candidate['provider'], $candidate['model']);
        if (!$prices) continue;
        $score = $estimatedInputTokens * $prices['input']
            + $estimatedOutputTokens * $prices['output'];
        if ($score < $bestScore) {
            $best = $candidate;
            $bestScore = $score;
        }
    }
    return $best ?? $models[0];
}
