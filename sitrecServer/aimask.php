<?php

// Ask a vision model to outline the sky in a single video frame.
//
// It returns one or more POLYGONS in normalised coordinates, and the client fills the other
// side of them into the video mask. No local segmentation is involved: see the prompt below
// for why the earlier seed-point version was abandoned.
//
// The prompt states the job as a constrained optimisation rather than as "trace the horizon",
// because the two error directions are not equally bad and a model told merely to trace will
// split the difference. Foliage left INSIDE the sky region puts false stars in the trees and
// ruins the result; sky left outside it merely costs a little data. So: no ground inside, at
// any price, and then as much sky as possible.
//
// ADMIN ONLY, and gated here rather than in the browser. The button that calls this is
// hidden for non-admins, but a hidden button is not a permission check - this endpoint
// spends real money on a provider API, so the check that matters is the one below.

session_start();

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';
require_once __DIR__ . '/ai_models.php';
require_once __DIR__ . '/ai_log.php';

header('Content-Type: application/json');

function failOut($message, $code = 400, $extra = []) {
    http_response_code($code);
    echo json_encode(array_merge(['error' => $message], $extra));
    exit;
}

$userInfo = getUserInfo();
if (!isAdmin($userInfo)) {
    failOut('Admin access required', 403);
}

// A 1024px-wide JPEG is ~100-300KB, so ~400KB of base64. The cap is four times that: big
// enough for a noisy frame that compresses badly, small enough that a malformed or hostile
// request cannot make PHP hold megabytes while the provider call runs.
const MAX_IMAGE_BASE64 = 1600000;

$raw = file_get_contents('php://input');
$data = json_decode($raw, true);
if (!is_array($data)) {
    failOut('Bad request body');
}

$provider = $data['provider'] ?? null;
$model = $data['model'] ?? null;
$imageB64 = $data['image'] ?? '';

if (!is_string($imageB64) || $imageB64 === '') {
    failOut('No image supplied');
}
if (strlen($imageB64) > MAX_IMAGE_BASE64) {
    failOut('Image too large - send a frame no wider than 1024 pixels');
}

// Vision, specifically. A user's chat model may well be a text-only one (Llama on Groq is
// in every tier), and sending it an image produces an unhelpful provider error - so say
// what is actually wrong, and name the models that would work.
$VISION_PROVIDERS = ['anthropic', 'openai', 'gemini'];

// "Auto (economy)" is a real selector entry, not a provider. Resolve it here as well as in
// chatbot.php so choosing it for chat does not make the AI-mask endpoint reject the same
// saved setting. Only consider vision-capable models for this endpoint.
if ($provider === 'auto' && $model === 'economy') {
    $visionModels = array_values(array_filter(
        getAvailableModels($userInfo['user_groups']),
        fn($candidate) => in_array($candidate['provider'], $VISION_PROVIDERS, true)
    ));
    $selected = economyModelFor($visionModels, 4000, 1200);
    if (!$selected) {
        failOut('No vision-capable AI model is available for this account', 403);
    }
    $provider = $selected['provider'];
    $model = $selected['model'];
} elseif (!isModelAllowed($userInfo['user_groups'], $provider, $model)) {
    // The browser picked provider/model from the menu the server built for this user, but
    // the request is still JSON - re-check it against the same permission table.
    failOut('Model not available for this account');
}

if (!in_array($provider, $VISION_PROVIDERS, true)) {
    failOut("The selected AI model ($provider/$model) cannot look at images. "
        . "Choose a Claude, GPT-5 or Gemini model in Settings > AI Model.");
}

$apiKey = getApiKeyForProvider($provider);
if (empty($apiKey)) {
    failOut("No API key configured on this server for $provider", 500);
}

// Logged BEFORE the provider call, not after it. A request that times out or errors has still
// been paid for, and a log written only on success would under-report exactly the calls worth
// investigating. Same log and same SITREC_TRACK_STATS switch as chatbot.php, so the admin
// dashboard shows chat and masking requests together; the prompt field is a fixed label
// because there is no user prompt here - the input is an image.
$aiLogId = null;
if (getenv('SITREC_TRACK_STATS')) {
    $aiLogId = logAIRequest($userInfo['user_id'], '[mask ground] sky outline from video frame', $model, $provider);
    recordDailyStats(['ai_requests' => 1]);
}

// ── The prompt ────────────────────────────────────────────────────────────────────────────
// This asks for the boundary itself, not for a hint towards it. An earlier version asked for
// SEED POINTS to drive the region-growing segmenter in src/SkyMask.js, and it failed for a
// reason better seeds cannot fix - on a wide night landscape the sky's own dark-zenith-to-
// bright-horizon-glow variation is as large as the sky-to-ground difference, so the two
// classes overlap whatever the seeds are. Measured: gpt-5-mini 0.69, a hand-placed human pair
// 0.63 and claude-opus-4-8 0.08, against a gate needing 1.0. Where the sky ENDS, on the other
// hand, is a semantic question - the one thing a vision model is genuinely good at.
$OUTLINE_PROMPT = <<<'PROMPT'
You are outlining the OPEN SKY in one frame of a video or photograph, so that a star-detection
tool can ignore everything else. The frames are usually of the night sky, so they are often
dark and grainy, and the ground is often a near-black silhouette.

