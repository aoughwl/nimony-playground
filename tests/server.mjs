// server.mjs — the tiny static server the harness serves the playground from.
// Same-origin is required (the pipeline spawns `new Worker("worker.js")`).
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".json": "application/json", ".css": "text/css", ".wasm": "application/wasm",
  ".bin": "application/octet-stream", ".png": "image/png", ".ico": "image/x-icon",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json" };

export function serve(root, port = 0) {
  const srv = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(req.url.split("?")[0]);
      if (p === "/" || p === "") p = "/index.html";
      const file = join(root, normalize(p).replace(/^(\.\.[/\\])+/, ""));
      const st = await stat(file).catch(() => null);
      if (!st || !st.isFile()) { res.writeHead(404); res.end("not found"); return; }
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream",
                           "cache-control": "no-store" });
      res.end(body);
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise(resolve => srv.listen(port, "127.0.0.1", () => resolve({ srv, port: srv.address().port })));
}
