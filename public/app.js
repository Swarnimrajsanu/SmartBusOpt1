/* SmartBusOpt frontend (§2, §8).
 * Real Leaflet map + OSM-derived tiles, live SUMO/TraCI vehicle streaming over SSE,
 * current-vs-alternative results. Every number is labeled by provenance; nothing is
 * faked. If SUMO is unavailable the banner says DEMO MODE and runs are refused (§11).
 */
(function () {
  "use strict";

  // ---- The 8 progress stages, exactly as the backend emits them (§2.3) ----
  const STAGES = [
    "Preparing network",
    "Loading scenario",
    "Starting SUMO",
    "Generating traffic",
    "Running simulation (current)",
    "Running simulation (alternative)",
    "Collecting metrics",
    "Completed",
  ];

  const state = {
    mode: "unknown",
    stops: [],            // merged: geojson props + dataset observation
    byId: new Map(),
    selectedId: null,
    es: null,             // active EventSource
    running: false,
    vehicleLayer: null,
    stopLayer: null,
    recLayer: null,
    corridorLayer: null,
    markers: new Map(),   // stopId -> marker
    map: null,
  };

  const $ = (id) => document.getElementById(id);

  // ===================== MAP SETUP =====================
  function initMap() {
    const map = L.map("map", {
      center: [13.060, 77.545],
      zoom: 14,
      zoomControl: false,
      preferCanvas: true,
    });
    L.control.zoom({ position: "topright" }).addTo(map);

    const CARTO_KEY = "cb1_3wln_1_bd4f03b91cab199213c8c354";
    const cartoDark = L.tileLayer(
      `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png?api_key=${CARTO_KEY}`,
      { attribution: '&copy; OpenStreetMap contributors &copy; CARTO', subdomains: "abcd", maxZoom: 20 }
    );
    const osm = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
    });
    const cartoLight = L.tileLayer(
      `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png?api_key=${CARTO_KEY}`,
      { attribution: '&copy; OpenStreetMap contributors &copy; CARTO', subdomains: "abcd", maxZoom: 20 }
    );
    cartoDark.addTo(map);
    L.control.layers(
      { "Dark (OSM/CARTO)": cartoDark, "Street (OSM)": osm, "Voyager (OSM/CARTO)": cartoLight },
      null, { position: "topright" }
    ).addTo(map);

    state.corridorLayer = L.layerGroup().addTo(map);
    state.stopLayer = L.layerGroup().addTo(map);
    state.recLayer = L.layerGroup().addTo(map);
    state.vehicleLayer = L.layerGroup().addTo(map);
    state.map = map;
    window.addEventListener("resize", () => map.invalidateSize());
    return map;
  }

  function stopIcon(seq, cls) {
    return L.divIcon({
      className: "",
      html: `<div class="stop-marker ${cls}" style="width:26px;height:26px;font-size:11px">${seq}</div>`,
      iconSize: [26, 26], iconAnchor: [13, 13],
    });
  }
  function recIcon() {
    return L.divIcon({
      className: "",
      html: `<div class="rec-marker rec-pulse"><span>★</span></div>`,
      iconSize: [30, 30], iconAnchor: [15, 30],
    });
  }
  function vehIcon(bus) {
    const size = bus ? 13 : 7;
    return L.divIcon({
      className: "",
      html: `<div class="${bus ? "bus-dot" : "veh-dot"}" style="width:${size}px;height:${size}px"></div>`,
      iconSize: [size, size], iconAnchor: [size / 2, size / 2],
    });
  }

  // ===================== DATA LOADING =====================
  async function jget(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
  }

  async function loadHealth() {
    try {
      const h = await jget("/api/health");
      state.mode = h.mode;
      const banner = $("mode-banner");
      const label = $("mode-label");
      banner.className = "mode-banner " + (h.mode === "REAL_SUMO" ? "mode-real" : "mode-demo");
      label.textContent = h.mode === "REAL_SUMO" ? "Real SUMO mode" : "Demo mode — SUMO unavailable";
    } catch (e) {
      $("mode-label").textContent = "backend offline";
      $("mode-banner").className = "mode-banner mode-demo";
    }
  }

  async function loadNetworkAndStops() {
    const [gj, unique] = await Promise.all([
      jget("/api/network").catch(() => null),
      jget("/api/stops/unique"),
    ]);

    // index dataset observations by stopId (first observation per stop)
    const obsById = new Map();
    for (const s of unique.stops) {
      const o = s.observations && s.observations[0];
      if (o) obsById.set(o.Stop_Id, o);
    }

    if (gj && gj.features) {
      const bounds = [];
      for (const f of gj.features) {
        const pr = f.properties || {};
        if (pr.kind === "corridor" && f.geometry.type === "LineString") {
          const latlngs = f.geometry.coordinates.map((c) => [c[1], c[0]]);
          const line = L.polyline(latlngs, {
            color: "#22d3ee", weight: 4, opacity: 0.75, smoothFactor: 1,
          }).bindPopup("<b>Bus corridor</b><br>OSM-derived network · " + pr.edgeCount + " edges");
          state.corridorLayer.addLayer(line);
          latlngs.forEach((ll) => bounds.push(ll));
        } else if (pr.kind === "stop") {
          const obs = obsById.get(pr.stopId) || {};
          const stop = {
            stopId: pr.stopId, name: pr.name, sequence: pr.sequence,
            lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0],
            sourceLat: pr.sourceLat, sourceLon: pr.sourceLon,
            edgeId: pr.edgeId, laneId: pr.laneId,
            distanceToRoadM: pr.distanceToRoadM, feasible: pr.feasible,
            obs,
          };
          state.stops.push(stop);
          state.byId.set(stop.stopId, stop);
          const m = L.marker([stop.lat, stop.lon], { icon: stopIcon(stop.sequence, "existing") });
          m.bindPopup(stopPopup(stop));
          m.on("click", () => selectStop(stop.stopId));
          state.stopLayer.addLayer(m);
          state.markers.set(stop.stopId, m);
          bounds.push([stop.lat, stop.lon]);
        }
      }
      if (bounds.length) state.map.fitBounds(bounds, { padding: [40, 40] });
    }

    renderStopList();
    $("stop-count").textContent = state.stops.length;
  }

  function stopPopup(s) {
    const o = s.obs || {};
    return `<b>${s.name}</b><br>
      seq ${s.sequence} · ${s.feasible ? "on network" : Math.round(s.distanceToRoadM) + "m from road"}<br>
      ${o.Passenger_Count != null ? "Demand: " + o.Passenger_Count + " pax" : ""}`;
  }

  function renderStopList() {
    const ul = $("stop-list");
    ul.innerHTML = "";
    const sorted = [...state.stops].sort((a, b) => a.sequence - b.sequence);
    for (const s of sorted) {
      const li = document.createElement("li");
      li.className = "stop-item";
      li.dataset.stopId = s.stopId;
      const o = s.obs || {};
      const flag = s.feasible
        ? '<span class="stop-flag flag-ok">on net</span>'
        : `<span class="stop-flag flag-far">${Math.round(s.distanceToRoadM)}m</span>`;
      li.innerHTML = `
        <div class="stop-seq">${s.sequence}</div>
        <div class="stop-meta">
          <div class="stop-name">${s.name}</div>
          <div class="stop-sub">${o.Passenger_Count != null ? o.Passenger_Count + " pax · " : ""}${o.Traffic_Level || ""}</div>
        </div>${flag}`;
      li.addEventListener("click", () => selectStop(s.stopId));
      ul.appendChild(li);
    }
  }

  // ===================== SELECTION + DETAIL =====================
  function provTag(kind) {
    const map = {
      sumo: ["prov-sumo", "SUMO"], derived: ["prov-derived", "derived"],
      synthetic: ["prov-synthetic", "synthetic"], sourced: ["prov-sourced", "sourced"],
      corrected: ["prov-corrected", "corrected"],
    };
    const [cls, txt] = map[kind] || map.synthetic;
    return `<span class="prov-tag ${cls}">${txt}</span>`;
  }

  function selectStop(stopId) {
    state.selectedId = stopId;
    const s = state.byId.get(stopId);
    if (!s) return;

    // highlight marker + list
    for (const [id, m] of state.markers) {
      m.setIcon(stopIcon(state.byId.get(id).sequence, id === stopId ? "selected" : "existing"));
    }
    document.querySelectorAll(".stop-item").forEach((el) =>
      el.classList.toggle("active", el.dataset.stopId === stopId));

    state.map.setView([s.lat, s.lon], Math.max(state.map.getZoom(), 15), { animate: true });
    renderDetail(s);
    $("run-card").hidden = false;
    setRunButton(false);

    // clear stale sim UI
    state.recLayer.clearLayers();
    $("stepper-card").hidden = true;
    $("telemetry-card").hidden = true;
    $("results-card").hidden = true;
    $("sim-time").textContent = "—";
    state.vehicleLayer.clearLayers();

    // show last computed run if any (§2.5)
    loadLatestRun(stopId);
  }

  function renderDetail(s) {
    const o = s.obs || {};
    const el = $("stop-detail");
    const tile = (k, v, unit, prov) => `
      <div class="metric-tile">
        <div class="k">${k} ${provTag(prov)}</div>
        <div class="v">${v}${unit ? ` <small>${unit}</small>` : ""}</div>
      </div>`;
    el.innerHTML = `
      <div class="detail-name">${s.name}</div>
      <div class="detail-id">${s.stopId} · seq ${s.sequence}</div>
      <div class="detail-grid">
        ${tile("Latitude", s.sourceLat.toFixed(5), "", o.Longitude_Est === 77.5485 && s.name.includes("Sapthagiri Hospital") ? "corrected" : "sourced")}
        ${tile("Longitude", s.sourceLon.toFixed(5), "", o.Longitude_Est === 77.5485 && s.name.includes("Sapthagiri Hospital") ? "corrected" : "sourced")}
        ${tile("Passengers", o.Passenger_Count ?? "–", "pax", "synthetic")}
        ${tile("Peak hour", o.Peak_Hour_Passengers ?? "–", "pax", "synthetic")}
        ${tile("Boarding", o.Boarding ?? "–", "", "synthetic")}
        ${tile("Alighting", o.Alighting ?? "–", "", "synthetic")}
        ${tile("Traffic", o.Traffic_Level ?? "–", "", "synthetic")}
        ${tile("Land use", o.Land_Use ?? "–", "", "synthetic")}
        ${tile("Safety", o.Safety_Score_0_100 ?? "–", "/100", "synthetic")}
        ${tile("Access", o.Accessibility_Score_0_100 ?? "–", "/100", "synthetic")}
        ${tile("Walk to road", Math.round(s.distanceToRoadM), "m", "derived")}
        ${tile("Optimal (label)", o.Optimal_Stop == null ? "–" : (o.Optimal_Stop ? "Yes" : "No"), "", "sourced")}
      </div>
      <div class="results-note">
        Snapped to SUMO lane <code>${s.laneId || "—"}</code>
        ${s.feasible ? "" : `· <b style="color:var(--warn)">${Math.round(s.distanceToRoadM)}m from network — flagged, not force-placed (§5.3)</b>`}
      </div>`;
  }

  async function loadLatestRun(stopId) {
    try {
      const r = await jget(`/api/stops/${encodeURIComponent(stopId)}/runs/latest`);
      if (r && r.run) {
        renderResults(r.run, true);
        if (r.run.candidate && r.run.candidate.lat) addRecommendedMarker(r.run.candidate);
      }
    } catch (e) { /* no prior run — fine */ }
  }

  // ===================== RUN SIMULATION (SSE) =====================
  function setRunButton(running) {
    const btn = $("btn-run");
    state.running = running;
    btn.disabled = running;
    btn.classList.toggle("running", running);
    btn.innerHTML = running
      ? '<span class="btn-run-icon">■</span> Running… (click to stop)'
      : '<span class="btn-run-icon">▶</span> Run Simulation';
    btn.onclick = running ? stopRun : startRun;
  }

  function buildStepper() {
    const ol = $("stepper");
    ol.innerHTML = "";
    STAGES.forEach((name, i) => {
      const li = document.createElement("li");
      li.dataset.stage = name;
      li.innerHTML = `<span class="step-dot">${i + 1}</span><span class="step-name">${name}</span>`;
      ol.appendChild(li);
    });
    $("stepper-card").hidden = false;
  }
  function advanceStepper(stageName, isError) {
    const items = [...document.querySelectorAll("#stepper li")];
    const idx = items.findIndex((li) => li.dataset.stage === stageName);
    items.forEach((li, i) => {
      li.classList.remove("active");
      if (i < idx) li.classList.add("done");
      else li.classList.remove("done");
    });
    if (idx >= 0) {
      items[idx].classList.add(isError ? "error" : "active");
      items[idx].querySelector(".step-dot").textContent = isError ? "!" : (idx + 1);
      if (!isError && idx > 0) items[idx].querySelector(".step-dot").textContent = "✓";
    }
  }
  function completeStepper() {
    document.querySelectorAll("#stepper li").forEach((li) => {
      li.classList.remove("active"); li.classList.add("done");
      li.querySelector(".step-dot").textContent = "✓";
    });
  }

  function startRun() {
    const stopId = state.selectedId;
    if (!stopId || state.running) return;
    if (state.mode !== "REAL_SUMO") {
      showResultsError(
        "SUMO is not available on this machine, so a real simulation cannot run. " +
        "The app is in DEMO MODE and will not fabricate traffic or results (§2.6, §11). " +
        "Install SUMO — see docs/SUMO_SETUP.md.");
      return;
    }
    if (state.es) { try { state.es.close(); } catch (e) {} }

    buildStepper();
    $("telemetry-card").hidden = false;
    $("results-card").hidden = true;
    state.recLayer.clearLayers();
    state.vehicleLayer.clearLayers();
    setRunButton(true);

    const url = `/api/simulate/${encodeURIComponent(stopId)}/stream`;
    const es = new EventSource(url);
    state.es = es;

    es.addEventListener("stage", (ev) => {
      const d = JSON.parse(ev.data);
      // bridge-internal stages carry a `label`; the orchestrator drives the stepper.
      if (!d.label) advanceStepper(d.stage, false);
    });
    es.addEventListener("frame", (ev) => {
      const d = JSON.parse(ev.data);
      drawFrame(d);
    });
    es.addEventListener("scenario", (ev) => {
      const d = JSON.parse(ev.data);
      if (d.manifest && d.manifest.candidate && d.manifest.candidate.lat) {
        addRecommendedMarker(d.manifest.candidate, true);
      }
    });
    es.addEventListener("result", (ev) => {
      const d = JSON.parse(ev.data);
      completeStepper();
      renderResults(d.result, false);
      if (d.result.candidate && d.result.candidate.lat) addRecommendedMarker(d.result.candidate);
      finishRun();
    });
    es.addEventListener("error", (ev) => {
      // SSE 'error' fires both for our custom event and for connection close.
      let d = null;
      try { d = ev.data ? JSON.parse(ev.data) : null; } catch (e) {}
      if (d && d.message) {
        const items = [...document.querySelectorAll("#stepper li.active")];
        if (items[0]) { items[0].classList.add("error"); items[0].querySelector(".step-dot").textContent = "!"; }
        showResultsError(d.message + (d.code ? ` [${d.code}]` : ""));
      }
      finishRun();
    });
    es.onerror = () => {
      // connection ended (normal after result, or a transport failure)
      if (state.running) finishRun();
    };
  }

  function stopRun() {
    if (state.es) { try { state.es.close(); } catch (e) {} state.es = null; }
    finishRun();
    showResultsError("Simulation stopped by user before completion. No result was fabricated.");
  }

  function finishRun() {
    if (state.es) { try { state.es.close(); } catch (e) {} state.es = null; }
    setRunButton(false);
  }

  function drawFrame(f) {
    $("sim-time").textContent = fmtClock(f.simulationTime);
    // redraw live vehicles (real SUMO positions only)
    state.vehicleLayer.clearLayers();
    for (const v of f.vehicles) {
      state.vehicleLayer.addLayer(L.marker([v.lat, v.lon], { icon: vehIcon(false), interactive: false }));
    }
    for (const b of f.buses) {
      const m = L.marker([b.lat, b.lon], { icon: vehIcon(true), interactive: false });
      state.vehicleLayer.addLayer(m);
    }
    renderTelemetry(f, f.label);
  }

  function renderTelemetry(f, label) {
    const m = f.metrics || {};
    const g = $("telemetry");
    const tile = (k, v, unit) => `
      <div class="metric-tile"><div class="k">${k}</div>
      <div class="v">${v}${unit ? ` <small>${unit}</small>` : ""}</div></div>`;
    g.innerHTML =
      `<div class="metric-tile" style="grid-column:1/-1">
         <div class="k"><span class="telem-live"></span>Streaming · ${label || ""} scenario</div>
         <div class="v" style="font-size:12px;color:var(--text-dim)">sim t = ${fmtClock(f.simulationTime)}</div>
       </div>` +
      tile("Active vehicles", m.activeVehicles ?? "–", "") +
      tile("Buses", m.buses ?? "–", "") +
      tile("Avg speed", m.avgSpeedMs != null ? m.avgSpeedMs.toFixed(1) : "–", "m/s") +
      tile("Halting (queue)", m.haltingVehicles ?? "–", "") +
      tile("Max queue", m.maxQueueLength ?? "–", "veh");
  }

  function fmtClock(sec) {
    if (sec == null) return "—";
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function addRecommendedMarker(cand, provisional) {
    state.recLayer.clearLayers();
    const m = L.marker([cand.lat, cand.lon], { icon: recIcon(), zIndexOffset: 1000 });
    m.bindPopup(`<b>Recommended stop</b>${provisional ? " (candidate)" : ""}<br>
      lane ${cand.laneId}<br>
      junction score ${cand.junctionScore} · shift ${cand.shiftAlongCorridorM}m<br>
      <span style="color:var(--text-faint);font-size:11px">GIS rule-based candidate — SUMO validates, ML never decides (§11)</span>`);
    state.recLayer.addLayer(m);
  }

  // ===================== RESULTS CARD =====================
  // direction: "lower" = lower is better, "higher" = higher is better
  const RESULT_ROWS = [
    { k: "Avg travel time", unit: "s", path: ["avgTravelTimeSec"], dir: "lower", prov: "sumo" },
    { k: "Avg delay", unit: "s", path: ["avgDelaySec"], dir: "lower", prov: "sumo" },
    { k: "Avg speed", unit: "m/s", path: ["avgSpeedMs"], dir: "higher", prov: "sumo" },
    { k: "Max queue", unit: "veh", path: ["maxQueueLength"], dir: "lower", prov: "sumo" },
    { k: "Vehicles completed", unit: "", path: ["vehiclesCompleted"], dir: null, prov: "sumo" },
    { k: "Bus travel time", unit: "s", path: ["bus", "avgTravelTimeSec"], dir: "lower", prov: "sumo" },
    { k: "Bus delay", unit: "s", path: ["bus", "avgDelaySec"], dir: "lower", prov: "sumo" },
    { k: "Bus stop waiting", unit: "s", path: ["bus", "avgStopWaitingSec"], dir: "lower", prov: "sumo" },
  ];

  function dig(obj, path) {
    let v = obj;
    for (const p of path) { if (v == null) return null; v = v[p]; }
    return v;
  }

  function deltaBadge(cur, alt, dir) {
    if (cur == null || alt == null || dir == null || cur === 0) return "";
    const pct = ((alt - cur) / Math.abs(cur)) * 100;
    if (Math.abs(pct) < 0.05) return `<span class="delta delta-neutral">±0%</span>`;
    const better = dir === "lower" ? pct < 0 : pct > 0;
    const cls = better ? "delta-better" : "delta-worse";
    const sign = pct > 0 ? "+" : "";
    return `<span class="delta ${cls}">${sign}${pct.toFixed(1)}%</span>`;
  }

  function fmt(v, unit) {
    if (v == null) return "—";
    const n = typeof v === "number" ? (Math.abs(v) >= 100 ? v.toFixed(0) : v.toFixed(2)) : v;
    return `${n}${unit ? " " + unit : ""}`;
  }

  function renderResults(result, fromCache) {
    $("results-card").hidden = false;
    const cur = result.current || {};
    const alt = result.alternative || {};
    const walk = result.walking || {};

    let rows = "";
    for (const r of RESULT_ROWS) {
      const cv = dig(cur, r.path), av = dig(alt, r.path);
      rows += `
        <div class="result-row">
          <div class="rk">${r.k} ${provTag(r.prov)}</div>
          <div class="rv rv-current">${fmt(cv, r.unit)}</div>
          <div class="rv rv-alt">${fmt(av, r.unit)}${deltaBadge(cv, av, r.dir)}</div>
        </div>`;
    }
    // walking distance (GIS-derived, not SUMO)
    rows += `
      <div class="result-row">
        <div class="rk">Walk to road ${provTag("derived")}</div>
        <div class="rv rv-current">${walk.currentWalkToRoadM != null ? walk.currentWalkToRoadM + " m" : "—"}</div>
        <div class="rv rv-alt">${walk.alternativeWalkToRoadM != null ? walk.alternativeWalkToRoadM + " m" : "—"}</div>
      </div>`;

    const feasible = result.alternativeFeasible;
    const cand = result.candidate || {};
    $("results").innerHTML = `
      ${fromCache ? '<div class="results-note" style="border:0;padding:0 0 9px;margin:0">Showing last computed run (cached). Re-run to refresh.</div>' : ""}
      <div class="results-head">
        <div class="rh-col rh-current">CURRENT</div>
        <div class="rh-col rh-alt">${feasible ? "RECOMMENDED" : "ALT = CURRENT"}</div>
      </div>
      ${rows}
      ${!feasible ? `<div class="results-note" style="color:var(--warn)">${result.note || "No feasible relocation candidate found. The alternative mirrors the current stop — this is NOT an improvement (§2.2)."}</div>` : ""}
      <div class="results-note">
        ${feasible ? `Candidate lane <code>${cand.laneId || "—"}</code> · junction score ${cand.junctionScore ?? "—"} · relocated ${cand.shiftAlongCorridorM ?? "—"}m along corridor.<br>` : ""}
        ${result.candidateProvenance || ""}
      </div>
      <div class="run-meta">
        run ${result.runId || "—"} · seed ${result.seed} · ${result.simDuration}s ·
        network: ${result.networkProvenance} · demand: ${result.demandProvenance}<br>
        ${result.completedAt || ""}
      </div>`;
  }

  function showResultsError(msg) {
    $("results-card").hidden = false;
    $("results").innerHTML = `<div class="results-error"><b>Cannot show a result.</b><br>${msg}</div>`;
  }

  // ===================== BOOT =====================
  async function boot() {
    initMap();
    await loadHealth();
    try {
      await loadNetworkAndStops();
    } catch (e) {
      $("stop-detail").innerHTML =
        `<div class="results-error">Failed to load map data: ${e.message}<br>
         Ensure the corridor is built (sim_build.py prepare + geojson).</div>`;
    }
  }

  boot();
})();
