# ============================================================
# SmartBusOpt — Dockerfile
#
# Architecture (Railway / Render / Docker):
#   Container
#     ├── Node.js API (server/index.js)  → serves /public + /api/*
#     ├── Python TraCI bridge            → spawned per-simulation
#     └── SUMO headless (sumo binary)    → controlled via TraCI
#
# SUMO .net.xml + .rou.xml live in simulation/ (committed to repo).
# Scenarios are pre-built at Docker build time so the first click
# runs immediately without a cold-start scenario-build delay.
# ============================================================

# ── Stage 1: SUMO + scenario builder ────────────────────────
FROM ubuntu:22.04 AS sumo-builder

ENV DEBIAN_FRONTEND=noninteractive
ENV SUMO_HOME=/usr/share/sumo
ENV PYTHONPATH=/usr/share/sumo/tools

# Install SUMO from official PPA
RUN apt-get update -qq \
 && apt-get install -y -q --no-install-recommends \
      software-properties-common gnupg ca-certificates \
 && add-apt-repository -y ppa:sumo/stable \
 && apt-get update -qq \
 && apt-get install -y -q --no-install-recommends \
      sumo sumo-tools python3 python3-pip \
 && pip3 install --no-cache-dir sumolib traci \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

# Copy simulation assets
WORKDIR /app
COPY simulation/ ./simulation/

# Pre-build corridor route and all 4 stop scenarios
# Uses the committed bengaluru.net.xml + stop_edges.json
RUN python3 simulation/scripts/sim_build.py prepare \
 && python3 simulation/scripts/sim_build.py geojson \
 && python3 simulation/scripts/sim_build.py scenario sequence-003-observation-01 \
 && python3 simulation/scripts/sim_build.py scenario sequence-005-observation-01 \
 && python3 simulation/scripts/sim_build.py scenario sequence-006-observation-01 \
 && python3 simulation/scripts/sim_build.py scenario sequence-009-observation-01


# ── Stage 2: Runtime image ───────────────────────────────────
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV SUMO_HOME=/usr/share/sumo
ENV SUMO_PYTHON=/usr/bin/python3
ENV PYTHONPATH=/usr/share/sumo/tools
ENV NODE_ENV=production

# Install SUMO runtime + Node.js 20 + Python3
RUN apt-get update -qq \
 && apt-get install -y -q --no-install-recommends \
      software-properties-common gnupg ca-certificates curl \
 && add-apt-repository -y ppa:sumo/stable \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get update -qq \
 && apt-get install -y -q --no-install-recommends \
      sumo sumo-tools nodejs python3 python3-pip \
 && pip3 install --no-cache-dir sumolib traci \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy pre-built simulation artifacts from builder stage
COPY --from=sumo-builder /app/simulation/ ./simulation/

# Copy app source
COPY package.json ./
COPY server/ ./server/
COPY public/ ./public/

# Install Node dependencies
RUN npm install --omit=dev

# Create data directory for normalized dataset + run DB
RUN mkdir -p server/data

EXPOSE 10000

ENV PORT=10000

CMD ["node", "server/index.js"]
