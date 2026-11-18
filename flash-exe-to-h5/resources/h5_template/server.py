#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
High-concurrency local HTTP server for H5 courseware:
- Disables Windows Console QuickEdit Mode so clicking the terminal never freezes the server
- Enlarges TCP listen backlog (request_queue_size = 128) to handle 200+ SVG fetches cleanly
- Always returns 200 OK with Content-Length (avoids 304 cache stalls)
- Supports HTTP Range (206 Partial Content) for smooth MP4/MP3 streaming
- Suppresses harmless ConnectionAbortedError / BrokenPipeError when browser aborts media streams
"""

import ctypes
import os
import re
import socket
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


def disable_windows_quickedit():
    if os.name != "nt":
        return
    try:
        kernel32 = ctypes.windll.kernel32
        stdin_handle = kernel32.GetStdHandle(-10)  # STD_INPUT_HANDLE
        mode = ctypes.c_uint32()
        if kernel32.GetConsoleMode(stdin_handle, ctypes.byref(mode)):
            new_mode = (mode.value & ~0x0040) | 0x0080
            kernel32.SetConsoleMode(stdin_handle, new_mode)
    except Exception:
        pass


class H5RequestHandler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def handle(self):
        try:
            super().handle()
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError, TimeoutError):
            pass

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def do_GET(self):
        if self.path.startswith("/favicon.ico"):
            self.send_response(204)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return

        for hdr in ("If-Modified-Since", "If-None-Match"):
            if hdr in self.headers:
                del self.headers[hdr]

        path = self.translate_path(self.path)
        if os.path.isfile(path) and "Range" in self.headers:
            self._serve_range(path)
            return

        try:
            super().do_GET()
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True

    def _serve_range(self, path: str):
        try:
            file_size = os.path.getsize(path)
            range_hdr = self.headers.get("Range", "")
            m = re.match(r"bytes=(\d*)-(\d*)", range_hdr)
            if not m:
                super().do_GET()
                return

            start_s, end_s = m.group(1), m.group(2)
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else file_size - 1
            if start >= file_size or start > end:
                self.send_error(416, "Requested Range Not Satisfiable")
                return
            end = min(end, file_size - 1)
            length = end - start + 1

            ctype = self.guess_type(path)
            self.send_response(206, "Partial Content")
            self.send_header("Content-Type", ctype)
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Range", f"bytes {start}-{end}/{file_size}")
            self.send_header("Content-Length", str(length))
            self.end_headers()

            with open(path, "rb") as f:
                f.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = f.read(min(65536, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (ConnectionAbortedError, BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True


class DualStackH5Server(ThreadingHTTPServer):
    request_queue_size = 128
    allow_reuse_address = True
    daemon_threads = True

    def server_bind(self):
        if self.address_family == socket.AF_INET6:
            try:
                self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            except Exception:
                pass
        return super().server_bind()

    def handle_error(self, request, client_address):
        exc = sys.exc_info()[1]
        if isinstance(exc, (ConnectionAbortedError, BrokenPipeError, ConnectionResetError, TimeoutError)):
            return
        super().handle_error(request, client_address)


def create_server(port: int):
    if socket.has_ipv6:
        try:
            DualStackH5Server.address_family = socket.AF_INET6
            return DualStackH5Server(("::", port), H5RequestHandler)
        except Exception:
            pass
    DualStackH5Server.address_family = socket.AF_INET
    return DualStackH5Server(("0.0.0.0", port), H5RequestHandler)


def main():
    disable_windows_quickedit()
    port = int(sys.argv[1]) if len(sys.argv) >= 2 else 8080
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = create_server(port)
    print(f"[H5 Server] Serving {os.getcwd()} at http://localhost:{port}/index.html")
    print("[H5 Server] Press Ctrl+C to stop.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[H5 Server] Stopped.")


if __name__ == "__main__":
    main()
