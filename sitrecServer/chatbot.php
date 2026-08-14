<?php

session_start();

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';
require_once __DIR__ . '/user.php';

// The API keys, the per-group model permission table, and getAvailableModels() live in
// ai_models.php, shared with the other endpoints that spend money on a provider (aimask.php).
// One table, so a model's tier cannot differ between endpoints.
require_once __DIR__ . '/ai_models.php';

// Handle fetchModels request
if (isset($_GET['fetchModels'])) {
    header('Content-Type: application/json');
    $userInfo = getUserInfo();
    $models = getAvailableModels($userInfo['user_groups']);
    echo json_encode([
        'models' => $models,
        'userId' => $userInfo['user_id'],
        'userGroups' => $userInfo['user_groups']
    ]);
    exit;
}

// Rate limiting configuration by user group
// Groups: admin=3, registered=2, verified=9, sitrec=14, sitrec-plus=19
$RATE_LIMITS = [
    3 => ['minute' => 1000000, 'hour' => 1000000],  // admin - effectively unlimited
    19 => ['minute' => 200, 'hour' => 1000],        // sitrec-plus - 10x sitrec
    14 => ['minute' => 20, 'hour' => 100],          // sitrec - premium
    9 => ['minute' => 10, 'hour' => 50],            // verified - mid tier
    2 => ['minute' => 10, 'hour' => 50],            // registered - same as verified
];
$RATE_LIMIT_DIR = sys_get_temp_dir() . '/sitrec_ratelimit/';

// $AI_LOG_FILE and logAIRequest() live in ai_log.php, shared with the other endpoints that
// spend money on a provider, so the dashboard sees every AI request and not just this one's.
require_once __DIR__ . '/ai_log.php';

function getRateLimitsForUser($userGroups) {
    global $RATE_LIMITS;
    $maxMinute = 5;  // default for unknown groups
    $maxHour = 20;
    
    foreach ($userGroups as $group) {
        if (isset($RATE_LIMITS[$group])) {
            $maxMinute = max($maxMinute, $RATE_LIMITS[$group]['minute']);
            $maxHour = max($maxHour, $RATE_LIMITS[$group]['hour']);
        }
    }
    return ['minute' => $maxMinute, 'hour' => $maxHour];
}

function checkRateLimit($userId, $limitPerMinute, $limitPerHour, $rateDir) {
    if ($userId <= 0) {
        return ['allowed' => false, 'error' => 'Authentication required to use the chatbot'];
    }
    
    if (!is_dir($rateDir)) {
        @mkdir($rateDir, 0755, true);
    }
    
    $file = $rateDir . "user_{$userId}.json";
    $now = time();
    
    $data = file_exists($file) ? json_decode(file_get_contents($file), true) : null;
    if (!$data || !isset($data['minute']) || !isset($data['hour'])) {
        $data = [
            'minute' => ['count' => 0, 'reset' => $now + 60],
            'hour' => ['count' => 0, 'reset' => $now + 3600]
        ];
    }
    
    if ($now > $data['minute']['reset']) {
        $data['minute'] = ['count' => 0, 'reset' => $now + 60];
    }
    if ($now > $data['hour']['reset']) {
        $data['hour'] = ['count' => 0, 'reset' => $now + 3600];
    }
    
    if ($data['minute']['count'] >= $limitPerMinute) {
        $waitSeconds = $data['minute']['reset'] - $now;
        return ['allowed' => false, 'error' => "Rate limit exceeded. Please wait {$waitSeconds} seconds."];
    }
    
    if ($data['hour']['count'] >= $limitPerHour) {
        $waitMinutes = ceil(($data['hour']['reset'] - $now) / 60);
        $remaining = $limitPerHour - $data['hour']['count'];
        return ['allowed' => false, 'error' => "Hourly limit ({$limitPerHour}) exceeded. Please wait {$waitMinutes} minutes."];
    }
    
    $data['minute']['count']++;
    $data['hour']['count']++;
    file_put_contents($file, json_encode($data), LOCK_EX);
    
    $remainingHour = $limitPerHour - $data['hour']['count'];
    $remainingMinute = $limitPerMinute - $data['minute']['count'];
    return ['allowed' => true, 'remainingHour' => $remainingHour, 'remainingMinute' => $remainingMinute];
}

$data = json_decode(file_get_contents('php://input'), true);

// Get user info early for rate limiting
$userInfo = getUserInfo();

// Check rate limits only if stats tracking is enabled
if (getenv('SITREC_TRACK_STATS')) {
    $userRateLimits = getRateLimitsForUser($userInfo['user_groups']);
    $rateLimitResult = checkRateLimit($userInfo['user_id'], $userRateLimits['minute'], $userRateLimits['hour'], $RATE_LIMIT_DIR);
    if (!$rateLimitResult['allowed']) {
        header('Content-Type: application/json');
        http_response_code(429);
        echo json_encode(['text' => $rateLimitResult['error'], 'apiCalls' => [], 'debug' => ['error' => 'rate_limited']]);
        exit;
    }
}

// Check if this is a session continuation with tool results
$toolResults = $data['toolResults'] ?? null;
$continueSession = isset($data['continueSession']) && $data['continueSession'];

