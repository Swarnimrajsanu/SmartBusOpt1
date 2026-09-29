# SmartBusOpt

> AI-driven, network-aware bus stop location optimization for Bengaluru — GIS · ML · SUMO microsimulation

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy)

---

## Tech Stack

- **Backend**: Node.js 18+ (zero npm dependencies, pure built-ins)
- **Frontend**: Vanilla HTML/CSS/JS (`public/`)
- **Simulation**: Eclipse SUMO 1.27.1 + Python TraCI bridge (optional)
- **Data**: Source `.xlsx` → normalized JSON pipeline

## Quick Start (Local)

```bash
git clone https://github.com/Swarnimrajsanu/SmartBusOpt1.git
cd SmartBusOpt1
npm install

# Optional: point to your xlsx file
export SMARTBUSOPT_XLSX="/path/to/your/bus_data.xlsx"
npm run load-data   # builds server/data/stops.normalized.generated.json

npm start           # http://localhost:8787
```

## Deploy on Render

1. Fork / use this repo on [render.com](https://render.com) → **New Web Service** → Connect GitHub
2. Render auto-detects `render.yaml` — no manual config needed
3. The pre-built dataset (`server/data/stops.normalized.generated.json`) is committed, so the server boots without needing the xlsx

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `10000` | HTTP port (Render sets this automatically) |
| `SMARTBUSOPT_XLSX` | hardcoded | Path to source xlsx (not needed if JSON is pre-built) |
| `SUMO_HOME` | auto-detect | SUMO share dir (for REAL_SUMO mode) |

## API

```
GET  /api/health          → server status + SUMO mode
GET  /api/stops           → all 22 stop observations
GET  /api/stops/unique    → 11 unique stops
GET  /api/quality         → data quality report
GET  /api/dataset         → full normalized dataset
GET  /api/network         → corridor + stops GeoJSON
GET  /api/simulate/:id/stream  → live SSE simulation (needs SUMO)
```

## SUMO (Real Simulation Mode)

Without SUMO the app runs in `DEMO_MODE` (all data APIs work, live simulation disabled).  
See [`docs/SUMO_SETUP.md`](docs/SUMO_SETUP.md) to enable `REAL_SUMO` mode.
