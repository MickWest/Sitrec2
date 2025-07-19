<?php

require_once __DIR__ . '/config.php';
require_once __DIR__ . '/config_paths.php';

// Load API key from environment or config
$OPENAI_API_KEY = getenv("OPENAI_API");

$S3 = getenv("S3_ACCESS_KEY_ID");

$data = json_decode(file_get_contents('php://input'), true);
$prompt = $data['prompt'] ?? '';
$sitrecDoc = $data['sitrecDoc'] ?? [];

$systemPrompt = <<<EOT
You are a helpful assistant for the Sitrec app.

You can answer questions about Sitrec and issue JSON API calls.

You must:
- Only respond with plain text and a list of API calls at the end.
- Not discuss anything unrelated to Sitrec, including people, events, or politics.
- Stay focused on satellite tracking, astronomy, ADS-B, and related tools.
- Show your work and reasoning in the text for each parameter and choice of API call.
- Return your API calls in a JSON block with this example structure:

```json
{
  "apiCalls": [
    { "fn": "gotoLLA", "args": [ ...arguments for the call ....] }
  ]
}
Do not return anything except the plain text explanation and the JSON block at the end of your response.

Available API functions (function name followed by description and parameter list):
EOT;

$systemPrompt .= ":\n\n";

foreach ($sitrecDoc as $fn => $desc) {
    $systemPrompt .= "- {$fn}: {$desc}\n";
}

$messages = [
    ["role" => "system", "content" => $systemPrompt],
    ["role" => "user", "content" => $prompt]
];

// Call OpenAI
$ch = curl_init("https://api.openai.com/v1/chat/completions");
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_POST => true,
    CURLOPT_HTTPHEADER => [
        "Authorization: Bearer $OPENAI_API_KEY",
        "Content-Type: application/json"
    ],
    CURLOPT_POSTFIELDS => json_encode([
        "model" => "gpt-4o",
        "messages" => $messages,
        "temperature" => 0.2
    ])
]);

$response = curl_exec($ch);
curl_close($ch);

$parsed = json_decode($response, true);
$content = $parsed['choices'][0]['message']['content'] ?? '';

$text = '';
$calls = [];

// Extract JSON block if present and remove it from content
$calls = [];
if (preg_match('/```json\s*(\{.*?\})\s*```/s', $content, $matches)) {
    $json = json_decode($matches[1], true);
    if (isset($json['apiCalls'])) {
        $calls = $json['apiCalls'];
    }
    // Remove JSON block from content
    $content = preg_replace('/```json\s*\{.*?\}\s*```/s', '', $content);
}

$text = trim($content);

header('Content-Type: application/json');
echo json_encode([
    'text' => $text,
    'apiCalls' => $calls
]);
