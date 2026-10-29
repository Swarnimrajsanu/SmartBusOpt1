/* SmartBusOpt — detailed results dashboard (§2.5, §9, §11).
 *
 * Reached automatically after a live simulation completes, or from the top nav.
 * Reads only real endpoints: /api/runs, /api/stops/unique, /api/network, /api/quality.
 *
 * Charts are hand-rolled inline SVG — the project has zero npm dependencies and this page
 * keeps it that way (Leaflet is the only external asset, as on the map page).
 *
 * §11 rules this file obeys:
 *   - a null metric renders as "—" and is omitted from charts, never plotted as 0
 *   - every panel carries a provenance tag; synthetic dataset fields are never shown
 *     alongside SUMO output without one
 *   - single-seed runs are labelled as such; small deltas are not presented as proven wins
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // ===================== METRIC DEFINITIONS =====================
  // dir: "lower" = lower is better, "higher" = higher is better, null = context only (no verdict)
  const METRICS = [
    { k: "Avg travel time",   unit: "s",   path: ["avgTravelTimeSec"],          dir: "lower",  delta: true },
    { k: "Avg delay",         unit: "s",   path: ["avgDelaySec"],               dir: "lower",  delta: true },
    { k: "Avg waiting",       unit: "s",   path: ["avgWaitingSec"],             dir: "lower",  delta: true },
    { k: "Avg speed",         unit: "m/s", path: ["avgSpeedMs"],                dir: "higher", delta: true },
    { k: "Max queue",         unit: "veh", path: ["maxQueueLength"],            dir: "lower",  delta: true },
    { k: "Bus travel time",   unit: "s",   path: ["bus", "avgTravelTimeSec"],   dir: "lower",  delta: true },
    { k: "Bus delay",         unit: "s",   path: ["bus", "avgDelaySec"],        dir: "lower",  delta: true },
    { k: "Bus stop waiting",  unit: "s",   path: ["bus", "avgStopWaitingSec"],  dir: "lower",  delta: true },
    { k: "Bus speed",         unit: "m/s", path: ["bus", "avgSpeedMs"],         dir: "higher", delta: true },
    { k: "Vehicles completed", unit: "",   path: ["vehiclesCompleted"],         dir: null,     delta: false },
    { k: "Bus trips completed", unit: "",  path: ["bus", "completed"],          dir: null,     delta: false },
    { k: "Avg route length",  unit: "m",   path: ["avgRouteLengthM"],           dir: null,     delta: false },
  ];

  const AMENITIES = [
    ["Bus_Shelter", "Shelter"], ["Seating", "Seating"], ["Street_Lighting", "Lighting"],
    ["Footpath", "Footpath"], ["Zebra_Crossing", "Zebra"], ["Bus_Bay", "Bus bay"],
  ];

  const C = {
    cur: "#3b82f6", curLight: "#93c5fd",
    alt: "#a3e635", altLight: "#d9f99d",
    good: "#34d399", bad: "#f87171", neutral: "#64748b",
    grid: "rgba(120,150,220,0.14)", axis: "rgba(120,150,220,0.32)",
    text: "#9fb0d0", faint: "#6b7c9e", accent2: "#22d3ee", warn: "#fbbf24",
  };

  const state = {
    mode: "unknown",
    runs: [],            // all persisted runs, newest first
    run: null,           // the run being displayed
    stops: [],           // unique stops with observations
    obsById: new Map(),  // Stop_Id -> observation
    geo: null,           // corridor geojson
    quality: null,
    crossMetric: 0,      // index into METRICS for the cross-stop chart
    radarStopId: null,
    map: null,
    charts: [],          // { el, draw } for resize re-render
  };

  // ===================== SMALL UTILITIES =====================
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function dig(obj, path) {
    let v = obj;
    for (const p of path) { if (v == null) return null; v = v[p]; }
    return v == null ? null : v;
  }

  function fmtNum(v, unit) {
    if (v == null || !Number.isFinite(v)) return "—";
    const a = Math.abs(v);
    const n = a >= 1000 ? v.toFixed(0) : a >= 100 ? v.toFixed(1) : v.toFixed(2);
    return `${n.replace(/\.0+$/, "")}${unit ? " " + unit : ""}`;
  }

  function fmtPct(v) {
    if (v == null || !Number.isFinite(v)) return "—";
    return `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
  }

  function pctChange(cur, alt) {
    if (cur == null || alt == null || !Number.isFinite(cur) || !Number.isFinite(alt)) return null;
    if (cur === 0) return null;
    return ((alt - cur) / Math.abs(cur)) * 100;
  }

  // Is this change an improvement? null when the metric has no direction or no data.
  function isBetter(pct, dir) {
    if (pct == null || dir == null) return null;
    if (Math.abs(pct) < 0.05) return null;
    return dir === "lower" ? pct < 0 : pct > 0;
  }

  function niceMax(v) {
    if (!(v > 0)) return 1;
    const exp = Math.floor(Math.log10(v));
    const f = v / Math.pow(10, exp);
    const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    return nf * Math.pow(10, exp);
  }

  function relTime(iso) {
    if (!iso) return "";
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return "";
    const s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  async function jget(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url} -> ${r.status}`);
    return r.json();
  }

  // ===================== SVG HELPERS =====================
  const NS = "http://www.w3.org/2000/svg";
  function s(name, attrs, children) {
    const e = document.createElementNS(NS, name);
    if (attrs) for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    if (children) {
      for (const c of [].concat(children)) {
        if (c == null) continue;
        e.appendChild(typeof c === "object" ? c : document.createTextNode(String(c)));
      }
    }
    return e;
  }

  const tip = () => $("chart-tip");
  function showTip(html, ev) {
    const t = tip();
    t.innerHTML = html;
    t.hidden = false;
    moveTip(ev);
  }
  function moveTip(ev) {
    const t = tip();
    const pad = 15;
    const r = t.getBoundingClientRect();
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > window.innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > window.innerHeight - 8) y = ev.clientY - r.height - pad;
    t.style.left = `${Math.max(8, x)}px`;
    t.style.top = `${Math.max(8, y)}px`;
  }
  function hideTip() { tip().hidden = true; }
  function bindTip(el, html) {
    el.addEventListener("mouseenter", (ev) => showTip(html, ev));
    el.addEventListener("mousemove", moveTip);
    el.addEventListener("mouseleave", hideTip);
    el.classList.add("has-tip");
  }

  // Register a chart so a window resize redraws it at the new container width.
  // Re-mounting the same box replaces its previous draw function.
  function mountChart(boxId, draw) {
    const el = $(boxId);
    if (!el) return;
    state.charts = state.charts.filter((c) => c.el !== el);
    state.charts.push({ el, draw });
    el.innerHTML = "";
    draw(el);
  }

  function redrawAll() {
    hideTip();
    for (const c of state.charts) { c.el.innerHTML = ""; c.draw(c.el); }
  }

  // Bars grow in with a CSS keyframe animation. The natural (unanimated) state is fully
  // drawn, so a browser that skips the animation still shows correct charts — nothing can
  // be left invisible waiting on a class toggle.

  // Animated KPI number. The final value is written first and the count-up is purely
  // decorative: requestAnimationFrame is throttled or paused in background tabs, so an
  // animation that never runs must not leave the tile blank or stuck mid-count.
  function countUp(el, to, unit, dec) {
    el.textContent = "";
    if (to == null || !Number.isFinite(to)) { el.textContent = "—"; return; }
    const d = dec != null ? dec : Math.abs(to) >= 1000 ? 0 : Math.abs(to) >= 10 ? 1 : 2;
    const final = to.toFixed(d);

    const num = document.createElement("span");
    num.textContent = final;
    el.appendChild(num);
    if (unit) {
      const sm = document.createElement("small");
      sm.textContent = unit;
      el.appendChild(sm);
    }
    if (document.hidden) return;

    const dur = 700, t0 = performance.now();
    const pin = setTimeout(() => { num.textContent = final; }, dur + 400);
    requestAnimationFrame(function step(t) {
      const k = Math.min(1, (t - t0) / dur);
      num.textContent = (to * (1 - Math.pow(1 - k, 3))).toFixed(d);
      if (k < 1) requestAnimationFrame(step);
      else { clearTimeout(pin); num.textContent = final; }
    });
  }

  // CSS grow-in animations are throttled in background tabs too, which can leave a bar stuck
  // at its zero-size start frame. The unanimated state is fully drawn, so dropping the
  // animation once it should have finished guarantees the chart is always visible.
  function pinAnimations(root) {
    setTimeout(() => {
      root.querySelectorAll(".bar-x-pos, .bar-x-neg, .bar-y, .fade-in")
        .forEach((n) => { n.style.animation = "none"; });
    }, 1500);
  }

  // ===================== CHART: diverging delta bars =====================
  function drawDelta(el, run) {
    const cur = run.current || {}, alt = run.alternative || {};
    const rows = [];
    for (const m of METRICS) {
      if (!m.delta) continue;
      const cv = dig(cur, m.path), av = dig(alt, m.path);
      const pct = pctChange(cv, av);
      rows.push({ m, cv, av, pct, better: isBetter(pct, m.dir) });
    }

    const W = Math.max(320, el.clientWidth || 600);
    const labelW = Math.min(150, Math.max(96, Math.round(W * 0.26)));
    const valW = 68;
    const padR = 10, padT = 18, padB = 22;
    const rowH = 30;
    const H = padT + padB + rows.length * rowH;
    const plotX = labelW, plotW = W - labelW - valW - padR;
    const zero = plotX + plotW / 2;

    const valid = rows.filter((r) => r.pct != null).map((r) => Math.abs(r.pct));
    const maxAbs = niceMax(valid.length ? Math.max(...valid) : 1);

    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart" });

    // gridlines at 0 and +/- halves
    for (const f of [-1, -0.5, 0, 0.5, 1]) {
      const x = zero + f * (plotW / 2);
      svg.appendChild(s("line", {
        x1: x, y1: padT - 6, x2: x, y2: H - padB,
        stroke: f === 0 ? C.axis : C.grid, "stroke-width": f === 0 ? 1.4 : 1,
        "stroke-dasharray": f === 0 ? "" : "3 4",
      }));
      svg.appendChild(s("text", {
        x, y: 11, "text-anchor": "middle", class: "ax-tick",
      }, `${f === 0 ? "0" : (f * maxAbs > 0 ? "+" : "") + Math.round(f * maxAbs)}%`));
    }

    rows.forEach((r, i) => {
      const cy = padT + i * rowH + rowH / 2;
      const bh = 14;
      svg.appendChild(s("text", {
        x: labelW - 10, y: cy + 4, "text-anchor": "end", class: "ax-label",
      }, r.m.k));

      if (r.pct == null) {
        svg.appendChild(s("text", {
          x: W - padR, y: cy + 4, "text-anchor": "end", class: "ax-none",
        }, "no data"));
        return;
      }

      const w = Math.max(1.5, (Math.abs(r.pct) / maxAbs) * (plotW / 2));
      const x = r.pct >= 0 ? zero : zero - w;
      const fill = r.better == null ? C.neutral : r.better ? C.good : C.bad;

      const rect = s("rect", {
        x, y: cy - bh / 2, width: w, height: bh, rx: 3, fill,
        class: `bar ${r.pct >= 0 ? "bar-x-pos" : "bar-x-neg"}`,
        "fill-opacity": r.better == null ? 0.5 : 0.9,
        style: `animation-delay:${i * 45}ms`,
      });
      bindTip(rect,
        `<b>${esc(r.m.k)}</b><br>
         current <span class="tt-cur">${esc(fmtNum(r.cv, r.m.unit))}</span><br>
         recommended <span class="tt-alt">${esc(fmtNum(r.av, r.m.unit))}</span><br>
         change <b>${esc(fmtPct(r.pct))}</b> ·
         ${r.better == null ? "no meaningful change" : r.better ? "improvement" : "regression"}<br>
         <span class="tt-note">${esc(r.m.dir === "lower" ? "lower is better" : "higher is better")} · SUMO-measured</span>`);
      svg.appendChild(rect);

      svg.appendChild(s("text", {
        x: W - padR, y: cy + 4, "text-anchor": "end",
        class: "ax-val", fill: r.better == null ? C.faint : r.better ? C.good : C.bad,
      }, fmtPct(r.pct)));
    });

    el.appendChild(svg);
  }

  // ===================== CHART: grouped vertical bars =====================
  // groups: [{ label, sub, bars: [{ value, color, name, tipHtml }] }]
  function drawGrouped(el, groups, opt) {
    opt = opt || {};
    const W = Math.max(320, el.clientWidth || 600);
    const H = opt.height || 280;
    const padL = opt.padL || 50, padR = 14, padT = 16, padB = opt.padB || 58;
    const plotW = W - padL - padR, plotH = H - padT - padB;

    const allVals = [];
    for (const g of groups) for (const b of g.bars) if (b.value != null && Number.isFinite(b.value)) allVals.push(b.value);
    if (!allVals.length) { el.appendChild(emptyChart("no measurable values")); return; }
    const top = niceMax(Math.max(...allVals) * 1.08);

    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart" });
    const y = (v) => padT + plotH - (v / top) * plotH;

    const ticks = 4;
    for (let i = 0; i <= ticks; i++) {
      const v = (top / ticks) * i, yy = y(v);
      svg.appendChild(s("line", { x1: padL, y1: yy, x2: W - padR, y2: yy, stroke: i === 0 ? C.axis : C.grid, "stroke-width": i === 0 ? 1.3 : 1 }));
      svg.appendChild(s("text", { x: padL - 8, y: yy + 4, "text-anchor": "end", class: "ax-tick" },
        v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : String(Math.round(v * 10) / 10)));
    }
    if (opt.yTitle) {
      svg.appendChild(s("text", {
        x: 13, y: padT + plotH / 2, class: "ax-title",
        transform: `rotate(-90 13 ${padT + plotH / 2})`, "text-anchor": "middle",
      }, opt.yTitle));
    }

    const gw = plotW / groups.length;
    groups.forEach((g, gi) => {
      const cx = padL + gw * gi + gw / 2;
      const n = g.bars.length;
      const bw = Math.min(opt.barWidth || 26, (gw * 0.66) / n);
      const totalW = bw * n + (n - 1) * Math.min(5, bw * 0.18);
      let bx = cx - totalW / 2;

      g.bars.forEach((b) => {
        if (b.value == null || !Number.isFinite(b.value)) { bx += bw + 5; return; }
        const yy = y(b.value), hh = Math.max(1, padT + plotH - yy);
        const rect = s("rect", {
          x: bx, y: yy, width: bw, height: hh, rx: 3, fill: b.color,
          class: "bar bar-y", "fill-opacity": b.dim ? 0.45 : 0.9,
          style: `animation-delay:${gi * 55}ms`,
        });
        if (b.tipHtml) bindTip(rect, b.tipHtml);
        svg.appendChild(rect);

        if (opt.valueLabels && bw >= 18) {
          svg.appendChild(s("text", {
            x: bx + bw / 2, y: yy - 5, "text-anchor": "middle", class: "ax-vlab",
          }, b.label != null ? b.label : fmtNum(b.value, "")));
        }
        bx += bw + Math.min(5, bw * 0.18);
      });

      svg.appendChild(s("text", { x: cx, y: H - padB + 16, "text-anchor": "middle", class: "ax-label" }, g.label));
      if (g.sub) svg.appendChild(s("text", { x: cx, y: H - padB + 30, "text-anchor": "middle", class: "ax-sub" }, g.sub));
      if (g.badge) {
        const bwd = 34;
        svg.appendChild(s("rect", {
          x: cx - bwd / 2, y: H - padB + 36, width: bwd, height: 14, rx: 7,
          fill: g.badge === "Yes" ? "rgba(52,211,153,0.18)" : "rgba(148,163,184,0.14)",
        }));
        svg.appendChild(s("text", {
          x: cx, y: H - padB + 46.5, "text-anchor": "middle", class: "ax-badge",
          fill: g.badge === "Yes" ? C.good : C.faint,
        }, g.badge));
      }
    });

    el.appendChild(svg);
  }

  function emptyChart(msg) {
    const g = s("g");
    g.appendChild(s("text", { x: 12, y: 26, class: "ax-none" }, msg));
    return s("svg", { width: 240, height: 44, viewBox: "0 0 240 44", class: "chart" }, [g]);
  }

  // ===================== CHART: radar =====================
  function drawRadar(el, axes, values, color) {
    const W = Math.max(260, el.clientWidth || 380);
    const H = 300;
    const cx = W / 2, cy = H / 2 + 4, R = Math.min(W, H) / 2 - 56;
    const n = axes.length;
    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart" });

    const pt = (i, r) => {
      const a = (Math.PI * 2 * i) / n - Math.PI / 2;
      return [cx + Math.cos(a) * r, cy + Math.sin(a) * r];
    };

    for (let ring = 1; ring <= 4; ring++) {
      const r = (R * ring) / 4;
      const pts = axes.map((_, i) => pt(i, r).join(",")).join(" ");
      svg.appendChild(s("polygon", { points: pts, fill: "none", stroke: C.grid, "stroke-width": 1 }));
    }
    axes.forEach((a, i) => {
      const [x, y2] = pt(i, R);
      svg.appendChild(s("line", { x1: cx, y1: cy, x2: x, y2, stroke: C.grid, "stroke-width": 1 }));
      const [lx, ly] = pt(i, R + 20);
      const anchor = Math.abs(lx - cx) < 12 ? "middle" : lx > cx ? "start" : "end";
      const t = s("text", { x: lx, y: ly + 4, "text-anchor": anchor, class: "ax-label" }, a.label);
      svg.appendChild(t);
      const dot = s("circle", { cx: lx, cy: ly, r: 13, fill: "transparent" });
      bindTip(dot, `<b>${esc(a.label)}</b><br>value <b>${esc(a.raw)}</b>${a.scaled != null ? `<br>scaled <b>${Math.round(a.scaled * 100)}%</b>` : ""}<br><span class="tt-note">${esc(a.note || "")}</span>`);
      svg.appendChild(dot);
    });

    const have = values.map((v, i) => (v == null || !Number.isFinite(v) ? 0 : Math.max(0, Math.min(1, v))));
    const pts = have.map((v, i) => pt(i, R * v).join(",")).join(" ");
    svg.appendChild(s("polygon", {
      points: pts, fill: color || C.alt, "fill-opacity": 0.2,
      stroke: color || C.alt, "stroke-width": 2, class: "fade-in radar-poly",
    }));
    have.forEach((v, i) => {
      if (values[i] == null) return;
      const [x, y2] = pt(i, R * v);
      const c = s("circle", { cx: x, cy: y2, r: 3.5, fill: color || C.alt, stroke: "#0b1020", "stroke-width": 1.5, class: "fade-in" });
      bindTip(c, `<b>${esc(axes[i].label)}</b><br>${esc(axes[i].raw)}`);
      svg.appendChild(c);
    });

    el.appendChild(svg);
  }

  // ===================== CHART: amenity heatmap =====================
  function drawAmenities(el, stops) {
    const W = Math.max(320, el.clientWidth || 600);
    const nameW = Math.min(190, Math.max(110, Math.round(W * 0.34)));
    const cellH = 26, headH = 46;
    const H = headH + stops.length * cellH + 8;
    const cols = AMENITIES.length;
    const optW = 46;
    const cw = (W - nameW - optW - 12) / cols;
    const svg = s("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: "chart" });

    AMENITIES.forEach(([, short], i) => {
      const x = nameW + 6 + cw * i + cw / 2;
      svg.appendChild(s("text", {
        x, y: headH - 12, "text-anchor": "middle", class: "ax-tick",
        transform: `rotate(-28 ${x} ${headH - 12})`,
      }, short));
    });
    svg.appendChild(s("text", { x: W - optW / 2 - 4, y: headH - 12, "text-anchor": "middle", class: "ax-tick" }, "Optimal"));

    stops.forEach((st, r) => {
      const o = st.obs || {};
      const cy = headH + r * cellH + cellH / 2;
      svg.appendChild(s("text", { x: 0, y: cy + 4, class: "ax-label" }, truncate(st.name, 24)));

      AMENITIES.forEach(([field], i) => {
        const v = o[field];
        const x = nameW + 6 + cw * i + (cw - 16) / 2;
        const on = v === true;
        const rect = s("rect", {
          x, y: cy - 8, width: 16, height: 16, rx: 4,
          fill: on ? C.accent2 : "rgba(120,150,220,0.07)",
          stroke: on ? "none" : C.grid, "stroke-width": 1,
          "fill-opacity": on ? 0.85 : 1, class: "fade-in",
        });
        bindTip(rect, `<b>${esc(st.name)}</b><br>${esc(AMENITIES[i][1])}: <b>${v == null ? "not recorded" : on ? "present" : "absent"}</b><br><span class="tt-note">synthetic dataset field</span>`);
        svg.appendChild(rect);
      });

      const opt = o.Optimal_Stop;
      const bx = W - optW - 4;
      svg.appendChild(s("rect", {
        x: bx, y: cy - 9, width: optW, height: 18, rx: 9,
        fill: opt === true ? "rgba(52,211,153,0.16)" : opt === false ? "rgba(148,163,184,0.12)" : "rgba(251,191,36,0.14)",
      }));
      svg.appendChild(s("text", {
        x: bx + optW / 2, y: cy + 4, "text-anchor": "middle", class: "ax-badge",
        fill: opt === true ? C.good : opt === false ? C.faint : C.warn,
      }, opt == null ? "n/a" : opt ? "Yes" : "No"));
    });

    el.appendChild(svg);
  }

  function truncate(str, n) {
    const t = String(str == null ? "" : str);
    return t.length > n ? t.slice(0, n - 1) + "…" : t;
  }

  // ===================== DATA LOADING =====================
  async function loadAll() {
    const [runsRes, uniq, health] = await Promise.all([
      jget("/api/runs").catch(() => ({ runs: [] })),
      jget("/api/stops/unique").catch(() => ({ stops: [] })),
      jget("/api/health").catch(() => ({ mode: "unknown" })),
    ]);
    state.runs = runsRes.runs || [];
    state.mode = health.mode || "unknown";
    state.stops = (uniq.stops || []).map((u) => {
      const obs = (u.observations || []).slice().sort((a, b) => (a.Observation || 0) - (b.Observation || 0));
      return { name: u.name, sequence: u.sequence, observations: obs, obs: obs[0] || {} };
    }).sort((a, b) => a.sequence - b.sequence);
    for (const st of state.stops) for (const o of st.observations) if (o.Stop_Id) state.obsById.set(o.Stop_Id, o);

    // Non-blocking extras: the map and quality panel degrade to hidden if unavailable.
    jget("/api/network").then((g) => { state.geo = g; }).catch(() => { state.geo = null; });
    jget("/api/quality").then((q) => { state.quality = q; renderQuality(); }).catch(() => { state.quality = null; });
  }

  // Latest run per stop. /api/runs is newest-first, so first occurrence wins.
  function latestPerStop() {
    const seen = new Map();
    for (const r of state.runs) if (!seen.has(r.stopId)) seen.set(r.stopId, r);
    return [...seen.values()];
  }

  async function resolveRun() {
    const q = new URLSearchParams(location.search);
    const runId = q.get("runId"), stopId = q.get("stopId");
    if (runId) {
      const direct = state.runs.find((r) => r.runId === runId);
      if (direct) return direct;
      try { return await jget(`/api/runs/${encodeURIComponent(runId)}`); } catch (e) { /* fall through */ }
    }
    if (stopId) {
      const r = state.runs.find((x) => x.stopId === stopId);
      if (r) return r;
    }
    return state.runs[0] || null;
  }

  // ===================== RENDER: chrome =====================
  function renderMode() {
    const banner = $("mode-banner"), label = $("mode-label");
    if (state.mode === "REAL_SUMO") {
      banner.className = "mode-banner mode-real";
      label.textContent = "Live SUMO simulation";
    } else if (state.mode === "DEMO_MODE") {
      banner.className = "mode-banner mode-demo";
      label.textContent = "Precomputed SUMO results";
    } else {
      banner.className = "mode-banner mode-unknown";
      label.textContent = "backend offline";
    }
  }

  function renderPicker() {
    const sel = $("run-picker");
    sel.innerHTML = "";
    if (!state.runs.length) { sel.disabled = true; return; }
    for (const r of state.runs) {
      const o = document.createElement("option");
      o.value = r.runId;
      o.textContent = `${r.stopName || r.stopId} · ${relTime(r.completedAt)}`;
      if (state.run && r.runId === state.run.runId) o.selected = true;
      sel.appendChild(o);
    }
    sel.onchange = () => {
      const r = state.runs.find((x) => x.runId === sel.value);
      if (r) { state.run = r; history.replaceState(null, "", `?runId=${encodeURIComponent(r.runId)}`); renderAll(); }
    };
  }

  // ===================== RENDER: hero + verdict + KPIs =====================
  function renderHero(run) {
    $("hero-title").textContent = run.stopName || run.stopId;
    const bits = [
      `<code>${esc(run.stopId)}</code>`,
      `seed ${esc(run.seed)}`,
      `${esc(run.simDuration)} s simulated`,
      run.completedAt ? `run ${esc(relTime(run.completedAt))}` : "",
    ].filter(Boolean);
    $("hero-sub").innerHTML = bits.join(" · ");
    $("hero-eyebrow").textContent = run.alternativeFeasible
      ? "SUMO-validated comparison"
      : "No feasible relocation — alternative mirrors current";
  }

  function metricDeltas(run) {
    const out = [];
    for (const m of METRICS) {
      const cv = dig(run.current || {}, m.path), av = dig(run.alternative || {}, m.path);
      const pct = pctChange(cv, av);
      out.push({ m, cv, av, pct, better: isBetter(pct, m.dir) });
    }
    return out;
  }

  function renderVerdict(run) {
    const box = $("verdict");
    if (!run.alternativeFeasible) {
      box.className = "verdict verdict-none";
      box.innerHTML = `<div class="verdict-ico">⚠</div><div class="verdict-body">
        <div class="verdict-head">No relocation candidate</div>
        <div class="verdict-text">${esc(run.note || "The GIS search found no feasible alternative, so the alternative arm mirrors the current stop. This is not an improvement.")}</div>
      </div>`;
      return;
    }

    const d = metricDeltas(run).filter((x) => x.better != null);
    const better = d.filter((x) => x.better).length;
    const worse = d.length - better;
    const total = metricDeltas(run).filter((x) => x.pct != null && x.m.dir != null).length;

    const tt = metricDeltas(run).find((x) => x.m.k === "Avg travel time");
    const btt = metricDeltas(run).find((x) => x.m.k === "Bus travel time");

    let cls = "verdict-mixed", ico = "◐", head;
    if (better > worse) { cls = "verdict-good"; ico = "▲"; head = "Recommended stop performs better"; }
    else if (worse > better) { cls = "verdict-bad"; ico = "▼"; head = "Recommended stop performs worse"; }
    else { cls = "verdict-mixed"; ico = "◐"; head = "No clear difference"; }

    box.className = `verdict ${cls}`;
    box.innerHTML = `
      <div class="verdict-ico">${ico}</div>
      <div class="verdict-body">
        <div class="verdict-head">${esc(head)}</div>
        <div class="verdict-text">
          Better on <b>${better}</b> of ${total} directional SUMO metrics, worse on <b>${worse}</b>.
          ${tt && tt.pct != null ? `Average travel time <b>${esc(fmtPct(tt.pct))}</b>.` : ""}
          ${btt && btt.pct != null ? ` Bus travel time <b>${esc(fmtPct(btt.pct))}</b>.` : ""}
        </div>
        <div class="verdict-caveat">
          Single deterministic realisation at seed ${esc(run.seed)} — no confidence intervals are
          available, so differences under about 1% are indicative rather than proven.
          ${better + worse < total && total > 0 ? `${total - better - worse} metric(s) had no measurable change.` : ""}
        </div>
      </div>`;
  }

  function renderKpis(run) {
    const box = $("kpis");
    const gis = run.gis || {};
    const d = metricDeltas(run);
    const pick = (k) => d.find((x) => x.m.k === k) || {};

    const tt = pick("Avg travel time"), bt = pick("Bus travel time"),
      spd = pick("Avg speed"), q = pick("Max queue"), vc = pick("Vehicles completed");

    const tile = (label, sub, prov, tone) => `
      <div class="kpi ${tone || ""}">
        <div class="kpi-label">${esc(label)} <span class="prov-tag ${prov === "SUMO-measured" ? "prov-sumo" : "prov-derived"}">${esc(prov)}</span></div>
        <div class="kpi-value" data-kpi="${esc(label)}">—</div>
        <div class="kpi-sub">${sub}</div>
      </div>`;

    const deltaSub = (x, unit) => x && x.pct != null
      ? `<span class="${x.better == null ? "d-neu" : x.better ? "d-good" : "d-bad"}">${esc(fmtPct(x.pct))}</span> vs current ${esc(fmtNum(x.cv, unit))}`
      : `<span class="d-neu">no change measured</span>`;

    box.innerHTML =
      tile("Avg travel time", deltaSub(tt, "s"), "SUMO-measured", toneOf(tt)) +
      tile("Bus travel time", deltaSub(bt, "s"), "SUMO-measured", toneOf(bt)) +
      tile("Avg speed", deltaSub(spd, "m/s"), "SUMO-measured", toneOf(spd)) +
      tile("Max queue", deltaSub(q, "veh"), "SUMO-measured", toneOf(q)) +
      tile("Relocation",
        gis.relocationAlongCorridorM != null
          ? `<span class="d-neu">${esc(fmtNum(gis.relocationStraightLineM, "m"))} straight-line</span> · GIS-derived`
          : `<span class="d-neu">not available for this run</span>`,
        "GIS-derived", "");

    // Fill in the animated numbers now that the tiles exist.
    const setValue = (label, value, unit, dec) => {
      const el = box.querySelector(`[data-kpi="${label}"]`);
      if (!el) return;
      if (value == null || !Number.isFinite(value)) { el.textContent = "—"; return; }
      el.textContent = "";
      countUp(el, value, "", dec);
      if (unit) el.insertAdjacentHTML("beforeend", `<small>${esc(unit)}</small>`);
    };
    setValue("Avg travel time", tt.av, "s", 1);
    setValue("Bus travel time", bt.av, "s", 1);
    setValue("Avg speed", spd.av, "m/s", 2);
    setValue("Max queue", q.av, "veh", 0);
    setValue("Relocation",
      gis.relocationAlongCorridorM != null ? Math.abs(gis.relocationAlongCorridorM) : null, "m", 0);

    const vcEl = box.querySelector('[data-kpi="Avg travel time"]');
    if (vcEl && vc && vc.av != null) {
      vcEl.parentNode.title =
        `${vc.cv == null ? "—" : vc.cv} vehicles completed in the current arm, ` +
        `${vc.av} in the recommended arm (SUMO-measured).`;
    }
  }

  function toneOf(x) {
    if (!x || x.better == null) return "";
    return x.better ? "kpi-good" : "kpi-bad";
  }

  // ===================== RENDER: charts =====================
  function drawBus(el, run) {
    const busMetrics = METRICS.filter((m) => m.path[0] === "bus" && m.unit === "s");
    const groups = busMetrics.map((m) => ({
      label: m.k.replace("Bus ", ""),
      sub: "seconds",
      bars: [
        { value: dig(run.current || {}, m.path), color: C.cur, name: "current", tipHtml: tipFor(m, run, "current") },
        { value: dig(run.alternative || {}, m.path), color: C.alt, name: "recommended", tipHtml: tipFor(m, run, "recommended") },
      ],
    }));
    drawGrouped(el, groups, { height: 260, yTitle: "seconds", valueLabels: true, padB: 40 });
  }

  function renderBusLegend() {
    $("legend-bus").innerHTML = legendItems([
      [C.cur, "Current stop"], [C.alt, "Recommended stop"],
    ]) + `<span class="legend-note">These are three separate SUMO outputs, not a partition of one total — stop waiting overlaps delay.</span>`;
  }

  function tipFor(m, run, arm) {
    const v = dig(run[arm] || {}, m.path);
    const other = arm === "current" ? "alternative" : "current";
    const ov = dig(run[other] || {}, m.path);
    return `<b>${esc(m.k)}</b> · ${esc(arm)}<br>value <b>${esc(fmtNum(v, m.unit))}</b><br>
      other arm ${esc(fmtNum(ov, m.unit))}<br><span class="tt-note">SUMO-measured</span>`;
  }

  function legendItems(items) {
    return items.map(([c, t]) =>
      `<span class="lg"><i style="background:${c}"></i>${esc(t)}</span>`).join("");
  }

  function renderCrossChart() {
    const latest = latestPerStop();
    const m = METRICS[state.crossMetric];
    $("cross-count").innerHTML = latest.length
      ? `<b>${latest.length}</b> of ${state.stops.length} stops have been simulated.`
      : `No stops have been simulated yet.`;

    // toggle buttons (built once, then reused across runs)
    const tg = $("metric-toggle");
    if (!tg.childElementCount) {
      tg.innerHTML = METRICS.map((mm, i) =>
        `<button class="mtoggle${i === state.crossMetric ? " on" : ""}" data-i="${i}">${esc(mm.k)}</button>`).join("");
      tg.onclick = (ev) => {
        const b = ev.target.closest(".mtoggle");
        if (!b) return;
        state.crossMetric = Number(b.dataset.i);
        [...tg.children].forEach((c) => c.classList.toggle("on", c === b));
        renderCrossChart();
      };
    } else {
      [...tg.children].forEach((c, i) => c.classList.toggle("on", i === state.crossMetric));
    }

    function drawCross(el) {
      if (!latest.length) { el.appendChild(emptyChart("no runs recorded yet")); return; }
      // order groups by corridor sequence where we can match a stop
      const seqOf = (r) => {
        const st = state.stops.find((x) => x.observations.some((o) => o.Stop_Id === r.stopId));
        return st ? st.sequence : 999;
      };
      const ordered = latest.slice().sort((a, b) => seqOf(a) - seqOf(b));
      const groups = ordered.map((r) => {
        const highlight = state.run && r.runId === state.run.runId;
        return {
          label: truncate(r.stopName || r.stopId, 18),
          sub: highlight ? "viewing" : `seq ${seqOf(r)}`,
          bars: [
            { value: dig(r.current || {}, m.path), color: C.cur, tipHtml: tipForRun(m, r, "current") },
            { value: dig(r.alternative || {}, m.path), color: highlight ? C.altLight : C.alt, tipHtml: tipForRun(m, r, "alternative") },
          ],
        };
      });
      drawGrouped(el, groups, { height: 300, yTitle: m.unit || "value", valueLabels: true, barWidth: 22 });
    }

    mountChart("chart-cross", drawCross);
    $("legend-cross").innerHTML = legendItems([[C.cur, "Current stop"], [C.alt, "Recommended stop"]]);
    $("cross-caveat").innerHTML =
      `<b>Read this carefully.</b> The <span class="c-cur">current</span> arm is the same baseline
       corridor simulation for every stop — identical network, demand and seed, and the only file
       that changes between arms is one <code>&lt;busStop&gt;</code> lane. So a stop's bar height
       reflects corridor-wide traffic, not that stop's own conditions; only the
       <span class="c-alt">current → recommended</span> difference is attributable to the relocation.
       Stops without a run are absent rather than zero.`;
  }

  function tipForRun(m, r, arm) {
    const v = dig(r[arm] || {}, m.path);
    return `<b>${esc(r.stopName || r.stopId)}</b><br>${esc(m.k)} · ${esc(arm)}<br>
      value <b>${esc(fmtNum(v, m.unit))}</b><br>
      <span class="tt-note">${esc(arm)} arm · run ${esc(r.runId || "")}</span>`;
  }

  function renderDemandChart() {
    const stops = state.stops;
    if (!stops.length) { $("chart-demand").appendChild(emptyChart("dataset unavailable")); return; }
    const groups = stops.map((st) => {
      const o = st.obs || {};
      const isSel = state.run && st.observations.some((x) => x.Stop_Id === state.run.stopId);
      return {
        label: String(st.sequence),
        sub: truncate(st.name, 16),
        bars: [
          {
            value: o.Passenger_Count, color: isSel ? C.accent2 : C.cur,
            tipHtml: `<b>${esc(st.name)}</b> · seq ${esc(st.sequence)}<br>
              Passenger count <b>${o.Passenger_Count ?? "—"}</b><br>
              Peak hour <b>${o.Peak_Hour_Passengers ?? "—"}</b><br>
              Boarding ${esc(o.Boarding ?? "—")} · Alighting ${esc(o.Alighting ?? "—")}<br>
              Traffic level ${esc(o.Traffic_Level ?? "—")} · Land use ${esc(o.Land_Use ?? "—")}<br>
              <span class="tt-note">synthetic dataset field${isSel ? " · stop being viewed" : ""}</span>`,
          },
          {
            value: o.Peak_Hour_Passengers, color: isSel ? C.altLight : C.alt, dim: !isSel,
            tipHtml: `<b>${esc(st.name)}</b> · seq ${esc(st.sequence)}<br>
              Peak hour passengers <b>${o.Peak_Hour_Passengers ?? "—"}</b><br>
              <span class="tt-note">synthetic dataset field</span>`,
          },
        ],
        badge: o.Optimal_Stop == null ? null : o.Optimal_Stop ? "Yes" : "No",
      };
    });
    mountChart("chart-demand", (el) =>
      drawGrouped(el, groups, { height: 300, yTitle: "passengers", padB: 74, barWidth: 18 }));
    $("legend-demand").innerHTML = legendItems([
      [C.cur, "Passenger_Count"], [C.alt, "Peak_Hour_Passengers"], [C.accent2, "Stop being viewed"],
    ]) + `<span class="legend-note">Badge shows the dataset's <code>Optimal_Stop</code> label — a synthetic target, not a SUMO verdict.</span>`;
  }

  // Radar axes: min-max scaled across all stops so the shape is corridor-relative.
  function radarSpec(st) {
    const o = st.obs || {};
    const pool = state.stops.map((x) => x.obs || {});
    const range = (field) => {
      const vs = pool.map((p) => p[field]).filter((v) => typeof v === "number" && Number.isFinite(v));
      return vs.length ? [Math.min(...vs), Math.max(...vs)] : [0, 1];
    };
    const scale = (field, invert) => {
      const v = o[field];
      if (v == null || !Number.isFinite(v)) return null;
      const [lo, hi] = range(field);
      if (hi === lo) return 0.5;
      const k = (v - lo) / (hi - lo);
      return invert ? 1 - k : k;
    };
    const amenCount = AMENITIES.filter(([f]) => o[f] === true).length;

    const axes = [
      { label: "Safety", raw: `${o.Safety_Score_0_100 ?? "—"} /100`, scaled: num01(o.Safety_Score_0_100), note: "Safety_Score_0_100 (synthetic)" },
      { label: "Accessibility", raw: `${o.Accessibility_Score_0_100 ?? "—"} /100`, scaled: num01(o.Accessibility_Score_0_100), note: "Accessibility_Score_0_100 (synthetic)" },
      { label: "Demand", raw: `${o.Passenger_Count ?? "—"} pax`, scaled: scale("Passenger_Count", false), note: "Passenger_Count, min-max across the 11 stops (synthetic)" },
      { label: "Peak hour", raw: `${o.Peak_Hour_Passengers ?? "—"} pax`, scaled: scale("Peak_Hour_Passengers", false), note: "Peak_Hour_Passengers, min-max scaled (synthetic)" },
      { label: "Road width", raw: `${o.Road_Width_m ?? "—"} m`, scaled: scale("Road_Width_m", false), note: "Road_Width_m, min-max scaled (synthetic)" },
      { label: "Amenities", raw: `${amenCount} /${AMENITIES.length}`, scaled: amenCount / AMENITIES.length, note: "Count of shelter, seating, lighting, footpath, zebra, bus bay (synthetic)" },
      { label: "Density", raw: `${o.Population_Density_persons_km2 ?? "—"}/km²`, scaled: scale("Population_Density_persons_km2", false), note: "Population_Density_persons_km2, min-max scaled (synthetic)" },
      { label: "Short wait", raw: `${o.Waiting_Time_min ?? "—"} min`, scaled: scale("Waiting_Time_min", true), note: "Waiting_Time_min, inverted — further out is better (synthetic)" },
    ];
    return { axes, values: axes.map((a) => a.scaled) };
  }
  function num01(v) { return v == null || !Number.isFinite(v) ? null : Math.max(0, Math.min(1, v / 100)); }

  function renderRadar() {
    const st = state.stops.find((x) => x.observations.some((o) => o.Stop_Id === state.radarStopId))
      || state.stops.find((x) => x.observations.some((o) => o.Stop_Id === (state.run && state.run.stopId)))
      || state.stops[0];
    if (!st) { $("chart-radar").appendChild(emptyChart("dataset unavailable")); return; }
    state.radarStopId = st.observations[0] ? st.observations[0].Stop_Id : state.radarStopId;

    const sw = $("stop-switch");
    sw.innerHTML = state.stops.map((x) => {
      const id = x.observations[0] ? x.observations[0].Stop_Id : "";
      return `<button class="mtoggle${id === state.radarStopId ? " on" : ""}" data-sid="${esc(id)}">${esc(x.sequence)}. ${esc(truncate(x.name, 16))}</button>`;
    }).join("");
    sw.onclick = (ev) => {
      const b = ev.target.closest(".mtoggle");
      if (!b) return;
      state.radarStopId = b.dataset.sid;
      renderRadar();
    };

    const spec = radarSpec(st);
    const box = $("chart-radar");
    mountChart("chart-radar", (el) => drawRadar(el, spec.axes, spec.values, C.alt));

    const o = st.obs || {};
    const head = box.parentNode.querySelector(".dcard-sub");
    if (head) {
      head.innerHTML = `<b>${esc(st.name)}</b> · seq ${esc(st.sequence)} · land use
        ${esc(o.Land_Use ?? "—")} · traffic ${esc(o.Traffic_Level ?? "—")} ·
        ${esc(o.Hospital_Nearby ? "hospital" : "")}${esc(o.College_Nearby ? " college" : "")}${esc(o.School_Nearby ? " school" : "")}${esc(o.Commercial_Nearby ? " commercial" : "")}${esc(o.Residential_Nearby ? " residential" : "")} nearby.
        Each axis is min-max scaled across the 11 stops, so the shape is relative to this corridor
        only. <b>Waiting time is inverted</b> — further out is better.`;
    }
  }

  function renderAmenities() {
    mountChart("chart-amenities", (el) => drawAmenities(el, state.stops));
    $("legend-amenities").innerHTML = legendItems([
      [C.accent2, "Present"], ["rgba(120,150,220,0.16)", "Absent / not recorded"],
    ]) + `<span class="legend-note">All amenity fields are synthetic dataset values.</span>`;
  }

  // ===================== RENDER: relocation map =====================
  function renderRelocation(run) {
    const facts = $("reloc-facts");
    const gis = run.gis || {};
    const cand = run.candidate || {};
    const obs = obsFor(run.stopId);
    const geo = geoStopFor(run.stopId);

    const row = (k, v, prov, title) => `
      <div class="rf-row"${title ? ` title="${esc(title)}"` : ""}><span class="rf-k">${esc(k)} ${prov ? `<span class="prov-tag ${prov}">${esc(prov.replace("prov-", ""))}</span>` : ""}</span><span class="rf-v">${v}</span></div>`;

    const coord = (lat, lon) => (lat != null && lon != null) ? `${Number(lat).toFixed(6)}, ${Number(lon).toFixed(6)}` : "—";

    facts.innerHTML = `
      <div class="rf-block">
        <div class="rf-title">Current stop</div>
        ${row("SUMO lane", `<code>${esc(geo ? geo.laneId : "—")}</code>`, "prov-derived", "The lane the stop was snapped to in the OSM-derived network.")}
        ${row("Surveyed coordinate", coord(obs && obs.Latitude_Est, obs && obs.Longitude_Est), "prov-sourced", "Latitude_Est / Longitude_Est as recorded in the source dataset.")}
        ${row("Snapped position", coord(geo && geo.lat, geo && geo.lon), "prov-derived", "Where that coordinate lands on the real SUMO lane. This is the point SUMO simulates from.")}
        ${row("Stop→lane offset", gis.currentSnapResidualM != null ? `${esc(gis.currentSnapResidualM)} m` : "—", "prov-derived", "How far the surveyed coordinate sits from the lane it was snapped to. A network-fit measure, not a passenger walking distance.")}
      </div>
      <div class="rf-block">
        <div class="rf-title">Recommended stop</div>
        ${row("SUMO lane", `<code>${esc(cand.laneId || "—")}</code>`, "prov-derived")}
        ${row("Coordinate", coord(cand.lat, cand.lon), "prov-derived", "Projected from the real lane geometry, not invented.")}
        ${row("Junction score", cand.junctionScore != null ? esc(String(cand.junctionScore)) : "—", "prov-derived", "Heuristic weight for the downstream junction: more connections and/or a traffic light score higher.")}
        ${row("Edge length", cand.edgeLength != null ? `${esc(fmtNum(cand.edgeLength, "m"))}` : "—", "prov-derived")}
      </div>
      <div class="rf-block rf-move">
        <div class="rf-title">The move</div>
        ${row("Along corridor", gis.relocationAlongCorridorM != null ? `<b>${esc(fmtNum(gis.relocationAlongCorridorM, "m"))}</b>` : "—", "prov-derived", "Measured stop-position to stop-position along the corridor, including junction crossings.")}
        ${row("Straight line", gis.relocationStraightLineM != null ? `${esc(fmtNum(gis.relocationStraightLineM, "m"))}` : "—", "prov-derived", "Great-circle distance from the surveyed coordinate to the candidate. Differs slightly from the along-corridor figure because the two start from different points and follow different paths.")}
        ${row("Direction", gis.relocationAlongCorridorM != null ? (gis.relocationAlongCorridorM > 0 ? "further along the route" : gis.relocationAlongCorridorM < 0 ? "back along the route" : "no shift") : "—")}
        ${row("Walk added for existing users", gis.relocationStraightLineM != null ? `${esc(fmtNum(gis.relocationStraightLineM, "m"))}` : "—", "prov-derived", "Passengers who used the old site walk this much further. Not a distance from the road.")}
      </div>
      <div class="rf-note">
        ${esc(run.candidateProvenance || "")}
        ${!run.alternativeFeasible ? `<br><b>${esc(run.note || "No feasible relocation candidate — the alternative arm mirrors the current stop.")}</b>` : ""}
        ${gis.relocationAlongCorridorM == null ? `<br><b>This run predates the corrected GIS labelling — relocation distance is unavailable rather than zero.</b>` : ""}
      </div>`;

    drawMiniMap(run, geo, obs);
  }

  // The corridor GeoJSON carries the snapped lane position; the dataset carries the surveyed one.
  function geoStopFor(stopId) {
    if (!state.geo || !state.geo.features) return null;
    for (const f of state.geo.features) {
      const pr = f.properties || {};
      if (pr.kind === "stop" && pr.stopId === stopId && f.geometry) {
        return { laneId: pr.laneId, edgeId: pr.edgeId, name: pr.name, sequence: pr.sequence,
                 lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1] };
      }
    }
    return null;
  }

  function obsFor(stopId) {
    for (const st of state.stops) {
      const o = st.observations.find((x) => x.Stop_Id === stopId);
      if (o) return o;
    }
    return null;
  }

  function drawMiniMap(run, geo, obs) {
    const box = $("mini-map");
    if (!state.geo || !state.geo.features) {
      box.innerHTML = `<div class="map-missing">Corridor geometry is not built yet. Run
        <code>sim_build.py prepare</code> then <code>geojson</code>.</div>`;
      return;
    }
    if (state.map) { try { state.map.remove(); } catch (e) { } state.map = null; }
    box.innerHTML = "";

    const map = L.map(box, { zoomControl: true, preferCanvas: true, attributionControl: true });
    state.map = map;
    // Plain OSM raster: no API key, so the results page has no credential dependency.
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "&copy; OpenStreetMap contributors", maxZoom: 19,
    }).addTo(map);

    const corridor = [];
    for (const f of state.geo.features) {
      const pr = f.properties || {};
      if (pr.kind === "corridor" && f.geometry.type === "LineString") {
        for (const c of f.geometry.coordinates) corridor.push([c[1], c[0]]);
        L.polyline(corridor, { color: C.accent2, weight: 4, opacity: 0.8 })
          .bindPopup(`<b>Bus corridor</b><br>OSM-derived · ${esc(pr.edgeCount)} edges`).addTo(map);
      } else if (pr.kind === "stop") {
        const p = [f.geometry.coordinates[1], f.geometry.coordinates[0]];
        const isSel = pr.stopId === run.stopId;
        L.circleMarker(p, {
          radius: isSel ? 7 : 4, color: "#fff", weight: isSel ? 2 : 1,
          fillColor: isSel ? C.warn : C.cur, fillOpacity: isSel ? 1 : 0.7,
        }).bindPopup(`<b>${esc(pr.name)}</b><br>seq ${esc(pr.sequence)}${isSel ? "<br><i>stop being viewed · snapped position</i>" : ""}`).addTo(map);
      }
    }

    // Zoom on the relocation itself, not the whole 4.9km corridor — the move is the point.
    const focus = [];
    if (geo) focus.push([geo.lat, geo.lon]);
    if (obs && obs.Latitude_Est != null && obs.Longitude_Est != null) {
      const surveyed = [obs.Latitude_Est, obs.Longitude_Est];
      focus.push(surveyed);
      L.circleMarker(surveyed, {
        radius: 5, color: C.bad, weight: 2, fillColor: "#0b1020", fillOpacity: 1, dashArray: "3 3",
      }).bindPopup(`<b>Surveyed coordinate</b><br>${esc(obs.Latitude_Est)}, ${esc(obs.Longitude_Est)}<br><span class="tt-note">hollow red = where the dataset says the stop is, before snapping to the lane</span>`).addTo(map);
      if (geo) {
        L.polyline([surveyed, [geo.lat, geo.lon]], {
          color: C.bad, weight: 1.5, opacity: 0.7, dashArray: "2 4",
        }).bindPopup("<b>Snap residual</b><br>surveyed coordinate → SUMO lane").addTo(map);
      }
    }

    const cand = run.candidate || {};
    if (cand.lat != null && cand.lon != null) {
      const cp = [cand.lat, cand.lon];
      focus.push(cp);
      if (geo) {
        L.polyline([[geo.lat, geo.lon], cp], {
          color: C.alt, weight: 3, dashArray: "7 6", opacity: 0.95,
        }).bindPopup(`<b>Relocation</b><br>snapped current stop → recommended stop<br>dashed line = the move, not a walking path`).addTo(map);
      }
      L.marker(cp, {
        icon: L.divIcon({
          className: "",
          html: `<div class="rec-marker"><span>★</span></div>`,
          iconSize: [30, 30], iconAnchor: [15, 30],
        }),
      }).bindPopup(`<b>Recommended stop</b><br>lane ${esc(cand.laneId || "—")}<br>junction score ${esc(cand.junctionScore ?? "—")}<br><span class="tt-note">GIS rule-based candidate — SUMO validates, ML never decides (§11)</span>`).addTo(map);
    }

    if (focus.length >= 2) map.fitBounds(focus, { padding: [90, 90] });
    else if (focus.length === 1) map.setView(focus[0], 17);
    else if (corridor.length) map.fitBounds(corridor, { padding: [24, 24] });
    setTimeout(() => map.invalidateSize(), 60);
  }

  // ===================== RENDER: table =====================
  function renderTable(run) {
    const d = metricDeltas(run);
    const gis = run.gis || {};
    let rows = "";
    for (const x of d) {
      const cls = x.better == null ? "d-neu" : x.better ? "d-good" : "d-bad";
      rows += `<tr>
        <td class="t-k">${esc(x.m.k)} <span class="prov-tag prov-sumo">SUMO</span></td>
        <td class="t-num c-cur">${esc(fmtNum(x.cv, x.m.unit))}</td>
        <td class="t-num c-alt">${esc(fmtNum(x.av, x.m.unit))}</td>
        <td class="t-num ${cls}">${esc(fmtPct(x.pct))}</td>
        <td class="t-dir">${x.m.dir == null ? "context" : x.m.dir === "lower" ? "lower is better" : "higher is better"}</td>
      </tr>`;
    }
    rows += `<tr>
      <td class="t-k">Stop→lane offset <span class="prov-tag prov-derived">GIS</span></td>
      <td class="t-num c-cur">${gis.currentSnapResidualM != null ? esc(gis.currentSnapResidualM) + " m" : "—"}</td>
      <td class="t-num c-alt">${gis.recommendedSnapResidualM != null ? esc(gis.recommendedSnapResidualM) + " m" : "—"}</td>
      <td class="t-num d-neu">—</td>
      <td class="t-dir">network fit, not a walking distance</td>
    </tr>
    <tr>
      <td class="t-k">Relocation <span class="prov-tag prov-derived">GIS</span></td>
      <td class="t-num c-cur">—</td>
      <td class="t-num c-alt">${gis.relocationAlongCorridorM != null ? esc(fmtNum(gis.relocationAlongCorridorM, "m")) + " along corridor" : "—"}${gis.relocationStraightLineM != null ? `<br><span class="t-sub">${esc(fmtNum(gis.relocationStraightLineM, "m"))} straight line</span>` : ""}</td>
      <td class="t-num d-neu">—</td>
      <td class="t-dir">how far the stop itself moves</td>
    </tr>`;

    $("metric-table").innerHTML = `
      <table class="dtable">
        <thead><tr><th>Metric</th><th class="t-num">Current</th><th class="t-num">Recommended</th><th class="t-num">Change</th><th>Direction</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  // ===================== RENDER: provenance =====================
  function renderProvenance(run) {
    const items = [
      ["Run ID", run.runId || "—"],
      ["Completed", run.completedAt ? `${new Date(run.completedAt).toLocaleString()} (${relTime(run.completedAt)})` : "—"],
      ["Simulation duration", `${run.simDuration ?? "—"} s`],
      ["Random seed", `${run.seed ?? "—"} (single realisation, no repeats)`],
      ["Network", run.networkProvenance || "—"],
      ["Demand", run.demandProvenance || "—"],
      ["Candidate rule", run.candidateProvenance || "—"],
      ["Alternative feasible", run.alternativeFeasible ? "yes" : "no — alternative mirrors current"],
      ["Traffic + bus metrics", "SUMO-measured (tripinfo.xml)"],
      ["Stop→lane and relocation", "GIS-derived from the OSM network"],
      ["Passenger / amenity fields", "synthetic dataset values — not counts"],
    ];
    $("run-provenance").innerHTML = items.map(([k, v]) =>
      `<div class="pl-row"><span class="pl-k">${esc(k)}</span><span class="pl-v">${esc(v)}</span></div>`).join("");
  }

  function renderQuality() {
    const box = $("dataset-quality");
    const q = state.quality;
    if (!q) { box.innerHTML = `<div class="pl-row"><span class="pl-v">quality report unavailable</span></div>`; return; }
    const sh = q.shape || {};
    const mv = q.missingValues || {};
    const missing = Object.entries(mv).map(([f, where]) => `${f}: ${(where || []).join(", ")}`).join("; ") || "none";
    const coord = q.coordinates || {};
    const items = [
      ["Rows / unique stops", `${sh.rowCount ?? "—"} rows · ${sh.uniqueStops ?? "—"} unique stops`],
      ["Columns", `${sh.columnCount ?? "—"}`],
      ["Duplicate header rows", (q.structuralIssues && q.structuralIssues.duplicateHeaderRows || []).join(", ") || "none"],
      ["Missing values", missing],
      ["Coordinate range", coord.latRange ? `lat ${coord.latRange[0]}…${coord.latRange[1]}, lon ${coord.lonRange[0]}…${coord.lonRange[1]}` : "—"],
      ["Out of study area", (coord.outOfStudyArea || []).length ? coord.outOfStudyArea.join(", ") : "none"],
      ["Corrections applied", (coord.correctionsApplied || []).length ? coord.correctionsApplied.join(", ") : "none"],
      ["Target distribution", q.target ? `Optimal_Stop true ${q.target.distribution.true} · false ${q.target.distribution.false} · null ${q.target.distribution.null}` : "—"],
      ["Leakage risk", q.target && q.target.leakageRisk ? `${q.target.leakageRisk.independentEntities} independent entities across ${q.target.leakageRisk.rows} rows — split by stop, never by row` : "—"],
      ["Generated", q.generatedAt ? new Date(q.generatedAt).toLocaleString() : "—"],
    ];
    box.innerHTML = items.map(([k, v]) =>
      `<div class="pl-row"><span class="pl-k">${esc(k)}</span><span class="pl-v">${esc(v)}</span></div>`).join("");
  }

  // ===================== MASTER RENDER =====================
  function renderAll() {
    const run = state.run;
    state.charts = [];
    renderMode();
    renderPicker();
    renderHero(run);
    renderVerdict(run);
    renderKpis(run);

    mountChart("chart-delta", (el) => drawDelta(el, run));
    mountChart("chart-bus", (el) => drawBus(el, run));
    renderBusLegend();

    renderRelocation(run);
    renderCrossChart();
    renderDemandChart();
    state.radarStopId = run.stopId;
    renderRadar();
    renderAmenities();
    renderTable(run);
    renderProvenance(run);
    if (state.quality) renderQuality();
  }

  // ===================== BOOT =====================
  async function boot() {
    try {
      await loadAll();
    } catch (e) {
      fail(`Could not reach the API: ${e.message}`);
      return;
    }
    if (!state.runs.length) {
      $("dash-loading").hidden = true;
      $("dash-content").hidden = true;
      const f = $("dash-fatal");
      f.hidden = false;
      f.innerHTML = `<b>No simulation results yet.</b><br>
        Pick a bus stop on the <a href="/">map</a> and run a simulation — the results page opens
        automatically when it finishes. Nothing is shown here until a real SUMO run exists (§11).`;
      return;
    }
    state.run = await resolveRun();
    if (!state.run) { fail("That run could not be found."); return; }

    // The map needs the corridor GeoJSON, which loads in the background.
    if (!state.geo) {
      try { state.geo = await jget("/api/network"); } catch (e) { state.geo = null; }
    }

    $("dash-loading").hidden = true;
    $("dash-content").hidden = false;
    renderAll();

    // smooth-scroll the section nav without hijacking the URL history
    $("dashnav").addEventListener("click", (ev) => {
      const a = ev.target.closest("a[href^='#']");
      if (!a) return;
      ev.preventDefault();
      const t = document.querySelector(a.getAttribute("href"));
      if (t) t.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    let resizeTimer = null;
    window.addEventListener("resize", () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(redrawAll, 180);
    });
  }

  function fail(msg) {
    $("dash-loading").hidden = true;
    $("dash-content").hidden = true;
    const f = $("dash-fatal");
    f.hidden = false;
    f.innerHTML = esc(msg);
  }

  boot();
})();
