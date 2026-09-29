// Environment / SUMO availability detection (§5.1, §2.6, §8).
// We report the TRUTH: if SUMO is missing, the app must say so and run in DEMO MODE —
// never fake traffic. This module only detects; it does not simulate.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function which(cmd) {
  try {
    const out = execFileSync("which", [cmd], { encoding: "utf8" }).trim();
    return out || null;
  } catch {
    return null;
  }
}

function version(binPath, args = ["--version"]) {
  try {
    return execFileSync(binPath, args, { encoding: "utf8" }).split("\n")[0].trim();
  } catch {
    return null;
  }
}

// Candidate SUMO bin directories, in priority order. We check these even when SUMO is
// not on PATH, so the server detects a user-local install (no sudo) without shell config.
function candidateBinDirs() {
  const dirs = [];
  if (process.env.SUMO_HOME) dirs.push(path.join(process.env.SUMO_HOME, "bin"));
  dirs.push(path.join(os.homedir(), "Applications", "Sumo", "bin")); // macOS no-sudo install
  dirs.push("/Applications/Sumo/bin");  // macOS official .pkg install
  dirs.push("/usr/bin");                 // Linux apt-get install sumo (Ubuntu/Debian/Render)
  dirs.push("/usr/local/bin");           // Linux local install
  dirs.push("/opt/homebrew/bin");        // Homebrew on Apple Silicon
  return dirs;
}

// Resolve a SUMO binary: PATH first, then known install dirs.
function resolveBin(name) {
  const onPath = which(name);
  if (onPath) return onPath;
  for (const dir of candidateBinDirs()) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// Best-effort SUMO_HOME: env var, else derived from the resolved bin dir (bin/.. /share/sumo).
function resolveSumoHome(sumoBin) {
  if (process.env.SUMO_HOME) return process.env.SUMO_HOME;
  if (!sumoBin) return null;
  const root = path.resolve(path.dirname(sumoBin), ".."); // .../Sumo
  // Linux apt install: sumo is at /usr/bin/sumo, tools are at /usr/share/sumo/tools
  const linuxShare = "/usr/share/sumo";
  if (fs.existsSync(linuxShare)) return linuxShare;
  const share = path.join(root, "share", "sumo");
  return fs.existsSync(share) ? share : root;
}

// Pick a Python whose XML parser works. This machine's Homebrew Python 3.14 has a broken
// pyexpat/xml.sax, which SUMO's tools (randomTrips.py, traci, sumolib) require. macOS
// system Python 3.9 (/usr/bin/python3) works, so prefer it for the TraCI bridge.
// On Linux (Render/Ubuntu), python3 from apt is fully functional.
function resolveTraciPython() {
  const candidates = [
    process.env.SUMO_PYTHON,
    "/usr/bin/python3",   // macOS system + Ubuntu apt python3
    which("python3"),
    which("python"),
    "/usr/local/bin/python3",
  ].filter(Boolean);
  // dedupe while preserving order
  const seen = new Set();
  const unique = candidates.filter((p) => { if (seen.has(p)) return false; seen.add(p); return true; });
  for (const py of unique) {
    try {
      execFileSync(
        py,
        ["-c", "import xml.sax; xml.sax.make_parser(); print('ok')"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
      );
      return { path: py, xmlOk: true };
    } catch {
      // try next candidate
    }
  }
  return { path: unique[0] || null, xmlOk: false };
}

export function detectSumo() {
  const sumo = resolveBin("sumo");
  const netconvert = resolveBin("netconvert");
  const sumoGui = resolveBin("sumo-gui");
  const sumoHome = resolveSumoHome(sumo);
  const traciPython = resolveTraciPython();
  const available = !!sumo && !!netconvert;
  return {
    available,
    mode: available ? "REAL_SUMO" : "DEMO_MODE",
    sumoHome,
    binaries: {
      sumo,
      netconvert,
      sumoGui,
      // Node has no TraCI/libsumo bindings; live stepping uses a Python TraCI bridge.
      traciPython: traciPython.path,
      traciPythonXmlOk: traciPython.xmlOk,
      traciToolsDir: sumoHome ? path.join(sumoHome, "tools") : null,
      libsumo: false, // libsumo Python binding not shipped in this package; use TraCI
    },
    versions: {
      sumo: sumo ? version(sumo) : null,
      netconvert: netconvert ? version(netconvert) : null,
    },
    note: available
      ? `SUMO detected (${sumo}). Real microsimulation is possible.`
      : "SUMO not installed (or not on PATH / SUMO_HOME unset). The app runs in DEMO MODE and must not fabricate traffic. See docs/SUMO_SETUP.md.",
  };
}

export function detectEnvironment() {
  return {
    node: process.version,
    platform: process.platform,
    sumo: detectSumo(),
  };
}
