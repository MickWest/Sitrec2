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