if ($continueSession && $toolResults && isset($_SESSION['chatbot_pending'])) {
    $pendingState = $_SESSION['chatbot_pending'];
    unset($_SESSION['chatbot_pending']);
    
    $toolResultsText = "[Tool Results]\n";
    foreach ($toolResults as $tr) {
        $resultJson = json_encode($tr['result'] ?? null);
        $toolResultsText .= "Tool {$tr['fn']} returned: $resultJson\n";
    }
    
    $pendingState['history'][] = ['role' => 'user', 'text' => $toolResultsText];

    $result = runToolLoop(
        $pendingState['provider'],
        getApiKeyForProvider($pendingState['provider']),
        $pendingState['systemPrompt'],
        $pendingState['history'],
        $pendingState['tools'],
        $pendingState['model'],
        $pendingState['menuSummary'],
        $pendingState['available3DModels'],
        $pendingState['availableDocs'] ?? [],
        $pendingState['remainingIterations']
    );
    
    if (!empty($result['apiCalls'])) {
        // Loop guard: if the LLM is re-issuing exactly the same fn+args we just sent it
        // a successful result for, drop the duplicate calls and stop continuing. Without
        // this, a model that ignores [Tool Results] semantics will burn through the
        // continuation budget repeating itself.
        $priorCallSig = [];
        foreach ($toolResults as $tr) {
            $priorCallSig[] = $tr['fn'] . '|' . json_encode($tr['args'] ?? null);
        }
        $filteredCalls = [];
        $droppedDuplicates = [];
        foreach ($result['apiCalls'] as $call) {
            $sig = $call['fn'] . '|' . json_encode($call['args'] ?? null);
            if (in_array($sig, $priorCallSig, true)) {
                $droppedDuplicates[] = $call['fn'];
            } else {
                $filteredCalls[] = $call;
            }
        }
        $result['apiCalls'] = $filteredCalls;
        if (!empty($droppedDuplicates)) {
            $result['debug']['droppedDuplicateCalls'] = $droppedDuplicates;
            if (empty($result['text'])) {
                $result['text'] = "Done.";
            }
        }
    }

    if (!empty($result['apiCalls'])) {
        $newRemaining = $pendingState['remainingIterations'] - 1;
        if ($newRemaining > 0) {
            $_SESSION['chatbot_pending'] = [
                'provider' => $pendingState['provider'],
                'systemPrompt' => $pendingState['systemPrompt'],
                'history' => $result['history'],
                'tools' => $pendingState['tools'],
                'model' => $pendingState['model'],
                'menuSummary' => $pendingState['menuSummary'],
                'available3DModels' => $pendingState['available3DModels'],
                'availableDocs' => $pendingState['availableDocs'] ?? [],
                'remainingIterations' => $newRemaining
            ];
            $result['sessionContinue'] = true;
        }
    }
    unset($result['history']);

    $result['debug']['sessionContinued'] = true;
    header('Content-Type: application/json');
    echo json_encode($result);
    exit;
}

// Validate and sanitize prompt
$prompt = $data['prompt'] ?? '';
$prompt = trim($prompt);
$maxPromptLength = 4000;
if (strlen($prompt) > $maxPromptLength) {
    $prompt = substr($prompt, 0, $maxPromptLength);
}
if (empty($prompt)) {
    header('Content-Type: application/json');
    echo json_encode(['text' => 'Please enter a message.', 'apiCalls' => [], 'debug' => ['error' => 'empty_prompt']]);
    exit;
}

// Validate and sanitize history
$rawHistory = $data['history'] ?? [];
$history = [];
$maxHistoryMessages = 20;
$maxHistoryMessageLength = 4000;
foreach (array_slice($rawHistory, -$maxHistoryMessages) as $msg) {
    if (isset($msg['role']) && in_array($msg['role'], ['user', 'bot']) && 
        isset($msg['text']) && is_string($msg['text'])) {
        $history[] = [
            'role' => $msg['role'],
            'text' => substr($msg['text'], 0, $maxHistoryMessageLength)
        ];
    }
}

$sitrecDoc = $data['sitrecDoc'] ?? [];
$menuSummary = $data['menuSummary'] ?? [];
$available3DModels = $data['availableModels'] ?? [];
$availableDocs = $data['availableDocs'] ?? [];
$date = $data['dateTime'] ?? date('Y-m-d H:i:s');
$simDateTime = $data['simDateTime'] ?? null;
// Client-supplied, so pin the type. It is substituted into the prompt with str_replace(),
// which in PHP 8 raises a fatal TypeError on a non-string replacement — a request body of
// {"simDateTime":[]} would 500 the endpoint. The old heredoc merely warned and inlined
// "Array", so this became reachable when the prompt moved out of the heredoc.
if (!is_string($simDateTime)) {
    $simDateTime = null;
}
$requestedProvider = $data['provider'] ?? null;
$requestedModel = $data['model'] ?? null;

function getHelpDocContent($docName, $availableDocs) {
    global $APP_PATH;

    if (!preg_match('/^[A-Za-z0-9_-]+$/', $docName)) {
        return ['error' => "Invalid doc name: $docName"];
    }

    if (!isset($availableDocs[$docName])) {
        return ['error' => "Unknown doc: $docName. Available: " . implode(', ', array_keys($availableDocs))];
    }

    $docPath = __DIR__ . '/' . $APP_PATH . 'docs/' . $docName . '.md';
    if (!file_exists($docPath)) {
        return ['error' => "Doc file not found: $docName. Tried path: $docPath, __DIR__=" . __DIR__ . ", APP_PATH=$APP_PATH"];
    }
    
    $content = file_get_contents($docPath);
    $content = preg_replace('/<!--[\s\S]*?-->/', '', $content);

    // Keep AI_DOC_CHAR_LIMIT in src/docsRegistry.js in step with this. The appended
    // notice below tells the model it was truncated, so it can flag an incomplete
    // answer rather than confidently answering from a fragment — but it still cannot
    // see the missing content, so keeping docs under the limit is the real fix.
    // tests/docsRegistry.test.js fails the build if an AI-facing doc grows past it.
    // The old 20000 hid two thirds of TraverseMethods.md, including everything about
    // the Analyze button and the verdict, with no notice at all.
    // Cut on a character boundary where mbstring is available: a naive byte-wise substr
    // can split a multibyte UTF-8 sequence, and the resulting invalid string makes the
    // json_encode of this response fail outright rather than merely truncating oddly.
    $limit = 60000;
    if (strlen($content) > $limit) {
        $content = function_exists('mb_substr')
            ? mb_substr($content, 0, $limit, 'UTF-8')
            : substr($content, 0, $limit);
        $content = $content
            . "\n\n[Content truncated - showing first $limit characters of this document."
            . " Tell the user that your answer may be incomplete and point them at the full document.]";
    }

    return ['content' => $content];
}

