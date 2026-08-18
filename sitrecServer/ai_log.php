<?php

// The AI request log: one rolling file of who asked what of which model, and what it cost.
//
// Shared, for the same reason ai_models.php is: the log is only useful if EVERY endpoint that
// spends money on a provider writes to it. A second endpoint keeping its own file, or naming
// the same file separately, produces an admin dashboard that quietly under-reports. So the
// path and the writer live here, and chatbot.php, aimask.php and admin_dashboard.php all
// take them from this one place.
//
// Two stores, because they answer different questions and have different lifetimes:
//
//   $AI_LOG_FILE      the last 500 individual requests, for "what did this user just ask,
//                     and what did that one cost". Rolling, so it forgets.
//   recordDailyStats  28 days of totals, in the persistent cache dir. This is the one that
//                     answers "what is the AI feature costing", and it must not be tied to
//                     the 500-entry window or a busy hour would erase a day's spend.

require_once __DIR__ . '/ai_models.php';
require_once __DIR__ . '/stats_history.php';

$AI_LOG_FILE = sys_get_temp_dir() . '/sitrec_ai_requests.json';

// Convert one provider's raw response into the single shape everything downstream prices.
//
// The providers disagree about what "input tokens" means, and getting this wrong is not a
// rounding error - it is the difference between billing a cached token at 1x and at 0.1x.
// The normalised contract is: inputTokens is the FULL-PRICE portion ONLY, with cached
// tokens counted separately. That is Anthropic's native shape; OpenAI and Gemini report a
// prompt total that INCLUDES the cached tokens, so those have to be subtracted out.
function normalizeAIUsage($parsed, $provider) {
    if (!is_array($parsed)) return null;

    if ($provider === 'anthropic') {
        $u = $parsed['usage'] ?? null;
        if (!is_array($u)) return null;
        // Already split the way we want: input_tokens excludes both cache figures.
        return [
            'inputTokens'      => (int)($u['input_tokens'] ?? 0),
            'outputTokens'     => (int)($u['output_tokens'] ?? 0),
            'cacheReadTokens'  => (int)($u['cache_read_input_tokens'] ?? 0),
            'cacheWriteTokens' => (int)($u['cache_creation_input_tokens'] ?? 0),
        ];
    }

    if ($provider === 'gemini') {
        $u = $parsed['usageMetadata'] ?? null;
        if (!is_array($u)) return null;
        $prompt = (int)($u['promptTokenCount'] ?? 0);
        $cached = (int)($u['cachedContentTokenCount'] ?? 0);
        // thoughtsTokenCount is reasoning output, billed at the output rate and reported
        // separately from candidatesTokenCount rather than included in it.
        $out = (int)($u['candidatesTokenCount'] ?? 0) + (int)($u['thoughtsTokenCount'] ?? 0);
        return [
            'inputTokens'      => max(0, $prompt - $cached),
            'outputTokens'     => $out,
            'cacheReadTokens'  => $cached,
            'cacheWriteTokens' => 0,
        ];
    }

    // openai, groq, grok - all OpenAI-shaped. completion_tokens already includes any
    // reasoning tokens, so completion_tokens_details is not added again here.
    $u = $parsed['usage'] ?? null;
    if (!is_array($u)) return null;
    $prompt = (int)($u['prompt_tokens'] ?? 0);
    $cached = (int)($u['prompt_tokens_details']['cached_tokens'] ?? 0);
    return [
        'inputTokens'      => max(0, $prompt - $cached),
        'outputTokens'     => (int)($u['completion_tokens'] ?? 0),
        'cacheReadTokens'  => $cached,
        'cacheWriteTokens' => 0,
    ];
}

// Sum usage records. One user turn is up to 15 provider calls (runToolLoop iterations plus
// continuations), so reporting only the last call's usage would under-report a tool-heavy
// turn by an order of magnitude.
function addAIUsage($into, $add) {
    if (!is_array($add)) return $into;
    if (!is_array($into)) $into = ['inputTokens' => 0, 'outputTokens' => 0, 'cacheReadTokens' => 0, 'cacheWriteTokens' => 0, 'calls' => 0];
    foreach (['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'] as $k) {
        $into[$k] = ($into[$k] ?? 0) + (int)($add[$k] ?? 0);
    }
    $into['calls'] = ($into['calls'] ?? 0) + 1;
    return $into;
}

