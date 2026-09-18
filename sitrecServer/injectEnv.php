<?php
$filename = '../shared.env.php';

if (!file_exists($filename)) {
    // Log the error but don't die - this allows the application to continue
    error_log("Warning: File '$filename' not found. Environment variables will not be loaded.");
    return;
}

if (!function_exists('sitrecStripEnvComment')) {
    // One line with its comment removed and its ends trimmed. A '#' starts a comment
    // only outside quotes, and only at the start of the line or after whitespace, so
    // BANNER_COLOR="#FFFFFF" and URL=https://host/page#top keep their '#'. A quote
    // opens only at the start of the value (the apostrophe in It's is plain text), and
    // a quote that never closes keeps the whole line. The same rule as
    // scripts/envFile.js, which the build uses to read the same file; keep them in step.
    function sitrecStripEnvComment($line) {
        $len = strlen($line);
        $start = -1; // first character of the value
        $eq = strpos($line, '=');
        if ($eq !== false) {
            $start = $eq + 1;
            while ($start < $len && ($line[$start] === ' ' || $line[$start] === "\t")) {
                $start++;
            }
        }
        $quote = null;
        for ($i = 0; $i < $len; $i++) {
            $ch = $line[$i];
            if ($quote !== null) {
                if ($ch === '\\' && $quote === '"') {
                    $i++; // skip the escaped character
                } elseif ($ch === $quote) {
                    $quote = null;
                }
            } elseif (($ch === '"' || $ch === "'") && $i === $start) {
                $quote = $ch;
            } elseif ($ch === '#' && ($i === 0 || ctype_space($line[$i - 1]))) {
                return trim(substr($line, 0, $i));
            }
        }
        return trim($line);
    }
}

// Read the file line by line, ignoring empty lines
$lines = file($filename, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);

foreach ($lines as $line) {
    // Remove any comment and the whitespace around what is left
    $line = sitrecStripEnvComment($line);

    // Skip the line if it was a comment or empty
    if ($line === '') {
        continue;
    }

    // Split the line into key and value on the first '=' found
    $parts = explode('=', $line, 2);
    if (count($parts) != 2) {
        // not a line with a single '=', so skip it
        // this will skip the <?php tag and the php /* .... */ multi-line comment
        // that is automatically added to the shared.env file by webpackCopyPatterns.js

        // Optionally log or handle malformed lines here
        continue;
    }

    $key = trim($parts[0]);
    $value = trim($parts[1]);

    // Remove wrapping quotes (either single or double) if they exist
    if (strlen($value) >= 2 &&
       (($value[0] === '"' && $value[strlen($value) - 1] === '"') ||
        ($value[0] === "'" && $value[strlen($value) - 1] === "'"))) {
        $value = substr($value, 1, -1);
    } else {
        // check for boolean values
        if (strtolower($value) === 'true') {
            $value = true;
        } elseif (strtolower($value) === 'false') {
            $value = false;
        } elseif (is_numeric($value)) {
            // check for numeric values, including integers and floats
            $value = $value + 0;
        }
    }

    // Inject the environment variable
    putenv("$key=$value");
    // Optionally, also set it in $_ENV and $_SERVER for broader availability
//    $_ENV[$key] = $value;
//    $_SERVER[$key] = $value;
}
?>