// Log AI request
if (getenv('SITREC_TRACK_STATS')) {
    logAIRequest($userInfo['user_id'], $prompt, $requestedModel);
    require_once __DIR__ . '/stats_history.php';
    recordDailyStats(['ai_requests' => 1]);
}

// User info already retrieved above for rate limiting
$aiModels = getAvailableModels($userInfo['user_groups']);
$selectedProvider = null;
$selectedModel = null;

if ($requestedProvider && $requestedModel) {
    foreach ($aiModels as $m) {
        if ($m['provider'] === $requestedProvider && $m['model'] === $requestedModel) {
            $selectedProvider = $requestedProvider;
            $selectedModel = $requestedModel;
            break;
        }
    }
}

// Fall back to first available model if requested model not allowed
if (!$selectedProvider && !empty($aiModels)) {
    $selectedProvider = $aiModels[0]['provider'];
    $selectedModel = $aiModels[0]['model'];
}

// Build tools array from sitrecDoc (OpenAI format, will convert for Anthropic)
function buildToolsFromDoc($sitrecDoc, $menuSummary) {
    $tools = [];
    $addedNames = [];

    // Menu function names that we'll add manually with better schemas
    $menuFunctions = ['setMenuValue', 'getMenuValue', 'executeMenuButton', 'listMenus', 'listMenuControls'];

    // SECURITY (B1): never advertise JS-executing functions to the LLM. The client already
    // sends the filtered getLLMDocumentation(), but re-deny here so a tampered/legacy client
    // sending the full doc still can't expose these. Keep in sync with the CSitrecAPI entries
    // tagged llmCallable:false.
    $llmDenied = ['setScriptedVideoScript', 'previewScriptedVideo'];

    // Parse sitrecDoc entries to extract function schemas
    foreach ($sitrecDoc as $fn => $desc) {
        // Skip menu functions - we'll add them with better schemas below
        if (in_array($fn, $menuFunctions)) {
            continue;
        }
        // Skip functions that must never be callable from chat (JS execution).
        if (in_array($fn, $llmDenied, true)) {
            continue;
        }
        $tool = [
            "type" => "function",
            "function" => [
                "name" => $fn,
                "description" => $desc,
                "parameters" => [
                    "type" => "object",
                    "properties" => new stdClass(),
                    "required" => []
                ]
            ]
        ];
        
        // Try to extract parameters from description
        if (preg_match('/Parameters:\s*(.+)$/i', $desc, $matches)) {
            $paramsStr = $matches[1];
            preg_match_all('/(\w+)\s*\(([^)]+)\)/', $paramsStr, $paramMatches, PREG_SET_ORDER);
            
            $properties = [];
            $required = [];
            foreach ($paramMatches as $pm) {
                $paramName = $pm[1];
                $paramDesc = $pm[2];
                
                $type = "string";
                if (stripos($paramDesc, 'float') !== false || stripos($paramDesc, 'number') !== false) {
                    $type = "number";
                } elseif (preg_match('/\binteger\b|\bint\b/i', $paramDesc)) {
                    $type = "integer";
                } elseif (stripos($paramDesc, 'bool') !== false) {
                    $type = "boolean";
                } elseif (stripos($paramDesc, 'array') !== false) {
                    $type = "array";
                }
                
                $prop = [
                    "type" => $type,
                    "description" => $paramDesc
                ];
                // For array types, add items schema so LLMs know element type
                if ($type === "array") {
                    $prop["items"] = ["type" => "string"];
                }
                $properties[$paramName] = $prop;
                
                if (stripos($paramDesc, 'optional') === false) {
                    $required[] = $paramName;
                }
            }
            
            if (!empty($properties)) {
                $tool["function"]["parameters"]["properties"] = $properties;
                $tool["function"]["parameters"]["required"] = $required;
            }
        }
        
        $tools[] = $tool;
    }
    
    // Build short menu list for tool descriptions (just menu IDs)
    $menuIds = !empty($menuSummary) ? implode(", ", array_keys($menuSummary)) : "view, camera, satellites, terrain";
    
    // Add menu control functions (keep descriptions short - full list is in system prompt)
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "setMenuValue",
            "description" => "Set a menu control's value. Available menus: $menuIds. See system prompt for full control list.",
            "parameters" => [
                "type" => "object",
                "properties" => [
                    "menu" => ["type" => "string", "description" => "Menu ID"],
                    "path" => ["type" => "string", "description" => "Control name or path with '/' for nested folders"],
                    "value" => ["description" => "New value (number, boolean, or string)"]
                ],
                "required" => ["menu", "path", "value"]
            ]
        ]
    ];
    
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "getMenuValue",
            "description" => "Get the current value of a menu control.",
            "parameters" => [
                "type" => "object",
                "properties" => [
                    "menu" => ["type" => "string", "description" => "Menu ID"],
                    "path" => ["type" => "string", "description" => "Control name or path"]
                ],
                "required" => ["menu", "path"]
            ]
        ]
    ];
    
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "executeMenuButton",
            "description" => "Click/execute a button control in a menu.",
            "parameters" => [
                "type" => "object",
                "properties" => [
                    "menu" => ["type" => "string", "description" => "Menu ID"],
                    "path" => ["type" => "string", "description" => "Button name or path"]
                ],
                "required" => ["menu", "path"]
            ]
        ]
    ];
    
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "listMenus",
            "description" => "List all available menu IDs.",
            "parameters" => ["type" => "object", "properties" => new stdClass()]
        ]
    ];
    
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "listMenuControls",
            "description" => "List all controls in a specific menu.",
            "parameters" => [
                "type" => "object",
                "properties" => ["menu" => ["type" => "string", "description" => "Menu ID to list controls for"]],
                "required" => ["menu"]
            ]
        ]
    ];
    
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "getHelpDoc",
            "description" => "Read a help documentation file. Use this to answer questions about Sitrec features, what's new, or how to use specific functionality.",
            "parameters" => [
                "type" => "object",
                "properties" => ["docName" => ["type" => "string", "description" => "Name of the doc to read (e.g., 'WhatsNew', 'Starlink', 'UserInterface')"]],
                "required" => ["docName"]
            ]
        ]
    ];
    
    return $tools;
}

