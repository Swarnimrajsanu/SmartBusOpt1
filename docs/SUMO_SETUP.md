# SUMO Setup (macOS / Apple Silicon)

SmartBusOpt uses **Eclipse SUMO** for real traffic microsimulation (build prompt §5).
Until SUMO is installed and detected, the app runs in **DEMO MODE** and must never
fabricate traffic (§2.6, §8, §11). `GET /api/health` reports the live mode.

Current status on this machine: **SUMO 1.27.1 INSTALLED** (user-local, no sudo) →
`mode: REAL_SUMO`. Verified end-to-end: `netgenerate` built a network, `randomTrips.py`
generated demand, `sumo` ran headless and produced real `tripinfo.xml` metrics, and a
**TraCI** live-stepping test moved vehicles for 60 steps with real positions/speeds.

---

## How it was actually installed here (no sudo)

The official `.pkg` normally installs to `/Applications/Sumo` via `sudo installer`, but
sudo needs a password we don't handle automatically. Instead we expanded the signed package
payload into a user-writable location — no system changes, no sudo:

```bash
# 1. download the signed + notarized installer (Eclipse Foundation / Apple notary)
curl -L -o /tmp/sumo.pkg https://sumo.dlr.de/releases/1.27.1/sumo-1.27.1.pkg
pkgutil --check-signature /tmp/sumo.pkg          # verify it's trusted before use

# 2. expand the payload without installing
pkgutil --expand-full /tmp/sumo.pkg /tmp/sumo-expanded

# 3. copy the SUMO tree into ~/Applications (user-writable)
cp -R "/tmp/sumo-expanded/EclipseSUMO-1.27.1.pkg/Payload/Versions/1.27.1/EclipseSUMO" \
      "$HOME/Applications/Sumo"

# 4. env (also appended to ~/.zshrc under a "# SmartBusOpt SUMO" marker)
export SUMO_HOME="$HOME/Applications/Sumo/share/sumo"
export PATH="$HOME/Applications/Sumo/bin:$PATH"
```

Result: binaries in `~/Applications/Sumo/bin`, `SUMO_HOME=~/Applications/Sumo/share/sumo`.
The Node server auto-detects this location even without the env vars set (see
`server/lib/env.js` → `candidateBinDirs()`), so `npm start` reports `REAL_SUMO`.

---

## ⚠️ Python gotcha on this machine (affects SUMO tools + TraCI)

- **Homebrew Python 3.14 (`/opt/homebrew/bin/python3`) has a BROKEN XML parser**
  (`pyexpat`/`xml.sax` — "No parsers found"). SUMO's Python tools (`randomTrips.py`,
  `traci`, `sumolib`) all fail with it.
- **Use macOS system Python 3.9 (`/usr/bin/python3`)** — its XML parser works. The server's
  `detectSumo()` already prefers a Python with a working parser and reports it as
  `traciPython` (+ `traciPythonXmlOk`). Set `PYTHONPATH="$SUMO_HOME/tools"` when running tools.
- **`libsumo` Python binding is NOT shipped** in this package (only `libsumocs.dylib` /
  `libsumocpp.dylib`). Use **TraCI** (subprocess + socket), not libsumo, for the live bridge.
- When calling `traci.start([...])`, pass the **absolute** path to the `sumo` binary
  (`~/Applications/Sumo/bin/sumo`) — TraCI spawns it via subprocess and won't find a bare
  `sumo` unless it's on PATH.
- **Projection caveat (§11):** `traci.simulation.convertGeo(x, y)` only returns correct
  lat/lon if the network has a georeference. A synthetic `netgenerate` grid has none, so
  convertGeo returns garbage there. Real OSM-imported networks (`netconvert` from OSM) carry
  the projection — always convert SUMO x/y to lat/lon, never treat x/y as lat/lon.

---

## Option A — Official prebuilt .pkg (system-wide, needs sudo)


Binaries are hosted on `sumo.dlr.de` (the GitHub *releases* page is empty). Latest
stable at time of writing: **1.27.1**.

