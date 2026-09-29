// Simulation orchestration (§2, §5.5, §5.6, §9).
// Builds a CURRENT vs ALTERNATIVE scenario for a stop, runs both through the Python TraCI
// bridge, and streams real SUMO state to a callback. Persists each run for reproducibility.
//
// HARD RULES (§11): every number emitted here comes from SUMO/TraCI or the GIS candidate
// computation. If SUMO is unavailable we throw — we never fabricate traffic or a result.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  SIM_SCENARIOS, SIM_BUILD_PY, SIM_TRACI_BRIDGE_PY, SIM_CORRIDOR_JSON,
  SIM_EMIT_EVERY_SEC, SIM_STREAM_FPS, RUNS_DB,
} from "./config.js";
import { sumoChildEnv } from "./sumoEnv.js";

export class SimError extends Error {
  constructor(message, code = "SIM_ERROR") {
    super(message);
    this.code = code;
  }
}

function readJsonIfExists(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

// The 7 stages the UI stepper must show (§2.3), in order.
export const STAGES = [
  "Preparing network",
  "Loading scenario",
  "Starting SUMO",
  "Generating traffic",
  "Running simulation (current)",
  "Running simulation (alternative)",
  "Collecting metrics",
  "Completed",
];

// Ensure a scenario pair exists for stopId; build it if missing (or force=true).
export function ensureScenario(stopId, { force = false } = {}) {
  const ctx = sumoChildEnv();
  if (!ctx.available) {
    throw new SimError(
      "SUMO is not available on this machine, so a real scenario cannot be built or run. " +
      "The app must show DEMO MODE and must not fabricate a result (§2.6, §11).",
      "SUMO_UNAVAILABLE"
    );
  }
  if (!ctx.pythonXmlOk) {
    throw new SimError(
      "No Python with a working XML parser was found (needed for SUMO tools/TraCI). " +
      "Set SUMO_PYTHON to a working interpreter. See docs/SUMO_SETUP.md.",
      "PYTHON_XML_BROKEN"
    );
  }
  const dir = path.join(SIM_SCENARIOS, stopId);
  const manifestPath = path.join(dir, "manifest.json");
  const curCfg = path.join(dir, "current", "scenario.sumocfg");
  const altCfg = path.join(dir, "alternative", "scenario.sumocfg");

  if (!force && fs.existsSync(manifestPath) && fs.existsSync(curCfg) && fs.existsSync(altCfg)) {
    return { dir, manifest: readJsonIfExists(manifestPath), built: false };
  }

  const res = spawnSync(ctx.python, [SIM_BUILD_PY, "scenario", stopId], {
    env: ctx.env, encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new SimError(
      `scenario build failed for ${stopId}: ${(res.stderr || res.stdout || "").trim()}`,
      "SCENARIO_BUILD_FAILED"
    );
  }
  const manifest = readJsonIfExists(manifestPath);
  if (!manifest || !fs.existsSync(curCfg) || !fs.existsSync(altCfg)) {
    throw new SimError(`scenario build produced no usable config for ${stopId}`, "SCENARIO_MISSING");
  }
  return { dir, manifest, built: true };
}

// Run one scenario (current|alternative) via the bridge, forwarding parsed JSON events.
// Returns a promise resolving to the "done" message (with measured metrics).
function runBridge(cfgPath, label, ctx, { recommendedStop, duration, onEvent, signal }) {
  return new Promise((resolve, reject) => {
    const args = [
      SIM_TRACI_BRIDGE_PY,
      "--config", cfgPath,
      "--label", label,
      "--emit-every", String(SIM_EMIT_EVERY_SEC),
      "--fps", String(SIM_STREAM_FPS),
    ];
    if (duration) args.push("--duration", String(duration));
    if (recommendedStop) args.push("--recommended-stop", recommendedStop);

    const child = spawn(ctx.python, args, { env: ctx.env });
    if (signal) {
      signal.addEventListener("abort", () => {
        try { child.kill("SIGTERM"); } catch { /* already gone */ }
      });
    }

    let buf = "";
    let doneMsg = null;
    let errMsg = null;

    child.stdout.on("data", (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        if (obj.type === "done") doneMsg = obj;
        else if (obj.type === "error") errMsg = obj;
        if (onEvent) onEvent(obj);
      }
    });
    child.stderr.on("data", () => { /* bridge writes traci retry noise here; ignore */ });
    child.on("error", (e) => reject(new SimError(`bridge spawn failed: ${e.message}`, "BRIDGE_SPAWN_FAILED")));
    child.on("close", (code) => {
      if (errMsg) return reject(new SimError(errMsg.message || "bridge reported an error", "BRIDGE_ERROR"));
      if (code !== 0 && !doneMsg) {
        return reject(new SimError(`bridge exited with code ${code}`, "BRIDGE_EXIT"));
      }
      resolve(doneMsg);
    });
  });
}

// Compute walking-distance comparison (GIS/derived, NOT SUMO) for the results card.
// Distance from the stop's source coordinate to current vs alternative snapped location.
function walkingComparison(manifest) {
  const sel = manifest.selected;
  const cand = manifest.candidate;
  const out = { provenance: "derived (GIS)", unit: "m" };
  if (sel && typeof sel.distanceToRoadM === "number") {
    out.currentWalkToRoadM = Math.round(sel.distanceToRoadM);
  }
  if (cand && sel) {
    // candidate is on the corridor; walking distance proxy = how far the relocation moves
    // the stop along/across the network from the source demand point.
    const R = 6371000;
    const toRad = (d) => (d * Math.PI) / 180;
    if (cand.lat && cand.lon && sel.lat && sel.lon) {
      const dLat = toRad(cand.lat - sel.lat);
      const dLon = toRad(cand.lon - sel.lon);
      const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(sel.lat)) * Math.cos(toRad(cand.lat)) * Math.sin(dLon / 2) ** 2;
      out.alternativeWalkToRoadM = Math.round(2 * R * Math.asin(Math.sqrt(a)));
      out.relocationShiftM = cand.shiftAlongCorridorM;
    }
  }
  return out;
}