YOUR TASK IS AN OPTIMISATION WITH ONE HARD CONSTRAINT:

  CONSTRAINT - your sky polygon must contain NO ground whatsoever. Not one branch, twig,
  leaf, rooftop, mast, wire, hilltop or blade of grass may lie inside it. A single piece of
  foliage inside the polygon produces false star detections and ruins the result.

  OBJECTIVE - subject to that constraint, enclose AS MUCH SKY AS POSSIBLE. Every patch of
  real sky you leave outside the polygon is data thrown away.

So: hug the silhouette closely, but always from the SKY side of it.

Reply with ONLY a JSON object - no prose, no explanation, no markdown code fence:

{
  "region": "sky",
  "polygons": [[[0.0, 0.0], [1.0, 0.0], [1.0, 0.55], [0.82, 0.58], [0.61, 0.66], [0.30, 0.62], [0.16, 0.20], [0.0, 0.10]]],
  "groundVisible": true,
  "notes": "one short sentence describing the scene"
}

Coordinates are FRACTIONS of the image: x runs 0 at the left edge to 1 at the right edge, y
runs 0 at the TOP edge to 1 at the bottom edge. Never answer in pixels.

Rules:

- "region" says what your polygons enclose. "sky" means everything OUTSIDE them is masked;
  "ground" means everything INSIDE them is masked. Prefer "sky", since the constraint above
  is stated in terms of the sky region. Use "ground" only when the foreground is one or two
  compact objects in an otherwise open sky - then the same constraint applies inverted: the
  ground polygons must contain every pixel of those objects.

- USE AS MANY POINTS AS THE SHAPE NEEDS. This is not a sketch. 40, 80, even 150 points in a
  ring is perfectly acceptable and usually better. Points are cheap; an enclosed branch is
  not. Go around each significant protrusion - a tall tree, a mast, a bush on the ridge -
  rather than cutting the line straight across it.

- Where the silhouette is intricate (fine twigs, grass heads, a lacy canopy edge), do not try
  to trace every filament. Run the line along the OUTSIDE of the whole ragged band, at the
  height of the highest twigs, so the entire tangle falls on the ground side.

- "polygons": 1 to 3 closed rings, each a list of points in order around its edge. Do not
  repeat the first point at the end - the ring is closed for you. Polygons must not overlap
  each other. Use more than one when a foreground object splits the sky into separate pieces.

- A "sky" polygon almost always runs along the image edges for part of its length - across the
  top, and down the left and right sides as far as the horizon. Include those edge points.

- Trees, buildings and masts that reach up into the frame are GROUND, including a tree that
  fills a whole side of the picture. Take the sky outline down and around them, following
  their profile.

- If you cannot tell whether something is sky or ground, it is GROUND. Put the line on the
  sky side of it and move on.

- If the frame is ALL sky - no horizon, no trees, no rooftops, nothing in the foreground
  anywhere - set "groundVisible": false and return an empty "polygons" list. Do not invent a
  horizon.

- If the image comes through a circular optic (a night-vision tube, a telescope, a boresight
  camera) with a dead black surround outside a circular live area, keep the polygon inside
  that live circle. The surround is not sky and nothing can be detected in it.
PROMPT;

$USER_TEXT = 'Here is the frame. Return only the JSON object.';

// ── Provider calls ────────────────────────────────────────────────────────────────────────
// Each returns ['text' => string] or ['error' => string]. Deliberately not shared with
// chatbot.php's callXxx() functions: those thread history and a tool loop, this one is a
// single stateless image question, and folding the two together would complicate both.

function curlJson($url, $headers, $body) {
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 90,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_POSTFIELDS => json_encode($body),
    ]);
    $response = curl_exec($ch);
    $curlError = curl_error($ch);
    curl_close($ch);
    if ($curlError) return ['error' => "Network error: $curlError"];
    $parsed = json_decode($response, true);
    if (!is_array($parsed)) return ['error' => 'Unreadable response from provider'];
    return ['json' => $parsed];
}

