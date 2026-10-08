// Temperatures are K; emissivity, Mach and power are dimensionless.
// All zone defaults and ranges are estimated family envelopes, not calibrated vehicles.
const turbofanSource = "Estimated separate-flow climb surfaces; a published study supplies a different-engine temperature scale only. No Trent 500 metal thermometry or finish measurements.";

// Estimated load-coordinate mapping, not a measured throttle or engine deck.
// Climb is P=0.90 at Mach 0.82; ambient is calculated at 7500 m as
// 288.15 - 0.0065*7500 = 239.40 K. Keep the existing (P/Pref)^0.7 law.
export const TURBOFAN_CLIMB_REFERENCE = Object.freeze({
    powerFraction: 0.90, mach: 0.82, ambientK: 239.40,
    ambientKStatus: "calculated",
    status: "estimated", source: "Declared climb operating point; standard-atmosphere lapse calculation for ambientK",
});

function turbofanZone(id, temperatureK, rangeK, emissivity, emissivityRange, notes, radiatorKind = "surface") {
    return {id, vehicle_class: "high_bypass_turbofan", radiator_kind: radiatorKind,
        temperature_K: {min: rangeK[0], max: rangeK[1], default: temperatureK, status: "estimated", source: turbofanSource},
        emissivity_3_5: {min: emissivityRange[0], max: emissivityRange[1], default: emissivity, status: "estimated", source: turbofanSource},
        scaling: "Recovery temperature plus reference excess times (P/0.90)^0.7; reference ambient 239.40 K, Mach 0.82.",
        source_ids: ["STUDY", "PRIOR"], source: turbofanSource, notes};
}

