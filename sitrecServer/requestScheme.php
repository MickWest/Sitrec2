<?php
/*
 * Normalise $_SERVER['REQUEST_SCHEME'] so every URL built from it matches the page in the
 * browser.
 *
 * The PHP built-in server does not set it at all. Behind a reverse proxy that terminates TLS
 * (Caddy, nginx, a load balancer, an ingress) the web server is spoken to over plain HTTP, so
 * it reports "http" while the page is https://. Every URL built from it - the cache
 * redirects, the upload and terrain paths, the CORS origin - would then be http://, which the
 * browser refuses to use from an https:// page. Such a proxy reports the real scheme in
 * X-Forwarded-Proto, so the scheme is taken from that header when it is present.
 *
 * Only the scheme. REMOTE_ADDR is deliberately left alone: the localhost rule in config.php
 * grants administrator rights, so a client-supplied address must never reach it.
 *
 * Required first by config_paths.php, and directly by the endpoints that build their CORS
 * origin before they load config_paths.php.
 */
if (!isset($_SERVER['REQUEST_SCHEME'])) {
    $_SERVER['REQUEST_SCHEME'] = 'http';
}
$forwardedProto = strtolower(trim($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? ''));
if ($forwardedProto === 'https' || $forwardedProto === 'http') {
    $_SERVER['REQUEST_SCHEME'] = $forwardedProto;
}
unset($forwardedProto);
