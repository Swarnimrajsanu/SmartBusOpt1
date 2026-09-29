// Data access layer: loads the generated dataset, rebuilding from the source xlsx if needed.
// Cloud-deploy note: if stops.normalized.generated.json is committed to the repo, the server
// will use it directly on Render/Railway without needing the source xlsx to be present.

import fs from "node:fs";
import { GENERATED_DATASET, SOURCE_XLSX } from "./config.js";
import { buildDataset } from "./buildDataset.js";

let cache = null;

export function getDataset({ forceRebuild = false } = {}) {
  if (cache && !forceRebuild) return cache;

  // Use the pre-built JSON if it exists (cloud deploy path — xlsx may not be present).
  if (!forceRebuild && fs.existsSync(GENERATED_DATASET)) {
    cache = JSON.parse(fs.readFileSync(GENERATED_DATASET, "utf8"));
    return cache;
  }

  // Rebuild from xlsx. Fail clearly if the source file is missing.
  if (!fs.existsSync(SOURCE_XLSX)) {
    const msg =
      `Source xlsx not found: ${SOURCE_XLSX}\n` +
      `Set the SMARTBUSOPT_XLSX env var to the correct path, or run \`npm run load-data\` locally ` +
      `and commit server/data/stops.normalized.generated.json.`;
    throw new Error(msg);
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
