# PROJECT_INSPECTION.md — SmartBusOpt

Pre-build inspection report (Build Prompt §1). **No feature code written yet — stopping here for review, per §1 and §10.1.**

Date: 2026-09-24 · Working dir: `/Users/swarnimraj/Documents/Qoder/2026-09-24/3498ebfd`

---

## 1. Repository state

- Working directory is **empty** — no existing repo, `package.json`, frontend, backend, or API routes.
- **Nothing to preserve / extend.** This is a greenfield build (the "inspect before redesign" rule in §0/§11 is trivially satisfied: there is no prior app).
- Not a git repository yet (`git` available if we want version control).

## 2. Environment / toolchain availability (§1.4)

| Tool | Status | Notes |
|---|---|---|
| Python | ✅ 3.14.4 (`/opt/homebrew/bin/python3`) | **`pandas` / `openpyxl` NOT installed.** Also **`pyexpat`/`xml.etree`/`xml.sax` is broken** on this Homebrew Python (dlopen symbol error) — SUMO's Python tools fail with it too. Excel is parsed via `zipfile`+regex instead. **System Python 3.9 (`/usr/bin/python3`) has a working XML parser** and is used for SUMO tools/TraCI. |
| Node.js | ✅ v25.9.0 | Fine for FastAPI-alternative or frontend tooling. |
| SUMO / sumo-gui / netconvert / TraCI / libsumo | ✅ **Installed 1.27.1** (user-local `~/Applications/Sumo`, no sudo) | Server reports `REAL_SUMO`. Verified end-to-end (netgenerate → randomTrips → headless sumo → tripinfo; TraCI live-stepped 60 steps). **libsumo Python binding NOT shipped — use TraCI.** See `docs/SUMO_SETUP.md`. |
| PostgreSQL | ✅ psql/postgres 14.24 | **PostGIS extension NOT verified.** No DB/schema/data present. |
| git | ✅ 2.50.1 | |

**Implication:** The demo-critical click-to-simulate flow (§2, §7 milestone) **cannot run real SUMO on this machine today.** Two honest paths: (a) install SUMO + set `SUMO_HOME`, or (b) build the full pipeline with the screening-only fallback and a clear DEMO MODE banner. Decision needed from you (see §7).

## 3. Dataset location & shape (§1.2, §4)

- File: `/Users/swarnimraj/Desktop/jaydwip das bus optimization data.xlsx` (13 KB, 1 worksheet `sheet1`). Source file **not modified** (§4 rule).
- **22 data rows = 11 unique stops × 2 observations.** The sheet is two stacked blocks separated by a **repeated header row at spreadsheet row 13** (0-indexed row 12).
  - Block A = rows 2–12 (sequence 1→11 ascending).
  - Block B = rows 14–24 (sequence 11→1 descending; same 11 stops, **different numeric values**).
  - This matches the `sequence-001-observation-01` id scheme hinted in §5.3 → treat each stop as having 2 observations.

### 3.1 Column mapping (headers are malformed — do NOT trust positions blindly)

The header row itself is corrupted by a DataFrame-index export:

| Col | Header cell | Actual meaning | Issue |
|---|---|---|---|
| A | `'0'` | junk index | **All 22 values empty** — drop |
| B | *(empty/None)* | **Bus_Stop_Name** | **Header missing** |
| C | `'1'` | junk index | **All 22 values empty** — drop |
| D | *(empty/None)* | stop **sequence** (1–11) | **Header missing** |
| E | `Latitude_Est` | latitude | ok |
| F | `Longitude_Est` | longitude | ok (see §3.3 outlier) |
| G | `Road_Width_m` | road width | 1 missing |
| H | `Distance_to_Next_Stop_m` | ok | |
| I | `'Boarding '` | boarding | **trailing space in header** |
| J–AH | named | alighting, passenger counts, POI flags, amenities, walking/wait/dwell, pop density, land use, safety, accessibility, **`Optimal_Stop` (target)**, `Data_Status` | ok |

Full named set (E→AH) matches the §4 "likely fields" list.

### 3.2 dtypes

**Every value is stored as a string**, including all numerics (`Road_Width_m`, counts, scores, lat/lon). Loader must coerce types explicitly and handle blanks.

### 3.3 Coordinate validity — ⚠️ one bad coordinate

- Valid cluster: lat **13.0420–13.0754**, lon **77.5375–77.5503** (Chikkabanavara segment, Bengaluru — consistent with §5.2 study area).
- **`Sapthagiri Hospital` (seq 5) has lon `77.1485` in BOTH observations** — ~43 km west of every other stop. Almost certainly a typo for **`77.5485`** (digit transposition). As-is it will break stop-to-edge mapping (§5.3) and any network bounding box.
- **Action required:** flag/quarantine this coordinate; do NOT silently "fix" it (§4/§11). Needs your confirmation on the correction.

### 3.4 Missing values

- `Road_Width_m`: 1 blank (Bagalagunte Bus Station, obs A).
- `Waiting_Time_min`: 1 blank (Bone Mill, obs B — value is two spaces `'  '`).
- Cols A, C: 100% empty (drop).

### 3.5 Target distribution & LEAKAGE RISK (§1.2, §7)