// Convert OpenAI tools format to Anthropic format
function convertToolsForAnthropic($tools) {
    $anthropicTools = [];
    foreach ($tools as $tool) {
        $anthropicTools[] = [
            "name" => $tool["function"]["name"],
            "description" => $tool["function"]["description"],
            "input_schema" => $tool["function"]["parameters"]
        ];
    }
    return $anthropicTools;
}

// Convert the OpenAI-style tools array into Gemini's tools.functionDeclarations form.
function convertToolsForGemini($tools) {
    $decls = [];
    foreach ($tools as $tool) {
        $decls[] = [
            "name" => $tool["function"]["name"],
            "description" => $tool["function"]["description"],
            "parameters" => $tool["function"]["parameters"]
        ];
    }
    return [["functionDeclarations" => $decls]];
}

// Call Google Gemini (generativelanguage REST). Same contract as the other providers:
// take the text chat history + OpenAI-style tools, return {text, apiCalls, debug}. The
// chatbot's tool loop feeds tool *results* back as plain text messages (see runToolLoop),
// so we only parse the model's function CALLS here — no native functionResponse threading
// is needed. Hidden from users unless GEMINI_API is set (see getAvailableModels()).
function callGemini($apiKey, $systemPrompt, $history, $tools, $model = 'gemini-2.5-flash-lite') {
    $contents = [];
    foreach ($history as $msg) {
        $role = $msg['role'] === 'bot' ? 'model' : 'user';
        $contents[] = ["role" => $role, "parts" => [["text" => $msg['text']]]];
    }

    if (empty($contents)) {
        return [
            'text' => 'Error: No messages to send',
            'apiCalls' => [],
            'debug' => ['provider' => 'gemini', 'model' => $model, 'error' => 'No messages']
        ];
    }

    $requestBody = [
        "system_instruction" => ["parts" => [["text" => $systemPrompt]]],
        "contents" => $contents,
        "tools" => convertToolsForGemini($tools),
        "generationConfig" => ["maxOutputTokens" => 1024]
    ];

    $url = "https://generativelanguage.googleapis.com/v1beta/models/" . rawurlencode($model) . ":generateContent";
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => [
            "x-goog-api-key: $apiKey",
            "Content-Type: application/json"
        ],
        CURLOPT_POSTFIELDS => json_encode($requestBody)
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);

    if ($curlError) {
        return [
            'text' => "Error: $curlError",
            'apiCalls' => [],
            'debug' => ['provider' => 'gemini', 'curlError' => $curlError]
        ];
    }

    $parsed = json_decode($response, true);

    if (isset($parsed['error'])) {
        return [
            'text' => "Gemini API error: " . ($parsed['error']['message'] ?? 'Unknown error'),
            'apiCalls' => [],
            'debug' => ['provider' => 'gemini', 'httpCode' => $httpCode, 'error' => $parsed['error']]
        ];
    }

    $parts = $parsed['candidates'][0]['content']['parts'] ?? [];
    $text = '';
    $calls = [];
    foreach ($parts as $part) {
        if (isset($part['text'])) {
            $text .= $part['text'];
        } elseif (isset($part['functionCall'])) {
            $calls[] = [
                "fn" => $part['functionCall']['name'],
                "args" => $part['functionCall']['args'] ?? []
            ];
        }
    }

    return [
        'text' => trim($text),
        'apiCalls' => $calls,
        'debug' => [
            'provider' => 'gemini',
            'model' => $model,
            'hasToolCalls' => !empty($calls),
            'toolCallCount' => count($calls),
            'finishReason' => $parsed['candidates'][0]['finishReason'] ?? null,
            'httpCode' => $httpCode
        ]
    ];
}

$tools = buildToolsFromDoc($sitrecDoc, $menuSummary);

// ── SINGLE SOURCE OF TRUTH FOR THE SYSTEM PROMPT ─────────────────────────────
// Every line of prompt prose lives in chatbotSystemPrompt.txt, split into
// @@SECTION blocks. The browser's BYOK path (src/CDirectLLMClient.js) parses the
// same file with the same rules, so the two cannot drift. They previously held
// hand-synced copies and had already diverged: the browser copy was missing the
// camera point-vs-lock rules, the multi-part-request rule, the whole
// "[Tool Results]" handling section, and the help-doc link instruction.
// Only genuinely dynamic formatting (loops over menus/docs) lives in code.
// A prompt-configuration fault is a deploy problem, not a user problem, and carrying on
// would ask the model to act with no instructions at all. Bail out — but in the shape
// this endpoint always returns. The chat view reads `response.text` and checks neither
// `res.ok` nor an `error` field, so an off-contract body would leave the user staring at
// silence with no clue anything failed. Specifics go to the server log, not the response.
function failPromptConfig($detail) {
    error_log("chatbot.php prompt configuration error: $detail");
    if (!headers_sent()) {
        header('Content-Type: application/json');
        http_response_code(500);
    }
    echo json_encode([
        'text' => 'The AI assistant is unavailable (server configuration problem).',
        'apiCalls' => [],
        'debug' => ['error' => 'prompt_configuration'],
    ]);
    exit;
}

