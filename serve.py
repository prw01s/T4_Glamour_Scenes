"""
serve.py - the local development server (started by serve.sh).

A static file server for this folder with HTTP byte-range support, which
<video> needs for seeking and looping. It replaces `ruby -run -ehttpd`, whose
WEBrick server answered the browser's conditional range requests for cached
videos with "304 Not Modified" and no data, which broke playback after a few
reloads ("PIPELINE_ERROR_READ: FFmpegDemuxer: data source error").

Every response is sent with Cache-Control: no-store, so the browser never
revalidates (no conditional requests at all) and edited files are always
fresh. Standard library only.

Usage: python3 serve.py [port]   (default 8000)
"""
import http.server
import os
import re
import sys

RANGE = re.compile(r"bytes=(\d*)-(\d*)$")


class Handler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        self.send_header("Accept-Ranges", "bytes")
        super().end_headers()

    def send_head(self):
        """Serves a single byte range (206) when asked; otherwise the default."""
        m = RANGE.match(self.headers.get("Range", "").strip())
        path = self.translate_path(self.path)
        if not m or not os.path.isfile(path):
            return super().send_head()
        size = os.path.getsize(path)
        first, last = m.groups()
        if first == "":                       # "bytes=-N": the last N bytes
            start, end = max(0, size - int(last or 0)), size - 1
        else:
            start, end = int(first), min(int(last) if last else size - 1, size - 1)
        if start >= size or start > end:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.end_headers()
            return None
        f = open(path, "rb")
        f.seek(start)
        self.send_response(206)
        self.send_header("Content-Type", self.guess_type(path))
        self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Content-Length", str(end - start + 1))
        self.end_headers()
        self._remaining = end - start + 1
        return f

    def copyfile(self, source, outputfile):
        remaining = getattr(self, "_remaining", None)
        if remaining is None:
            return super().copyfile(source, outputfile)
        self._remaining = None
        try:
            while remaining > 0:
                chunk = source.read(min(64 * 1024, remaining))
                if not chunk:
                    break
                outputfile.write(chunk)
                remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass                              # the browser cancelled the range: normal for <video>


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    Handler.extensions_map[".glsl"] = "text/plain"
    print(f"Serving {os.getcwd()} at http://localhost:{port}/")
    http.server.ThreadingHTTPServer(("", port), Handler).serve_forever()