- `Optimal_Stop`: **Yes = 12, No = 10** across 22 rows (≈ balanced).
- **Critical:** the label is **identical for a given stop across both observations** (e.g. Gangamma = Yes/Yes, Bone Mill = No/No). The 22 rows are only **11 independent labelled entities.**
  - → A naive random train/test split puts the same stop (same label) in both sets = **optimistic, invalid accuracy.**
  - → **Must use `GroupKFold(groups = stop_name)`** and report metrics grouped by stop.
- Additional leakage watch: `Safety_Score_0_100` and `Accessibility_Score_0_100` may partly encode the target; inspect feature importance (§7) and never present the model output as the final verdict (§11).
- **Sample size honesty (§4):** 11 unique stops is **far too small** to claim real ML accuracy. A Random Forest here is a *demonstration of the pipeline*, not a trustworthy predictor. The UI/docs must say this explicitly.

### 3.6 Data provenance — the dataset declares itself synthetic

`Data_Status` for **all 22 rows** = *"Stop name/sequence sourced; other values are synthetic/estimated for modelling."*

- Only **stop names + sequence** are real/sourced. **All numeric attributes are synthetic/estimated.**
- → Every derived number (screening score, ML suitability, "impact %") inherits this. Per §4/§11 all UI values must carry provenance labels: here mostly **synthetic (source dataset)** or **model prediction**, and SUMO metrics would be **SUMO-generated** *if* SUMO were installed. **No value in this dataset is "observed."**

## 4. Answers to §1.3 (where things live / how selected)

No app exists, so there is currently:
- **No** storage of bus-stop coordinates (they live only in the xlsx on the Desktop).
- **No** current/alternative stop selection logic.
- **No** screening/score calculation.
- **No** map / Simulation Workspace component.
- **No** "Run scenario" endpoint.
- **No** WebSockets.
- Python is available but **lacks pandas/openpyxl** and has a **broken XML parser**.

All of the above must be built from scratch.

## 5. Proposed implementation plan (aligned to §10 build order)

1. **Project scaffold + data loader.** Backend (FastAPI recommended) that reads the xlsx *without pandas* (regex/`zipfile` parser, or install `openpyxl`), normalizes the malformed headers, drops junk cols A/C, coerces dtypes, tags provenance, quarantines the bad Sapthagiri Hospital coordinate. Emit a clean internal stops table (11 stops × 2 obs). — *(needs a Python env decision, §7)*
2. **Data quality report endpoint** surfacing §3 findings in-app (§4 honesty).
3. **SUMO environment** (§5.1–5.2): detect availability at startup; `download_osm.py` + `netconvert` for the Chikkabanavara bbox (≈ W77.536 S13.041 E77.551 N13.076, **excluding** the outlier lon); `validate_network.py`. Graceful DEMO MODE if SUMO absent.
4. **Stop-to-edge mapping** (§5.3) for the 10 valid stops; reject/flag Sapthagiri Hospital until coordinate resolved.
5. **Baseline SUMO scenario** (current stops) + metrics (§5.5–6).
6. **Candidate generation + suitability scoring** (§7): GIS candidates under spacing/junction/road-width constraints; RF classifier trained with **GroupKFold by stop**, name+target excluded, feature importance exposed.
7. **⭐ Core click-to-simulate flow** (§2) end-to-end with live streaming (§5.6) — demo-critical.
8. Results card, map update with recommended stop, run persistence (§2.5).
9. Polish: stepper states, DEMO MODE banner, error states, provenance tooltips (§8–9).
10. Optional: NSGA-II Pareto, surrogate, sensitivity, analytics (§10.10).

## 6. Key risks

- **R1 — SUMO not installed:** the central product flow (§2) can't produce *real* simulation on this machine. Highest-impact blocker.
- **R2 — Broken Python XML / missing pandas:** affects data loading and any Python GIS/ML work; needs env fix (venv + `openpyxl`/`scikit-learn`, or a working Python).
- **R3 — Synthetic data (11 stops):** ML and any "ground truth" claims must be heavily caveated; risk of overclaiming (§4/§11).
- **R4 — Label leakage:** duplicate-stop rows will inflate accuracy unless grouped (§3.5).
- **R5 — Bad coordinate:** Sapthagiri Hospital lon outlier will break network mapping (§3.3).
- **R6 — Malformed headers:** positional loading will silently mislabel columns (§3.1).

## 7. Decisions needed before implementing further

1. **Stack:** FastAPI (Python) backend + Leaflet/MapLibre frontend — OK? (Python needs a venv with `openpyxl`/`scikit-learn` given §2/§R2.)
2. **SUMO:** Should I attempt to install SUMO and set `SUMO_HOME` (enables REAL mode), or build now with the honest DEMO-MODE screening-only fallback and wire real SUMO later?
3. **Sapthagiri Hospital coordinate:** confirm correcting `77.1485 → 77.5485`, or quarantine the stop entirely?
4. **Scope for this pass:** proceed with steps 1–2 (scaffold + data pipeline + quality report) first and re-check, per the incremental rule (§10)?

---
**Status: inspection complete. Awaiting your answers to §7 before writing feature code.**