```bash
# download the universal macOS installer
curl -L -o /tmp/sumo.pkg https://sumo.dlr.de/releases/1.27.1/sumo-1.27.1.pkg
# install (requires sudo — this is a system-level change; run it yourself)
sudo installer -pkg /tmp/sumo.pkg -target /
```

URL pattern for other versions:
`https://sumo.dlr.de/releases/<VERSION>/sumo-<VERSION>.pkg`

The `.pkg` installs to `/Applications/Sumo`:
- binaries: `/Applications/Sumo/bin` (`sumo`, `sumo-gui`, `netconvert`, …)
- data/share: `/Applications/Sumo/share/sumo`

## Option B — Homebrew tap (DLR-maintained, but stale)

```bash
brew tap dlr-ts/sumo
brew install sumo
brew install --cask xquartz      # needed for the GUI (sumo-gui / netedit)
```

Caveats: this tap lags the official release (was 1.20.0), and the SUMO docs now say
Homebrew "is no longer considered a good alternative." Prefer Option A.

---

## Set SUMO_HOME

Add to `~/.zshrc` (Option A path shown; for Homebrew use `$(brew --prefix sumo)/share/sumo`):

```bash
export SUMO_HOME="/Applications/Sumo/share/sumo"
export PATH="$SUMO_HOME/bin:$PATH"
```

Then `source ~/.zshrc` and verify:

```bash
which sumo netconvert
sumo --version
```

Restart the SmartBusOpt server (`npm start`). `GET /api/environment` should now show
`sumo.mode: "REAL_SUMO"` and `sumo.available: true`.

> **Note:** installing SUMO is a system-level change requiring `sudo`. I have not run it
> automatically — run the installer yourself, then the app will pick it up on next start.

---

## Headless vs GUI

- **Headless** (server / CI): `sumo -c scenario.sumocfg --no-step-log`
- **GUI** (visual debug): `sumo-gui -c scenario.sumocfg` (needs XQuartz on macOS)

For the click-to-simulate flow (§2) the backend runs SUMO **headless** and streams state.

---

## Node ↔ TraCI bridging strategy (§5.6)

There are **no official Node.js bindings** for TraCI/libsumo (they ship for Python, Java,
C++, MATLAB only). Two viable approaches for streaming live vehicle positions to the Node
backend:

1. **Python TraCI bridge (recommended for live stepping).** A small Python subprocess
   connects via TraCI (or libsumo), steps the simulation, and emits the §5.6 JSON payload
   (`simulationTime`, `vehicles[]`, `buses[]`, `metrics{}`) on stdout or a WebSocket. Node
   relays it to the browser. This requires a working Python with `sumo`'s traci module
   (bundled in `SUMO_HOME/tools`).
2. **FCD output pipe (simpler, no per-step control).** Run
   `sumo -c scenario.sumocfg --fcd-output -` and parse the streamed floating-car-data.
   Less flexible for live interaction but avoids a persistent TraCI socket.

> ⚠️ This machine's system Python currently has a **broken `xml.etree`/pyexpat** and no
> `pandas`. Before building the bridge, set up a dedicated venv (or conda) with a working
> Python so `traci`/`libsumo` import cleanly. Coordinates from SUMO are x/y in the network
> projection — **always convert to lat/lon** with `sumo.net.convertGeo` (never treat x/y as
> lat/lon, §11).

---

## Network build (next steps, §5.2)

Once SUMO is present, the study-area network is generated with SUMO's official OSM workflow:

```bash
# bbox = Chikkabanavara segment (config.js STUDY_AREA), excludes the raw lon outlier
$SUMO_HOME/bin/netconvert --osm-files simulation/osm/chikkabanavara.osm.xml \
  --output-file simulation/network/bengaluru.net.xml \
  --osm.ramps.guess --osm.stop-output.length 20 --geometry.remove --junctions.join
```

Generated OSM/network files are git-ignored (§5.1). See `PROJECT_INSPECTION.md` §5 for the
full incremental build order.
