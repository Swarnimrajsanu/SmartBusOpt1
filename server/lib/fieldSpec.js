// Field type specification for the normalized dataset.
// Drives dtype coercion (§3.2 — every cell is stored as a string in the source xlsx)
// and provenance tagging (§3.6 — only name + sequence are "sourced"; the rest are synthetic).

import { PROVENANCE } from "./config.js";

// type: number | int | boolYesNo | string
// provenance: the source type applied to every value of this field (§4 honesty labels)
export const FIELD_SPEC = {
  Bus_Stop_Name: { type: "string", provenance: PROVENANCE.SOURCED },
  Sequence: { type: "int", provenance: PROVENANCE.SOURCED },
  Latitude_Est: { type: "number", provenance: PROVENANCE.SOURCED },
  Longitude_Est: { type: "number", provenance: PROVENANCE.SOURCED },
  Road_Width_m: { type: "number", provenance: PROVENANCE.SYNTHETIC },
  Distance_to_Next_Stop_m: { type: "number", provenance: PROVENANCE.SYNTHETIC },
  Boarding: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Alighting: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Passenger_Count: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Peak_Hour_Passengers: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Traffic_Level: { type: "string", provenance: PROVENANCE.SYNTHETIC },
  School_Nearby: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  College_Nearby: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Industry_Nearby: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Hospital_Nearby: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Residential_Nearby: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Commercial_Nearby: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Bus_Shelter: { type: "boolYesNo", provenance: PROVENANCE.SYNTHETIC },
  Seating: { type: "boolYesNo", provenance: PROVENANCE.SYNTHETIC },
  Street_Lighting: { type: "boolYesNo", provenance: PROVENANCE.SYNTHETIC },
  Footpath: { type: "boolYesNo", provenance: PROVENANCE.SYNTHETIC },
  Zebra_Crossing: { type: "boolYesNo", provenance: PROVENANCE.SYNTHETIC },
  Bus_Bay: { type: "boolYesNo", provenance: PROVENANCE.SYNTHETIC },
  Walking_Distance_m: { type: "number", provenance: PROVENANCE.SYNTHETIC },
  Waiting_Time_min: { type: "number", provenance: PROVENANCE.SYNTHETIC },
  Dwell_Time_sec: { type: "number", provenance: PROVENANCE.SYNTHETIC },
  Population_Density_persons_km2: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Land_Use: { type: "string", provenance: PROVENANCE.SYNTHETIC },
  Safety_Score_0_100: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Accessibility_Score_0_100: { type: "int", provenance: PROVENANCE.SYNTHETIC },
  Optimal_Stop: { type: "boolYesNo", provenance: PROVENANCE.SYNTHETIC }, // TARGET
  Data_Status: { type: "string", provenance: PROVENANCE.SOURCED },
};

export function coerce(rawValue, type) {
  if (rawValue === null || rawValue === undefined) return null;
  const s = String(rawValue).trim();
  if (s === "") return null;
  switch (type) {
    case "int": {
      const n = Number(s);
      return Number.isFinite(n) ? Math.round(n) : null;
    }
    case "number": {
      const n = Number(s);
      return Number.isFinite(n) ? n : null;
    }
    case "boolYesNo": {
      const low = s.toLowerCase();
      if (low === "yes" || low === "1" || low === "true") return true;
      if (low === "no" || low === "0" || low === "false") return false;
      return null;
    }
    case "string":
    default:
      return s;
  }
}