function promptSection($name) {
    static $sections = null;
    if ($sections === null) {
        $raw = @file_get_contents(__DIR__ . '/chatbotSystemPrompt.txt');
        if ($raw === false) {
            failPromptConfig('chatbotSystemPrompt.txt could not be read');
        }
        $sections = [];
        // Anchored (?:^|\n) with NO /m flag, matching src/CDirectLLMClient.js character for
        // character. JS's /m anchor also matches after a lone \r, U+2028 and U+2029, which
        // PCRE's does not — so /m on both sides would still let a stray separator split a
        // section in the browser but not here. This form consumes the newline preceding the
        // marker, so both parsers must (and do) apply the same single trailing-newline strip.
        $parts = preg_split('/(?:^|\n)@@SECTION[ \t]+(\w+)[ \t]*\r?\n/', $raw, -1, PREG_SPLIT_DELIM_CAPTURE);
        // $parts = [preamble, name, body, name, body, ...]
        for ($i = 1; $i + 1 < count($parts); $i += 2) {
            $sections[$parts[$i]] = preg_replace('/\r?\n$/', '', $parts[$i + 1]);
        }
    }
    // Require a non-empty body, not merely a present key. A deploy truncated mid-file
    // (an interrupted scp, a partial write) can leave a section marker with nothing
    // after it — isset() would accept that and we would hand the model an empty prompt,
    // which is the exact failure this function exists to prevent.
    if (!isset($sections[$name]) || trim($sections[$name]) === '') {
        failPromptConfig("prompt section '$name' is missing or empty");
    }
    return $sections[$name];
}

// Build menu documentation for system prompt (limit size to avoid token limits)
$menuDocForPrompt = "";
if (!empty($menuSummary)) {
    $menuDocForPrompt = "\n\n" . promptSection('menuHeader') . "\n";
    $totalControls = 0;
    $maxControls = 9999; // Limit to prevent huge prompts (temporarily high for debugging)
    
    foreach ($menuSummary as $menuId => $controls) {
        if (!empty($controls) && $totalControls < $maxControls) {
            $menuDocForPrompt .= "\n" . str_replace('{{menuId}}', $menuId, promptSection('menuGroup')) . "\n";
            foreach ($controls as $control) {
                if ($totalControls >= $maxControls) {
                    // Server-only truncation guard — the browser path applies no cap,
                    // so this line has no counterpart to drift against.
                    $menuDocForPrompt .= "  - (more controls available - use listMenuControls)\n";
                    break;
                }
                $menuDocForPrompt .= str_replace('{{control}}', $control, promptSection('menuItem')) . "\n";
                $totalControls++;
            }
        }
    }
    $menuDocForPrompt .= "\n" . promptSection('menuFooter') . "\n";
}

// The prompt text itself lives in chatbotSystemPrompt.txt (@@SECTION base),
// shared verbatim with the browser BYOK path. See promptSection() above.
$systemPrompt = str_replace('{{simDateTime}}', $simDateTime ?? '', promptSection('base'));

$systemPrompt .= $menuDocForPrompt;

if (!empty($availableDocs)) {
    $systemPrompt .= "\n\n" . promptSection('docsHeader') . "\n";
    $docsItem = promptSection('docsItem');
    foreach ($availableDocs as $docName => $description) {
        $systemPrompt .= str_replace(
            ['{{name}}', '{{description}}'],
            [$docName, $description],
            $docsItem
        ) . "\n";
    }
    $systemPrompt .= "\n" . promptSection('docsFooter') . "\n";
}

// Call OpenAI API
function callOpenAI($apiKey, $systemPrompt, $history, $tools, $model = 'gpt-5-mini') {
    $messages = [["role" => "system", "content" => $systemPrompt]];
    foreach ($history as $msg) {
        $role = $msg['role'] === 'bot' ? 'assistant' : $msg['role'];
        $messages[] = ["role" => $role, "content" => $msg['text']];
    }
    
    $requestBody = [
        "model" => $model,
        "messages" => $messages,
        "tools" => $tools,
        "tool_choice" => "auto",
    ];
    // GPT-5 and o-series are reasoning models that only accept the DEFAULT temperature
    // (1) and reject a custom value with a 400. Older chat models (gpt-4o, etc.) accept
    // 0.2. So only send a custom temperature for models that support it — otherwise the
    // request 400s and (without the error check below) comes back as empty text.
    if (!preg_match('/^(gpt-5|o\d)/i', $model)) {
        $requestBody["temperature"] = 0.2;
    }
    // GPT-5 reasoning models default to "medium" effort (~10-15s per call), which makes
    // the multi-step tool loop slow enough to hit PHP/proxy timeouts, and burns reasoning
    // tokens. But "minimal" effort skips the reasoning pass that drives tool calling —
    // gpt-5-mini at minimal effort narrates actions ("moving camera now...") WITHOUT
    // emitting the tool calls, silently doing nothing. "low" is the floor when tools
    // are involved: still fast (~2-4s), but the model actually calls the functions.
    if (preg_match('/^gpt-5/i', $model)) {
        $requestBody["reasoning_effort"] = "low";
    }

    $ch = curl_init("https://api.openai.com/v1/chat/completions");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer $apiKey",
            "Content-Type: application/json"
        ],
        CURLOPT_POSTFIELDS => json_encode($requestBody)
    ]);

    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);

    $parsed = json_decode($response, true);

    // Surface API errors instead of silently returning empty text.
    if (isset($parsed['error'])) {
        return [
            'text' => "OpenAI API error: " . ($parsed['error']['message'] ?? 'Unknown error'),
            'apiCalls' => [],
            'debug' => ['provider' => 'openai', 'model' => $model, 'httpCode' => $httpCode, 'error' => $parsed['error']]
        ];
    }

    $message = $parsed['choices'][0]['message'] ?? [];
    $text = $message['content'] ?? '';
    $calls = [];
    
    if (!empty($message['tool_calls'])) {
        foreach ($message['tool_calls'] as $tc) {
            $args = json_decode($tc['function']['arguments'], true);
            $calls[] = [
                "fn" => $tc['function']['name'],
                "args" => $args ?? []
            ];
        }
    }
    
    return [
        'text' => trim($text),
        'apiCalls' => $calls,
        'debug' => [
            'provider' => 'openai',
            'model' => $model,
            'hasToolCalls' => !empty($message['tool_calls']),
            'toolCallCount' => count($message['tool_calls'] ?? [])
        ]
    ];
}


