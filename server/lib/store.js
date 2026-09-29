// Data access layer: loads the generated dataset, rebuilding from the source xlsx if needed.

import fs from "node:fs";
import { GENERATED_DATASET } from "./config.js";
import { buildDataset } from "./buildDataset.js";

let cache = null;

export function getDataset({ forceRebuild = false } = {}) {
  if (cache && !forceRebuild) return cache;
  if (!forceRebuild && fs.existsSync(GENERATED_DATASET)) {
    cache = JSON.parse(fs.readFileSync(GENERATED_DATASET, "utf8"));
    return cache;
  }
  cache = buildDataset();
  return cache;
}

export function getStops() {
  return getDataset().stops;
}

export function getStopById(stopId) {
  return getDataset().stops.find((s) => s.Stop_Id === stopId) || null;
}

// Unique stops (collapse the 2 observations), keeping both observations attached.
export function getUniqueStops() {
  const ds = getDataset();
  const byName = new Map();
  for (const s of ds.stops) {
    if (!byName.has(s.Bus_Stop_Name)) {
      byName.set(s.Bus_Stop_Name, {
        name: s.Bus_Stop_Name,
        sequence: s.Sequence,
        observations: [],
      });
    }
    byName.get(s.Bus_Stop_Name).observations.push(s);
  }
  return [...byName.values()];
}
