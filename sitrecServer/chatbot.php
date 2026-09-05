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
    if (!empty($models)) {
        $models[] = [
            'provider' => 'auto',
            'model' => 'economy',
            'label' => 'Auto (economy)',
        ];
    }
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

// Hard request bounds. The normal live payload is ~65 KB; these ceilings leave ample room
// for larger sitches and a 60 KB help-document result while making crafted clients finite.
const AI_REQUEST_MAX_BYTES = 1048576;
const AI_HISTORY_MAX_BYTES = 131072;
const AI_SITREC_DOC_MAX_BYTES = 262144;
const AI_MENU_SUMMARY_MAX_BYTES = 262144;
const AI_AVAILABLE_MODELS_MAX_BYTES = 65536;
const AI_AVAILABLE_DOCS_MAX_BYTES = 65536;
const AI_TOOL_RESULTS_MAX_BYTES = 524288;

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
    $handle = @fopen($file, 'c+');
    if (!$handle || !flock($handle, LOCK_EX)) {
        if ($handle) fclose($handle);
        return ['allowed' => false, 'error' => 'Rate limiter unavailable; please try again'];
    }
    rewind($handle);
    $raw = stream_get_contents($handle);
    $data = $raw !== '' ? json_decode($raw, true) : null;
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
        flock($handle, LOCK_UN);
        fclose($handle);
        return ['allowed' => false, 'error' => "Rate limit exceeded. Please wait {$waitSeconds} seconds."];
    }
    
    if ($data['hour']['count'] >= $limitPerHour) {
        $waitMinutes = ceil(($data['hour']['reset'] - $now) / 60);
        flock($handle, LOCK_UN);
        fclose($handle);
        return ['allowed' => false, 'error' => "Hourly limit ({$limitPerHour}) exceeded. Please wait {$waitMinutes} minutes."];
    }
    
    $data['minute']['count']++;
    $data['hour']['count']++;
    rewind($handle);
    ftruncate($handle, 0);
    fwrite($handle, json_encode($data));
    fflush($handle);
    flock($handle, LOCK_UN);
    fclose($handle);
    
    $remainingHour = $limitPerHour - $data['hour']['count'];
    $remainingMinute = $limitPerMinute - $data['minute']['count'];
    return ['allowed' => true, 'remainingHour' => $remainingHour, 'remainingMinute' => $remainingMinute];
}

function consumeProviderRateLimit($userInfo) {
    global $RATE_LIMIT_DIR;
    $limits = getRateLimitsForUser($userInfo['user_groups'] ?? []);
    return checkRateLimit(
        (int)($userInfo['user_id'] ?? 0),
        $limits['minute'],
        $limits['hour'],
        $RATE_LIMIT_DIR
    );
}

function failChatRequest($message, $status = 400, $code = 'bad_request') {
    header('Content-Type: application/json');
    http_response_code($status);
    echo json_encode(['text' => $message, 'apiCalls' => [], 'debug' => ['error' => $code]]);
    exit;
}

function validateStructuredField($data, $name, $maxBytes, $maxItems = null) {
    if (!array_key_exists($name, $data)) return;
    if (!is_array($data[$name])) failChatRequest("Invalid $name payload", 400, 'invalid_payload');
    if ($maxItems !== null && count($data[$name]) > $maxItems) {
        failChatRequest("$name contains too many items", 413, 'payload_too_large');
    }
    $encoded = json_encode($data[$name]);
    if ($encoded === false || strlen($encoded) > $maxBytes) {
        failChatRequest("$name payload is too large", 413, 'payload_too_large');
    }
}

$rawInput = file_get_contents('php://input');
if (strlen($rawInput) > AI_REQUEST_MAX_BYTES) {
    failChatRequest('Chat request is too large', 413, 'payload_too_large');
}
$data = json_decode($rawInput, true);
if (!is_array($data)) failChatRequest('Invalid JSON request', 400, 'invalid_json');

