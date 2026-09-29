// Build the normalized dataset + quality report from the source xlsx.
// Run: `npm run load-data`. Writes server/data/stops.normalized.generated.json
// The source workbook is only ever READ, never modified (§4).

import fs from "node:fs";
import path from "node:path";
import { readXlsx } from "./xlsxReader.js";
import { normalizeRows } from "./normalize.js";
import { buildQualityReport } from "./quality.js";
import { SOURCE_XLSX, GENERATED_DATASET } from "./config.js";

export function buildDataset() {
  const { rows, sheetEntry } = readXlsx(SOURCE_XLSX);
  const { observations, correctionsLog, seenHeaderRows } = normalizeRows(rows);
  const quality = buildQualityReport({ observations, correctionsLog, seenHeaderRows });

  const dataset = {
    meta: {
      source: SOURCE_XLSX,
      sheetEntry,
      builtAt: new Date().toISOString(),
      builder: "server/lib/buildDataset.js",
      provenancePolicy:
        "Every field carries a provenance label (sourced/synthetic/corrected). See PROJECT_INSPECTION.md §3.6.",
    },
    stops: observations.map((o) => o.record),
    provenance: observations.map((o) => ({
      stopId: o.record.Stop_Id,
      fields: o.provenance,
    })),
    correctionsLog,
    quality,
  };

  fs.mkdirSync(path.dirname(GENERATED_DATASET), { recursive: true });
  fs.writeFileSync(GENERATED_DATASET, JSON.stringify(dataset, null, 2));
  return dataset;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ds = buildDataset();
  console.log(`Wrote ${GENERATED_DATASET}`);
  console.log(`  stops(observations): ${ds.stops.length}`);
  console.log(`  unique stops: ${ds.quality.shape.uniqueStops}`);
  console.log(`  corrections applied: ${ds.correctionsLog.length}`);
}
