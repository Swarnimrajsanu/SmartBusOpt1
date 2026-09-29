// Data-quality report (§1.2 / §3 / §4). Computes every finding from the ACTUAL parsed
// data — no hard-coded numbers. Consumed by /api/quality and `npm run quality`.

import { FIELD_SPEC } from "./fieldSpec.js";
import { NON_FEATURE_FIELDS, STUDY_AREA } from "./config.js";

export function buildQualityReport({ observations, correctionsLog, seenHeaderRows }) {
  const records = observations.map((o) => o.record);
  const rowCount = records.length;

  // Unique stops and per-stop observation counts
  const byName = new Map();
  for (const r of records) {
    if (!byName.has(r.Bus_Stop_Name)) byName.set(r.Bus_Stop_Name, []);
    byName.get(r.Bus_Stop_Name).push(r);
  }
  const uniqueStops = byName.size;
  const observationCounts = [...byName.entries()].map(([name, rs]) => ({
    stop: name,
    observations: rs.length,
  }));

  // Duplicate / repeated header rows detected mid-file
  const duplicateHeaderRows =
    seenHeaderRows.length > 1 ? seenHeaderRows.slice(1) : [];

  // Missing values per field
  const missing = {};
  for (const field of Object.keys(FIELD_SPEC)) {
    const rowsMissing = records
      .map((r, idx) => ({ r, idx }))
      .filter(({ r }) => r[field] === null || r[field] === undefined)
      .map(({ r }) => `${r.Bus_Stop_Name} (obs ${r.Observation})`);
    if (rowsMissing.length) missing[field] = rowsMissing;
  }

  // Coordinate validity
  const outOfBox = records
    .filter((r) => r.Coordinate_Valid === false)
    .map((r) => ({
      stop: r.Bus_Stop_Name,
      observation: r.Observation,
      lat: r.Latitude_Est,
      lon: r.Longitude_Est,
    }));
  const lats = records.map((r) => r.Latitude_Est).filter((x) => typeof x === "number");
  const lons = records.map((r) => r.Longitude_Est).filter((x) => typeof x === "number");

  // Target distribution
  const targetCounts = { true: 0, false: 0, null: 0 };
  for (const r of records) {
    if (r.Optimal_Stop === true) targetCounts.true++;
    else if (r.Optimal_Stop === false) targetCounts.false++;
    else targetCounts.null++;
  }

  // Leakage risk: is the label identical across observations of the same stop?
  const leakage = [];
  for (const [name, rs] of byName.entries()) {
    const labels = new Set(rs.map((r) => String(r.Optimal_Stop)));
    if (rs.length > 1 && labels.size === 1) {
      leakage.push({ stop: name, label: [...labels][0], observations: rs.length });
    }
  }

  // Provenance summary (Data_Status is uniform in this dataset)
  const dataStatusValues = [...new Set(records.map((r) => r.Data_Status))];

  return {
    generatedAt: new Date().toISOString(),
    shape: {
      rowCount,
      uniqueStops,
      observationsPerStop: observationCounts,
      columnCount: Object.keys(FIELD_SPEC).length,
    },
    structuralIssues: {
      duplicateHeaderRows, // spreadsheet row numbers of repeated headers
      note:
        "The sheet is two stacked blocks of the same 11 stops (2 observations each), separated by a repeated header row. Columns A('0') and C('1') are empty junk index columns; B (Bus_Stop_Name) and D (Sequence) had no header text. All handled by the normalizer.",
    },
    missingValues: missing,
    coordinates: {
      studyArea: STUDY_AREA,
      latRange: lats.length ? [Math.min(...lats), Math.max(...lats)] : null,
      lonRange: lons.length ? [Math.min(...lons), Math.max(...lons)] : null,
      outOfStudyArea: outOfBox,
      correctionsApplied: correctionsLog,
    },
    target: {
      field: "Optimal_Stop",
      distribution: targetCounts,
      leakageRisk: {
        // Independent labelled entities = unique stops, NOT rows.
        independentEntities: uniqueStops,
        rows: rowCount,
        duplicateLabelStops: leakage,
        recommendation:
          "Use GroupKFold(groups = Bus_Stop_Name). A random row split puts the same stop+label in train and test and inflates accuracy. With only 11 unique stops, any model is a pipeline demonstration, not a trustworthy predictor (§4).",
      },
    },
    provenance: {
      dataStatusValues,
      sourcedFields: ["Bus_Stop_Name", "Sequence", "Latitude_Est", "Longitude_Est"],
      syntheticFields: Object.keys(FIELD_SPEC).filter(
        (f) =>
          !["Bus_Stop_Name", "Sequence", "Latitude_Est", "Longitude_Est", "Data_Status"].includes(f)
      ),
      note: "Data_Status declares all numeric attributes synthetic/estimated; only stop name + sequence are sourced. No value in this dataset is 'observed'.",
    },
    modeling: {
      excludedFromFeatures: NON_FEATURE_FIELDS,
      sampleSizeWarning:
        "11 unique stops is far too small to claim real ML accuracy. State this in the UI/docs rather than overclaiming (§4).",
    },
  };
}
