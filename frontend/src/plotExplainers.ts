export interface PlotExplainer {
  title: string;
  formula: string;
  secondaryFormula?: string;
  requires: string[];
  notes: string[];
}

const CYCLE_EXPLAINERS: Record<string, PlotExplainer> = {
  discharge_capacity: {
    title: "Discharge capacity",
    formula: "Absolute: max discharge capacity reached in each cycle, in mAh.",
    requires: ["discharge_capacity_mah"],
    notes: [
      "Neware reports capacity at each time point; CellXplorer stores the per-cycle maximum from the discharge step.",
    ],
  },
  charge_capacity: {
    title: "Charge capacity",
    formula: "Absolute: max charge capacity reached in each cycle, in mAh.",
    requires: ["charge_capacity_mah"],
    notes: [
      "Neware reports capacity at each time point; CellXplorer stores the per-cycle maximum from the charge step.",
    ],
  },
  coulombic_efficiency: {
    title: "Coulombic efficiency",
    formula: "CE (%) = discharge capacity / charge capacity x 100.",
    requires: ["charge_capacity_mah", "discharge_capacity_mah"],
    notes: ["Undefined values are left empty when the charge capacity is zero or missing."],
  },
  discharge_energy: {
    title: "Discharge energy",
    formula: "Integrated discharge energy per cycle, in mWh.",
    requires: ["discharge_energy_mwh"],
    notes: ["Energy values come from the cached per-cycle summary generated from raw cycling records."],
  },
  charge_energy: {
    title: "Charge energy",
    formula: "Integrated charge energy per cycle, in mWh.",
    requires: ["charge_energy_mwh"],
    notes: ["Energy values come from the cached per-cycle summary generated from raw cycling records."],
  },
  energy_efficiency: {
    title: "Energy efficiency",
    formula: "EE (%) = discharge energy / charge energy x 100.",
    requires: ["charge_energy_mwh", "discharge_energy_mwh"],
    notes: ["Undefined values are left empty when the charge energy is zero or missing."],
  },
  voltaic_efficiency: {
    title: "Voltaic efficiency",
    formula: "VE (%) = energy efficiency / coulombic efficiency x 100.",
    requires: ["energy_efficiency_pct", "coulombic_efficiency_pct"],
    notes: ["This is derived from the cached CE and EE values for each cycle."],
  },
  mean_charge_voltage: {
    title: "Mean charge voltage",
    formula: "Arithmetic mean of voltage samples during charge steps in each cycle.",
    requires: ["voltage_v", "status"],
    notes: ["Charge rows are identified from the Neware step/status labels."],
  },
  mean_discharge_voltage: {
    title: "Mean discharge voltage",
    formula: "Arithmetic mean of voltage samples during discharge steps in each cycle.",
    requires: ["voltage_v", "status"],
    notes: ["Discharge rows are identified from the Neware step/status labels."],
  },
  polarization: {
    title: "Polarization (DeltaV)",
    formula: "DeltaV = selected charge voltage - selected discharge voltage.",
    requires: ["voltage_v", "status"],
    notes: [
      "The voltage-pair definition is controlled by the Polarization settings.",
      "The sign can be charge minus discharge or discharge minus charge.",
    ],
  },
  polarization_pct: {
    title: "Polarization (% DeltaV)",
    formula: "% DeltaV = DeltaV / selected reference voltage x 100.",
    requires: ["voltage_v", "status"],
    notes: [
      "DeltaV is calculated from charge and discharge voltages in the same cycle.",
      "The exact voltage pair and sign follow the Polarization settings.",
    ],
  },
  capacity_retention: {
    title: "Capacity retention / SoH",
    formula: "SoH (%) = discharge capacity / selected reference discharge capacity x 100.",
    requires: ["discharge_capacity_mah"],
    notes: [
      "The reference is either the maximum within the first N cycles or a specific reference cycle.",
    ],
  },
  discharge_capacity_loss: {
    title: "Discharge capacity loss",
    formula: "Loss (mAh/cycle) = reference discharge capacity - discharge capacity.",
    requires: ["discharge_capacity_mah"],
    notes: ["The reference follows the Retention reference setting in the Cycles section."],
  },
  charge_capacity_loss: {
    title: "Charge capacity loss",
    formula: "Loss (mAh/cycle) = reference charge capacity - charge capacity.",
    requires: ["charge_capacity_mah"],
    notes: ["The reference follows the Retention reference setting in the Cycles section."],
  },
  cycle_duration: {
    title: "Cycle duration",
    formula: "Cycle duration (h) = last timestamp in cycle - first timestamp in cycle.",
    requires: ["timestamp", "cycle"],
    notes: ["Reported in hours from the cached per-cycle summary."],
  },
  charge_time: {
    title: "Charge time",
    formula: "Charge time (h) = duration of rows identified as charge steps.",
    requires: ["timestamp", "status"],
    notes: ["Reported in hours from the cached per-cycle summary."],
  },
  discharge_time: {
    title: "Discharge time",
    formula: "Discharge time (h) = duration of rows identified as discharge steps.",
    requires: ["timestamp", "status"],
    notes: ["Reported in hours from the cached per-cycle summary."],
  },
  cv_charge_time: {
    title: "CV charge time",
    formula: "CV charge time is the summed duration of charge records in the constant-voltage region of each cycle.",
    requires: ["status", "time_s", "voltage_v", "current_ma"],
    notes: [
      "Explicit CV charge steps are measured directly.",
      "For combined CCCV steps, CV begins when the terminal voltage plateau is reached and current tapers.",
    ],
  },
  cv_charge_capacity: {
    title: "CV charge capacity",
    formula: "CV charge capacity is the charge transferred during the detected CV region, in mAh.",
    requires: ["charge_capacity_mah", "status", "voltage_v", "current_ma"],
    notes: ["This is charge transferred in CV, not the instantaneous current during CV."],
  },
  cv_charge_fraction: {
    title: "CV charge fraction",
    formula: "CV fraction (%) = CV charge capacity / total charge capacity x 100.",
    requires: ["cv_charge_capacity_mah", "charge_capacity_mah"],
    notes: ["Undefined when total charge capacity is zero or missing."],
  },
  cv_charge_events: {
    title: "CV charge events",
    formula: "Count of explicit or detected CV charge regions in each cycle.",
    requires: ["status", "voltage_v", "current_ma"],
    notes: ["A cycle can contain more than one CV event when the protocol has multiple charge steps."],
  },
  cv_reached: {
    title: "CV reached",
    formula: "1 when at least one CV charge region is reached in the cycle; otherwise 0.",
    requires: ["status", "voltage_v", "current_ma"],
    notes: ["For CCCV steps, a voltage plateau and current taper are required."],
  },
};

