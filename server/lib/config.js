// Central configuration for SmartBusOpt.
// Every value that the UI/pipeline surfaces should be traceable back to a rule here.

import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(__dirname, "..", "..");

// --- Source dataset (§4: never silently modify the source file) ---
// 2026-09-24 file replaced by the 24.09.2026 export (same 11 stops × 2 obs layout,
// corrected coordinates for the Chikka Banavara–Bagalagunte segment, no lon outlier).
export const SOURCE_XLSX =
  process.env.SMARTBUSOPT_XLSX ||
  "/Users/swarnimraj/Desktop/jaydwip das bus optimization data 24.09.2026.xlsx";

// Where the normalized (derived) dataset is written. This is a build artifact.
export const GENERATED_DATASET = path.join(
  PROJECT_ROOT,
  "server",
  "data",
  "stops.normalized.generated.json"
);

// --- Header repair (§3.1): the xlsx header row is corrupted by a DataFrame-index export.
// Columns A ('0') and C ('1') are empty junk index columns; B and D have NO header.
// We map by column letter, which is stable, rather than trusting header text.
export const COLUMN_MAP = {
  A: { name: "_junk_index_0", drop: true },
  B: { name: "Bus_Stop_Name", drop: false },
  C: { name: "_junk_index_1", drop: true },
  D: { name: "Sequence", drop: false },
  E: { name: "Latitude_Est", drop: false },
  F: { name: "Longitude_Est", drop: false },
  G: { name: "Road_Width_m", drop: false },
  H: { name: "Distance_to_Next_Stop_m", drop: false },
  I: { name: "Boarding", drop: false }, // header had a trailing space: 'Boarding '
  J: { name: "Alighting", drop: false },
  K: { name: "Passenger_Count", drop: false },
  L: { name: "Peak_Hour_Passengers", drop: false },
  M: { name: "Traffic_Level", drop: false },
  N: { name: "School_Nearby", drop: false },
  O: { name: "College_Nearby", drop: false },
  P: { name: "Industry_Nearby", drop: false },
  Q: { name: "Hospital_Nearby", drop: false },
  R: { name: "Residential_Nearby", drop: false },
  S: { name: "Commercial_Nearby", drop: false },
  T: { name: "Bus_Shelter", drop: false },
  U: { name: "Seating", drop: false },
  V: { name: "Street_Lighting", drop: false },
  W: { name: "Footpath", drop: false },
  X: { name: "Zebra_Crossing", drop: false },
  Y: { name: "Bus_Bay", drop: false },
  Z: { name: "Walking_Distance_m", drop: false },
  AA: { name: "Waiting_Time_min", drop: false },
  AB: { name: "Dwell_Time_sec", drop: false },
  AC: { name: "Population_Density_persons_km2", drop: false },
  AD: { name: "Land_Use", drop: false },
  AE: { name: "Safety_Score_0_100", drop: false },
  AF: { name: "Accessibility_Score_0_100", drop: false },
  AG: { name: "Optimal_Stop", drop: false }, // TARGET — exclude from features (§7)
  AH: { name: "Data_Status", drop: false },
};

// Fields that must never be used as model features (§7): identifiers + target.
export const NON_FEATURE_FIELDS = [
  "Bus_Stop_Name",
  "Sequence",
  "Optimal_Stop",
  "Data_Status",
  "Latitude_Est",
  "Longitude_Est",
];

// --- Coordinate corrections (§3.3) ---
// The 2026-09-24 file had Sapthagiri Hospital lon 77.1485 (a ~43km outlier, fixed to
// 77.5485 with approval). The 24.09.2026 file already carries plausible coordinates for
// every stop (verified: all 22 rows inside STUDY_AREA), so no correction is applied.
// Entries here must name an approving decision before any value is rewritten (§4/§11).
export const COORDINATE_CORRECTIONS = [];

// --- Study area (§5.2). Chikka Banavara–Bagalagunte segment bbox for the 24.09.2026
// dataset (observed cluster: lat 13.0461–13.0811, lon 77.5023–77.5079, plus margin). ---
export const STUDY_AREA = {
  WEST: 77.5,
  SOUTH: 13.044,
  EAST: 77.511,
  NORTH: 13.083,
};

// --- Provenance vocabulary (§4). Every value carries one of these source types. ---
export const PROVENANCE = {
  SOURCED: "sourced", // stop name + sequence (real, per Data_Status)
  SYNTHETIC: "synthetic", // all other dataset numbers (Data_Status: synthetic/estimated)
  CORRECTED: "corrected", // value we explicitly repaired (see COORDINATE_CORRECTIONS)
  DERIVED: "derived", // computed by our pipeline
  MODEL_PREDICTION: "model_prediction", // ML suitability score (never the final verdict)
  SUMO_GENERATED: "sumo_generated", // real microsimulation output (only if SUMO available)
};

export const SERVER_PORT = Number(process.env.PORT || 8787);

// --- Simulation artifacts (§5). Paths the backend reads to serve the map + run scenarios. ---
export const SIM_ROOT = path.join(PROJECT_ROOT, "simulation");
export const SIM_NETWORK = path.join(SIM_ROOT, "network", "bengaluru.net.xml");
export const SIM_CORRIDOR_GEOJSON = path.join(SIM_ROOT, "config", "corridor.geojson");
export const SIM_CORRIDOR_JSON = path.join(SIM_ROOT, "config", "corridor.json");
export const SIM_STOP_EDGES = path.join(SIM_ROOT, "config", "stop_edges.json");
export const SIM_SCENARIOS = path.join(SIM_ROOT, "scenarios");
export const SIM_BUILD_PY = path.join(SIM_ROOT, "scripts", "sim_build.py");
export const SIM_TRACI_BRIDGE_PY = path.join(SIM_ROOT, "scripts", "traci_bridge.py");
// Persisted simulation runs (§2.5, §9 reproducibility).
export const RUNS_DB = path.join(PROJECT_ROOT, "server", "data", "runs.generated.json");
// Static frontend served by the backend (§8).
export const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");

// Simulation pacing for the live stream (§2.3 must be visibly running, not instantaneous).
export const SIM_EMIT_EVERY_SEC = Number(process.env.SIM_EMIT_EVERY || 15); // sim-seconds per frame
export const SIM_STREAM_FPS = Number(process.env.SIM_FPS || 15); // wall-clock frames/sec