function emptyAIUsage() {
    return ['inputTokens' => 0, 'outputTokens' => 0, 'cacheReadTokens' => 0, 'cacheWriteTokens' => 0, 'calls' => 0];
}

// Record that a request was ATTEMPTED. Called before the provider call so a failure still
// appears. Returns an id; hand it to recordAISpend() afterwards to attach what it cost.
function logAIRequest($userId, $prompt, $model = null, $provider = null) {
    global $AI_LOG_FILE;

    // Unique per entry so recordAISpend can find its own row under concurrency, rather
    // than guessing at "the most recent one for this user".
    $id = bin2hex(random_bytes(8));

    $logs = [];
    if (file_exists($AI_LOG_FILE)) {
        $content = file_get_contents($AI_LOG_FILE);
        $logs = json_decode($content, true) ?: [];
    }

    $logs[] = [
        'id' => $id,
        'timestamp' => time(),
        'user_id' => $userId,
        'prompt' => substr($prompt, 0, 500),
        'model' => $model,
        'provider' => $provider,
    ];

    if (count($logs) > 500) {
        $logs = array_slice($logs, -500);
    }

    file_put_contents($AI_LOG_FILE, json_encode($logs), LOCK_EX);
    return $id;
}

// Record what a completed turn actually cost, from the provider's own reported usage.
//
// Cost is banked HERE, at the rate in effect now, rather than derived at display time: a
// later price change or a lapsing promotion must not retroactively rewrite what past turns
// cost. Stored in micro-dollars as an integer because the daily rollup is a running sum and
// a turn is often a fraction of a cent.
function recordAISpend($logId, $userId, $provider, $model, $usage) {
    global $AI_LOG_FILE;
    if (!is_array($usage)) return;

    $costUSD = aiCostUSD($usage, $provider, $model);
    $priced = $costUSD !== null;
    $micros = $priced ? (int)round($costUSD * 1000000) : 0;
    $calls = (int)($usage['calls'] ?? 1);

    // 1. Attach to this turn's row in the rolling log, so an expensive single request can
    //    be identified rather than only showing up in a daily total.
    //
    //    ACCUMULATES rather than replaces. One user turn can span several HTTP requests -
    //    the initial one plus up to four continuations as the browser executes tool calls
    //    and comes back - and they all carry the same log id, because they are one thing
    //    the user asked for and should appear as one cost.
    if ($logId !== null && file_exists($AI_LOG_FILE)) {
        $logs = json_decode(file_get_contents($AI_LOG_FILE), true) ?: [];
        foreach ($logs as &$entry) {
            if (($entry['id'] ?? null) === $logId) {
                $entry['usage'] = addAIUsage($entry['usage'] ?? null, $usage);
                // addAIUsage counts one call per record; this usage is already a turn
                // total, so restore the real call count.
                $entry['usage']['calls'] = (int)($entry['usage']['calls'] ?? 1) - 1 + $calls;
                if ($priced) {
                    $entry['cost_micros'] = (int)($entry['cost_micros'] ?? 0) + $micros;
                } elseif (!isset($entry['cost_micros'])) {
                    // null, not 0, when unpriced - see aiCostUSD.
                    $entry['cost_micros'] = null;
                }
                break;
            }
        }
        unset($entry);
        file_put_contents($AI_LOG_FILE, json_encode($logs), LOCK_EX);
    }

    // 2. Add to the 28-day rollup. Per-model keys as well as the total, because "AI cost us
    //    $40 this week" is only actionable alongside which model spent it.
    $stats = [
        'ai_calls'              => $calls,
        'ai_input_tokens'       => (int)($usage['inputTokens'] ?? 0),
        'ai_output_tokens'      => (int)($usage['outputTokens'] ?? 0),
        'ai_cache_read_tokens'  => (int)($usage['cacheReadTokens'] ?? 0),
        'ai_cache_write_tokens' => (int)($usage['cacheWriteTokens'] ?? 0),
    ];
    if ($priced) {
        $stats['ai_cost_micros'] = $micros;
        $stats['ai_cost_micros__' . $provider . ':' . $model] = $micros;
    } else {
        // Counted, so a total that reads low is explainable rather than merely wrong.
        $stats['ai_unpriced_calls'] = $calls;
    }
    recordDailyStats($stats);
}
