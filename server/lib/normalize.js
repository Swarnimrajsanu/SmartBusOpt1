// Normalization pipeline: raw xlsx rows -> clean, provenance-tagged stop observations.
// Implements §3 findings: header repair, junk-column drop, duplicate-header removal,
// dtype coercion, 11 stops x 2 observations grouping, and the approved coordinate fix.

import {
  COLUMN_MAP,
  COORDINATE_CORRECTIONS,
  STUDY_AREA,
  PROVENANCE,
} from "./config.js";
import { FIELD_SPEC, coerce } from "./fieldSpec.js";

function colLetterToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Precompute letter -> {index, fieldName, drop}
const LETTERS = Object.keys(COLUMN_MAP);
const COLINFO = LETTERS.map((letter) => ({
  letter,
  index: colLetterToIndex(letter),
  field: COLUMN_MAP[letter].name,
  drop: !!COLUMN_MAP[letter].drop,
}));

function isHeaderRow(cells) {
  // Header rows carry the literal 'Latitude_Est' in column E (index 4).
  const e = cells[colLetterToIndex("E")];
  return e !== undefined && String(e).trim() === "Latitude_Est";
}

function isDataRow(cells) {
  const name = cells[colLetterToIndex("B")];
  return name !== undefined && name !== null && String(name).trim() !== "" && !isHeaderRow(cells);
}

function makeStopId(sequence, observation) {
  const s = String(sequence).padStart(3, "0");
  const o = String(observation).padStart(2, "0");
  return `sequence-${s}-observation-${o}`;
}

export function normalizeRows(rows) {
  const correctionsLog = [];
  const seenHeaderRows = [];
  const observationCounter = new Map(); // stop name -> count so far
  const observations = [];

  rows.forEach((cells, i) => {
    if (isHeaderRow(cells)) {
      seenHeaderRows.push(i + 1); // 1-based spreadsheet row number
      return;
    }
    if (!isDataRow(cells)) return;

    const rec = {};
    const provenance = {};
    for (const { index, field, drop } of COLINFO) {
      if (drop) continue;
      const spec = FIELD_SPEC[field];
      const raw = cells[index];
      const type = spec ? spec.type : "string";
      rec[field] = coerce(raw, type);
      provenance[field] = spec ? spec.provenance : PROVENANCE.SYNTHETIC;
    }

    // --- Coordinate corrections (§3.3, approved) ---
    for (const corr of COORDINATE_CORRECTIONS) {
      const matches = Object.entries(corr.match).every(
        ([k, v]) => rec[k] === v
      );
      if (!matches) continue;
      const current = rec[corr.field];
      if (
        typeof current === "number" &&
        Math.abs(current - corr.from) <= corr.tolerance
      ) {
        rec[corr.field] = corr.to;
        provenance[corr.field] = PROVENANCE.CORRECTED;
        correctionsLog.push({
          stop: rec.Bus_Stop_Name,
          field: corr.field,
          from: current,
          to: corr.to,
          reason: corr.reason,
        });
      }
    }

    // --- Observation grouping (each stop appears twice: 2 stacked blocks) ---
    const name = rec.Bus_Stop_Name;
    const obsIndex = (observationCounter.get(name) || 0) + 1;
    observationCounter.set(name, obsIndex);
    rec.Observation = obsIndex;
    rec.Stop_Id = makeStopId(rec.Sequence, obsIndex);

    // --- Coordinate validity vs study area (§5.2) ---
    const { Latitude_Est: lat, Longitude_Est: lon } = rec;
    const inBox =
      typeof lat === "number" &&
      typeof lon === "number" &&
      lat >= STUDY_AREA.SOUTH &&
      lat <= STUDY_AREA.NORTH &&
      lon >= STUDY_AREA.WEST &&
      lon <= STUDY_AREA.EAST;
    rec.Coordinate_Valid = inBox;

    observations.push({ record: rec, provenance });
  });

  return { observations, correctionsLog, seenHeaderRows };
}