validateStructuredField($data, 'sitrecDoc', AI_SITREC_DOC_MAX_BYTES, 512);
validateStructuredField($data, 'menuSummary', AI_MENU_SUMMARY_MAX_BYTES, 256);
validateStructuredField($data, 'availableModels', AI_AVAILABLE_MODELS_MAX_BYTES, 2048);
validateStructuredField($data, 'availableDocs', AI_AVAILABLE_DOCS_MAX_BYTES, 256);
validateStructuredField($data, 'toolResults', AI_TOOL_RESULTS_MAX_BYTES, 64);
validateStructuredField($data, 'history', AI_HISTORY_MAX_BYTES, 20);

// The fields below eventually reach trim(), comparisons, or prompt substitution. Reject
// arrays/objects here instead of letting a crafted request trigger PHP 8 TypeErrors later.
foreach (['prompt', 'dateTime', 'simDateTime', 'provider', 'model'] as $stringField) {
    if (array_key_exists($stringField, $data)
        && $data[$stringField] !== null
        && !is_string($data[$stringField])) {
        failChatRequest("Invalid $stringField payload", 400, 'invalid_payload');
    }
}
foreach (['sitrecDoc', 'availableDocs'] as $stringMapField) {
    foreach (($data[$stringMapField] ?? []) as $key => $value) {
        if (!is_string($key) || !is_string($value)) {
            failChatRequest("Invalid $stringMapField entry", 400, 'invalid_payload');
        }
    }
}
foreach (($data['menuSummary'] ?? []) as $menuId => $controls) {
    if (!is_string($menuId) || !is_array($controls)) {
        failChatRequest('Invalid menuSummary entry', 400, 'invalid_payload');
    }
    foreach ($controls as $control) {
        if (!is_string($control)) failChatRequest('Invalid menu control', 400, 'invalid_payload');
    }
}
foreach (($data['availableModels'] ?? []) as $availableModel) {
    if (!is_string($availableModel)) failChatRequest('Invalid availableModels entry', 400, 'invalid_payload');
}
foreach (($data['toolResults'] ?? []) as $toolResult) {
    if (!is_array($toolResult) || !is_string($toolResult['fn'] ?? null)) {
        failChatRequest('Invalid toolResults entry', 400, 'invalid_payload');
    }
}

// Get user info early; the rate limit is consumed immediately before EACH provider call.
$userInfo = getUserInfo();

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
        $pendingState['remainingIterations'],
        // Absent on a session stored by a pre-split deploy: callAnthropic falls back to a
        // single cached block, so an in-flight continuation survives the upgrade.
        $pendingState['systemParts'] ?? null,
        $userInfo,
        $pendingState['specialistTools'] ?? []
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
                'systemParts' => $pendingState['systemParts'] ?? null,
                'logId' => $pendingState['logId'] ?? null,
                'history' => $result['history'],
                'tools' => $result['tools'] ?? $pendingState['tools'],
                'specialistTools' => $result['specialistTools'] ?? ($pendingState['specialistTools'] ?? []),
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

    // A continuation is more provider calls for the SAME user turn, so it reports against
    // the turn's original log row. Without this the initial request was the only one ever
    // costed, hiding up to four further round trips per turn.
    if (!empty($pendingState['logId']) && !empty($result['usage'])) {
        recordAISpend(
            $pendingState['logId'],
            $userInfo['user_id'],
            $pendingState['provider'],
            $pendingState['model'],
            $result['usage']
        );
    }
    unset($result['usage']);
    if (!empty($result['rateLimited'])) http_response_code(429);
    unset($result['tools'], $result['specialistTools'], $result['rateLimited']);

    $result['debug']['sessionContinued'] = true;
    header('Content-Type: application/json');
    echo json_encode($result);
    exit;
}

// A new user turn supersedes any abandoned action-only continuation left in the session.
// The browser intentionally skips that paid confirmation call, so nothing else clears it.
unset($_SESSION['chatbot_pending']);

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

// Resolve the requested model before logging so the row records the provider that actually
// gets billed. Explicit invalid selections fail closed instead of silently spending against
// a different model. Only an absent selection uses the tier default.
$aiModels = getAvailableModels($userInfo['user_groups']);
$selectedProvider = null;
$selectedModel = null;

if (($requestedProvider && !$requestedModel) || (!$requestedProvider && $requestedModel)) {
    failChatRequest('Both provider and model are required', 400, 'invalid_model');
}

