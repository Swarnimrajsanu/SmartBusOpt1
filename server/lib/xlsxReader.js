// Dependency-free .xlsx reader.
//
// Why hand-rolled: this machine's Python has no pandas/openpyxl and its xml.etree is
// broken (pyexpat dlopen failure). An .xlsx is just a ZIP of XML parts, so we shell out
// to `unzip` (present at /usr/bin/unzip) and parse the two XML parts we need with regex.
// We never modify the source workbook (§4).

import { execFileSync } from "node:child_process";
import fs from "node:fs";

function unzipEntry(xlsxPath, entry) {
  // `unzip -p` writes the entry to stdout without touching disk.
  return execFileSync("unzip", ["-p", xlsxPath, entry], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function decodeEntities(s) {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#10;/g, "\n")
    .replace(/&#9;/g, "\t")
    .replace(/&amp;/g, "&");
}

function columnLettersToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1; // 0-based
}

// Parse sharedStrings.xml -> array of strings (index === the `s`-type cell value).
function parseSharedStrings(xml) {
  const out = [];
  const siRe = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml)) !== null) {
    const inner = m[1];
    const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    let text = "";
    while ((t = tRe.exec(inner)) !== null) text += t[1];
    out.push(decodeEntities(text));
  }
  return out;
}

// Parse a worksheet into an array of rows; each row is an array of raw string cells
// (indexed by column position, gaps filled with null).
function parseSheet(xml, sharedStrings) {
  const rows = [];
  const rowRe = /<row[^>]*\br="(\d+)"[^>]*>([\s\S]*?)<\/row>/g;
  let rm;
  while ((rm = rowRe.exec(xml)) !== null) {
    const rowNum = Number(rm[1]);
    const body = rm[2];
    const cells = [];
    const cellRe =
      /<c\s+r="([A-Z]+)\d+"([^>]*)>([\s\S]*?)<\/c>|<c\s+r="([A-Z]+)\d+"([^>]*)\/>/g;
    let cm;
    while ((cm = cellRe.exec(body)) !== null) {
      const colLetters = cm[1] || cm[4];
      const attrs = cm[2] || cm[5] || "";
      const inner = cm[3] || "";
      const idx = columnLettersToIndex(colLetters);
      const typeMatch = /t="([^"]*)"/.exec(attrs);
      const type = typeMatch ? typeMatch[1] : "n";
      let value = null;
      if (type === "inlineStr") {
        const tRe = /<t[^>]*>([\s\S]*?)<\/t>/g;
        let t;
        let text = "";
        while ((t = tRe.exec(inner)) !== null) text += t[1];
        value = decodeEntities(text);
      } else {
        const vMatch = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vMatch) {
          const raw = vMatch[1];
          value = type === "s" ? sharedStrings[Number(raw)] : decodeEntities(raw);
        }
      }
      cells[idx] = value;
    }
    rows.push({ rowNum, cells });
  }
  rows.sort((a, b) => a.rowNum - b.rowNum);
  return rows;
}

// Read the first worksheet of an .xlsx into { rows: string[][] , sheetName }.
export function readXlsx(xlsxPath) {
  if (!fs.existsSync(xlsxPath)) {
    throw new Error(`Source workbook not found: ${xlsxPath}`);
  }
  const entries = execFileSync("unzip", ["-Z1", xlsxPath], {
    encoding: "utf8",
  })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const sharedStringsEntry = entries.find((e) => e === "xl/sharedStrings.xml");
  const sharedStrings = sharedStringsEntry
    ? parseSharedStrings(unzipEntry(xlsxPath, sharedStringsEntry))
    : [];

  // First worksheet part (this workbook has a single sheet: xl/worksheets/sheet1.xml).
  const sheetEntry =
    entries.find((e) => /^xl\/worksheets\/sheet1\.xml$/.test(e)) ||
    entries.find((e) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e));
  if (!sheetEntry) throw new Error("No worksheet part found in workbook");

  const sheetXml = unzipEntry(xlsxPath, sheetEntry);
  const parsed = parseSheet(sheetXml, sharedStrings);
  const rows = parsed.map((r) => r.cells);
  return { rows, sheetEntry, sharedStringCount: sharedStrings.length };
}