// Current antropic models:
// Claude Sonnet 4.5	claude-sonnet-4-5-20250929	Recommended - best balance
// Claude Haiku 4.5	    claude-haiku-4-5-20251001	Fastest, cheapest
// Claude Opus 4.5	    claude-opus-4-5-20251101	Most intelligent, higher cost

// Call Anthropic (Claude) API
function callAnthropic($apiKey, $systemPrompt, $history, $tools, $model = 'claude-haiku-4-5-20251001') {
    $messages = [];
    foreach ($history as $msg) {
        $role = $msg['role'] === 'bot' ? 'assistant' : 'user';
        $messages[] = ["role" => $role, "content" => $msg['text']];
    }
    
    // Anthropic requires at least one message
    if (empty($messages)) {
        return [
            'text' => 'Error: No messages to send',
            'apiCalls' => [],
            'debug' => ['provider' => 'anthropic', 'model' => $model, 'error' => 'No messages']
        ];
    }
    
    $anthropicTools = convertToolsForAnthropic($tools);

    // ── PARITY WITH THE BROWSER BYOK CLIENT ───────────────────────────────────────────
    // This Anthropic request-shaping logic has a sibling in the client-side BYOK path:
    // src/CDirectLLMClient.js (callAnthropic() + chat()). The two MUST stay behaviorally
    // in sync — when you change the prompt-caching breakpoints, the system-prompt
    // structure, or the tool loop here, mirror the change there (and update its Jest
    // tests in tests/CDirectLLMClient.test.js), and vice-versa. Both paths now carry
    // the same two cache_control breakpoints and the same getCurrentDateTime tool /
    // "no wall-clock time in the prompt" convention — keep them aligned.
    // ──────────────────────────────────────────────────────────────────────────────────
    //
    // Prompt caching uses up to two prefix breakpoints (max 4 allowed). Caching is a
    // prefix match over the rendered request, whose block order is tools -> system ->
    // messages, so a breakpoint caches everything from the start of the prompt up to it.
    //
    // Breakpoint 1 (system block): because tools render before system, this one marker
    // caches the tools+system prefix together. That prefix is large and byte-identical
    // across turns, so repeated turns pay ~10% (cache read) instead of full input price.
    $systemBlocks = [["type" => "text", "text" => $systemPrompt, "cache_control" => ["type" => "ephemeral"]]];

    // Breakpoint 2 (last message): one user message fans out to up to 5 tool-loop
    // iterations (see runToolLoop maxIterations), and each iteration re-sends the GROWING
    // message history. Without a marker here that history is re-billed at full price every
    // iteration. Marking the final message caches the conversation prefix too, so each
    // iteration reads the prior one's messages at ~0.1x (the 5-min ephemeral TTL stays warm
    // because the iterations are seconds apart). cache_control requires block-form content,
    // so convert just the final message; earlier messages stay plain strings (allowed).
    $lastIdx = count($messages) - 1;
    if (is_string($messages[$lastIdx]['content']) && $messages[$lastIdx]['content'] !== '') {
        $messages[$lastIdx]['content'] = [[
            "type" => "text",
            "text" => $messages[$lastIdx]['content'],
            "cache_control" => ["type" => "ephemeral"],
        ]];
    }

    $requestBody = [
        "model" => $model,
        "max_tokens" => 1024,
        "system" => $systemBlocks,
        "messages" => $messages,
        "tools" => $anthropicTools
    ];
    
    $ch = curl_init("https://api.anthropic.com/v1/messages");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => [
            "x-api-key: $apiKey",
            "anthropic-version: 2023-06-01",
            "Content-Type: application/json"
        ],
        CURLOPT_POSTFIELDS => json_encode($requestBody)
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);
    
    // Check for curl errors
    if ($curlError) {
        return [
            'text' => "Error: $curlError",
            'apiCalls' => [],
            'debug' => ['provider' => 'anthropic', 'curlError' => $curlError]
        ];
    }
    
    $parsed = json_decode($response, true);
    
    // Check for API errors
    if (isset($parsed['error'])) {
        return [
            'text' => "Anthropic API error: " . ($parsed['error']['message'] ?? 'Unknown error'),
            'apiCalls' => [],
            'debug' => [
                'provider' => 'anthropic',
                'httpCode' => $httpCode,
                'error' => $parsed['error']
            ]
        ];
    }
    
    $content = $parsed['content'] ?? [];
    
    $text = '';
    $calls = [];
    
    foreach ($content as $block) {
        if ($block['type'] === 'text') {
            $text .= $block['text'];
        } elseif ($block['type'] === 'tool_use') {
            $calls[] = [
                "fn" => $block['name'],
                "args" => $block['input'] ?? []
            ];
        }
    }
    
    return [
        'text' => trim($text),
        'apiCalls' => $calls,
        'debug' => [
            'provider' => 'anthropic',
            'model' => $model,
            'hasToolCalls' => !empty($calls),
            'toolCallCount' => count($calls),
            'stopReason' => $parsed['stop_reason'] ?? null,
            'httpCode' => $httpCode,
            // Cache verification: if cacheReadTokens stays 0 across repeated turns, a silent
            // invalidator is changing the prefix (e.g. the menu-doc system prompt differs
            // between turns). inputTokens is the UNCACHED remainder only — the full prompt
            // size is inputTokens + cacheWriteTokens + cacheReadTokens.
            'cacheReadTokens' => $parsed['usage']['cache_read_input_tokens'] ?? null,
            'cacheWriteTokens' => $parsed['usage']['cache_creation_input_tokens'] ?? null,
            'inputTokens' => $parsed['usage']['input_tokens'] ?? null,
            'outputTokens' => $parsed['usage']['output_tokens'] ?? null
        ]
    ];
}