if ($requestedProvider === 'auto' && $requestedModel === 'economy') {
    $economy = economyModelFor($aiModels);
    if ($economy) {
        $selectedProvider = $economy['provider'];
        $selectedModel = $economy['model'];
    }
} elseif ($requestedProvider && $requestedModel) {
    foreach ($aiModels as $m) {
        if ($m['provider'] === $requestedProvider && $m['model'] === $requestedModel) {
            $selectedProvider = $requestedProvider;
            $selectedModel = $requestedModel;
            break;
        }
    }
    if (!$selectedProvider) {
        failChatRequest('The selected AI model is not available for this account', 403, 'model_not_allowed');
    }
}

// Fall back to first available model if requested model not allowed
if (!$selectedProvider && !empty($aiModels)) {
    $selectedProvider = $aiModels[0]['provider'];
    $selectedModel = $aiModels[0]['model'];
}

// Log that a provider attempt is about to be possible. Deliberately before the provider
// call, so outages are counted; continuations attach their spend to this same row.
$aiLogId = null;
if (getenv('SITREC_TRACK_STATS') && $selectedProvider) {
    $aiLogId = logAIRequest($userInfo['user_id'], $prompt, $selectedModel, $selectedProvider);
    recordDailyStats(['ai_requests' => 1]);
}