const NORMALIZED: Record<string, string> = {
  discharge_capacity: "Discharge capacity (mAh/g) = discharge capacity (mAh) / active material mass (g).",
  charge_capacity: "Charge capacity (mAh/g) = charge capacity (mAh) / active material mass (g).",
  discharge_energy: "Discharge energy (mWh/g) = discharge energy (mWh) / active material mass (g).",
  charge_energy: "Charge energy (mWh/g) = charge energy (mWh) / active material mass (g).",
  discharge_capacity_loss:
    "Discharge capacity loss (mAh/g/cycle) = discharge capacity loss (mAh/cycle) / active material mass (g).",
  charge_capacity_loss:
    "Charge capacity loss (mAh/g/cycle) = charge capacity loss (mAh/cycle) / active material mass (g).",
  cv_charge_capacity:
    "CV charge capacity (mAh/g) = CV charge capacity (mAh) / active material mass (g).",
};

export function getCycleQuantityExplainer(quantity: string, normalizeByMass: boolean): PlotExplainer {
  const base = CYCLE_EXPLAINERS[quantity] ?? {
    title: quantity.replace(/_/g, " "),
    formula: "This quantity is read from the cached per-cycle table.",
    requires: [],
    notes: [],
  };
  if (!normalizeByMass || !(quantity in NORMALIZED)) return base;
  return {
    ...base,
    formula: NORMALIZED[quantity],
    requires: Array.from(new Set([...base.requires, "active_material_mg"])),
    notes: [
      ...base.notes,
      "Cells without active material mass cannot contribute normalized values.",
    ],
  };
}

export function getTimeCapacityExplainer(
  xAxis: "time" | "capacity_mah" | "capacity_mah_g",
  currentAxis: "none" | "current_ma" | "current_density" | "c_rate",
  view: "voltage_current" | "dqdv" | "dvdq" = "voltage_current",
  derivativeSpecific = false,
  smoothingWindow = 7,
): PlotExplainer {
  if (view === "dqdv") {
    return {
      title: "Incremental capacity analysis (ICA)",
      formula: derivativeSpecific ? "dQ/dV from specific capacity (mAh/g) versus voltage." : "dQ/dV from capacity (mAh) versus voltage.",
      requires: ["voltage_v", "charge_capacity_mah", "discharge_capacity_mah"],
      notes: [
        `Voltage and capacity are centered-smoothed over ${smoothingWindow} points before numerical differentiation.`,
        "Charge and discharge can be plotted separately; discharge can retain its sign or be shown as an absolute derivative.",
      ],
    };
  }
  if (view === "dvdq") {
    return {
      title: "Differential voltage analysis (DVA)",
      formula: derivativeSpecific ? "dV/dQ versus specific capacity (mAh/g)." : "dV/dQ versus capacity (mAh).",
      requires: ["voltage_v", "charge_capacity_mah", "discharge_capacity_mah"],
      notes: [
        `Voltage and capacity are centered-smoothed over ${smoothingWindow} points before numerical differentiation.`,
        "Charge and discharge can be plotted separately; discharge can retain its sign or be shown as an absolute derivative.",
      ],
    };
  }
  const xInfo =
    xAxis === "time"
      ? {
          title: "Voltage/current vs time",
          formula: "Time is the elapsed raw-record time within the selected cycle window.",
          requires: ["time_s", "voltage_v", "current_ma"],
        }
      : xAxis === "capacity_mah"
        ? {
            title: "Voltage/current vs capacity",
            formula: "Capacity is the raw cumulative capacity reported during each half-cycle, in mAh.",
            requires: ["capacity_mah", "voltage_v", "current_ma"],
          }
        : {
            title: "Voltage/current vs specific capacity",
            formula: "Specific capacity (mAh/g) = capacity (mAh) / active material mass (g).",
            requires: ["capacity_mah", "active_material_mg", "voltage_v", "current_ma"],
          };

  const currentFormula =
    currentAxis === "current_density"
      ? "Current density (mA/cm2) = current (mA) / electrode area (cm2)."
      : currentAxis === "c_rate"
        ? "C-rate (C) = current (mA) / nominal capacity (mAh)."
        : undefined;

  return {
    ...xInfo,
    secondaryFormula: currentFormula,
    requires:
      currentAxis === "current_density"
        ? Array.from(new Set([...xInfo.requires, "electrode_area_cm2"]))
        : currentAxis === "c_rate"
          ? Array.from(new Set([...xInfo.requires, "nominal_capacity_mah"]))
          : xInfo.requires,
    notes: [
      "Consecutive mode keeps elapsed time/capacity continuous; overlap modes reset or mirror each half-cycle for comparison.",
      "The current panel is optional and can use current, current density, or C-rate.",
    ],
  };
}