// Groq models (OpenAI-compatible API, very fast inference):
// llama-3.3-70b-versatile - Best quality
// llama-3.1-8b-instant - Fastest
// mixtral-8x7b-32768 - Good balance

// Call Groq API (OpenAI-compatible)
function callGroq($apiKey, $systemPrompt, $history, $tools, $model = 'llama-3.3-70b-versatile') {
    $messages = [["role" => "system", "content" => $systemPrompt]];
    foreach ($history as $msg) {
        $role = $msg['role'] === 'bot' ? 'assistant' : $msg['role'];
        $messages[] = ["role" => $role, "content" => $msg['text']];
    }
    
    $ch = curl_init("https://api.groq.com/openai/v1/chat/completions");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer $apiKey",
            "Content-Type: application/json"
        ],
        CURLOPT_POSTFIELDS => json_encode([
            "model" => $model,
            "messages" => $messages,
            "tools" => $tools,
            "tool_choice" => "auto",
            "temperature" => 0.2
        ])
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);
    
    if ($curlError) {
        return [
            'text' => "Error: $curlError",
            'apiCalls' => [],
            'debug' => ['provider' => 'groq', 'curlError' => $curlError]
        ];
    }
    
    $parsed = json_decode($response, true);
    
    if (isset($parsed['error'])) {
        return [
            'text' => "Groq API error: " . ($parsed['error']['message'] ?? 'Unknown error'),
            'apiCalls' => [],
            'debug' => ['provider' => 'groq', 'httpCode' => $httpCode, 'error' => $parsed['error']]
        ];
    }
    
    $message = $parsed['choices'][0]['message'] ?? [];
    $text = $message['content'] ?? '';
    $calls = [];
    
    if (!empty($message['tool_calls'])) {
        foreach ($message['tool_calls'] as $tc) {
            $args = json_decode($tc['function']['arguments'], true);
            $calls[] = [
                "fn" => $tc['function']['name'],
                "args" => $args ?? []
            ];
        }
    }
    
    return [
        'text' => trim($text),
        'apiCalls' => $calls,
        'debug' => [
            'provider' => 'groq',
            'model' => $model,
            'hasToolCalls' => !empty($message['tool_calls']),
            'toolCallCount' => count($message['tool_calls'] ?? []),
            'httpCode' => $httpCode
        ]
    ];
}

// xAI Grok models (OpenAI-compatible API):
// grok-2-latest - Latest Grok 2
// grok-beta - Beta version

// Call xAI Grok API (OpenAI-compatible)
function callGrok($apiKey, $systemPrompt, $history, $tools, $model = 'grok-4-fast') {
    $messages = [["role" => "system", "content" => $systemPrompt]];
    foreach ($history as $msg) {
        $role = $msg['role'] === 'bot' ? 'assistant' : $msg['role'];
        $messages[] = ["role" => $role, "content" => $msg['text']];
    }
    
    $ch = curl_init("https://api.x.ai/v1/chat/completions");
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_POST => true,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_HTTPHEADER => [
            "Authorization: Bearer $apiKey",
            "Content-Type: application/json"
        ],
        CURLOPT_POSTFIELDS => json_encode([
            "model" => $model,
            "messages" => $messages,
            "tools" => $tools,
            "tool_choice" => "auto",
            "temperature" => 0.2
        ])
    ]);
    
    $response = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $curlError = curl_error($ch);
    curl_close($ch);
    
    if ($curlError) {
        return [
            'text' => "Error: $curlError",
            'apiCalls' => [],
            'debug' => ['provider' => 'grok', 'curlError' => $curlError]
        ];
    }
    
    $parsed = json_decode($response, true);
    
    if (isset($parsed['error'])) {
        return [
            'text' => "Grok API error: " . ($parsed['error']['message'] ?? 'Unknown error'),
            'apiCalls' => [],
            'debug' => ['provider' => 'grok', 'httpCode' => $httpCode, 'error' => $parsed['error']]
        ];
    }
    
    $message = $parsed['choices'][0]['message'] ?? [];
    $text = $message['content'] ?? '';
    $calls = [];
    
    if (!empty($message['tool_calls'])) {
        foreach ($message['tool_calls'] as $tc) {
            $args = json_decode($tc['function']['arguments'], true);
            $calls[] = [
                "fn" => $tc['function']['name'],
                "args" => $args ?? []
            ];
        }
    }
    
    return [
        'text' => trim($text),
        'apiCalls' => $calls,
        'debug' => [
            'provider' => 'grok',
            'model' => $model,
            'hasToolCalls' => !empty($message['tool_calls']),
            'toolCallCount' => count($message['tool_calls'] ?? []),
            'httpCode' => $httpCode
        ]
    ];
}