// Build tools array from sitrecDoc (OpenAI format, will convert for Anthropic)
function buildToolsFromDoc($sitrecDoc, $menuSummary) {
    $tools = [];
    $specialistTools = [];

    // Menu function names that we'll add manually with better schemas
    $menuFunctions = ['setMenuValue', 'getMenuValue', 'executeMenuButton', 'listMenus', 'listMenuControls'];

    // SECURITY (B1): never advertise JS-executing functions to the LLM. The client already
    // sends the filtered getLLMDocumentation(), but re-deny here so a tampered/legacy client
    // sending the full doc still can't expose these. Keep in sync with the CSitrecAPI entries
    // tagged llmCallable:false.
    $llmDenied = ['setScriptedVideoScript', 'previewScriptedVideo'];
    $specialistNames = ['createWalker', 'createSynthBuilding', 'createSynthOverlay', 'createSynthClouds'];
    $specialistSummaries = [
        'createWalker' => 'Create an animated object that follows geographic waypoints.',
        'createSynthBuilding' => 'Create a procedural 3D building.',
        'createSynthOverlay' => 'Create a georeferenced synthetic ground overlay.',
        'createSynthClouds' => 'Create a procedural cloud layer.',
    ];

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

        // The "Parameters: ..." tail has now been parsed into JSON Schema properties, each
        // carrying the same descriptive text. Leaving it in the description as well sends
        // every parameter's documentation TWICE — measured at 14,478 bytes (~3,620 tokens,
        // 24% of the whole tool block) across the live tool set. Strip it.
        //
        // Note the regex is deliberately looser than the parse regex above: that one uses
        // (.+) and so never matches the bare "Parameters:" that CSitrecAPI appends to every
        // no-argument function. (.*) here removes those too.
        // Mirrored in src/CDirectLLMClient.js buildTools().
        $tool["function"]["description"] = trim(preg_replace('/\s*Parameters:\s*.*$/is', '', $desc));

        if (in_array($fn, $specialistNames, true)) $specialistTools[$fn] = $tool;
        else $tools[] = $tool;
    }
    
    // Add menu control functions (keep descriptions short - full list is in system prompt).
    //
    // These descriptions deliberately name NO menus. Tools render before the system prompt,
    // so anything per-request in a tool description invalidates the cached prefix for the
    // whole request — and the menu list is per-sitch. The system prompt's menu appendix
    // already names every menu and control, and listMenus/listMenuControls remain callable,
    // so nothing is lost. Mirrored in src/CDirectLLMClient.js buildTools().
    $tools[] = [
        "type" => "function",
        "function" => [
            "name" => "setMenuValue",
            "description" => "Set a menu control's value. Use listMenuControls when you need the exact control path.",
            "parameters" => [
                "type" => "object",
                "properties" => [
                    "menu" => ["type" => "string", "description" => "Menu ID"],
                    "path" => ["type" => "string", "description" => "Control name or path with '/' for nested folders"],
                    // An explicit type UNION, not an omitted type: a stricter consumer
                    // (Ollama's chat template) fails outright on a property with no type.
                    // Mirrors src/CDirectLLMClient.js buildToolSet().
                    "value" => ["type" => ["number", "boolean", "string"], "description" => "New value (number, boolean, or string)"]
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

    if (!empty($specialistTools)) {
        $summaryParts = [];
        foreach (array_keys($specialistTools) as $name) {
            $summaryParts[] = "$name: " . $specialistSummaries[$name];
        }
        $tools[] = [
            "type" => "function",
            "function" => [
                "name" => "discoverSpecialistTools",
                "description" => "Load full schemas for uncommon constructors. " . implode(' ', $summaryParts),
                "parameters" => [
                    "type" => "object",
                    "properties" => [
                        "names" => [
                            "type" => "array",
                            "items" => ["type" => "string", "enum" => array_keys($specialistTools)],
                            "description" => "One or more specialist tool names to enable."
                        ]
                    ],
                    "required" => ["names"]
                ]
            ]
        ];
    }

    return ['tools' => $tools, 'specialistTools' => $specialistTools];
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
        // Provider-reported token counts, normalised to the one shape ai_models.php can
        // price. runToolLoop sums these across iterations; see recordAISpend.
        'usage' => normalizeAIUsage($parsed, 'gemini'),
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

$toolSet = buildToolsFromDoc($sitrecDoc, $menuSummary);
$tools = $toolSet['tools'];
$specialistTools = $toolSet['specialistTools'];

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

// List menu IDs only. The previous debugging cap of 9,999 effectively shipped every one
// of 409 controls (~5,350 tokens) on every call. listMenuControls supplies the exact paths
// on demand, so the fixed prompt only needs the discovery index.
$menuDocForPrompt = "";
if (!empty($menuSummary)) {
    $menuDocForPrompt = "\n\n" . promptSection('menuHeader') . "\n";
    $maxMenus = 128;
    $menuCount = 0;
    foreach ($menuSummary as $menuId => $controls) {
        if (empty($controls)) continue;
        if ($menuCount >= $maxMenus) {
            $menuDocForPrompt .= "  - (more menus available - use listMenus)\n";
            break;
        }
        $menuDocForPrompt .= "\n" . str_replace('{{menuId}}', $menuId, promptSection('menuGroup')) . "\n";
        $menuCount++;
    }
    $menuDocForPrompt .= "\n" . promptSection('menuFooter') . "\n";
}

// The prompt text itself lives in chatbotSystemPrompt.txt (@@SECTION base),
// shared verbatim with the browser BYOK path. See promptSection() above.
//
// ── ASSEMBLED IN STABILITY ORDER, MOST STABLE FIRST ──────────────────────────────────
// Prompt caching is a prefix match, so the ONLY thing that makes the big prefix cacheable
// is putting the parts that never change ahead of the parts that do. Three tiers:
//
//   $systemStatic   base prose + the help-doc index. Identical for every user on a given
//                   build, so one cache entry serves everyone.
//   $systemMenu     the menu appendix. Differs per sitch, but getMenuSummary() reports
//                   STRUCTURE only (control names, types, ranges) — not values — so it is
//                   stable across a user's whole session unless a menu appears/disappears.
//   $systemVolatile the simulation clock, which is the playhead and therefore changes on
//                   almost every message. Nothing cacheable may sit after it.
//
// This ordering is the whole point: simDateTime used to sit on line 8 of the base section,
// 583 bytes into a ~100 KB prefix, so every turn re-wrote the cache and never read it —
// which with cache_control set costs 1.25x rather than the 0.1x a hit would cost.
// Mirror any change here in src/CDirectLLMClient.js buildSystemPromptParts().
// ─────────────────────────────────────────────────────────────────────────────────────
// Sitrec-provided models always retain the topic restriction. The browser's
// own-key/custom-endpoint preference cannot change this server-side prompt.
$systemStatic = str_replace('{{topicScope}}', promptSection('scopeSitrec'), promptSection('base'));

if (!empty($availableDocs)) {
    $systemStatic .= "\n\n" . promptSection('docsHeader') . "\n";
    $docsItem = promptSection('docsItem');
    foreach ($availableDocs as $docName => $description) {
        $systemStatic .= str_replace(
            ['{{name}}', '{{description}}'],
            [$docName, $description],
            $docsItem
        ) . "\n";
    }
    $systemStatic .= "\n" . promptSection('docsFooter') . "\n";
}

$systemMenu = $menuDocForPrompt;

$systemVolatile = "\n\n" . str_replace('{{simDateTime}}', $simDateTime ?? '', promptSection('simTime')) . "\n";

// The single-string form every non-Anthropic provider takes, and what the session stores.
// The order still matters for them: OpenAI and Gemini cache a stable prefix automatically,
// so putting the clock last earns a hit there too even with no explicit breakpoints.
$systemPrompt = $systemStatic . $systemMenu . $systemVolatile;

// The same text, kept split, so callAnthropic can put a breakpoint at each boundary.
$systemParts = ['static' => $systemStatic, 'menu' => $systemMenu, 'volatile' => $systemVolatile];

// A capped response that ran out of room mid-answer comes back with finish_reason
// "length". That is harmless for prose, but NOT for tool calls: the arguments are a JSON
// string, and a truncated one makes json_decode() return null, which the parsers below
// turn into an empty args array — so the tool would RUN with its arguments silently
// missing. Refuse the turn instead. Shared by the three OpenAI-compatible providers.
function refuseIfTruncatedToolCall($parsed, $provider, $model, $httpCode) {
    $choice = $parsed['choices'][0] ?? [];
    if (($choice['finish_reason'] ?? null) !== 'length') return null;
    if (empty($choice['message']['tool_calls'])) return null;
    return [
        'text' => "That answer was cut off before I could finish the action, so I have not run it. Please try a shorter request.",
        'apiCalls' => [],
        'debug' => [
            'provider' => $provider,
            'model' => $model,
            'httpCode' => $httpCode,
            'error' => 'truncated_tool_call',
        ],
    ];
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

    // Cap the output. GPT-5 and the o-series REJECT max_tokens with a 400 and require
    // max_completion_tokens; every model configured in ai_models.php is gpt-5-*, but keep
    // the same guard the temperature and reasoning_effort rules above use so adding an
    // older model does not 400 every request. The cap is 2048 rather than the 1024 used
    // for the other providers because reasoning tokens are billed and counted against it,
    // so a 1024 ceiling can be consumed by reasoning alone and return empty content.
    if (preg_match('/^(gpt-5|o\d)/i', $model)) {
        $requestBody["max_completion_tokens"] = 2048;
    } else {
        $requestBody["max_tokens"] = 2048;
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

    $truncated = refuseIfTruncatedToolCall($parsed, 'openai', $model, $httpCode);
    if ($truncated !== null) return $truncated;

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
        'usage' => normalizeAIUsage($parsed, 'openai'),
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
// $systemParts is the ['static', 'menu', 'volatile'] split built above, used to place the
// cache breakpoints at the stability boundaries. It is optional: a continuation request
// whose session was stored by an older deploy carries only the concatenated $systemPrompt,
// and passing null there reproduces the previous single-block behavior rather than
// erroring. See the block-building comment below.
function callAnthropic($apiKey, $systemPrompt, $history, $tools, $model = 'claude-haiku-4-5-20251001', $systemParts = null) {
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
    // the same three cache_control breakpoints and the same getCurrentDateTime tool /
    // "no wall-clock time in the prompt" convention — keep them aligned.
    // ──────────────────────────────────────────────────────────────────────────────────
    //
    // Prompt caching uses up to three prefix breakpoints here (max 4 allowed). Caching is
    // a prefix match over the rendered request, whose block order is tools -> system ->
    // messages, so a breakpoint caches everything from the START of the prompt up to it —
    // and one byte changing anywhere before a breakpoint invalidates it.
    //
    // The system prompt is therefore sent as up to three blocks in decreasing stability,
    // with a breakpoint at each boundary. Anthropic picks the LONGEST prefix that still
    // matches, so a menu change costs the menu block but still reads the static one:
    //
    //   Breakpoint 1 — static (base prose + help-doc index). Tools render before system,
    //     so this marker caches the whole tools+static prefix, ~21k tokens. It is
    //     byte-identical for every user on a build, so one entry serves everyone.
    //   Breakpoint 2 — menu appendix. Per-sitch, but getMenuSummary() reports structure
    //     and not values, so it holds for a whole session unless a menu appears/disappears.
    //   (no breakpoint) — the simulation clock. It is the playhead, so it changes on almost
    //     every message; nothing cacheable may follow it.
    //
    // This ordering is load-bearing. The clock used to sit on line 8 of the base prose,
    // inside the single cached block, which meant the prefix never repeated: every call
    // paid the 1.25x cache WRITE and never collected a 0.1x read — strictly worse than not
    // caching at all. Empty blocks are omitted because the API rejects empty text blocks.
    $systemBlocks = [];
    if (is_array($systemParts)) {
        foreach ([$systemParts['static'] ?? '', $systemParts['menu'] ?? ''] as $cacheable) {
            if (trim($cacheable) !== '') {
                $systemBlocks[] = ["type" => "text", "text" => $cacheable, "cache_control" => ["type" => "ephemeral"]];
            }
        }
        $volatile = $systemParts['volatile'] ?? '';
        if (trim($volatile) !== '') {
            $systemBlocks[] = ["type" => "text", "text" => $volatile];
        }
    }
    // Older session, or a split that produced nothing: fall back to one cached block.
    if (empty($systemBlocks)) {
        $systemBlocks = [["type" => "text", "text" => $systemPrompt, "cache_control" => ["type" => "ephemeral"]]];
    }

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
        'usage' => normalizeAIUsage($parsed, 'anthropic'),
        'debug' => [
            'provider' => 'anthropic',
            'model' => $model,
            'hasToolCalls' => !empty($calls),
            'toolCallCount' => count($calls),
            'stopReason' => $parsed['stop_reason'] ?? null,
            'httpCode' => $httpCode,
            // Cache verification, and the check to run after touching the system prompt or
            // the tool schema: if cacheReadTokens stays 0 across repeated turns, a silent
            // invalidator has crept back into the prefix. The menu doc is no longer a
            // suspect — it sits in its own block after the first breakpoint — so look for
            // something per-request that moved AHEAD of one, most likely in the tools array
            // (which renders first) or in the static system block.
            // inputTokens is the UNCACHED remainder only — the full prompt size is
            // inputTokens + cacheWriteTokens + cacheReadTokens.
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
            "temperature" => 0.2,
            // Groq accepts max_tokens as a deprecated alias; use the current name.
            "max_completion_tokens" => 1024
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

    $truncated = refuseIfTruncatedToolCall($parsed, 'groq', $model, $httpCode);
    if ($truncated !== null) return $truncated;

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
        'usage' => normalizeAIUsage($parsed, 'groq'),
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
            "temperature" => 0.2,
            // x.ai's OpenAI-compatible endpoint uses max_tokens, not max_completion_tokens.
            "max_tokens" => 1024
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

    $truncated = refuseIfTruncatedToolCall($parsed, 'grok', $model, $httpCode);
    if ($truncated !== null) return $truncated;

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
        'usage' => normalizeAIUsage($parsed, 'grok'),
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
// $systemParts carries the stability split described where it is built; only the Anthropic
// path uses it (the other providers take a single system string). Null is valid and means
// "no split available", which callAnthropic handles by falling back to one cached block.
function runToolLoop($provider, $apiKey, $systemPrompt, $history, $tools, $model, $menuSummary, $availableModels, $availableDocs = [], $maxIterations = 5, $systemParts = null, $userInfo = null, $specialistTools = []) {
    $allApiCalls = [];  // Action calls to send to client
    $debugInfo = [];
    $finalText = '';
    $currentHistory = $history;
    // Token spend for the WHOLE turn. One user message is up to maxIterations provider
    // calls here, and up to 15 across continuations, each re-sending the full prompt -
    // so reporting only the last call's usage would under-report a tool-heavy turn
    // several-fold. Continuations add to this via the caller.
    $turnUsage = emptyAIUsage();
    $rateLimited = false;
    $requiresContinuation = false;
    
    for ($iteration = 0; $iteration < $maxIterations; $iteration++) {
        // One limiter unit buys exactly one provider call. This is deliberately independent
        // of SITREC_TRACK_STATS: disabling analytics must never disable spend protection.
        $rateLimitResult = consumeProviderRateLimit($userInfo ?? []);
        if (!$rateLimitResult['allowed']) {
            $finalText .= ($finalText ? "\n" : '') . $rateLimitResult['error'];
            $debugInfo['iteration_' . $iteration] = ['error' => 'rate_limited'];
            $rateLimited = true;
            break;
        }

        // Call the appropriate provider
        if ($provider === 'anthropic') {
            global $ANTHROPIC_API_KEY;
            $result = callAnthropic($ANTHROPIC_API_KEY, $systemPrompt, $currentHistory, $tools, $model, $systemParts);
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
        
        $turnUsage = addAIUsage($turnUsage, $result['usage'] ?? null);

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
            if ($call['fn'] === 'discoverSpecialistTools') {
                $requested = $call['args']['names'] ?? [];
                if (!is_array($requested)) $requested = [];
                $enabled = [];
                $unknown = [];
                $activeNames = array_column(array_column($tools, 'function'), 'name');
                foreach ($requested as $name) {
                    if (!is_string($name) || !isset($specialistTools[$name])) {
                        $unknown[] = $name;
                        continue;
                    }
                    if (!in_array($name, $activeNames, true)) {
                        $tools[] = $specialistTools[$name];
                        $activeNames[] = $name;
                    }
                    $enabled[] = $name;
                }
                $simResult = ['handled' => true, 'result' => [
                    'success' => empty($unknown) && !empty($enabled),
                    'enabled' => $enabled,
                    'unknown' => $unknown,
                    'available' => array_keys($specialistTools),
                ]];
            } else {
                $simResult = simulateToolCall($call['fn'], $call['args'], $menuSummary, $availableModels, $availableDocs);
            }
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
        
        // Feed locally handled query results into history before deciding whether the
        // browser must execute actions. A model may issue a query and an action together;
        // the old order broke immediately on the action and silently discarded the query
        // result, after which the browser mistook the batch for action-only and skipped the
        // continuation that the query needed.
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

        // Actions have to run in the browser. If this was a mixed query+action batch, tell
        // the client that even successful actions must continue so the model can interpret
        // the query result now stored above.
        if (!empty($pendingActionCalls)) {
            $allApiCalls = array_merge($allApiCalls, $pendingActionCalls);
            $requiresContinuation = !empty($handledCalls);
            break;
        }
    }
    
    return [
        'text' => $finalText,
        'apiCalls' => $allApiCalls,
        'history' => $currentHistory,
        'tools' => $tools,
        'specialistTools' => $specialistTools,
        'usage' => $turnUsage,
        'rateLimited' => $rateLimited,
        'requiresContinuation' => $requiresContinuation,
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
    $result = runToolLoop($selectedProvider, $apiKey, $systemPrompt, $history, $tools, $selectedModel, $menuSummary, $available3DModels, $availableDocs, 5, $systemParts, $userInfo, $specialistTools);

    if (!empty($result['apiCalls'])) {
        $_SESSION['chatbot_pending'] = [
            'provider' => $selectedProvider,
            'systemPrompt' => $systemPrompt,
            'systemParts' => $systemParts,
            'logId' => $aiLogId,
            'history' => $result['history'],
            'tools' => $result['tools'],
            'specialistTools' => $result['specialistTools'],
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

if (!empty($result['rateLimited'])) http_response_code(429);
unset($result['tools'], $result['specialistTools'], $result['rateLimited']);

// What this turn actually cost, from the providers' own reported token counts.
if ($aiLogId !== null && !empty($result['usage'])) {
    recordAISpend($aiLogId, $userInfo['user_id'], $selectedProvider, $selectedModel, $result['usage']);
}
unset($result['usage']);

header('Content-Type: application/json');
echo json_encode($result);
