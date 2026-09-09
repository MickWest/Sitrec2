#!/usr/bin/env python3
"""Read-only frontend artifact server. Backend routes are never served here."""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import os
import re

ROOT = Path(os.environ.get('SITREC_FRONTEND_ROOT', '/srv/frontend')).resolve()


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def allowed(self):
        path = unquote(urlsplit(self.path).path)
        parts = path.split('/')
        if '\\' in path or any(p in ('.', '..') for p in parts):
            return False
        if not re.fullmatch(r'/builds/[a-z0-9][a-z0-9-]{0,95}/.+', path):
            return False
        if any(p.startswith('.') or p in ('sitrecServer', 'config', 'private', 'node_modules') for p in parts if p):
            return False
        candidate = ROOT / path.lstrip('/')
        if candidate.suffix.lower() in ('.php', '.py', '.sh', '.env', '.map'):
            return False
        return candidate.resolve().is_relative_to(ROOT) and candidate.is_file()

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