// Run the full current-vs-alternative comparison for a stop, streaming events.
// onEvent(stage|frame|done|...) is called for every SSE-worthy message.
export async function runComparison(stopId, { onEvent, force = false, signal } = {}) {
  const ctx = sumoChildEnv();
  const emit = (obj) => { if (onEvent) onEvent(obj); };

  emit({ type: "stage", stage: "Preparing network", detail: "checking SUMO + network availability" });
  const { dir, manifest, built } = ensureScenario(stopId, { force });

  emit({ type: "stage", stage: "Loading scenario", detail: built ? "built current + alternative scenarios" : "reusing cached scenarios" });
  emit({ type: "scenario", stopId, manifest });

  const cand = manifest.candidate;
  const recommendedStop = cand && cand.laneId ? cand.laneId : null;

  // Downsampled live telemetry per scenario, for the run-report time series (§9).
  // Every point is a SUMO/TraCI frame metric — same data the SSE stream carries.
  const series = { current: [], alternative: [] };
  const captureSeries = (label) => (obj) => {
    emit(obj);
    if (obj.type === "frame" && obj.label === label && obj.metrics) {
      const m = obj.metrics;
      series[label].push({
        t: obj.simulationTime,
        v: m.activeVehicles ?? null,
        h: m.haltingVehicles ?? null,
        b: m.buses ?? null,
        s: m.avgSpeedMs ?? null,
        q: m.maxQueueLength ?? null,
      });
    }
  };

  emit({ type: "stage", stage: "Starting SUMO", detail: "launching headless SUMO via TraCI" });
  emit({ type: "stage", stage: "Generating traffic", detail: `synthetic demand (randomTrips, seed 42), ${manifest.simDuration}s` });

  emit({ type: "stage", stage: "Running simulation (current)", detail: "current stop location" });
  const curCfg = path.join(dir, "current", "scenario.sumocfg");
  const curDone = await runBridge(curCfg, "current", ctx, {
    recommendedStop: null, duration: manifest.simDuration, onEvent: emit, signal,
  });

  emit({ type: "stage", stage: "Running simulation (alternative)", detail: cand ? "recommended relocated stop" : "no feasible candidate — mirrors current" });
  const altCfg = path.join(dir, "alternative", "scenario.sumocfg");
  const altDone = await runBridge(altCfg, "alternative", ctx, {
    recommendedStop, duration: manifest.simDuration, onEvent: emit, signal,
  });

  emit({ type: "stage", stage: "Collecting metrics", detail: "aggregating SUMO tripinfo" });

  const walk = walkingComparison(manifest);
  const result = {
    stopId,
    stopName: manifest.selected ? manifest.selected.name : stopId,
    alternativeFeasible: manifest.alternativeFeasible !== false && !!cand,
    candidate: cand,
    candidateProvenance: manifest.candidateProvenance,
    simDuration: manifest.simDuration,
    seed: 42,
    networkProvenance: manifest.network ? manifest.network.provenance : "OSM-derived",
    demandProvenance: manifest.demand ? manifest.demand.provenance : "synthetic",
    walking: walk,
    current: curDone ? curDone.measured : null,
    alternative: altDone ? altDone.measured : null,
    completedAt: new Date().toISOString(),
  };
  if (!result.alternativeFeasible) {
    result.note = manifest.note ||
      "No feasible relocation candidate; alternative mirrors current. Not an improvement (§2.2).";
  }

  const runId = persistRun(result);
  result.runId = runId;

  emit({ type: "stage", stage: "Completed", detail: "both runs finished" });
  emit({ type: "result", result });
  return result;
}

// --- Run persistence (§2.5, §9) ---
function loadRuns() {
  return readJsonIfExists(RUNS_DB) || { runs: [] };
}

export function persistRun(result) {
  const db = loadRuns();
  const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.runs.unshift({ runId, ...result });
  db.runs = db.runs.slice(0, 50); // keep last 50
  fs.mkdirSync(path.dirname(RUNS_DB), { recursive: true });
  fs.writeFileSync(RUNS_DB, JSON.stringify(db, null, 2));
  return runId;
}

export function listRuns(stopId = null) {
  const db = loadRuns();
  return stopId ? db.runs.filter((r) => r.stopId === stopId) : db.runs;
}

export function getRun(runId) {
  const db = loadRuns();
  return db.runs.find((r) => r.runId === runId) || null;
}

export function latestRunForStop(stopId) {
  const runs = listRuns(stopId);
  return runs.length ? runs[0] : null;
}

// Corridor + stops geojson for the map (§8).
export function getCorridorGeoJson() {
  const g = readJsonIfExists(path.join(path.dirname(SIM_CORRIDOR_JSON), "corridor.geojson"));
  return g;
}