function visionAnthropic($apiKey, $model, $imageB64, $systemPrompt, $userText) {
    $res = curlJson('https://api.anthropic.com/v1/messages', [
        "x-api-key: $apiKey",
        "anthropic-version: 2023-06-01",
        "Content-Type: application/json",
    ], [
        "model" => $model,
        "max_tokens" => 8192,
        "system" => $systemPrompt,
        "messages" => [[
            "role" => "user",
            "content" => [
                ["type" => "image", "source" => [
                    "type" => "base64", "media_type" => "image/jpeg", "data" => $imageB64,
                ]],
                ["type" => "text", "text" => $userText],
            ],
        ]],
    ]);
    if (isset($res['error'])) return $res;
    $parsed = $res['json'];
    if (isset($parsed['error'])) {
        return ['error' => 'Anthropic API error: ' . ($parsed['error']['message'] ?? 'unknown')];
    }
    $text = '';
    foreach ($parsed['content'] ?? [] as $block) {
        if (($block['type'] ?? '') === 'text') $text .= $block['text'];
    }
    return ['text' => $text, 'usage' => normalizeAIUsage($parsed, 'anthropic')];
}

function visionOpenAI($apiKey, $model, $imageB64, $systemPrompt, $userText) {
    $body = [
        "model" => $model,
        "messages" => [
            ["role" => "system", "content" => $systemPrompt],
            ["role" => "user", "content" => [
                ["type" => "image_url", "image_url" => [
                    "url" => "data:image/jpeg;base64,$imageB64",
                ]],
                ["type" => "text", "text" => $userText],
            ]],
        ],
    ];
    // Same reasoning-effort floor chatbot.php settled on: "minimal" makes GPT-5 skip the
    // reasoning pass entirely, and the default "medium" is slow enough to risk the PHP
    // timeout. Reasoning models also reject a custom temperature, so none is sent.
    if (preg_match('/^gpt-5/i', $model)) {
        $body["reasoning_effort"] = "low";
        $body["max_completion_tokens"] = 8192;
    } else {
        $body["max_tokens"] = 8192;
    }
    $res = curlJson('https://api.openai.com/v1/chat/completions', [
        "Authorization: Bearer $apiKey",
        "Content-Type: application/json",
    ], $body);
    if (isset($res['error'])) return $res;
    $parsed = $res['json'];
    if (isset($parsed['error'])) {
        return ['error' => 'OpenAI API error: ' . ($parsed['error']['message'] ?? 'unknown')];
    }
    return [
        'text' => $parsed['choices'][0]['message']['content'] ?? '',
        'usage' => normalizeAIUsage($parsed, 'openai'),
    ];
}

function visionGemini($apiKey, $model, $imageB64, $systemPrompt, $userText) {
    $url = "https://generativelanguage.googleapis.com/v1beta/models/"
        . rawurlencode($model) . ":generateContent";
    $res = curlJson($url, [
        "x-goog-api-key: $apiKey",
        "Content-Type: application/json",
    ], [
        "system_instruction" => ["parts" => [["text" => $systemPrompt]]],
        "contents" => [["role" => "user", "parts" => [
            ["inline_data" => ["mime_type" => "image/jpeg", "data" => $imageB64]],
            ["text" => $userText],
        ]]],
        "generationConfig" => ["maxOutputTokens" => 8192],
    ]);
    if (isset($res['error'])) return $res;
    $parsed = $res['json'];
    if (isset($parsed['error'])) {
        return ['error' => 'Gemini API error: ' . ($parsed['error']['message'] ?? 'unknown')];
    }
    $text = '';
    foreach ($parsed['candidates'][0]['content']['parts'] ?? [] as $part) {
        if (isset($part['text'])) $text .= $part['text'];
    }
    return ['text' => $text, 'usage' => normalizeAIUsage($parsed, 'gemini')];
}

$result = match($provider) {
    'anthropic' => visionAnthropic($apiKey, $model, $imageB64, $OUTLINE_PROMPT, $USER_TEXT),
    'openai' => visionOpenAI($apiKey, $model, $imageB64, $OUTLINE_PROMPT, $USER_TEXT),
    'gemini' => visionGemini($apiKey, $model, $imageB64, $OUTLINE_PROMPT, $USER_TEXT),
};

// Cost is recorded here, before the response-parsing checks below. A frame whose outline
// could not be read still spent the tokens, and a masking prompt that reliably fails to
// parse is exactly the kind of quiet spend this logging exists to make visible.
if ($aiLogId !== null && !empty($result['usage'])) {
    recordAISpend($aiLogId, $userInfo['user_id'], $provider, $model, addAIUsage(null, $result['usage']));
}

if (isset($result['error'])) {
    failOut($result['error'], 502);
}

$text = trim($result['text'] ?? '');
if ($text === '') {
    failOut('The AI returned an empty response', 502);
}

// Models are asked for bare JSON and mostly give it, but a ```json fence or a sentence of
// preamble is common enough to be worth stripping rather than failing on.
if (preg_match('/\{.*\}/s', $text, $m)) {
    $outline = json_decode($m[0], true);
} else {
    $outline = null;
}
if (!is_array($outline)) {
    failOut('Could not read the AI response as JSON', 502, ['raw' => substr($text, 0, 500)]);
}

echo json_encode([
    'ok' => true,
    'outline' => $outline,
    'debug' => ['provider' => $provider, 'model' => $model],
]);
