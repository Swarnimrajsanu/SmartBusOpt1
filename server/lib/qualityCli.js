// CLI: print the data-quality report to stdout. Run: `npm run quality`

import { buildDataset } from "./buildDataset.js";

const ds = buildDataset();
const q = ds.quality;

const line = (s = "") => console.log(s);

line("=== SmartBusOpt — Data Quality Report ===");
line(`source: ${ds.meta.source}`);
line(`built:  ${ds.meta.builtAt}`);
line();
line(`rows (observations): ${q.shape.rowCount}`);
line(`unique stops:        ${q.shape.uniqueStops}`);
line(`columns:             ${q.shape.columnCount}`);
line(`duplicate header rows detected at spreadsheet row(s): ${q.structuralIssues.duplicateHeaderRows.join(", ") || "none"}`);
line();
line("--- Missing values ---");
for (const [field, where] of Object.entries(q.missingValues)) {
  line(`  ${field}: ${where.join("; ")}`);
}
if (!Object.keys(q.missingValues).length) line("  none");
line();
line("--- Coordinates ---");
line(`  lat range: ${JSON.stringify(q.coordinates.latRange)}`);
line(`  lon range: ${JSON.stringify(q.coordinates.lonRange)}`);
line(`  out of study area: ${q.coordinates.outOfStudyArea.length}`);
line(`  corrections applied: ${q.coordinates.correctionsApplied.length}`);
for (const c of q.coordinates.correctionsApplied) {
  line(`    ${c.stop}: ${c.field} ${c.from} -> ${c.to}`);
}
line();
line("--- Target (Optimal_Stop) ---");
line(`  distribution: Yes=${q.target.distribution.true} No=${q.target.distribution.false} null=${q.target.distribution.null}`);
line(`  independent labelled entities: ${q.target.leakageRisk.independentEntities} (rows=${q.target.leakageRisk.rows})`);
line(`  stops with identical label across observations (leakage risk): ${q.target.leakageRisk.duplicateLabelStops.length}`);
line(`  -> ${q.target.leakageRisk.recommendation}`);
line();
line("--- Provenance ---");
line(`  Data_Status: ${q.provenance.dataStatusValues.join(" | ")}`);
line(`  sourced fields: ${q.provenance.sourcedFields.join(", ")}`);
line(`  ${q.provenance.note}`);
line();
line("--- Modeling ---");
line(`  excluded from features: ${q.modeling.excludedFromFeatures.join(", ")}`);
line(`  ${q.modeling.sampleSizeWarning}`);