// Simulate query-type tool calls on the server side
// Returns [handled => bool, result => mixed] - if handled, result is the tool response
function simulateToolCall($fn, $args, $menuSummary, $availableModels, $availableDocs = []) {
    
    switch ($fn) {
        case 'listMenus':
            return ['handled' => true, 'result' => array_keys($menuSummary)];
        case 'listMenuControls':
            $menu = $args['menu'] ?? '';
            if (isset($menuSummary[$menu])) {
                return ['handled' => true, 'result' => $menuSummary[$menu]];
            }
            return ['handled' => true, 'result' => ['error' => "Menu '$menu' not found"]];
        case 'listAvailableModels':
            return ['handled' => true, 'result' => $availableModels];
        case 'getHelpDoc':
            $docName = $args['docName'] ?? '';
            $result = getHelpDocContent($docName, $availableDocs);
            return ['handled' => true, 'result' => $result];
        case 'getCurrentDateTime':
            // Real-world "now" as reported by the client in this request's payload
            // ($date = $data['dateTime'], an ISO 8601 string with timezone offset).
            // Handled server-side as a query so the result feeds straight back into
            // the tool loop. (The BYOK path implements this client-side in CSitrecAPI.)
            global $date;
            return ['handled' => true, 'result' => [
                'dateTime' => $date,
                'note' => "Real-world current date/time reported by the client. Distinct from the simulation time.",
            ]];
        case 'listObjectFolders':
            return ['handled' => false, 'result' => null];
        default:
            return ['handled' => false, 'result' => null];
    }
}

// Tool use loop - allows AI to make multiple tool calls
function runToolLoop($provider, $apiKey, $systemPrompt, $history, $tools, $model, $menuSummary, $availableModels, $availableDocs = [], $maxIterations = 5) {
    $allApiCalls = [];  // Action calls to send to client
    $debugInfo = [];
    $finalText = '';
    $currentHistory = $history;
    
    for ($iteration = 0; $iteration < $maxIterations; $iteration++) {
        // Call the appropriate provider
        if ($provider === 'anthropic') {
            global $ANTHROPIC_API_KEY;
            $result = callAnthropic($ANTHROPIC_API_KEY, $systemPrompt, $currentHistory, $tools, $model);
        } elseif ($provider === 'groq') {
            global $GROQ_API_KEY;
            $result = callGroq($GROQ_API_KEY, $systemPrompt, $currentHistory, $tools, $model);
        } elseif ($provider === 'grok') {
            global $GROK_API_KEY;
            $result = callGrok($GROK_API_KEY, $systemPrompt, $currentHistory, $tools, $model);
        } elseif ($provider === 'gemini') {
            global $GEMINI_API_KEY;
            $result = callGemini($GEMINI_API_KEY, $systemPrompt, $currentHistory, $tools, $model);
        } else {
            global $OPENAI_API_KEY;
            $result = callOpenAI($OPENAI_API_KEY, $systemPrompt, $currentHistory, $tools, $model);
        }
        
        $debugInfo['iteration_' . $iteration] = $result['debug'];
        $debugInfo['iteration_' . $iteration]['toolResults'] = [];
        
        // Collect any text response
        if (!empty($result['text'])) {
            $finalText .= ($finalText ? "\n" : '') . $result['text'];
        }
        
        // No tool calls - we're done
        if (empty($result['apiCalls'])) {
            break;
        }
        
        // Process tool calls
        $handledCalls = [];
        $pendingActionCalls = [];
        
        foreach ($result['apiCalls'] as $call) {
            $simResult = simulateToolCall($call['fn'], $call['args'], $menuSummary, $availableModels, $availableDocs);
            if ($simResult['handled']) {
                // Query tool - we can simulate it
                $handledCalls[] = [
                    'fn' => $call['fn'],
                    'args' => $call['args'],
                    'result' => $simResult['result']
                ];
                $debugInfo['iteration_' . $iteration]['toolResults'][] = [
                    'fn' => $call['fn'],
                    'args' => $call['args'],
                    'result' => $simResult['result']
                ];
            } else {
                // Action tool - needs client execution
                $pendingActionCalls[] = $call;
            }
        }
        
        // If we have action calls, return them to client (don't continue loop)
        if (!empty($pendingActionCalls)) {
            $allApiCalls = array_merge($allApiCalls, $pendingActionCalls);
            break;
        }
        
        // If we handled query calls, add results to history and continue loop
        if (!empty($handledCalls)) {
            // Build a response showing tool results
            $toolResultsText = '';
            foreach ($handledCalls as $hc) {
                $resultJson = json_encode($hc['result']);
                $toolResultsText .= "Tool {$hc['fn']} returned: $resultJson\n";
            }
            
            // Add assistant's tool call and simulated tool response to history
            $currentHistory[] = ['role' => 'bot', 'text' => "Calling tools: " . json_encode(array_column($handledCalls, 'fn'))];
            $currentHistory[] = ['role' => 'user', 'text' => "[Tool Results]\n$toolResultsText"];
        }
    }
    
    return [
        'text' => $finalText,
        'apiCalls' => $allApiCalls,
        'history' => $currentHistory,
        'debug' => array_merge(
            ['provider' => $provider, 'model' => $model, 'iterations' => $iteration + 1],
            count($debugInfo) === 1 ? $debugInfo['iteration_0'] : $debugInfo
        )
    ];
}

// Call the appropriate provider with tool loop
if (!$selectedProvider) {
    $result = [
        'text' => 'Error: No models available for your account',
        'apiCalls' => [],
        'debug' => ['error' => 'No available models']
    ];
} else {
    $apiKey = getApiKeyForProvider($selectedProvider);
    $result = runToolLoop($selectedProvider, $apiKey, $systemPrompt, $history, $tools, $selectedModel, $menuSummary, $available3DModels, $availableDocs, 5);

    if (!empty($result['apiCalls'])) {
        $_SESSION['chatbot_pending'] = [
            'provider' => $selectedProvider,
            'systemPrompt' => $systemPrompt,
            'history' => $result['history'],
            'tools' => $tools,
            'model' => $selectedModel,
            'menuSummary' => $menuSummary,
            'available3DModels' => $available3DModels,
            'availableDocs' => $availableDocs,
            'remainingIterations' => 4
        ];
        $result['sessionContinue'] = true;
    }
    unset($result['history']);
}

header('Content-Type: application/json');
echo json_encode($result);
