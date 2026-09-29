// SUMO environment resolution for spawning the Python TraCI bridge (§5.1).
// The bridge needs SUMO_HOME, PYTHONPATH (tools), and PROJ_DATA/PROJ_LIB (proj.db) so the
// network's geo-projection resolves. We derive all of these from the detected sumo binary
// rather than assuming shell config, so the server works even without SUMO_HOME exported.

import fs from "node:fs";
import path from "node:path";
import { detectSumo } from "./env.js";

// Find the bundled proj.db directory under the SUMO framework (macOS .pkg layout).
function resolveProjDir(sumoRoot) {
  if (!sumoRoot) return null;
  const fwBase = path.join(sumoRoot, "framework", "EclipseSUMO.framework", "Versions");
  try {
    const versions = fs.readdirSync(fwBase).filter((v) => v !== "Current");
    for (const v of versions) {
      const p = path.join(fwBase, v, "EclipseSUMO", "share", "proj");
      if (fs.existsSync(path.join(p, "proj.db"))) return p;
    }
  } catch {
    // not the framework layout
  }
  // linux/other layout: share/proj relative to root
  const alt = path.join(sumoRoot, "share", "proj");
  if (fs.existsSync(path.join(alt, "proj.db"))) return alt;
  return null;
}

// Build the env object for a child process that runs SUMO tools / TraCI.
export function sumoChildEnv() {
  const sumo = detectSumo();
  const bin = sumo.binaries || {};
  const env = { ...process.env };

  const sumoBin = bin.sumo;
  let sumoRoot = null;
  if (sumoBin) sumoRoot = path.resolve(path.dirname(sumoBin), ".."); // .../Sumo

  const sumoHome = sumo.sumoHome || (sumoRoot ? path.join(sumoRoot, "share", "sumo") : null);

  if (sumoHome) {
    env.SUMO_HOME = sumoHome;
    // On Linux apt install, sumoHome IS /usr/share/sumo (tools live at sumoHome/tools).
    // On macOS, tools live at sumoHome/tools too, but sumoHome may be the share/sumo dir.
    const toolsDir = path.join(sumoHome, "tools");
    const pythonPathParts = [toolsDir];
    // Also include dist-packages for system traci/sumolib installed via apt python3-sumo
    if (process.platform === "linux") {
      pythonPathParts.push("/usr/lib/python3/dist-packages");
    }
    if (env.PYTHONPATH) pythonPathParts.push(env.PYTHONPATH);
    env.PYTHONPATH = pythonPathParts.filter(Boolean).join(path.delimiter);
  }

  // proj.db: only needed on macOS framework layout — on Linux, libproj handles it natively.
  if (process.platform !== "linux") {
    const projDir = resolveProjDir(sumoRoot);
    if (projDir) {
      env.PROJ_DATA = projDir;
      env.PROJ_LIB = projDir;
    }
  }

  if (sumoBin) env.SUMO_BIN = sumoBin;

  return {
    env,
    python: bin.traciPython,
    pythonXmlOk: bin.traciPythonXmlOk,
    sumoBin,
    sumoHome,
    projDir: null,
    available: sumo.available,
    mode: sumo.mode,
  };
}
