# ============================================================
# SmartBusOpt — Dockerfile (Railway & Cloud Deployments)
#
# Architecture (Railway / Render / Docker):
#   Container
#     ├── Node.js API (server/index.js)  → serves /public + /api/*
#     ├── Python TraCI bridge            → spawned per-simulation
#     └── SUMO headless (sumo binary)    → controlled via TraCI
#
# SUMO .net.xml + .rou.xml + pre-built scenarios live in simulation/
# (committed to repo).
# ============================================================

FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV SUMO_HOME=/usr/share/sumo
ENV SUMO_PYTHON=/usr/bin/python3
ENV PYTHONPATH=/usr/share/sumo/tools
ENV NODE_ENV=production

# Install SUMO runtime + Node.js 20 + Python3 + PROJ projection tools
RUN apt-get update -qq \
 && apt-get install -y -q --no-install-recommends \
      software-properties-common gnupg ca-certificates curl \
 && add-apt-repository -y ppa:sumo/stable \
 && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
 && apt-get update -qq \
 && apt-get install -y -q --no-install-recommends \
      sumo sumo-tools nodejs python3 python3-pip proj-bin libproj-dev \
 && pip3 install --no-cache-dir sumolib traci \
 && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy application source code + pre-built simulation assets
COPY package.json ./
COPY server/ ./server/
COPY public/ ./public/
COPY simulation/ ./simulation/

# Install Node dependencies
RUN npm install --omit=dev

# Create data directory for normalized dataset + run DB
RUN mkdir -p server/data

EXPOSE 8787 10000

ENV PORT=8787

CMD ["node", "server/index.js"]
