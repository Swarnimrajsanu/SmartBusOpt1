// SmartBusOpt backend — minimal dependency-free HTTP API (steps 1-2 of the build order).
// Exposes the normalized dataset + data-quality report + honest environment/SUMO status.
// Run: `npm start`  (default http://localhost:8787)

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { SERVER_PORT, PUBLIC_DIR } from "./lib/config.js";
import { getDataset, getStops, getStopById, getUniqueStops } from "./lib/store.js";
import { detectEnvironment } from "./lib/env.js";
import {
  runComparison, listRuns, getRun, latestRunForStop, getCorridorGeoJson,
  SimError,
} from "./lib/simulation.js";

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".geojson": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

// Serve a file from public/ (no directory traversal). Returns true if handled.
function serveStatic(req, res, pathname) {
  let rel = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { error: "forbidden" });
    return true;
  }
  fs.stat(filePath, (err, st) => {
    if (err || !st.isFile()) {
      // SPA-ish fallback to index.html for unknown non-API routes
      const idx = path.join(PUBLIC_DIR, "index.html");
      if (fs.existsSync(idx)) {
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        fs.createReadStream(idx).pipe(res);
      } else {
        sendJson(res, 404, { error: "not found", path: pathname });
      }
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
  });
  return true;
}

// Server-Sent Events helper.
function sseInit(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
}
function sseSend(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === "/api") {
      return sendJson(res, 200, {
        service: "SmartBusOpt API",
        status: "data pipeline + quality report + real SUMO simulation",
        endpoints: [
          "GET /api/health",
          "GET /api/environment",
          "GET /api/stops            (22 observations)",
          "GET /api/stops/unique     (11 stops, observations collapsed)",
          "GET /api/stops/:stopId    (e.g. sequence-005-observation-01)",
          "GET /api/quality          (data-quality report)",
          "GET /api/dataset          (full normalized dataset + provenance)",
          "POST /api/dataset/rebuild (re-read source xlsx)",
          "GET /api/network          (corridor + stops GeoJSON for the map)",
          "GET /api/simulate/:stopId/stream  (SSE: live SUMO current-vs-alternative)",
          "GET /api/runs             (persisted simulation runs)",
          "GET /api/runs/:runId",
          "GET /api/stops/:stopId/runs/latest (last computed recommendation)",
        ],
      });
    }

    if (p === "/api/health") {
      const env = detectEnvironment();
      return sendJson(res, 200, {
        ok: true,
        mode: env.sumo.mode, // REAL_SUMO or DEMO_MODE — never faked
        sumoAvailable: env.sumo.available,
      });
    }

    if (p === "/api/environment") {
      return sendJson(res, 200, detectEnvironment());
    }

    if (p === "/api/stops") {
      return sendJson(res, 200, { count: getStops().length, stops: getStops() });
    }

    if (p === "/api/stops/unique") {
      const stops = getUniqueStops();
      return sendJson(res, 200, { count: stops.length, stops });
    }

    const stopMatch = /^\/api\/stops\/([^/]+)$/.exec(p);
    if (stopMatch) {
      const stopId = decodeURIComponent(stopMatch[1]);
      const stop = getStopById(stopId);
      if (!stop) return sendJson(res, 404, { error: "stop not found", stopId });
      const ds = getDataset();
      const prov = ds.provenance.find((x) => x.stopId === stopId);
      return sendJson(res, 200, { stop, provenance: prov ? prov.fields : null });
    }

    if (p === "/api/quality") {
      return sendJson(res, 200, getDataset().quality);
    }

    if (p === "/api/dataset") {
      return sendJson(res, 200, getDataset());
    }

    if (p === "/api/dataset/rebuild" && req.method === "POST") {
      const ds = getDataset({ forceRebuild: true });
      return sendJson(res, 200, {
        rebuilt: true,
        stops: ds.stops.length,
        corrections: ds.correctionsLog.length,
      });
    }

    // --- Map geometry (§8): real corridor + snapped stops, from the OSM-derived network ---
    if (p === "/api/network") {
      const gj = getCorridorGeoJson();
      if (!gj) {
        return sendJson(res, 404, {
          error: "corridor geojson not built yet",
          hint: "run: /usr/bin/python3 simulation/scripts/sim_build.py prepare && ... geojson",
        });
      }
      return sendJson(res, 200, gj);
    }

    // --- Persisted runs (§2.5, §9) ---
    if (p === "/api/runs") {
      const stopId = url.searchParams.get("stopId");
      return sendJson(res, 200, { runs: listRuns(stopId) });
    }
    const runMatch = /^\/api\/runs\/([^/]+)$/.exec(p);
    if (runMatch) {
      const run = getRun(decodeURIComponent(runMatch[1]));
      if (!run) return sendJson(res, 404, { error: "run not found" });
      return sendJson(res, 200, run);
    }
    const latestMatch = /^\/api\/stops\/([^/]+)\/runs\/latest$/.exec(p);
    if (latestMatch) {
      const stopId = decodeURIComponent(latestMatch[1]);
      const run = latestRunForStop(stopId);
      return sendJson(res, 200, { stopId, run }); // run may be null (never fabricate)
    }

    // --- Live simulation stream (§2.3, §5.6): SSE of real SUMO/TraCI state ---
    const simMatch = /^\/api\/simulate\/([^/]+)\/stream$/.exec(p);
    if (simMatch) {
      const stopId = decodeURIComponent(simMatch[1]);
      const stop = getStopById(stopId);
      if (!stop) return sendJson(res, 404, { error: "stop not found", stopId });
      const force = url.searchParams.get("force") === "1";

      sseInit(res);
      const ac = new AbortController();
      req.on("close", () => ac.abort());

      try {
        await runComparison(stopId, {
          force,
          signal: ac.signal,
          onEvent: (obj) => {
            if (res.writableEnded) return;
            const ev = obj.type === "frame" ? "frame"
              : obj.type === "result" ? "result"
              : obj.type === "stage" ? "stage"
              : obj.type === "scenario" ? "scenario"
              : obj.type === "error" ? "error" : "message";
            sseSend(res, ev, obj);
          },
        });
      } catch (err) {
        const code = err instanceof SimError ? err.code : "SIM_ERROR";
        if (!res.writableEnded) {
          sseSend(res, "error", { type: "error", code, message: err.message });
        }
      } finally {
        if (!res.writableEnded) res.end();
      }
      return;
    }

    // --- Static frontend (§8) ---
    if (!p.startsWith("/api/")) {
      return serveStatic(req, res, p);
    }

    return sendJson(res, 404, { error: "not found", path: p });
  } catch (err) {
    return sendJson(res, 500, { error: String(err && err.message ? err.message : err) });
  }
});

server.listen(SERVER_PORT, () => {
  const env = detectEnvironment();
  console.log(`SmartBusOpt API listening on http://localhost:${SERVER_PORT}`);
  console.log(`  mode: ${env.sumo.mode} (SUMO available: ${env.sumo.available})`);
  if (!env.sumo.available) {
    console.log("  SUMO not detected -> DEMO_MODE. Real simulation disabled; see docs/SUMO_SETUP.md");
  }
});
