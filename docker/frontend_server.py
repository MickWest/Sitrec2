#!/usr/bin/env python3
"""Read-only frontend artifact server. Backend routes are never served here."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit
import os
import re

ROOT = os.path.realpath(os.environ.get('SITREC_FRONTEND_ROOT', '/srv/frontend'))
ROOT_PREFIX = os.path.join(ROOT, '')


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def allowed(self):
        path = unquote(urlsplit(self.path).path)
        parts = path.split('/')
        if '\\' in path or any(p in ('.', '..') for p in parts):
            return False
        if not re.fullmatch(r'/builds/[a-z0-9][a-z0-9-]{0,95}/.+', path):
            return False
        if any(p.startswith('.') or p in ('sitrecServer', 'config', 'private', 'node_modules') for p in parts if p):
            return False
        if os.path.splitext(path)[1].lower() in ('.php', '.py', '.sh', '.env', '.map'):
            return False
        # Normalize first, then check containment on the string, and only then touch
        # the file system. realpath follows symlinks, so a link out of ROOT is refused.
        candidate = os.path.realpath(os.path.join(ROOT, path.lstrip('/')))
        return candidate.startswith(ROOT_PREFIX) and os.path.isfile(candidate)

    def do_GET(self):
        if self.path == '/healthz':
            self.send_response(200)
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'ok\n')
        elif self.allowed():
            super().do_GET()
        else:
            self.send_error(404)

    def do_HEAD(self):
        if self.allowed():
            super().do_HEAD()
        else:
            self.send_error(404)

    def end_headers(self):
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'public, max-age=31536000, immutable' if self.allowed() else 'no-store')
        super().end_headers()


if __name__ == '__main__':
    ThreadingHTTPServer(('0.0.0.0', int(os.environ.get('PORT', '8080'))), Handler).serve_forever()