export const ZONE_TABLE = [
    // Separate-flow zones use disjoint visible regions, including plug/nozzle occlusion.
    // The intervals are estimated sensitivities, not operating limits or measurements.
    turbofanZone("turbofan_cavity", 750, [650, 850], 0.90, [0.70, 0.98],
        "Effective aft turbine/support aperture, including interreflection; no additional turbine disk.", "cavity"),
    turbofanZone("turbofan_plug", 650, [550, 750], 0.35, [0.05, 0.80],
        "Projecting core plug and visible upstream shoulder; finish and oxidation unknown."),
    turbofanZone("turbofan_core_nozzle", 550, [450, 650], 0.30, [0.05, 0.80],
        "Converging core nozzle exterior, cooled by bypass and external flow."),
    turbofanZone("turbofan_core_inner", 700, [600, 800], 0.80, [0.40, 0.95],
        "Nozzle inner wall exposed off axis; effective emissivity includes interior reflections."),
    turbofanZone("turbofan_fan_duct", 290, [260, 330], 0.70, [0.30, 0.95],
        "Effective cool fan duct, guide structures and lip; not an opaque bypass-gas emitter."),
    turbofanZone("turbofan_pylon_shield", 450, [350, 550], 0.30, [0.05, 0.80],
        "Disjoint pylon end/underside allowance; no measured shield geometry or temperature."),
    {
        "id": "jet_nozzle",
        "vehicle_class": "jet",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 400,
            "max": 1000,
            "default": 600,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.05,
            "max": 0.85,
            "default": 0.3,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Wall energy balance; rises with dry power, reduced by internal/bypass cooling and external airspeed. Hot metal does not equal gas total temperature.",
        "source_ids": [
            "STUDY",
            "CAMERADATA",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "jet_cavity",
        "vehicle_class": "jet",
        "radiator_kind": "cavity",
        "temperature_K": {
            "min": 550,
            "max": 1100,
            "default": 750,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.7,
            "max": 1,
            "default": 0.95,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Aperture radiance rises strongly with hot-wall temperature; view and obstruction determine visible hot area. Power changes wall temperature, not a linear radiance gain.",
        "source_ids": [
            "STUDY",
            "PRIOR"
        ],
        "notes": "Effective apparent cavity temperature/emissivity; do not add a turbine disc on top of the same aperture."
    },
    {
        "id": "turbine_exit_total",
        "vehicle_class": "jet",
        "radiator_kind": "state_only",
        "temperature_K": {
            "min": 650,
            "max": 1100,
            "default": 850,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": null,
        "scaling": "Use engine-specific total-temperature deck versus shaft power and inlet state; Tstatic=Ttotal/(1+(gamma_g-1)*Mexit^2/2).",
        "source_ids": [
            "STUDY",
            "F404",
            "PRIOR"
        ],
        "notes": "Internal state only. Turbine inlet temperature, turbine exit temperature, indicated EGT and nozzle-exit static temperature are distinct."
    },
    {
        "id": "jet_plume",
        "vehicle_class": "jet",
        "radiator_kind": "gas",
        "temperature_K": {
            "min": 450,
            "max": 950,
            "default": 650,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": null,
        "scaling": "Tcenter=Ta+(Te-Ta)*min(1,Lc/x); radius=D/2+s*x. Hotter/more powerful flow generally increases radiance; coflow can lengthen mixing core; density, species and crosswind matter.",
        "source_ids": [
            "SPECTRALDB",
            "JET",
            "JETDECAY",
            "PRIOR"
        ],
        "notes": "Gas emissivity=1-exp(-integral k_lambda ds), not a gray surface. Local temperature tends to ambient downstream."
    },
    {
        "id": "bypass_air",
        "vehicle_class": "high_bypass_turbofan",
        "radiator_kind": "gas",
        "temperature_K": {
            "min": 230,
            "max": 450,
            "default": 280,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": null,
        "scaling": "Tt_fan=Tt_in*(1+(FPR^((gamma-1)/gamma)-1)/eta_fan); expand to static exit state. Cold coflow changes hot-plume entrainment.",
        "source_ids": [
            "STUDY",
            "PRIOR"
        ],
        "notes": "No combustion products added to clean bypass; N2/O2 weak in this band. Neglected direct bypass emission in worked budget; hot bypass-duct walls are surfaces."
    },
    {
        "id": "nacelle_skin",
        "vehicle_class": "jet",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 230,
            "max": 370,
            "default": 275,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.7,
            "max": 0.96,
            "default": 0.85,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Recovery temperature plus conducted engine heat and solar/radiative balance; cowl remains much cooler than core.",
        "source_ids": [
            "SMALL",
            "THERMAL",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "afterburner_gas",
        "vehicle_class": "fighter",
        "radiator_kind": "gas",
        "temperature_K": {
            "min": 1100,
            "max": 1800,
            "default": 1450,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": null,
        "scaling": "Reheat raises downstream total gas temperature without raising turbine-exit temperature to that same value; variable nozzle area and expansion lower static T.",
        "source_ids": [
            "F404",
            "SPECTRALDB",
            "PRIOR"
        ],
        "notes": "Static gas range prior. F404 measured total peak about 2083–2111 K, not a 2111 K gray disc."
    },
    {
        "id": "afterburner_liner",
        "vehicle_class": "fighter",
        "radiator_kind": "cavity",
        "temperature_K": {
            "min": 800,
            "max": 1300,
            "default": 1100,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.65,
            "max": 1,
            "default": 0.9,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Transient liner/nozzle energy balance after reheat selection; effective aperture may include hot liner reflection.",
        "source_ids": [
            "F404",
            "CAMERADATA",
            "PRIOR"
        ],
        "notes": "Wall/aperture prior; never set every airframe mesh to afterburner gas temperature."
    },
    {
        "id": "painted_skin",
        "vehicle_class": "all",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 210,
            "max": 370,
            "default": 293,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.7,
            "max": 0.97,
            "default": 0.85,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Recovery plus heat balance; Ta/M determine aerodynamic term, alphaSolar controls sunlight, broadband epsilon controls cooling.",
        "source_ids": [
            "RECOVERY",
            "THERMAL",
            "PAINTDATA",
            "PRIOR"
        ],
        "notes": "Range is a subsonic environment envelope, not a cap for supersonic flight."
    },
    {
        "id": "bare_metal_skin",
        "vehicle_class": "all",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 210,
            "max": 370,
            "default": 293,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.02,
            "max": 0.4,
            "default": 0.1,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Same heat balance but weaker emission/stronger reflection; oxidation changes spectrum and directional response.",
        "source_ids": [
            "CAMERADATA",
            "OPTICALDATA",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "glass",
        "vehicle_class": "all",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 220,
            "max": 340,
            "default": 293,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.5,
            "max": 0.95,
            "default": 0.85,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Recovery plus cabin conduction or anti-ice; compute rho_lambda and tau_lambda along with epsilon_lambda.",
        "source_ids": [
            "OPTICALDATA",
            "CAMERADATA",
            "PRIOR"
        ],
        "notes": "Ordinary thick glazing is often absorbing in much of MWIR; coatings, acrylic canopies, thin films and sensor windows require their own spectra. Scalar prior not universal."
    },
    {
        "id": "hot_outlet",
        "vehicle_class": "airliner",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 320,
            "max": 420,
            "default": 360,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.7,
            "max": 1,
            "default": 0.9,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Pack/vent heat set by system operating state, not throttle alone.",
        "source_ids": [
            "STUDY",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "helicopter_exhaust",
        "vehicle_class": "helicopter",
        "radiator_kind": "gas",
        "temperature_K": {
            "min": 650,
            "max": 950,
            "default": 800,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": null,
        "scaling": "Gas enthalpy follows shaft power, ambient and rotor/forward-flow entrainment; deflect with downwash.",
        "source_ids": [
            "HELI",
            "SPECTRALDB",
            "PRIOR"
        ],
        "notes": "Unsuppressed exit-static prior."
    },
    {
        "id": "suppressed_exhaust",
        "vehicle_class": "helicopter",
        "radiator_kind": "gas",
        "temperature_K": {
            "min": 400,
            "max": 700,
            "default": 580,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": null,
        "scaling": "Tmix≈(mhot*cpHot*Thot+mcold*cpCold*Tcold)/(mhot*cpHot+mcold*cpCold); shield hot parts separately from dilution.",
        "source_ids": [
            "HELI",
            "PRIOR"
        ],
        "notes": "Suppression is not a global intensity multiplier."
    },
    {
        "id": "helicopter_engine_bay",
        "vehicle_class": "helicopter",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 310,
            "max": 400,
            "default": 340,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.7,
            "max": 0.97,
            "default": 0.85,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Heat leakage versus convection; slow heat-up/cooldown, hotter in hover if poorly ventilated.",
        "source_ids": [
            "SMALL",
            "HELI",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "helicopter_gearbox",
        "vehicle_class": "helicopter",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 315,
            "max": 380,
            "default": 335,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.6,
            "max": 0.95,
            "default": 0.8,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Oil/gear losses approximately proportional to transmitted shaft power; use exterior housing temperature.",
        "source_ids": [
            "SMALL",
            "PRIOR"
        ],
        "notes": "Proposed external housing envelope; lubricant temperature is not visible wall temperature."
    },
    {
        "id": "rotor_hub",
        "vehicle_class": "helicopter",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 290,
            "max": 345,
            "default": 310,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.15,
            "max": 0.85,
            "default": 0.6,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Bearing/conduction losses oppose strong rotor convection; depends on finish and rotation, not full engine exhaust temperature.",
        "source_ids": [
            "CAMERADATA",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "exhaust_heated_boom",
        "vehicle_class": "helicopter",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 300,
            "max": 420,
            "default": 335,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.7,
            "max": 0.97,
            "default": 0.85,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Local impingement footprint driven by outlet axis, crosswind, forward speed and downwash; integrate wall heat balance.",
        "source_ids": [
            "HELI",
            "SMALL",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "piston_cowl",
        "vehicle_class": "piston",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 300,
            "max": 380,
            "default": 340,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.7,
            "max": 0.97,
            "default": 0.85,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Heat from engine compartment minus flight/propwash convection; low-speed climb may run warmer than cruise.",
        "source_ids": [
            "ENGINEMAKER",
            "SMALL",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "piston_cylinder",
        "vehicle_class": "piston",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 400,
            "max": 520,
            "default": 480,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.3,
            "max": 0.9,
            "default": 0.7,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Internal metal controlled by combustion load, mixture and airflow; only visible through open louvers.",
        "source_ids": [
            "ENGINEMAKER",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "piston_stack",
        "vehicle_class": "piston",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 500,
            "max": 900,
            "default": 700,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.2,
            "max": 0.9,
            "default": 0.75,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Hot pipe wall follows gas/metal thermal balance; mixture changes EGT at fixed shaft power.",
        "source_ids": [
            "ENGINEMAKER",
            "CAMERADATA",
            "PRIOR"
        ],
        "notes": "Exterior metal prior, not measured EGT."
    },
    {
        "id": "piston_gas",
        "vehicle_class": "piston",
        "radiator_kind": "gas",
        "temperature_K": {
            "min": 750,
            "max": 1200,
            "default": 1000,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": null,
        "scaling": "Pulsed exhaust, short jets, mixture-dependent; gas emission follows CO2/H2O column density.",
        "source_ids": [
            "ENGINEMAKER",
            "SPECTRALDB",
            "PRIOR"
        ],
        "notes": "Exit-gas range assumed; no verified absolute piston EGT adopted."
    },
    {
        "id": "oil_cooler",
        "vehicle_class": "propeller",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 330,
            "max": 390,
            "default": 360,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.5,
            "max": 0.98,
            "default": 0.85,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Oil thermostat/load and airflow; radiator aperture differs from cowl paint; avoid drawing through closed panels.",
        "source_ids": [
            "ENGINEMAKER",
            "SMALL",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "turboprop_exhaust",
        "vehicle_class": "turboprop",
        "radiator_kind": "gas",
        "temperature_K": {
            "min": 550,
            "max": 850,
            "default": 650,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": null,
        "scaling": "Residual enthalpy after power turbine depends on shaft power; stack installation controls aspect.",
        "source_ids": [
            "SMALL",
            "SPECTRALDB",
            "PRIOR"
        ],
        "notes": "Turbine instrument temperature and visible free exhaust differ."
    },
    {
        "id": "electric_motor",
        "vehicle_class": "multirotor",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 303,
            "max": 353,
            "default": 325,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.3,
            "max": 0.95,
            "default": 0.8,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "P_loss=I^2*R+iron loss; T-Ta=P_loss/(h*A+G) at steady state; rotor wash increases h.",
        "source_ids": [
            "DRONE",
            "CAMERADATA",
            "PRIOR"
        ],
        "notes": "Surface rise commonly modest; this bracket is a prior centered near the measured motor/controller example, not a fleet survey."
    },
    {
        "id": "speed_controller",
        "vehicle_class": "multirotor",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 303,
            "max": 363,
            "default": 315,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.7,
            "max": 0.97,
            "default": 0.9,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Conduction/switching losses follow current and switching operation; heat must conduct through arm or casing if concealed.",
        "source_ids": [
            "DRONE",
            "PAINTDATA",
            "PRIOR"
        ],
        "notes": "This is case/cover temperature, not semiconductor junction temperature."
    },
    {
        "id": "battery",
        "vehicle_class": "multirotor",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 293,
            "max": 333,
            "default": 310,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.7,
            "max": 0.97,
            "default": 0.9,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "I^2*R internal loss plus reversible entropic heat; state of charge/history/cooling matter; expose exterior cover only.",
        "source_ids": [
            "DRONE",
            "PRIOR"
        ],
        "notes": "Battery envelope is assumed; source measures motor/controller, not battery."
    },
    {
        "id": "latex_envelope",
        "vehicle_class": "balloon",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 220,
            "max": 330,
            "default": 293,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.3,
            "max": 0.95,
            "default": 0.8,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Film thermal balance; gas has little direct MWIR emission, sunlight and pressure/film thickness affect equilibrium.",
        "source_ids": [
            "BALLOON",
            "BALLOONFILM",
            "PRIOR"
        ],
        "notes": "MWIR transmission can be appreciable in stretched latex. Epsilon default assumes tau=0.15, rho=0.05; both unmeasured, sensitivity required."
    },
    {
        "id": "metallized_envelope",
        "vehicle_class": "balloon",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 220,
            "max": 340,
            "default": 293,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.02,
            "max": 0.3,
            "default": 0.05,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Low epsilon implies strong reflection for opaque exposed metal. Sky-facing normals can reflect low radiance; sunlit/ground-facing normals need not.",
        "source_ids": [
            "THERMAL",
            "CAMERADATA",
            "OPTICALDATA",
            "PRIOR"
        ],
        "notes": "Polymer/paint on top of metal can raise MWIR emissivity; do not infer epsilon from visible shininess."
    },
    {
        "id": "hotair_envelope",
        "vehicle_class": "balloon",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 300,
            "max": 390,
            "default": 335,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.6,
            "max": 0.95,
            "default": 0.85,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Interior hot air/burner heat versus outside convection/radiation; solar envelope uses absorbed sunlight.",
        "source_ids": [
            "BALLOON",
            "LANTERN",
            "PRIOR"
        ],
        "notes": "Air temperature is not automatically fabric temperature."
    },
    {
        "id": "lantern_envelope",
        "vehicle_class": "balloon",
        "radiator_kind": "thin_layer",
        "power_input": "canopy",
        "temperature_K": {
            "min": 283,
            "max": 358,
            "default": 333,
            "status": "estimated from a calculated side-wall heat balance at 293 K air: +40 K at full burn (range +25 to +65 K), -10 to +5 K after flame-out"
        },
        "emissivity_3_5": {
            "min": 0.3,
            "max": 0.6,
            "default": 0.45,
            "status": "estimated: e = 1 - r - t for 15-30 g/m2 tissue, calculated by scaling published heavier-paper MWIR data"
        },
        "transmittance_3_5": {
            "min": 0.15,
            "max": 0.45,
            "default": 0.3,
            "status": "estimated by a calculated two-flux scaling of published heavier-paper MWIR data; no tissue measurement found"
        },
        "direct_transmittance_3_5": {
            "min": 0.005,
            "max": 0.15,
            "default": 0.03,
            "status": "estimated: the unscattered, image-forming part of the transmittance, from published paper scattering lengths scaled to 4 um"
        },
        "diffuse_lobe": {
            "fraction": 0.5,
            "hwhm_deg": 20,
            "status": "estimated: about half of the scattered transmittance in a forward lobe of 15-30 deg half-width, the rest Lambertian"
        },
        "scaling": "Convective heating from the interior air; follows burn power within seconds and is near air temperature after flame-out.",
        "source_ids": [
            "LANTERN",
            "BALLOONFILM",
            "PRIOR"
        ],
        "notes": "Thin diffuse paper: emits, reflects and transmits, so the flame behind it is seen through it. Uniform side-wall value; the real crown is hotter and the lower skirt cooler."
    },
    {
        "id": "lantern_flame",
        "vehicle_class": "balloon",
        "radiator_kind": "continuum_volume_proxy",
        "power_scaling": "intensity",
        "temperature_K": {
            "min": 1400,
            "max": 1900,
            "default": 1400,
            "status": "estimated: the temperature at which the proxy's effective emissivity was calculated; published small wax flames are 1400-1900 K. Fixed, not scaled by burn power"
        },
        "emissivity_3_5": {
            "min": 0.02,
            "max": 0.12,
            "default": 0.05,
            "status": "estimated: calculated effective value for the 0.05 x 0.125 m proxy from the 3-5 um intensity of a 1 kW fuel cell; scales with burn power"
        },
        "scaling": "Radiant intensity is proportional to heat release; the flame temperature does not fall with power. Gray proxy: a real flame emits much of its band power in the CO2 band, which a long path removes.",
        "source_ids": [
            "FLAME",
            "PRIOR"
        ],
        "notes": "Epsilon here is an effective continuum slab parameter for a deliberately crude comparison, not a solid flame material."
    },
    {
        "id": "bird_feathers",
        "vehicle_class": "reference",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 275,
            "max": 325,
            "default": 302,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.8,
            "max": 0.98,
            "default": 0.95,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Metabolic heat filtered through insulation; forced convection and solar heating set feather surface; never use core temperature for entire silhouette.",
        "source_ids": [
            "BIRD",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "bird_exposed_skin",
        "vehicle_class": "reference",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 295,
            "max": 315,
            "default": 309,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.85,
            "max": 0.99,
            "default": 0.95,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Small warm eye/leg/underwing regions; blood flow and flight cooling matter.",
        "source_ids": [
            "BIRD",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "flare",
        "vehicle_class": "reference",
        "radiator_kind": "continuum_volume_proxy",
        "temperature_K": {
            "min": 1400,
            "max": 2500,
            "default": 2000,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.1,
            "max": 0.95,
            "default": 0.4,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Emitting particle/gas temperature, opacity, area and time history; composition-specific spectrum.",
        "source_ids": [
            "FLARE",
            "PRIOR"
        ],
        "notes": "Estimated effective emitting-particle continuum; composition-specific spectra require separate data."
    },
    {
        "id": "ambient_sphere",
        "vehicle_class": "reference",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 220,
            "max": 330,
            "default": 293,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.02,
            "max": 1,
            "default": 0.9,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "T=Ta for stipulated ambient sphere; actual sunlight/radiative cooling may violate ambient assumption.",
        "source_ids": [
            "SI",
            "THERMAL",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "ship_stack_wall",
        "vehicle_class": "reference",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 330,
            "max": 600,
            "default": 450,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.3,
            "max": 0.95,
            "default": 0.8,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Insulation, exhaust load, wind and spray control external wall.",
        "source_ids": [
            "SHIP",
            "SHIPHOT",
            "PRIOR"
        ],
        "notes": "Wet exhaust case is much cooler than assumed dry stack."
    },
    {
        "id": "ship_stack_gas",
        "vehicle_class": "reference",
        "radiator_kind": "gas",
        "temperature_K": {
            "min": 450,
            "max": 900,
            "default": 700,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": null,
        "scaling": "Load-dependent exhaust enthalpy and mixing; water injection can dramatically reduce outlet temperature.",
        "source_ids": [
            "SHIP",
            "SHIPHOT",
            "SPECTRALDB",
            "PRIOR"
        ],
        "notes": "Dry-stack prior, no ship identification."
    },
    {
        "id": "road_hood",
        "vehicle_class": "road",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 300,
            "max": 380,
            "default": 330,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.7,
            "max": 0.97,
            "default": 0.85,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Engine/radiator heat leakage, fan and vehicle speed; separate from body solar heating.",
        "source_ids": [
            "THERMAL",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "road_exhaust",
        "vehicle_class": "road",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 400,
            "max": 850,
            "default": 550,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.2,
            "max": 0.95,
            "default": 0.75,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Exhaust/catalyst temperature follows load and warmup; insulation and shielding determine visible area.",
        "source_ids": [
            "CAMERADATA",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "road_tire",
        "vehicle_class": "road",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 290,
            "max": 350,
            "default": 315,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.8,
            "max": 0.98,
            "default": 0.95,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Rolling/deformation heating plus convection; braking adds separate transient hub/disc heat.",
        "source_ids": [
            "THERMAL",
            "PRIOR"
        ],
        "notes": ""
    },
    {
        "id": "road_brake",
        "vehicle_class": "road",
        "radiator_kind": "surface",
        "temperature_K": {
            "min": 300,
            "max": 700,
            "default": 330,
            "status": "assumed family envelope unless explicit measured anchor is cited"
        },
        "emissivity_3_5": {
            "min": 0.15,
            "max": 0.9,
            "default": 0.65,
            "status": "assumed MWIR prior, material and angle dependent"
        },
        "scaling": "Braking energy and cooldown, not engine power alone.",
        "source_ids": [
            "THERMAL",
            "PRIOR"
        ],
        "notes": ""
    }
];

export const PROFILE_DEFAULTS = {
    "high_bypass_turbofan": {
        "power_fraction": 0.65,
        "ambient_temperature_K": 220,
        "mach": 0.82,
        "skin_emissivity": 0.85,
        "afterburner_fraction": 0
    },
    "fighter": {
        "power_fraction": 1,
        "ambient_temperature_K": 255,
        "mach": 0.87,
        "skin_emissivity": 0.85,
        "afterburner_fraction": 0
    },
    "piston": {
        "power_fraction": 0.65,
        "ambient_temperature_K": 288,
        "mach": 0.16,
        "skin_emissivity": 0.85,
        "afterburner_fraction": 0
    },
    "turboprop": {
        "power_fraction": 0.7,
        "ambient_temperature_K": 265,
        "mach": 0.35,
        "skin_emissivity": 0.85,
        "afterburner_fraction": 0
    },
    "turboshaft": {
        "power_fraction": 0.7,
        "ambient_temperature_K": 293,
        "mach": 0.12,
        "skin_emissivity": 0.85,
        "afterburner_fraction": 0
    },
    "electric": {
        "power_fraction": 0.5,
        "ambient_temperature_K": 293,
        "mach": 0,
        "skin_emissivity": 0.9,
        "afterburner_fraction": 0
    },
    "unpowered": {
        "power_fraction": 0,
        "ambient_temperature_K": 293,
        "mach": 0,
        "skin_emissivity": 0.85,
        "afterburner_fraction": 0
    },
    "latex": {
        "power_fraction": 0,
        "ambient_temperature_K": 293,
        "mach": 0,
        "skin_emissivity": 0.8,
        "afterburner_fraction": 0
    },
    "foil": {
        "power_fraction": 0,
        "ambient_temperature_K": 293,
        "mach": 0,
        "skin_emissivity": 0.05,
        "afterburner_fraction": 0
    },
    "lantern": {
        "power_fraction": 1,
        "ambient_temperature_K": 293,
        "mach": 0,
        "skin_emissivity": 0.85,
        "afterburner_fraction": 0
    },
    "hotair": {
        "power_fraction": 0.3,
        "ambient_temperature_K": 293,
        "mach": 0,
        "skin_emissivity": 0.85,
        "afterburner_fraction": 0
    },
    "road_combustion": {
        "power_fraction": 0.3,
        "ambient_temperature_K": 293,
        "mach": 0,
        "skin_emissivity": 0.85,
        "afterburner_fraction": 0
    }
};

export const PRESET_OVERRIDES = {
    "a340-600": {
        "profile": "high_bypass_turbofan",
        "engine_model": "Trent500",
        "engine_count": 4,
        "status": "estimated",
        "source": "Separate-flow surface estimates; the published A340-600 aircraft planning document establishes separate fan/core exhausts, not metal temperatures"
    },
    "mil-fa18c": {
        "profile": "fighter",
        "engine_count": 2,
        "engine_model": "F404-class"
    },
    "mil-fa18e": {
        "profile": "fighter",
        "engine_count": 2,
        "engine_model": "F414-class, do not inherit F404 calibrated claims"
    },
    "heli-r22": {
        "profile": "piston",
        "engine_count": 1
    },
    "heli-r44": {
        "profile": "piston",
        "engine_count": 1
    },
    "heli-r66": {
        "profile": "turboshaft",
        "engine_count": 1
    },
    "heli-bell206": {
        "profile": "turboshaft",
        "engine_count": 1
    },
    "heli-bell505": {
        "profile": "turboshaft",
        "engine_count": 1
    },
    "heli-h130": {
        "profile": "turboshaft",
        "engine_count": 1
    },
    "mil-v22": {
        "profile": "turboshaft",
        "engine_count": 2
    },
    "mil-b2": {
        "profile": "fighter",
        "engine_count": 4,
        "afterburner_allowed": false
    },
    "mil-a10": {
        "profile": "high_bypass_turbofan",
        "afterburner_allowed": false
    },
    "mil-mq9": {
        "profile": "turboprop",
        "engine_count": 1
    },
    "drone-mavic3": {
        "profile": "electric",
        "engine_count": 4
    },
    "balloon-foil-round": {
        "profile": "foil"
    },
    "balloon-party-red": {
        "profile": "latex"
    },
    "balloon-lantern-white": {
        "profile": "lantern"
    },
    "balloon-hotair": {
        "profile": "hotair"
    }
};

const zonesById = Object.fromEntries(ZONE_TABLE.map(zone => [zone.id, zone]));
const PROFILE_ZONES = {
    // Generic jet_* zones remain available for outlets without a separate-flow
    // mesh; the podded turbofan surfaces use the six turbofan_* identifiers.
    high_bypass_turbofan: ["jet_nozzle", "jet_cavity", "nacelle_skin", "hot_outlet",
        "turbofan_cavity", "turbofan_plug", "turbofan_core_nozzle", "turbofan_core_inner", "turbofan_fan_duct", "turbofan_pylon_shield"],
    fighter: ["jet_nozzle", "jet_cavity", "nacelle_skin", "afterburner_liner"],
    piston: ["piston_cowl", "piston_cylinder", "piston_stack", "oil_cooler"],
    turboprop: ["nacelle_skin", "jet_nozzle", "jet_cavity", "oil_cooler"],
    turboshaft: ["helicopter_engine_bay", "helicopter_gearbox", "rotor_hub", "exhaust_heated_boom", "jet_nozzle", "jet_cavity"],
    electric: ["electric_motor", "speed_controller", "battery"],
    unpowered: [], latex: ["latex_envelope"], foil: ["metallized_envelope"],
    lantern: ["lantern_envelope", "lantern_flame"], hotair: ["hotair_envelope"],
    road_combustion: ["road_hood", "road_exhaust", "road_tire", "road_brake"],
};
// A scattering thin layer (lantern paper): the image-forming part of its transmittance and the angular spread of the
// scattered part. A layer without these fields transmits as an image (directTransmittance = transmittance).
function diffuser(zone) {
    return zone.direct_transmittance_3_5 ? {directTransmittance: zone.direct_transmittance_3_5.default,
        lobeFraction: zone.diffuse_lobe?.fraction ?? 0, lobeHwhmDeg: zone.diffuse_lobe?.hwhm_deg ?? 0} : {};
}

function finite(value, fallback, min, max, name) {
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
    return Math.min(max, Math.max(min, value));
}

/** Ambient K and Mach dimensionless; turbulent recovery with Pr=0.71, gamma=1.4.
 * This is the aerodynamic boundary temperature, not a complete surface heat balance.
 */
export function recoveryTemperature(ambientK, mach) {
    return finite(ambientK, 293, 0, 3000, "ambientK") *
        (1 + Math.cbrt(0.71) * 0.2 * finite(mach, 0, 0, 5, "mach") ** 2);
}

function inferProfile(recipe) {
    const parameters = recipe.parameters ?? recipe;
    if (parameters.vehicleType === "drone") return "electric";
    if (parameters.rotorLayout === "tiltrotor" || parameters.vehicleType === "helicopter") return "turboshaft";
    if (parameters.engineType === "turboprop") return "turboprop";
    if (parameters.engineType === "prop") return "piston";
    if (parameters.engineType === "jet") return "high_bypass_turbofan";
    if (["car", "truck"].includes(parameters.vehicleType)) return "road_combustion";
    return null;
}

/** Recipe or plain {temperatureK, emissivity}; ambient K, Mach, power [0,1].
 * Returns {zones, airframe, fallback, diagnostics, resolveZone(id)}. Zone overrides
 * live at recipe.thermal.zones[id]. Explicit temperatures override the estimated
 * equilibrium power law. No historical state or cooling time is invented.
 * Gas/state rows remain in ZONE_TABLE with null emissivity; this surface resolver
 * reports unsupported zones and substitutes the airframe instead of drawing gas as metal.
 */
export function resolveSignatures(recipe = {}, ambientK = 293, mach, power) {
    recipe = recipe ?? {};
    const thermal = recipe.thermal && typeof recipe.thermal === "object" ? recipe.thermal : recipe;
    const override = PRESET_OVERRIDES[recipe.presetId] ?? {};
    const profileName = thermal.profile ?? override.profile ?? inferProfile(recipe);
    const profile = PROFILE_DEFAULTS[profileName];
    const diagnostics = [];
    const ambient = finite(ambientK, 293, 0, 3000, "ambientK");
    const speed = finite(mach ?? thermal.mach, profile?.mach ?? 0, 0, 5, "mach");
    const powerFraction = finite(power ?? thermal.powerFraction, profile?.power_fraction ?? 0, 0, 1, "power");
    // A heated canopy (power_input "canopy") can be set apart from the flame: the same fraction scale, by default the
    // burn power. Its heating depends on the canopy's size and air flow as well as on the flame.
    const canopyPowerFraction = thermal.canopyPowerFraction == null ? powerFraction :
        finite(thermal.canopyPowerFraction, powerFraction, 0, 1, "canopyPower");
    const hasPlainData = thermal.temperatureK !== undefined || thermal.emissivity !== undefined;
    const fallback = !profile && !hasPlainData;
    if (fallback) diagnostics.push("No thermal data: ambient temperature and emissivity 1.");
    if (profileName && !profile) diagnostics.push(`Unknown profile ${profileName}; use the generic surface.`);
    const skinK = profile ? recoveryTemperature(ambient, speed) : ambient;
    const emissivity = finite(thermal.emissivity ?? thermal.skinEmissivityMWIR, profile?.skin_emissivity ?? 1, 0, 1, "emissivity");
    // Plain thin-layer attributes (a resolved zone copied onto a mesh) keep their transmittance.
    const transmittance = profile ? 0 : thermal.volume === true ? 1 - emissivity :
        Math.min(1 - emissivity, finite(thermal.transmittance, 0, 0, 1, "transmittance"));
    const airframe = {
        temperatureK: finite(thermal.temperatureK, skinK, 0, 3000, "temperatureK"), emissivity,
        ...(transmittance > 0 ? {transmittance} : {}), ...(!profile && thermal.volume === true ? {volume: true} : {}),
        ...(!profile && transmittance > 0 && Number.isFinite(thermal.directTransmittance) ?
            {directTransmittance: Math.min(transmittance, Math.max(0, thermal.directTransmittance))} : {}),
        ...(!profile && transmittance > 0 && thermal.lobeFraction !== undefined ? {lobeFraction: thermal.lobeFraction, lobeHwhmDeg: thermal.lobeHwhmDeg} : {}),
        status: "estimated", fallback,
        source: profile ? "Recovery temperature; estimated material emissivity" :
            hasPlainData ? "Explicit surface attributes" : "Ambient blackbody fallback",
    };
    const zones = {airframe: {...airframe}, painted_skin: {...airframe}};
    if (profile) {
        zones.bare_metal_skin = {...airframe, emissivity: zonesById.bare_metal_skin.emissivity_3_5.default,
            source: "Recovery temperature; estimated bare-metal emissivity"};
        zones.glass = {...airframe, emissivity: zonesById.glass.emissivity_3_5.default,
            source: "Recovery temperature; estimated opaque glazing without cabin heating"};
    }
    const referenceRecovery = profile ? recoveryTemperature(profile.ambient_temperature_K, profile.mach) : ambient;
    for (const id of PROFILE_ZONES[profileName] ?? []) {
        const zone = zonesById[id];
        const referenceK = zone.temperature_K.default;
        // The exponent and unit convection ratio are estimated wall interpolation.
        // Reference power gives the table temperature; zero power gives recovery.
        const separateFlow = id.startsWith("turbofan_");
        const referencePower = separateFlow ? TURBOFAN_CLIMB_REFERENCE.powerFraction : profile.power_fraction;
        const zoneRecovery = separateFlow ? recoveryTemperature(TURBOFAN_CLIMB_REFERENCE.ambientK, TURBOFAN_CLIMB_REFERENCE.mach) : referenceRecovery;
        const zonePower = zone.power_input === "canopy" ? canopyPowerFraction : powerFraction;
        const ratio = referencePower > 0 ? zonePower / referencePower : 0;
        // A flame proxy keeps its temperature; its effective emissivity (radiant intensity) is proportional to power.
        if (zone.power_scaling === "intensity") {
            // volume: a gas emitter that reflects nothing and transmits 1 - e of what is behind it; with zero
            // emissivity (flame-out) it is not drawn.
            const emissivity = Math.min(1, zone.emissivity_3_5.default * ratio);
            zones[id] = {temperatureK: referenceK, emissivity, transmittance: 1 - emissivity, volume: true,
                status: "estimated", source: zone.source ?? "Flame proxy; intensity proportional to burn power", fallback: false};
            continue;
        }
        let temperatureK = skinK + (referenceK - zoneRecovery) * ratio ** 0.7;
        if (id === "afterburner_liner") {
            const reheat = override.afterburner_allowed === false ? 0 :
                finite(thermal.afterburnerFraction, 0, 0, 1, "afterburnerFraction");
            temperatureK = zones.jet_cavity.temperatureK + reheat * Math.max(0, referenceK - zones.jet_cavity.temperatureK);
        }
        zones[id] = {temperatureK, emissivity: zone.emissivity_3_5.default,
            ...(zone.transmittance_3_5 ? {transmittance: zone.transmittance_3_5.default} : {}),
            ...diffuser(zone),
            status: "estimated", source: zone.source ?? "Family zone prior and equilibrium power interpolation", fallback: false};
    }
    for (const [id, values] of Object.entries(thermal.zones ?? {})) {
        const zone = zonesById[id];
        if (!zone && id !== "airframe") {
            diagnostics.push(`Unknown zone ${id}; using airframe skin.`);
            continue;
        }
        if (zone && !zone.emissivity_3_5) {
            diagnostics.push(`${id} requires a spectral volume or engine state model; using airframe.`);
            continue;
        }
        const base = zones[id] ?? (zone ? {temperatureK: zone.temperature_K.default,
            emissivity: zone.emissivity_3_5.default,
            ...(zone.transmittance_3_5 ? {transmittance: zone.transmittance_3_5.default} : {}), ...diffuser(zone),
            status: "estimated", fallback: false, source: "Estimated zone prior"} : airframe);
        const emissivity = finite(values.emissivity, base.emissivity, 0, 1, "zone emissivity");
        // A thin layer cannot transmit more than its emissivity leaves.
        const transmittance = base.volume ? 1 - emissivity :
            Math.min(1 - emissivity, finite(values.transmittance, base.transmittance ?? 0, 0, 1, "zone transmittance"));
        const {transmittance: _baseTransmittance, directTransmittance: _baseDirect, ...opaque} = base;
        zones[id] = {...opaque, temperatureK: finite(values.temperatureK, base.temperatureK, 0, 3000, "zone temperatureK"),
            emissivity, ...(transmittance > 0 ? {transmittance} : {}),
            ...(transmittance > 0 && base.directTransmittance !== undefined ? {directTransmittance: Math.min(transmittance, base.directTransmittance)} : {})};
    }
    return {profile: profileName ?? null, zones, airframe: zones.airframe, fallback, diagnostics,
        resolveZone(id) {
            if (zones[id]) return {...zones[id], zone: id};
            return {...zones.airframe, zone: id ?? "airframe", fallback: true,
                source: `Unknown or unsupported zone ${id ?? "(none)"}; airframe skin fallback`};
        }};
}
