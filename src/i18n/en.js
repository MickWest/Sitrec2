const en = {
    thermal: {
        "title": "Physical thermal",
        "mode": "Render mode",
        "titleTooltip": "A physical simulation of a mid-wave infrared (MWIR) thermal sensor for the Look View. Render mode turns it on.\nThe groups below set the environment, optics, detector, signal processing and display. The tooltip of each value ends with its status (Estimated, Published, Calculated or Measured) and source.\nOpening this folder loads the sensor code.",
        "modeTooltip": "Visible: the normal Look View render.\nPhysical MWIR thermal: the Look View shows a simulated infrared sensor image, calculated from surface temperatures, emissivity and the atmosphere. The Look View's rendering effects do not apply to it.\nA frame that per-frame camera data marks as visible light (EO) shows the visible render.\nNot available for a fisheye, panorama or orthographic camera, in a VR headset, or with flat earth.",
        "visible": "Visible",
        "physicalThermal": "Physical MWIR thermal",
        "loading": "Loading thermal sensor…",
        "unavailable": "Physical thermal unavailable for this projection or view.",
        "failed": "Physical thermal unavailable: {{message}}",
        "noTarget": "Select a target track or choose manual turbulence.",
        "readOnly": "This thermal value is calculated from scene geometry.",
        "controlReasons": {
            "terrainColor": "Used only with Ground temperature source = Terrain color estimate.",
            "materialClasses": "Used only with Ground temperature source = Material classes.",
            "groundAutomatic": "Used only with Ground condition = From sun and time; the other conditions are clear or overcast.",
            "statisticalSea": "Used only with atmospheric sky and the statistical sea model.",
            "swell": "Set a nonzero swell height to use this control.",
            "manualSky": "Used only with Sky source = Manual temperature.",
            "manualEnvironment": "Used only with Reflected environment source = Manual temperature.",
            "atmosphericSky": "Used only with Sky source = Atmosphere.",
            "exposure": "Calculated by the reference well-fill exposure policy. Select Manual to edit.",
            "wellFill": "Used only with Exposure policy = Reference well fill.",
            "noise": "Enable Detector noise to use this control.",
            "noiseSeed": "Used for detector noise or a nonzero residual fixed pattern.",
            "shading": "Set nonzero Edge shading to use this control.",
            "scatter": "Set a nonzero Scatter fraction to use this control.",
            "lensStep": "Used only with a preset Focal step.",
            "sampling": "Calculated by the Optical Nyquist policy. Select Manual to edit.",
            "manualGain": "Used only with Gain mode = Manual.",
            "adaptiveGain": "Used only with Automatic or Plateau gain.",
            "plateau": "Used only with Gain mode = Plateau equalization.",
            "localEnhancement": "Set nonzero Local enhancement to use this control.",
            "radiometric": "Used only with Fixed radiometric gain or the Radiance diagnostic view.",
            "diffraction": "Enable Diffraction to use this control.",
            "wavelengthBlur": "Used only with Diffraction or nonzero turbulence blur.",
            "whiteHot": "Used only with White hot polarity.",
            "turbulence": "Calculated along the camera-to-target path. Set Turbulence path to Manual to edit.",
            "sounding": "The loaded sounding supplies temperature and water vapor. This fallback applies without a sounding."
        },
        "readout": "Native {{width}} × {{height}} · {{vertical}}° V × {{horizontal}}° H · digital zoom {{zoom}}× · r0 {{r0}} m · ground/sea estimated",
        "sunGeometry": "Sun: azimuth {{azimuth}}° · elevation {{elevation}}° · from scene date, time and location",
        "groundMapReadout": "Mapped ground: {{roads}} roads, {{paths}} paths, {{buildings}} buildings over {{km}} km ({{meters}} m per texel).",
        "groundMapLoading": "Mapped ground: loading road and building data…",
        "groundMapUnavailable": "Mapped ground unavailable: {{message}}. Imagery colors are used.",
        "groundClassesReadout": "Ground material classes ({{condition}}, {{climate}}; air {{air}} K): {{classes}} K. Estimated from imagery colors; visible imagery does not measure material.",
        "groundClasses": {"grass": "grass", "trees": "trees", "asphalt": "asphalt", "concrete": "concrete", "roof": "roofs", "soil": "soil"},
        "terrainTemperatureEstimate": "Terrain color temperatures estimated: {{low}}–{{high}} K; darker colors warmer. Visible imagery is not a temperature measurement.",
        "readoutView": {
            "title": "Thermal Readout",
            "show": "Show readout",
            "showTooltip": "Show the thermal sensor readout in a separate window. You can select and copy the text.",
            "idle": "The Look View does not show a physical thermal image now."
        },
        "cloudDiagnostics": {"unresolvedThermal": "{{id}}: cloud field excluded; physical optical depth and temperature metadata are missing."},
        "cloudCost": "Clouds {{count}} · prepare {{prepareMs}} ms · sort {{sortMs}} ms · {{draws}} draws · absorption only; GPU timing unavailable",
        "coverageLimited": "Small-target refinement: {{refined}} of {{tiles}} tiles this frame (estimated budget); the others use normal supersampling",
        "seaDiagnostic": "Sea: clear-sky thermal-only diagnostic · estimated ensemble mean · gray water · statistical hiding / black cavity · clouds and Sun are not reflected; no moving crests",
        "cameraData": {
            "row": "Camera data: {{mode}} · {{focal}} mm · {{polarity}} · row at frame {{frame}}",
            "savedPolarity": "{{polarity}} (saved)",
            "notStep": "The camera data's {{focal}} mm is not a lens step of this sensor preset; the saved lens ({{saved}} mm) is kept.",
            "freeFocal": "Conditional optical model: CSV focal length {{focal}} mm with the selected aperture and detector. This is not calibrated sensor optics; electronic zoom does not change focal length.",
            "noSteps": "This sensor preset has no lens steps; the saved lens ({{saved}} mm) is kept for the camera data's {{focal}} mm.",
            "invalid": "The camera data focal length {{focal}} mm does not work with the selected optical settings ({{message}}); the saved lens ({{saved}} mm) is kept.",
            "previousLens": "The {{focal}} mm optics are still being built; until they are ready, this frame uses the optics of the previous lens ({{previous}} mm).",
            "readOnly": "Set by the per-frame camera data at this frame (Camera > Camera Data > Drive Look View). The saved value applies where the camera data does not set it."
        },
        "unvalidatedStep": "Lens step {{focal}} mm has no measured values in this sensor preset, so this frame is outside the validated lens steps. Foreground transfer uses the center-ray range table, a narrow-field model.",
        "viewLens": {
            "title": "Lens source",
            "view": "Follow camera field (estimated)",
            "sensor": "Selected thermal lens",
            "tooltip": "Follow camera field (estimated): without recorded infrared camera data, the sensor uses the preset lens step closest to the camera's field of view before display zoom. This estimates the step; it does not measure it. Presets without lens steps keep their optics.\nSelected thermal lens: the optics stay as set in Optics.\nRecorded infrared camera data takes priority over both.",
            "readOnly": "Estimated from the camera field. Select Lens source = Selected thermal lens to edit the optics.",
            "estimate": "Lens: {{focal}} mm estimated from the {{field}}° camera field before display zoom; no recorded lens data.",
            "invalid": "The estimated {{focal}} mm step does not work with the selected pupil policy ({{message}}); the selected thermal lens is kept."
        },
        "nyquistNotMet": "Optical sampling {{factor}}× is below the Nyquist factor {{required}}× at f/{{fNumber}}; fine diffraction detail is undersampled.",
        "vehicleReadout": "{{id}} · {{altitudeM}} m · air {{airTemperatureK}} K ({{airSource}}) · Mach {{mach}} ({{machSource}}) · speed {{speedMps}} m/s ({{speedSource}}) · power {{power}} ({{powerSource}})",
        "canopyReadout": "· canopy heating {{canopyPower}} (user override)",
        "machWarning": "Warning: scene-derived Mach {{mach}} is implausible for an airliner (estimated threshold 0.95). Check the track speed, or use Object → Thermal surface → Vehicle thermal state → Mach → Override.",
        "optics": {
            "coarsePending": "Coarse optical preview; full kernel pending. Calculated kernel L1 bound: 2; radiance error ≤ 2 × maximum scene contrast.",
            "retained": "Previous optical kernel retained while rebuilding. Calculated kernel L1 bound: 2; radiance error ≤ 2 × maximum scene contrast.",
            "coarse": "Coarse optical preview; diffraction and turbulence pending. Calculated kernel L1 bound: 2; radiance error ≤ 2 × maximum scene contrast."
        },
        "zones": {
            "turbofan_cavity": "Turbofan aft cavity",
            "turbofan_plug": "Turbofan core plug",
            "turbofan_core_nozzle": "Turbofan core nozzle (outside)",
            "turbofan_core_inner": "Turbofan core nozzle (inner wall)",
            "turbofan_fan_duct": "Turbofan fan duct",
            "turbofan_pylon_shield": "Turbofan pylon heat shield",
            "jet_nozzle": "Jet nozzle",
            "jet_cavity": "Jet exhaust cavity",
            "turbine_exit_total": "Turbine exit gas",
            "jet_plume": "Jet plume",
            "bypass_air": "Bypass air",
            "nacelle_skin": "Engine nacelle skin",
            "afterburner_gas": "Afterburner gas",
            "afterburner_liner": "Afterburner liner",
            "painted_skin": "Painted skin",
            "bare_metal_skin": "Bare metal skin",
            "glass": "Glass",
            "hot_outlet": "Hot outlet",
            "helicopter_exhaust": "Helicopter exhaust gas",
            "suppressed_exhaust": "Suppressed exhaust gas",
            "helicopter_engine_bay": "Helicopter engine bay",
            "helicopter_gearbox": "Helicopter gearbox",
            "rotor_hub": "Rotor hub",
            "exhaust_heated_boom": "Exhaust-heated tail boom",
            "piston_cowl": "Piston engine cowl",
            "piston_cylinder": "Piston engine cylinders",
            "piston_stack": "Piston exhaust stack",
            "piston_gas": "Piston exhaust gas",
            "oil_cooler": "Oil cooler",
            "turboprop_exhaust": "Turboprop exhaust gas",
            "electric_motor": "Electric motors",
            "speed_controller": "Motor speed controllers",
            "battery": "Battery",
            "latex_envelope": "Latex envelope",
            "metallized_envelope": "Metallized envelope",
            "hotair_envelope": "Hot-air envelope",
            "lantern_envelope": "Lantern canopy",
            "lantern_flame": "Lantern flame",
            "bird_feathers": "Feathers",
            "bird_exposed_skin": "Bare skin (bird)",
            "flare": "Flare",
            "ambient_sphere": "Ambient sphere",
            "ship_stack_wall": "Ship stack wall",
            "ship_stack_gas": "Ship stack gas",
            "road_hood": "Hood",
            "road_exhaust": "Exhaust",
            "road_tire": "Tires",
            "road_brake": "Brakes"
        },
        "vehicleSources": {
            "standard": "standard atmosphere, calculated",
            "sounding": "sounding profile, calculated",
            "groundSpeed": "ground speed; no wind at altitude",
            "stationary": "stationary; no track velocity",
            "windField": "airspeed; wind at altitude",
            "objectWind": "airspeed; bound object wind",
            "override": "user override",
            "recipe": "recipe, estimated",
            "climbReference": "climb reference, estimated",
            "burnPower": "follows burn power"
        },
        "groups": {
            "scene": "Environment",
            "optics": "Optics",
            "detector": "Detector",
            "processing": "Processing",
            "display": "Display"
        },
        "groupTooltips": {
            "scene": "The scene as the sensor sees it: atmosphere, sky, ground, sea, clouds, sunlight, and the fallback temperature of untagged object surfaces.",
            "optics": "The lens and the light path to the detector: spectral band, aperture, lens step, focal length and field of view, diffraction, scatter, turbulence, blur and optical sampling.",
            "detector": "The sensor preset and the detector: size, pixel pitch, exposure, well capacity, noise, edge shading and fixed pattern.",
            "processing": "How detector counts become display brightness: gain mode and window, temporal noise filter, local enhancement and fixed radiometric endpoints.",
            "display": "The output picture: polarity, response gamma and display curve, white-hot output gain and offset, digital zoom, enlargement sampling and diagnostic views."
        },
        "status": {
            "estimated": "Estimated",
            "published": "Published",
            "calculated": "Calculated",
            "measured": "Measured"
        },
        "object": {
            "title": "Thermal surface",
            "titleTooltip": "The temperature and emissivity of this object's surfaces in the physical thermal image (Effects > Physical thermal > Render mode = Physical MWIR thermal).\nFor a vehicle model (Browse vehicles…), opening this folder adds Vehicle thermal state and Zone overrides.",
            "modeTooltip": "Inherit vehicle zones / ambient: each surface keeps the thermal data of the model, such as the heat zones of a vehicle model with any Zone overrides. Surfaces without thermal data use Ambient fallback temperature (Effects > Physical thermal > Environment).\nUniform surface: every surface of this object uses Temperature and Emissivity below.",
            "uniformTemperatureKTooltip": "Temperature of every surface of this object, in K (kelvin; °C + 273.15). Used only with Render mode = Uniform surface.",
            "uniformEmissivityTooltip": "MWIR emissivity of every surface of this object, 0 to 1. 1 is a perfect emitter; a surface below 1 also reflects its surroundings, by the fraction 1 − emissivity. Used only with Render mode = Uniform surface.",
            "vehicleStateTooltip": "The air temperature, Mach number and engine power that set the heat zones of this vehicle model. A sky lantern also has Canopy heating.\nEach value comes from the scene, or from an override for this object only.",
            "stateTooltips": {
                "airTemperatureK": "Air temperature at this object, in K. The skin temperature and the engine zone temperatures start from it.",
                "mach": "Flight Mach number of this object (airspeed ÷ speed of sound). It adds ram heating to the skin and engine zone temperatures.",
                "power": "Engine load of this vehicle, 0 to 1. The engine and exhaust zones get hotter as it increases. For a sky lantern it is the burn fraction.",
                "canopyPower": "Heating of a sky lantern's canopy, as a burn fraction from 0 to 1. By default it follows Power."
            },
            "sourceTooltip": "From scene: Sitrec calculates the value each frame, and the value control shows it.\nOverride: set the value for this object only.",
            "canopySourceTooltip": "Follows burn power: the canopy heating equals Power.\nOverride: set the canopy heating for this object only.",
            "zonesTooltip": "The heat zones of this vehicle model, such as engine parts, exhaust and skin. Each zone starts at the values that Vehicle thermal state gives it. An edit overrides the zone for this object only.\nUsed only with Render mode = Inherit vehicle zones / ambient.",
            "zoneTooltip": "Override the surface values of this heat zone for this object. Inherit zone removes the override.",
            "zoneTooltips": {
                "temperatureK": "Temperature of this zone's surfaces, in K. An edit overrides the calculated value.",
                "emissivity": "MWIR emissivity of this zone, 0 to 1. For a gas volume, such as a flame, it sets the radiant intensity, and the transmittance is 1 − emissivity.",
                "transmittance": "Fraction of the radiation from behind that passes through this thin layer, such as a lantern canopy, 0 to 1. It cannot exceed 1 − emissivity; the control shows the effective value."
            },
            "resetTooltip": "Remove the overrides of this zone. The zone uses the calculated values again.",
            "inherit": "Inherit vehicle zones / ambient",
            "uniform": "Uniform surface",
            "temperatureK": "Temperature · K",
            "emissivity": "Emissivity · 1",
            "transmittance": "Transmittance · 1",
            "zones": "Zone overrides",
            "reset": "Inherit zone",
            "vehicleState": "Vehicle thermal state",
            "fromScene": "From scene",
            "override": "Override",
            "source": "Source",
            "airTemperatureK": "Air temperature · K",
            "mach": "Mach · 1",
            "power": "Power · 1",
            "canopyPower": "Canopy heating · 1",
            "followsPower": "Follows burn power",
            "canopyPowerTooltip": "Sky lantern canopy heating as a burn fraction, separate from the flame. Follows burn power by default. A larger or wind-cooled canopy is heated less by the same flame; 0 leaves the canopy at the air temperature.",
            "airTemperatureKTooltip": "From scene samples the thermal atmosphere at this object's altitude each frame. An override changes only this instance.",
            "machTooltip": "From scene divides track airspeed by the speed of sound at the air temperature used here. Without wind at this altitude it uses ground speed.",
            "powerTooltip": "From scene keeps recipe power, or the estimated climb reference when absent. Power is a family load coordinate, not calibrated throttle. For a sky lantern it is the burn fraction: the flame intensity follows it, and so does the canopy heating unless Canopy heating is set apart; 0 is after flame-out."
        },
        "parameters": {
            "cloudOpticalDepth": {"label": "Cloud absorption depth", "tooltip": "Estimated core absorption depth: alpha = 1 − exp(−depth × mask). Scattering is omitted."},
            "seaMode": {"options": {"smooth": "Smooth comparison", "statistical": "Statistical rough sea"}, "label": "Sea state model", "tooltip": "Statistical ensemble mean from wind slopes and independent swell; no moving crests or geometric occlusion."},
            "seaWindMps": {"label": "Sea wind at 10 m", "tooltip": "Estimated surface wind in m/s. It is independent of aircraft-altitude wind."},
            "seaWindDirectionRad": {"label": "Sea wind toward azimuth", "tooltip": "Clockwise from local north in radians; direction affects reflected sky."},
            "seaSkinTemperatureK": {"label": "Sea skin temperature", "tooltip": "Estimated radiating skin in K; independent of air or bulk water temperature."},
            "seaSwellHeightM": {"label": "Swell significant height", "tooltip": "Independent optional swell height in m; zero omits swell. All slopes are statistically averaged."},
            "seaSwellPeriodS": {"label": "Swell period", "tooltip": "Estimated monochromatic deep-water swell period in s; not recovered from wind."},
            "seaSwellDirectionRad": {"label": "Swell toward azimuth", "tooltip": "Independent swell direction, clockwise from local north in radians."},
            "agcDynamics": {
                "label": "Gain dynamics",
                "tooltip": "Choose exponential relaxation of count endpoints or of the affine display gain and offset.",
                "options": {
                    "endpoints": "Window endpoints",
                    "gainOffset": "Display gain and offset"
                }
            },
            "temporalFilterAlpha": {
                "label": "Temporal noise memory",
                "tooltip": "Previous filtered-count weight per delivered frame: y = (1-alpha)x + alpha yPrevious. Zero is off; repeated/backward frames reset."
            },
            "psfRangeM": {
                "label": "PSF source range",
                "tooltip": "Source blackbody spectrum weighted by path transmission at this range; zero disables path weighting. A host may override per frame."
            },
            "pupilReferenceM": {
                "label": "Pupil at reference step",
                "tooltip": "Estimated MX-15 pupil at 675 mm, range 0.120–0.180 m. Sets aperture at each optical step."
            },
            "pupilPolicy": {
                "label": "Stepped pupil policy",
                "tooltip": "Hold f-number scales the reference pupil with focal length; Keep pupil retains its diameter. Neither policy is measured.",
                "options": {
                    "holdFNumber": "Hold f-number (estimated)",
                    "keepPupil": "Keep pupil (estimated)"
                }
            },
            "focalStep": {
                "label": "Focal step",
                "tooltip": "Preset optical lens step, pupil policy and displayed detector window. Free uses Optical field control; presets without steps always use Free. An edit of Focal length, Vertical field of view, Aperture diameter or Optical field control selects Free.",
                "options": {
                    "27": "27 mm",
                    "135": "135 mm",
                    "675": "675 mm",
                    "1012": "1012 mm",
                    "free": "Free optical field"
                }
            },
            "sensorPreset": {
                "label": "Sensor preset",
                "tooltip": "Conditional sensor model. Selecting a preset replaces the optics, detector, processing and display settings with the preset's values. Each value shows its status and source.",
                "options": {
                    "MX15": "MX-15 class (stepped optics)",
                    "ATFLIR": "ATFLIR (conditional narrow)",
                    "OMAHA": "USS Omaha candidate (SAFIRE III)"
                }
            },
            "ambientTemperatureK": {
                "label": "Ambient fallback temperature",
                "tooltip": "Fallback temperature for untagged object surfaces. Vehicle air temperature comes from the atmosphere or the object's override."
            },
            "atmosphereProfile": {
                "label": "Atmosphere profile",
                "tooltip": "Standard: the standard atmosphere shape with the surface air temperature and water vapor below. Loaded sounding: the measured temperature and humidity of a weather balloon loaded into the scene (Import Sounding or Get Nearby Weather Balloons), the launch nearest the scene time.",
                "options": {"standard": "Standard profile", "sounding": "Loaded sounding"}
            },
            "surfaceTemperatureK": {
                "label": "Surface air temperature",
                "tooltip": "Sea-level air temperature for the standard atmospheric profile. A loaded sounding supplies the profile instead. This value also sets the water temperature in the Smooth comparison sea model."
            },
            "groundTemperatureK": {
                "label": "Ground temperature",
                "tooltip": "Estimated terrain reference temperature. Color mode spans equally above and below it. Uncolored terrain and water tiles with a manual sky use this fallback."
            },
            "groundTemperatureMode": {
                "label": "Ground temperature source",
                "tooltip": "Terrain color estimate: darker colors are warmer. Material classes: each imagery color is classed as vegetation, asphalt, concrete, roof or soil; each class is at the air temperature plus a researched offset for the time of day and has its own emissivity. Uniform: one temperature. Visible imagery does not measure temperature or material.",
                "options": {"color": "Terrain color estimate", "materials": "Material classes", "uniform": "Uniform temperature"}
            },
            "groundCondition": {
                "label": "Ground condition",
                "tooltip": "Sets each material class's temperature relative to the air. Automatic uses the scene's sun elevation, the time since sunset and the Cloud cover setting. The other conditions are fixed states: Day, clear and Day, overcast are midday with no cloud and with full cloud; Evening and Late night have a clear sky.",
                "options": {"automatic": "From sun and time", "day": "Day, clear", "overcast": "Day, overcast", "evening": "Evening", "night": "Late night"}
            },
            "groundClimate": {
                "label": "Ground climate",
                "tooltip": "Dry air lets surfaces cool further at night and heat further by day than humid air. Automatic uses the surface dew point and relative humidity of the atmosphere profile: a dew point of 18 °C or more is warm humid, under 35% relative humidity is dry.",
                "options": {"automatic": "From humidity", "humid": "Warm humid", "temperate": "Temperate", "dry": "Dry"}
            },
            "groundCloudFraction": {
                "label": "Cloud cover",
                "tooltip": "Fraction of the sky covered by cloud, for the automatic ground condition. From a weather report: FEW 0.2, SCT 0.45, BKN 0.75, OVC 1. Cloud reduces night cooling and day heating."
            },
            "groundMapData": {
                "label": "Mapped roads and buildings",
                "tooltip": "Loads open map road and building data around the target over the network, as Lighting > City Lights does. Road surfaces are asphalt, footpaths concrete and building footprints roofs; roads under tree canopy stay trees. Walls of 3D buildings are concrete. Elsewhere the imagery colors decide. Road widths are typical for each road class, not mapped."
            },
            "groundWindMps": {
                "label": "Surface wind",
                "tooltip": "Near-surface wind speed in m/s, for the material classes. Wind mixes surfaces toward the air temperature by day and night. A weather report gives the wind at 10 m in knots: 1 kt = 0.514 m/s."
            },
            "groundTemperatureSpanK": {
                "label": "Terrain color temperature span",
                "tooltip": "Estimated warm-to-cool span in K: black is warmer and white is cooler, around Ground temperature. Uses unlit sRGB luminance. Imagery shadows and colors are not measured temperatures. Zero gives uniform ground temperature."
            },
            "groundEmissivity": {
                "label": "Ground emissivity",
                "tooltip": "Estimated opaque terrain emissivity. Also used by water tiles with a manual sky; atmospheric sea emissivity comes from Fresnel reflection."
            },
            "skySource": {
                "label": "Sky source",
                "tooltip": "Elevation-dependent background from the range-table atmosphere, or a manual brightness temperature.",
                "options": {
                    "atmosphere": "Atmosphere",
                    "manual": "Manual temperature"
                }
            },
            "skyGradient": {
                "label": "Sky elevation gradient",
                "tooltip": "Use each camera ray elevation for atmospheric sky and sea; disable for a uniform center-ray background."
            },
            "skyTemperatureK": {
                "label": "Sky brightness temperature",
                "tooltip": "Equivalent blackbody radiance for the background in manual sky mode only."
            },
            "objectTemperatureK": {
                "label": "Object temperature",
                "tooltip": "Suggested temperature for authoring generic surface tags. Untagged meshes use ambient."
            },
            "emissivity": {
                "label": "Object emissivity",
                "tooltip": "Suggested emissivity for authoring tags; the remaining opaque fraction reflects the environment."
            },
            "environmentSource": {
                "label": "Reflected environment source",
                "tooltip": "Manual: every surface reflects one temperature. Sky and ground: each surface reflects the clear sky above and the ground below, weighted by the way it faces, calculated at its own altitude.",
                "options": {
                    "manual": "Manual temperature",
                    "skyGround": "Sky and ground"
                }
            },
            "environmentTemperatureK": {
                "label": "Reflected environment",
                "tooltip": "Cosine-weighted hemispheric incident radiance expressed as blackbody temperature."
            },
            "solarScale": {
                "label": "Solar transmission",
                "tooltip": "Estimated direct solar transmission (0–1). Sun direction follows scene date, time and location. Adds diffuse reflected sunlight to opaque surfaces; does not heat them or scatter sunlight in clouds. Zero disables this contribution."
            },
            "sunDirectionX": {
                "label": "Sun direction X",
                "tooltip": "World direction toward the sun, normalized with Y and Z."
            },
            "sunDirectionY": {
                "label": "Sun direction Y",
                "tooltip": "World direction toward the sun."
            },
            "sunDirectionZ": {
                "label": "Sun direction Z",
                "tooltip": "World direction toward the sun."
            },
            "atmosphereEnabled": {
                "label": "Atmosphere",
                "tooltip": "Apply the estimated 12-band transmission and thermal path emission."
            },
            "sensorAltitudeM": {
                "label": "Sensor altitude",
                "tooltip": "Altitude above the spherical surface for the atmospheric ray."
            },
            "pathElevationDeg": {
                "label": "Atmospheric elevation",
                "tooltip": "Center ray elevation; one narrow-field range table is used for all pixels."
            },
            "atmosphereMaxRangeM": {
                "label": "Atmosphere range",
                "tooltip": "Maximum lookup range. Geometry beyond this range is rejected."
            },
            "visibilityM": {
                "label": "Visibility",
                "tooltip": "Estimated visible meteorological range used for the aerosol profile."
            },
            "waterVaporDensityKgM3": {
                "label": "Surface water vapor",
                "tooltip": "Estimated surface density with a 2000 m scale height; capped at saturation."
            },
            "bandMinUm": {
                "label": "Band lower limit",
                "tooltip": "Flat photon response begins here; atmosphere supports 3–5 um."
            },
            "bandMaxUm": {
                "label": "Band upper limit",
                "tooltip": "Flat photon response ends here; must exceed the lower limit."
            },
            "apertureM": {
                "label": "Aperture diameter",
                "tooltip": "Entrance pupil diameter for diffraction and photon collection."
            },
            "fieldMode": {
                "label": "Optical field control",
                "tooltip": "The other field is calculated using detector height and pitch.",
                "options": {
                    "fieldOfView": "Vertical field of view",
                    "focalLength": "Focal length"
                }
            },
            "focalLengthM": {
                "label": "Focal length",
                "tooltip": "Effective focal length; linked to field of view and pitch."
            },
            "verticalFovDeg": {
                "label": "Vertical field of view",
                "tooltip": "Native optical field before digital zoom."
            },
            "opticalTransmission": {
                "label": "Optical transmission",
                "tooltip": "Photon throughput excluding atmosphere and detector quantum efficiency."
            },
            "opticsEnabled": {
                "label": "Diffraction",
                "tooltip": "Apply the normalized polychromatic circular pupil core."
            },
            "psfTemperatureK": {
                "label": "PSF spectral temperature",
                "tooltip": "Estimated common source spectrum for photon weighting of seven wavelength bins."
            },
            "opticsRadiusPx": {
                "label": "Core support radius",
                "tooltip": "Finite core radius in detector pixels; omitted tails are renormalized."
            },
            "scatterPreset": {
                "label": "Scatter preset",
                "tooltip": "Estimated sensitivity cases; selecting a preset sets fraction, shoulder, slope and cutoff. Editing one selects Custom.",
                "options": {
                    "clean": "Clean window",
                    "dirty": "Dirty window",
                    "custom": "Custom"
                }
            },
            "scatterFraction": {
                "label": "Scatter fraction",
                "tooltip": "Estimated fraction redistributed into the normalized skirt."
            },
            "scatterSlope": {
                "label": "Scatter slope",
                "tooltip": "Estimated far-wing exponent in [1+(angle/shoulder)²]^(-slope/2)."
            },
            "scatterShoulderRad": {
                "label": "Scatter shoulder",
                "tooltip": "Estimated transition angle from flat core to power-law skirt."
            },
            "scatterCutoffRad": {
                "label": "Scatter cutoff",
                "tooltip": "Finite support angle, required even for slopes at or below two."
            },
            "turbulenceR0M": {
                "label": "Turbulence coherence diameter",
                "tooltip": "Fried r0 at 4 um; zero disables. Wavelength-scaled long-exposure Kolmogorov MTF, with no finite-time correction."
            },
            "turbulenceMode": {
                "label": "Turbulence path",
                "tooltip": "Camera to target: integrates the estimated turbulence profile along the physical path from the camera to the target track. Only a host with scene geometry, such as the Look View, does this.\nManual: uses Turbulence coherence diameter.",
                "options": {
                    "manual": "Manual",
                    "geometry": "Camera to target"
                }
            },
            "jitterRmsUrad": {
                "label": "Exposure jitter",
                "tooltip": "Estimated per-axis intra-exposure Gaussian RMS; excludes frame-to-frame centroid motion."
            },
            "systemBlurHorizontalRmsUrad": {
                "label": "Horizontal residual blur",
                "tooltip": "Independent Gaussian residual along display x, in angle before sampling and detector noise. Excludes turbulence, exposure jitter and charge diffusion."
            },
            "systemBlurVerticalRmsUrad": {
                "label": "Vertical residual blur",
                "tooltip": "Independent Gaussian residual along display y, in angle before sampling and detector noise. MX-15 long steps use about 40 µrad with the measured display curve; origin unresolved."
            },
            "diffusionSigmaPx": {
                "label": "Charge diffusion",
                "tooltip": "Estimated Gaussian sigma before native sampling; zero disables. Pixel-area integration is separate."
            },
            "defocusM": {
                "label": "Defocus",
                "tooltip": "Longitudinal detector displacement; computed as quadratic pupil phase."
            },
            "opticalSamplingMode": {
                "label": "Optical sampling policy",
                "tooltip": "Calculate sampling from the shortest wavelength and f-number within allocation limits. Editing the factor selects Manual.",
                "options": {
                    "nyquist": "Optical Nyquist",
                    "manual": "Manual"
                }
            },
            "supersample": {
                "label": "Optical sampling",
                "tooltip": "Fine radiance grid factor; calculated in Nyquist mode. Small mesh coverage is independently refined to 128 samples per detector pixel (live views: up to 64 tiles per frame, overflow reported).",
                "options": {
                    "2": "2 ×",
                    "4": "4 ×",
                    "8": "8 ×"
                }
            },
            "detectorWidth": {
                "label": "Detector width",
                "tooltip": "Native sampling columns; independent of picture size."
            },
            "detectorHeight": {
                "label": "Detector height",
                "tooltip": "Native sampling rows; independent of picture size."
            },
            "pixelPitchM": {
                "label": "Pixel pitch",
                "tooltip": "Geometric detector pixel spacing."
            },
            "exposureMode": {
                "label": "Exposure policy",
                "tooltip": "Calculate integration from a reference blackbody and mean dark current, or use manual integration time.",
                "options": {
                    "wellFill": "Reference well fill",
                    "manual": "Manual"
                }
            },
            "wellFillFraction": {
                "label": "Reference well fraction",
                "tooltip": "Target fraction of full well before dark subtraction; 50% is a detector NETD comparison condition."
            },
            "wellFillReferenceK": {
                "label": "Exposure reference temperature",
                "tooltip": "Unshaded blackbody temperature at the detector input, before integration."
            },
            "shadingK": {
                "label": "Edge shading",
                "tooltip": "Estimated edge-minus-center signal at a fixed 300 K reference; zero disables the detector-fixed shading map."
            },
            "shadingWidth": {
                "label": "Shading width",
                "tooltip": "Radial width in native detector half-widths; digital zoom crops this fixed signal."
            },
            "fixedPatternFraction": {
                "label": "Residual fixed pattern",
                "tooltip": "Estimated pixel offset RMS as a fraction of ADC range; fixed across frames, independent of temporal noise switch. Zero disables."
            },
            "integrationTimeS": {
                "label": "Integration time",
                "tooltip": "Photon collection time in manual exposure mode only; reference well-fill mode reports its calculated time."
            },
            "quantumEfficiency": {
                "label": "Quantum efficiency",
                "tooltip": "Mean collected electrons per transmitted photon."
            },
            "fillFactor": {
                "label": "Fill factor",
                "tooltip": "Active square area fraction; affects sampling and electron collection once each."
            },
            "wellElectrons": {
                "label": "Well capacity",
                "tooltip": "Charge limit before read noise; also the ideal 14-bit ADC full scale."
            },
            "noiseEnabled": {
                "label": "Detector noise",
                "tooltip": "Frame-seeded Poisson shot noise and Gaussian read noise."
            },
            "shotNoiseEnabled": {
                "label": "Shot noise",
                "tooltip": "Exact Poisson below 64 expected electrons; Gaussian approximation above."
            },
            "readNoiseElectrons": {
                "label": "Read noise",
                "tooltip": "Gaussian charge uncertainty added after well clipping."
            },
            "adcOffsetCounts": {
                "label": "ADC pedestal",
                "tooltip": "Estimated electronic offset before quantization. Raw counts retain it; manual and radiometric windows remove it, adaptive modes absorb it in their statistics."
            },
            "darkElectronsPerS": {
                "label": "Dark current",
                "tooltip": "Mean is removed after well clipping; dark shot noise remains."
            },
            "noiseSeed": {
                "label": "Noise seed",
                "tooltip": "Combined with pixel index and frame for reproducible noise."
            },
            "gainMode": {
                "label": "Gain mode",
                "tooltip": "Choose a fixed count window, adaptive statistics, capped histogram or fixed photon scale.",
                "options": {
                    "manual": "Manual",
                    "automatic": "Automatic",
                    "plateau": "Plateau equalization",
                    "fixedRadiometric": "Fixed radiometric"
                }
            },
            "gainRegion": {
                "label": "Gain statistics region",
                "tooltip": "Automatic window and plateau histogram use the native detector or centers inside the digital zoom crop.",
                "options": {
                    "detector": "Whole detector",
                    "displayed": "Displayed crop"
                }
            },
            "fixedGain": {
                "label": "Fixed gain",
                "tooltip": "Manual display drive = (counts - level) × gain / 16383 + 0.5."
            },
            "fixedLevel": {
                "label": "Fixed level",
                "tooltip": "Signal count after pedestal removal mapped to middle gray before response and polarity."
            },
            "lowPercentile": {
                "label": "Lower percentile",
                "tooltip": "Lower adaptive count-window quantile."
            },
            "highPercentile": {
                "label": "Upper percentile",
                "tooltip": "Upper adaptive count-window quantile."
            },
            "agcTimeConstantS": {
                "label": "Gain time constant",
                "tooltip": "Exponential settling time; zero responds immediately."
            },
            "frameRateHz": {
                "label": "Frame rate",
                "tooltip": "Converts frame deltas to seconds for adaptive gain; repeated frames recompute the current window without smoothing."
            },
            "minimumWindowCounts": {
                "label": "Minimum window",
                "tooltip": "Like a camera's maximum gain: a scene with less spread than this is widened equally about its middle, so low contrast stays mid-gray. The default only steadies a nearly uniform frame. For the MX-15 preset near 295 K, about 250 counts per kelvin at the sensor."
            },
            "plateauFactor": {
                "label": "Histogram plateau",
                "tooltip": "Cap per detector-level bin = factor × pixel count / 16384; discarded counts are not redistributed."
            },
            "localAmount": {
                "label": "Local enhancement",
                "tooltip": "Signed unsharp detail before output clipping; produces opposite-sign rings."
            },
            "localRadiusPx": {
                "label": "Local radius",
                "tooltip": "Gaussian sigma in detector pixels; finite support is four sigma."
            },
            "radiometricLow": {
                "label": "Radiometric low",
                "tooltip": "Fixed lower photon-radiance endpoint, recovered from counts using the exposure factor."
            },
            "radiometricHigh": {
                "label": "Radiometric high",
                "tooltip": "Upper photon-radiance endpoint. By default it is the signal headroom of the well and the ADC at the selected exposure, and it follows the exposure; an edited value is held. Detector clipping still applies."
            },
            "polarity": {
                "label": "Polarity",
                "tooltip": "Black hot is the exact 255-code inverse of white hot, including the response curve.",
                "options": {
                    "whiteHot": "White hot",
                    "blackHot": "Black hot"
                }
            },
            "displayCurve": {
                "label": "Display curve",
                "tooltip": "Fixed lookup response after the count window and gamma, before quantization and polarity. Use gamma 1 for the measured law; MX-15 U depth uncertainty ±20%.",
                "options": {
                    "linear": "Linear",
                    "measured": "Measured preset curve"
                }
            },
            "polarityAffineGain": {
                "label": "White-hot output gain",
                "tooltip": "Output affine after the curve: white = gain × warm-increasing code + offset. Default 1 preserves exact inversion; the optional IB6830 recording profile uses 1.05."
            },
            "polarityAffineOffset": {
                "label": "White-hot output offset",
                "tooltip": "Output offset in 8-bit codes before clipping and rounding. Default 0 preserves exact inversion; the optional IB6830 recording profile uses +55 codes."
            },
            "responseGamma": {
                "label": "Response gamma",
                "tooltip": "White-hot response = clamped drive^(1/gamma); invert after quantization."
            },
            "digitalZoom": {
                "label": "Digital zoom",
                "tooltip": "Center crop after detector processing; does not alter optical field or counts."
            },
            "sampling": {
                "label": "Enlargement sampling",
                "tooltip": "Interpolate the final detector raster; float filtering is implemented explicitly.",
                "options": {
                    "nearest": "Nearest neighbor",
                    "linear": "Linear (half-pixel)",
                    "sampleCentered": "Linear (sample-centered)"
                }
            },
            "diagnosticView": {
                "label": "Diagnostic view",
                "tooltip": "Radiance uses fixed radiometric endpoints; counts use 0–16383. Readbacks retain physical units.",
                "options": {
                    "radiance": "Radiance",
                    "detectorCounts": "Detector counts",
                    "display": "Display"
                }
            },
            "pictureWidth": {
                "label": "Reference picture width",
                "tooltip": "Preset presentation metadata; the supplied output target determines actual size."
            },
            "pictureHeight": {
                "label": "Reference picture height",
                "tooltip": "Preset presentation metadata; does not change native sampling."
            }
        }
    },
    menus: {
        main: {
            title: "Sitrec",
            tooltip: "Start a sitch, load a legacy sitch or tool, open the extra tools, and change your settings.\nSome legacy sitches also put their controls in this menu.",
            noTooltip: "Load this sitch in place of the current sitch.",
            legacySitches: {
                label: "Legacy Sitches",
                tooltip: "Older built-in sitches. Each one is a predefined situation, often with its own code and assets.\nSelect one to load it in place of the current sitch.",
            },
            legacyTools: {
                label: "Legacy Tools",
                tooltip: "Special-purpose sitches: older tools, and sitches for testing and debugging.\nThe Test entries load many sitches, one after another, as a smoke test.\nSelect one to load it in place of the current sitch.",
            },
            extraTools: {
                label: "Extra Tools",
                tooltip: "Standalone tools that work alongside Sitrec. Each one opens in a new tab.",
                tools: {
                    losViewer: {
                        label: "LOS CSV Viewer",
                        tooltip: "Show line of sight (LOS) CSV data exported from Sitrec in 3D",
                    },
                    flowGen: {
                        label: "FlowGen",
                        tooltip: "Make synthetic videos with a known motion, to test optical flow and motion tracking",
                    },
                    px4Viewer: {
                        label: "PX4 ULog Viewer",
                        tooltip: "Show PX4 flight logs (ULog files) in 3D, and export them to CSV",
                    },
                    irBalloon: {
                        label: "IR Balloon",
                        tooltip: "Simulate how a mylar balloon looks to a mid-wave infrared (MWIR) thermal camera",
                    },
                    compass: {
                        label: "Compass & Elevation",
                        tooltip: "Measure compass heading and elevation angle with the orientation sensors of a phone",
                    },
                    shf: {
                        label: "Starlink Flare Predictor",
                        tooltip: "Predict the times and sky directions of Starlink horizon flares, for a place or along a flight",
                    },
                    psfStudio: {
                        label: "Diffraction PSF Studio",
                        tooltip: "Make the diffraction point spread function (PSF) of a camera aperture, and export it for Camera > Camera Tweaks > Diffraction Glare",
                    },
                    aircraftDesigner: {
                        label: "Vehicle Designer",
                        tooltip: "Build cars, trucks, aircraft, drones, balloons and sky lanterns with live sliders, searchable presets, and GLB model export",
                    },
                    xmlWindAnalyzer: {
                        label: "XML Wind Profile Analyzer",
                        tooltip: "Find the position and the vertical wind profile in an XML weather file, and get the settings that make Sitrec read it",
                    },
                },
            },
            selectPlaceholder: "-Select-",
        },
        file: {
            title: "File",
            tooltip: "Save and open sitches, import files, and export data, images and video.",
        },
        view: {
            title: "View",
            tooltip: "Controls for the views: layout, HUD color, video zoom and overlay, star and planet brightness, and atmospheric refraction.\nLike all menus, you can drag this menu off the menu bar to make it a floating menu.",
        },
        video: {
            title: "Video",
            tooltip: "Video adjustment, effects, and analysis",
        },
        time: {
            title: "Time",
            tooltip: "Date, time and frame controls for the sitch.\nThe date and time sliders show UTC, unless Use Time Zone in UI is on.\nDrag a time slider past its end to change the slider above it (for example, minutes past 59 add an hour).",
        },
        objects: {
            title: "Objects",
            tooltip: "3D objects and their settings. Each folder is one object.\ntraverseObject is the object that moves along the lines of sight (LOS). The Traverse menu sets its path.",
            addObject: {
                label: "Add Object",
                tooltip: "Create a new object at specified coordinates",
                prompt: "Enter: [Name] Lat Lon [Alt]\nExamples:\n  MyObject 37.7749 -122.4194 100m\n  37.7749, -122.4194\n  Landmark 37.7749 -122.4194",
                invalidInput: "Invalid input. Please enter coordinates in the format:\n[Name] Lat Lon [Alt]",
            },
        },
        satellites: {
            title: "Satellites",
            tooltip: "Load satellites, such as Starlink and the ISS, and control how they show.\nAlso holds the controls for horizon flares and other satellite effects.",
        },
        terrain: {
            title: "Terrain",
            tooltip: "The 3D model of the ground.\nMap Type sets the image drawn on the ground. Elevation Type sets the source of the ground heights.\nAlso 3D buildings, removing geometry, painting on the ground, and Street View panoramas.",
        },
        physics: {
            title: "Physics",
            tooltip: "Physics and motion settings, such as the units, the wind, the simple flight sim, track smoothing and object tilt.\nScenarios holds ready-made simulations.",
        },
        camera: {
            title: "Camera",
            tooltip: "The look camera: the camera that draws the look view, which is meant to match the video.\nLocation, Heading and FOV (Zoom) set where it is, where it points and how much it sees.",
        },
        target: {
            title: "Target",
            tooltip: "The target: a track that the look camera can point at.\nTarget Track chooses the track. The fixed target position is also set here: hold X with the pointer over a 3D view to move it.",
        },
        traverse: {
            title: "Traverse",
            tooltip: "Traverse controls.\nThe traverse object moves along the lines of sight (LOS) from the camera.\nThis menu sets how the traverse object moves and behaves.",
        },
        showHide: {
            title: "Show",
            tooltip: "Show or hide views, objects and other elements.",
            views: {
                title: "Views",
                tooltip: "Show or hide views (windows) like the look view, the video, the main view, as well as overlays like the MQ9UI",
            },
            linesOfSight: {
                title: "Lines of Sight (LOS)",
                tooltip: "The lines of sight from the camera over the sitch, and the line for the current frame",
            },
            frustum: {
                title: "Camera View Frustum",
                tooltip: "The camera view frustum: the pyramid from the camera that shows the edges of its view.\nAlso projects the video into the frustum or onto the ground",
            },
            graphs: {
                title: "Graphs",
                tooltip: "Show or hide the graph views, and add your own graphs.",
                addCustom: {
                    label: "Add Custom Graph",
                    tooltip: "Make a new graph window, with its own folder of controls in this menu.\nChoose its X, Y1, Y2 and Y3 data from the tracks, objects, analyses and other per-frame data in the sitch.",
                },
            },
            measurements: {
                title: "Measurements",
                tooltip: "Altitude and distance measurements drawn in the 3D views. Add your own, or click one to change or delete it",
            },
        },
        effects: {
            title: "Effects",
            tooltip: "Effects on the rendered image, such as blur, pixelation, color adjustments, sensor simulations and video format effects.\nAlso ray-traced refraction, water reflection and other scene effects.",
        },
        lighting: {
            title: "Lighting",
            tooltip: "Light in the scene: the Sun, ambient light and shadows.\nAlso the look view atmosphere and exposure, halos, city lights, and solar and lunar eclipses.",
        },
        contents: {
            title: "Contents",
            tooltip: "The tracks and other loaded data in the scene. Each track has a folder of display settings.\nAlso holds the live data feeds and the switches for all tracks.",
        },
        help: {
            title: "Help",
            tooltip: "Help for Sitrec: the documentation, the AI Assistant, the mouse and keyboard controls, and the debug log.",
            whatsNew: "What's New",
            gettingStarted: "Getting Started",
            docLinkTooltip: "Open the {{name}} page in a new tab.",
            githubDocLinkTooltip: "Open the {{name}} page on GitHub in a new tab.",
            docSectionTips: {
                start: "The basics: getting started, the user interface, time and frames, the AI Assistant, keyboard shortcuts and a glossary.",
                data: "Getting data into Sitrec and saving it: tracks, sources of flight data, recorded fireballs, saved sitches and chapters, 3D models and objects.",
                world: "How Sitrec models the world: the camera and target, geodesy and altitude, terrain, refraction, wind, historic skies, lighting, eclipses and haze.",
                video: "Working with video: loading, rendering and exporting it, and the video analysis tools.",
                analysis: "Analysis methods: traverse analysis, ground tracks, error analysis, BOTBench, special camera types, and satellites.",
                advanced: "Advanced topics: URL parameters, API keys, control from an AI assistant, local custom sitches, scripted camera moves, diffraction glare and the detailed release notes.",
            },
            documentation: {
                title: "Documentation",
                localTooltip: "The Sitrec documentation, grouped by subject. Each link opens a page in a new tab.",
                githubTooltip: "The Sitrec documentation on GitHub, grouped by subject. Each link opens a page in a new tab.",
                githubLinkLabel: "{{name}} (GitHub)",
                about: "About Sitrec",
                whatsNewDetails: "What's New (Details)",
                uiBasics: "User Interface Basics",
                aiAssistant: "The AI Assistant",
                keyboardShortcuts: "Keyboard Shortcuts",
                glossary: "Glossary",
                savingLoading: "Saving and Loading Sitches",
                sitchChapters: "Sitch Chapters",
                tracks: "Tracks and Data Sources",
                kmlDataSources: "Where to Get Flight Data",
                recordedFireballs: "Recorded Fireballs",
                objectReferences: "Reference Objects",
                gis: "GIS, Geodesy and Altitude",
                terrain: "Terrain and Elevation",
                refraction: "Atmospheric Refraction",
                historicSkies: "Historic Skies",
                lunarEclipse: "Lunar Eclipses",
                aerialPerspective: "Haze and Aerial Perspective",
                starlink: "How to Investigate Starlink Flares",
                customModels: "Objects and 3D Models (Planes)",
                cameraModes: "Camera Modes (Normal & Satellite)",
                fisheye: "Fisheye (Allsky) Projection",
                panoramicCamera: "Panoramic Camera",
                video: "Rendering and Exporting Video",
                longExposure: "Long Exposure/Stacking",
                videoQPGraph: "Video QP Graph",
                videoTonalGraph: "Video Tonal Range Graph",
                videoNoisePattern: "Video Noise Pattern Detection",
                masking: "Masking Out Part of the Video",
                starTracker: "Star Tracker",
                pointTrack: "Point Tracking and Stabilization",
                mq9Tracking: "MQ9 Tracking Simulation",
                lensGhost: "Lens Ghosts and Reflections",
                scriptedVideo: "Scripted Camera Moves",
                diffractionGlare: "Diffraction Glare",
                wind: "Wind",
                traverseConcepts: "Traverse Analysis: the Ideas First",
                groundTrack: "Ground Track (Points on the Ground)",
                traverseMethods: "Traverse Methods",
                balloonAlgorithms: "How the Balloon Algorithms Work",
                traverseAnalysis: "Traverse Analysis and the Verdict",
                losErrorAnalysis: "LOS Error Analysis",
                botBench: "BOTBench — Bearings-Only Traversal Bulk Analysis",
                botBenchScenarios: "BOTBench Scenario Files — where they come from",
                buildingMotionDatasets: "Building the Mundane, Extreme and Anomalies Datasets",
                botBenchCharts: "BOTBench Result Charts",
                gimbalRecreate: "Recreating Gimbal Step-by-Step",
                nimitz: "Nimitz / Tic Tac Case Study",
                football: "Football Scenario",
                lensGhostCaseStudy: "Lens Ghost Case Study (Pr055)",
                apiKeys: "Your API Keys: Storage & Security",
                webmcp: "Control Sitrec with ChatGPT",
                mcpBridge: "Control Sitrec from an AI Assistant (MCP Bridge)",
                localCustomSitches: "Local Custom Sitches (JSON)",
                timeAndSync: "Time, Frames and Syncing",
                sceneObjects: "Adding Objects and Tracks",
                cameraAndTarget: "Camera and Target Menus",
                lighting: "Lighting Menu",
                loadingVideo: "Loading and Adjusting Video",
                motionAnalysis: "Motion Analysis",
                satellites: "Satellites Menu",
                urlParameters: "URL Parameters",
                sections: {
                    start: "Start Here",
                    data: "Data and Tracks",
                    world: "The World",
                    video: "Video Tools",
                    analysis: "Analysis",
                    advanced: "Advanced",
                },
                menuHelpTitle: "Help",
                menuHelpTooltip: "Documentation pages about this menu. Each link opens a page in a new tab.",
                thirdPartyNotices: "Third-Party Notices",
                thirdPartyNoticesTooltip: "Open-source license attributions for bundled third-party software",
                downloadBridge: "Download MCP Bridge",
                downloadBridgeTooltip: "Download a zip of SitrecBridge: an MCP (Model Context Protocol) server, a Chrome extension and the Local Compute worker.\nWith it, an AI assistant can control Sitrec.",
            },
            externalLinks: {
                title: "External Links",
                tooltip: "Links to other help sites that this installation lists. Each link opens in a new tab.",
                linkTooltip: "Open {{name}} in a new tab.",
            },
            exportDebugLog: {
                label: "Export Debug Log",
                tooltip: "Download the console messages (log, warning and error) of this session as a text file, to send with a bug report.\nKeeps the last 10,000 messages. A development build does not record them.",
            },
        },
        debug: {
            title: "Debug",
            tooltip: "Debug tools and monitoring\nGPU memory usage, performance metrics, and other debugging information",
        },
    },
    file: {
        newSitch: {
            label: "New Sitch",
            tooltip: "Create a new sitch (will reload this page, resetting everything)",
        },
        savingDisabled: "Saving Disabled (click to log in)",
        savingDisabledTooltip: "Log in to save sitches to the server. The login page opens in a new tab. When you come back to this tab, the save buttons appear.",
        // Shown over the main view when a step late in restoring a saved sitch fails, and the
        // app carries on with what did load (CustomManagerSerialize.deserialize).
        sitchNotFullyLoaded: "This sitch did not fully load. Saving it now may lose parts of it.",
        // Shown over the main view when the startup login check fails (network error, or an
        // error page instead of an answer) and the app carries on logged out (src/login.js).
        loginCheckFailed: "Could not check your login. Reload the page to try again.",
        tweaks: {
            folder: {
                label: "File Tweaks",
                tooltip: "Settings that change what importing does",
            },
            resetOnTrackImport: {
                label: "Reset on Track Import",
                tooltip: "When a track is imported into a sitch that is already set up, "
                    + "throw the current scene away first and start a fresh one, so the "
                    + "result is the same as dropping the track onto an empty sitch. Off "
                    + "by default. Applies to files that can carry a track — including "
                    + "transport streams (.ts), where the video rides along with it — but "
                    + "not to plain video, images, audio or 3D models, since dropping one "
                    + "of those onto a track is how a scene gets built.",
            },
        },
        importFile: {
            label: "Import File",
            tooltip: "Import a file (or files) from your local system. Same as dragging and dropping a file into the browser window",
        },
        browseTracks: {
            label: "Browse Track Folder...",
            tooltip: "Browse a folder of multi-track files (such as BOT interchange CSVs) as thumbnails of their track shapes, preview one at full size, and import it",
        },
        server: {
            folderTooltip: "Save sitches to the Sitrec server, and open saved sitches from it.\nThe number after the server name is your user ID.",
            open: "Open",
            save: {
                label: "Save",
                tooltip: "Save the current sitch to the server",
            },
            saveAs: {
                label: "Save As",
                tooltip: "Save the current sitch to the server with a new name",
            },
            versions: {
                label: "Versions",
                tooltip: "Load a specific version of the currently selected sitch",
            },
            browseFeatured: "Browse featured sitches",
            browseAll: "Browse all your saved sitches in a searchable, sortable list",
        },
        local: {
            title: "Local",
            folderTooltip: "Save sitches as files on this computer, and open saved sitch files.\nWhen you last saved or opened a sitch on the server, this folder is closed and grayed out.",
            titleWithFolder: "Local: {{name}}",
            titleReconnect: "Local: {{name}} (reconnect)",
            status: "Status",
            noFileSelected: "No local file selected",
            noFolderSelected: "No folder selected",
            currentFile: "Current file: {{name}}",
            statusDesktop: "Current local desktop file/save state",
            statusFolder: "Current local folder/save state",
            stateReady: "Ready",
            stateReconnect: "Needs reconnect",
            stateNoFolder: "No folder",
            statusLine: "{{state}} | Folder: {{folder}} | Target: {{target}}",
            saveLocal: {
                label: "Save Local",
                tooltipDesktop: "Save to the current local file, or prompt for a filename if needed",
                tooltipFolder: "Save into the working folder (or prompts for a location if none is set)",
                tooltipSaveBack: "Save back to {{name}}",
                tooltipSaveBackInFolder: "Save back to {{name}} in {{folder}}",
                tooltipSaveInto: "Save into {{folder}} (prompts for sitch name)",
                tooltipPrompt: "Save a local sitch file (prompts for name/location)",
                tooltipSaveTo: "Save the current sitch to a local file",
            },
            saveLocalAs: {
                label: "Save Local As...",
                tooltipDesktop: "Save a local sitch file to a new path",
                tooltipFolder: "Save a local sitch file, choosing the location",
                tooltipInFolder: "Save with a new filename in the current working folder",
                tooltipNewPath: "Save the current sitch to a new local file path",
            },
            openLocal: {
                label: "Open Local Sitch",
                labelShort: "Open Local...",
                tooltipDesktop: "Open a local sitch file from disk",
                tooltipFolder: "Open a sitch file from the current working folder",
                tooltipCurrent: "Open a different local sitch file (current: {{name}})",
                tooltipFromFolder: "Open a sitch file from {{folder}}",
            },
            selectFolder: {
                label: "Select Local Sitch Folder",
                tooltip: "Select a working folder for local save/load operations",
            },
            reconnectFolder: {
                label: "Reconnect Folder",
                tooltip: "Re-grant access to the previously used working folder",
            },
        },
        debug: {
            recalculateAll: "debug recalculate all",
            dumpNodes: "debug dump nodes",
            dumpNodesBackwards: "debug dump nodes backwards",
            dumpRoots: "debug dump Root nodes",
            recalculateAllTooltip: "Recalculate every node in the node graph, in order of depth: nodes with no inputs first.",
            dumpNodesTooltip: "Print the node graph to the browser console: each root node (a node with no inputs), with the nodes that use it below it.",
            dumpNodesBackwardsTooltip: "Print the node graph to the browser console, from each end node (a node with no outputs) back through its inputs.",
            dumpRootsTooltip: "Print each root node (a node with no inputs) to the browser console. A green mark shows a visible node, a red mark a hidden one.",
        },
    },
    videoExport: {
        notAvailable: "Video Export Not Available",
        folder: {
            title: "Video Render & Export",
            tooltip: "Options for rendering and exporting video files from Sitrec views or full viewport",
        },
        renderView: {
            label: "Render Video View",
            tooltip: "Select which view to export as video",
        },
        renderSingleVideo: {
            label: "Render Single View Video",
            tooltip: "Render the view chosen in Render Video View to a video file, from the In frame to the Out frame.\nA dialog opens first, where you can add effects and see a preview.",
        },
        videoFormat: {
            label: "Video Format",
            tooltip: "File format and codec of the exported video. The list shows only the formats that this browser can encode.",
        },
        loops: {
            label: "Loops",
            tooltip: "Number of times the exported video repeats the frames from the In frame to the Out frame.",
        },
        renderSource: {
            label: "Render Source Video",
            tooltip: "Render the source video from the In frame to the Out frame, at its original resolution and frame rate, with the Video Adjustments applied.",
        },
        renderViewport: {
            label: "Render Viewport Video",
            tooltip: "Render the whole viewport (all the visible views, as on screen) to a video file, from the In frame to the Out frame.",
        },
        renderFullscreen: {
            label: "Render Fullscreen Video",
            tooltip: "Hide the menus, go to full screen, and render the whole viewport to a video file, from the In frame to the Out frame.",
        },
        recordWindow: {
            label: "Record Browser Window",
            tooltip: "Record the browser tab, with the menus and the rest of the UI, as a video from the In frame to the Out frame, at a fixed frame rate.\nThe browser first asks you to share the tab.",
        },
        retinaExport: {
            label: "Use HD/Retina Export",
            tooltip: "Multiply the size of a viewport export by the pixel ratio of the display (often 2 on a Retina or other HiDPI display).\nOff: export at the size of the views on screen.",
        },
        includeAudio: {
            label: "Include Audio",
            tooltip: "Include audio track from source video if available",
        },
        uniqueFramesOnly: {
            label: "Unique frames only",
            tooltip: "Scan the frames from the In frame to the Out frame before the export, and skip source video frames that repeat the frame before them.\nThe output keeps the selected or original frame rate, so the video becomes shorter.",
        },
        uniqueFrameThreshold: {
            label: "Unique threshold",
            tooltip: "Mean grayscale difference at or below this value counts as a duplicate for Unique frames only. Raise for recompressed videos with tiny frame-to-frame shimmer; lower if real subtle motion is being skipped.",
        },
        waitForLoading: {
            label: "Wait for background loading",
            tooltip: "When enabled, rendering waits for terrain/building/background loads before capturing each frame",
        },
        exportFrameJpg: {
            label: "Export Video Frame (JPG)",
            tooltip: "Export the current video frame as displayed (with effects) as a JPEG file",
        },
        exportFramePng: {
            label: "Export Video Frame (PNG)",
            tooltip: "Export the current video frame as displayed (with effects) as a PNG file",
        },
        fade: {
            folder: {
                title: "Render Fade",
                tooltip: "Render the selected view crossfading between the sim and the video overlay, as if the \"Vid Overlay Trans %\" slider were being moved up and down",
            },
            startView: {
                label: "Start With",
                tooltip: "Which view the render opens on. Look is the sim on its own (overlay transparency 0), Video is the video overlay alone (transparency 1)",
            },
            initialDelay: {
                label: "Initial Delay (s)",
                tooltip: "Seconds to hold on the starting view before the first fade begins",
            },
            fadeTime: {
                label: "Fade Time (s)",
                tooltip: "Seconds each crossfade takes, from one view fully to the other",
            },
            holdTime: {
                label: "Hold Time (s)",
                tooltip: "Seconds to hold on each view after a fade arrives on it, before the next fade starts",
            },
            fades: {
                label: "Fades",
                tooltip: "How many crossfades to render. Each fade goes to the other view, so 2 fades goes to the other view and back to the start",
            },
            holdFrame: {
                label: "Hold Current Frame",
                tooltip: "Freeze on the current frame for the whole render, so the output is a still comparison. Turn off to play the A-B range while fading, looping it if the fade schedule outlasts the clip",
            },
            viewport: {
                label: "Render Whole Viewport",
                tooltip: "Render the entire viewport - every visible view, laid out as on screen - instead of just the one view. The fade still runs on the look view's video overlay, so the rest of the viewport plays normally around it",
            },
            render: {
                label: "Render Fade Video",
                tooltip: "Render the fade using the view chosen in Render Video View, or the whole viewport if Render Whole Viewport is on. Length is Initial Delay + Fades x (Fade Time + Hold Time)",
            },
            startOptions: {
                look: "Look",
                video: "Video",
            },
        },
    },
    tracking: {
        enable: {
            label: "Enable Point Track",
            disableLabel: "Disable Point Track",
            tooltip: "Show the point-track cursor on the video and turn on Point Track. Drag the cursor onto the object, then press Start Point Track.\nWhile it is on, hold ' to track one frame at a time, or hold ; to step back and delete points.\nPress again to hide the cursor. The track is kept.",
        },
        start: {
            label: "Start Point Track",
            stopLabel: "Stop Point Track",
            tooltip: "Automatically advance through the video and track the object inside the cursor. Normal playback controls are disabled while tracking. Press Stop Point Track or Space to stop at the last tracked frame.",
        },
        useMask: {
            label: "Use Mask",
            tooltip: "Ignore masked pixels in Motion (Background) and in Center on Bright, Dark and Color.\nMotion tracking also excludes them from camera registration and the background model, helping prevent false returns on readouts and reticles.\nPaint a mask under Video > Masking. Has no effect if there is no mask.",
        },
        clearFromHere: {
            label: "Clear from Here",
            tooltip: "Delete all tracked points, including the points you placed by hand, from the current frame to the end of the A-B range. Points before the current frame stay.",
        },
        clearTrack: {
            label: "Clear Track",
            tooltip: "Clear all point-track positions and start fresh",
        },
        editHeadOnly: {
            label: "Edit Head Only",
            tooltip: "Only the point at the current frame - the one inside the yellow cursor - can be dragged.\nThe rest of the track still draws, faded back, but clicks pass over it.\nUse it on a dense track, where an earlier keyframe near the cursor would otherwise take the drag.",
        },
        stabilize: {
            label: "Stabilize",
            tooltip: "Shift each video frame so the tracked point stays still, and turn stabilization on. The point is held at the center of the video, or where it was in the first tracked frame when Stabilize Centers is off.\nNeeds a point track.",
        },
        stabilizeToggle: {
            enableLabel: "Enable Stabilization",
            disableLabel: "Disable Stabilization",
            tooltip: "Turn the stabilized display on or off. The stabilization data is kept.\nPress Stabilize first to make the data.",
        },
        stabilizeCenters: {
            label: "Stabilize Centers",
            tooltip: "On: Stabilize holds the tracked point at the center of the video frame. Off: it holds the point where it was in the first tracked frame.",
        },
        renderStabilized: {
            label: "Render Stabilized Video",
            tooltip: "Export stabilized video at original size (tracked point stays fixed, edges may show black)",
        },
        renderStabilizedExpanded: {
            label: "Render Stabilized Expanded",
            tooltip: "Export stabilized video with expanded canvas so no pixels are lost",
        },
        includeVideoInfo: {
            label: "Include Video Readout",
            tooltip: "Composite the Video Readout (frame counter, timecode, dates) and any visible OSD Tracker readouts onto the rendered stabilized video",
        },
        trackRadius: {
            label: "Track Radius",
            tooltip: "Radius of the inner solid circle, in original video pixels: the size of the object.\nTemplate Match: the size of the template. Optical Flow: the area it picks points to follow from. Center on Bright/Dark/Color: the area that holds the connected object, without separate neighbors. Motion (Background): the object size.",
        },
        searchRadius: {
            label: "Search Radius",
            tooltip: "Radius of the outer dashed circle, in original video pixels. In each frame, the tracker looks for the object within this distance of where it expects it. Motion (Background) adds the distance that a fast or missing object can move.\nIncrease it for fast motion. Decrease it if the track jumps to a nearby object.",
        },
        trackingMethod: {
            label: "Tracking Method",
            tooltip: "How the tracker finds the object in each frame:\nMotion (Background): what moves differently from the background. Suits small objects over terrain, sea or sky. Press Analyse Object after you choose it.\nTemplate Match: the image patch inside Track Radius. Suits objects with visible structure.\nOptical Flow: follows corner points inside Track Radius.\nCenter on Bright / Dark / Color: the center of the pixels that pass Brightness Threshold, or that are near Tracking Color.\nHigh Peak / Low Peak: the brightest or darkest spot of about Feature Size. Suit lights at night.\nA change while Start Point Track runs clears the whole track.",
        },
        clearUserPoints: {
            label: "Clear User Points",
            tooltip: "Delete only the points you placed by hand (the magenta ones). Asks first — the automatic points cannot replace them, because these are what the tracker uses to correct itself",
        },
        clearAutoPoints: {
            label: "Clear Auto Points",
            tooltip: "Delete only the automatically tracked points, keeping every point you placed by hand. Track again and the automatic points are recomputed, guided by yours",
        },
        analyseObject: {
            label: "Analyse Object",
            tooltip: "Put the cursor on the object, then press this. It tests the object in the current frame and sets Motion Polarity, Feature Size and Motion Parallax Slack to suit it. It can also set Motion Frame Gap to 1.\nIf the object is not clear enough, nothing changes.\nThe button shows the result for a few seconds. If another Tracking Method suits the object better (for example High Peak for a light on a dark sky), the button names it.",
        },
        showMotionField: {
            label: "Show Motion Field",
            tooltip: "Motion (Background) mode only: draw what the tracker works from in place of the video. This is the frame with the background's own motion subtracted.\nMid-gray: as the background predicts. Brighter or darker: brighter or darker than the background predicts. Black: masked out.\nUse it to see whether the object stands out, and what else does.",
        },
        motionPolarity: {
            label: "Motion Polarity",
            tooltip: "Motion (Background) mode: whether the object is brighter or darker than the background it crosses. Either works but is slightly noisier",
        },
        motionGap: {
            label: "Motion Frame Gap",
            tooltip: "Motion (Background) mode: frames between the earlier frames the background is built from. Raise it if the object moves slowly against the scene, so it separates from where it used to be",
        },
        motionSlack: {
            label: "Motion Parallax Slack",
            tooltip: "Motion (Background) mode: pixels of background shift to forgive. 0 for flat terrain viewed from directly above; 2-3 for hills or buildings viewed at an angle, where the background cannot be cancelled exactly",
        },
        motionThreshold: {
            label: "Motion Threshold",
            tooltip: "Motion (Background) mode: how far above the noise a detection must be before it is believed, in multiples of the noise level (sigma). Lower to hold a faint object, raise if the tracker jumps to clutter. Also set Feature Size to match the object — too large and a small object is smoothed away before it can be found",
        },
        centerOnBright: {
            label: "Center on Bright",
            tooltip: "Track centroid of bright pixels (better for stars/point lights)",
        },
        centerOnDark: {
            label: "Center on Dark",
            tooltip: "Track centroid of dark pixels",
        },
        brightnessThreshold: {
            label: "Brightness Threshold",
            tooltip: "Brightness level, 0–255, for Center on Bright and Center on Dark. Center on Bright uses only pixels brighter than this, and Center on Dark only pixels darker. Pixels farther past the level count more.\nIn those modes, while you drag the slider, the video shows the pixels that pass in white.",
        },
        trackingColor: {
            label: "Tracking Color",
            tooltip: "Target color for Center on Color mode. Pixels within Color Distance of this color contribute to the centroid",
        },
        colorDistance: {
            label: "Color Distance",
            tooltip: "Max RGB Euclidean distance (0-442) a pixel may be from Tracking Color and still contribute. Used in Center on Color mode",
        },
        status: {
            loadingJsfeat: "Loading jsfeat...",
            loadingOpenCv: "Loading OpenCV...",
            sam2Connecting: "SAM2: Connecting...",
            sam2Uploading: "SAM2: Uploading...",
        },
    },
    trackManager: {
        createSpline: "Create Spline",
        editTrack: "Edit Track",
        constantSpeed: "Constant Speed",
        extrapolateTrack: "Extrapolate Track",
        curveType: "Curve Type",
        exportSpline: "Export Spline",
        deleteTrack: "Delete Track",
        // A sounding or profile track with no position at each level.
        reconstructedAscent: {
            name: "Path",
            label: "Reconstructed ascent",
            tooltip: "The file gives no position for each level, so Sitrec makes this path:\na 5 m/s ascent from the launch point and time, moved by the winds in the file.\nThe real balloon (if any) did not necessarily fly this path. The wind data itself is not changed.",
        },
        deleteTrackConfirm: "Delete track \"{{name}}\"?",
        deleteTrackAndObject: "Delete Track and \"{{object}}\"",
        deleteTrackOnly: "Delete Track Only",
        cancel: "Cancel",
        pathFolder: "Path",
        smoothingFolder: "Smoothing",
        displayFolder: "Display",
        curveTypes: {
            linear: "Straight lines",
            chordal: "Smooth (chordal)",
            centripetal: "Smooth (centripetal)",
            catmull: "Smooth (Catmull-Rom)",
        },
        tips: {
            folder: "Settings for this track: how it is drawn, and the controls that change its path or data.\nHover over the title to highlight the track line in white",
            pathFolder: "How the track runs through its control points: speed, curve shape, extrapolation and altitude",
            smoothingFolder: "How the track's positions are smoothed. Choose the Smoothing Method first: it decides which of the other controls apply",
            displayFolder: "How the track is drawn: its line, color and width, a wall down to the ground, and a contrail",
            balloonFolder: "Settings for this simulated balloon: its launch, its rise rate and its drift in the wind.\nHover over the title to highlight the track line in white",
            editTrack: "Show this track's control points in the main view, so that you can move, add and delete them.\nOnly one track can be edited at a time. Press Esc to stop",
            constantSpeed: "Move along the path at one steady speed, from the first point at the start of the sitch to the last point at the end.\nOff: the track reaches each point at that point's own frame",
            extrapolateTrack: "Before the first point and after the last, continue the track in a straight line from the two end points.\nOff: the track stays at the first or last point",
            exportSpline: "Save this track's control points as a .spline.json file. Drop that file onto Sitrec to load it as an editable track.\nFile > Export has the same, and the track as CSV and KML",
            deleteSynthetic: "Delete this track, after you confirm. If an object moves along it, you choose whether to delete the object too",
            deleteImported: "Delete this track from the sitch, after you confirm. The file it came from is not changed: drop the file again to get the track back",
            deleteBalloon: "Delete this balloon and its sphere, after you confirm",
            createSpline: "Make a new editable track from 10 points spread evenly along this track. Its name ends in _sp, and it opens in edit mode",
        },
        curveTypeTooltip: "How the track goes through its points.\n"
            + "Straight lines: straight from point to point.\n"
            + "Chordal: smooth, with round turns. The default.\n"
            + "Centripetal: smooth, and never makes a loop or a sharp point between points.\n"
            + "Catmull-Rom: smooth, but can overshoot or loop where points are unevenly spaced.",
        showObjectMenu: {
            label: "Show Object Menu",
            tooltip: "Open the menu of the object that moves along this track",
        },
        // Asked when one file with two or more tracks, and no camera or target of its own,
        // goes into a new sitch. See TrackManager.shouldAskLoadOrderPairing.
        pairTracks: {
            title: "Camera and Target",
            question: "This file has {{count}} tracks. Use the first track, \"{{camera}}\", as the camera "
                + "and the second track, \"{{target}}\", as the target?\n\n"
                + "The camera then moves with \"{{camera}}\" and always points at \"{{target}}\".",
            yes: "Use as camera and target",
            yesDescription: "The camera moves with \"{{camera}}\" and points at \"{{target}}\"",
            no: "Only load the tracks",
            noDescription: "The camera and target do not change. You can select the tracks later "
                + "in Camera → Location → Position and in Target → Target Track",
            checkbox: "Use the first two tracks as camera and target",
            checkboxTooltip: "On: the camera moves with the first track that loads and always points at the second. "
                + "Off: the tracks load, but the camera and target do not change.",
        },
    },
    altitudeLock: {
        lock: {
            label: "Lock Altitude",
            tooltip: "Hold the whole track at one height. Moving a point up or down moves the lock height",
        },
        heightFrom: {
            label: "Height From",
            tooltip: "Measure the lock height from the ground below the track, or from the WGS84 ellipsoid (HAE)",
            ground: "Ground",
            ellipsoid: "Ellipsoid (HAE)",
        },
    },
    gpuMonitor: {
        enabled: "Monitor Enabled",
        total: "Total Memory",
        geometries: "Geometries",
        textures: "Textures",
        peak: "Peak Memory",
        average: "Average Memory",
        reset: "Reset History",
        tips: {
            folder: "Estimated GPU memory use of the 3D views, terrain tile counts, and tools to free GPU memory.",
            enabled: "Update the readouts in this folder about once a second while the folder is open. Off: the readouts stop updating.",
            total: "Estimated GPU memory of all geometries and textures in the scene, from a scan of the scene.",
            geometries: "Estimated GPU memory of the vertex data of all geometries.",
            textures: "Estimated GPU memory of all textures.",
            peak: "Highest Total Memory in the recent samples (up to 60).",
            average: "Average Total Memory over the recent samples (up to 60).",
            tiles: "Terrain tiles in use now, and in parentheses all the terrain tiles in the cache.",
            matCache: "Number of materials in the terrain tile material cache.",
            viewGL: "Textures, geometries and shader programs that this view's renderer holds in GPU memory, as Three.js counts them.",
            prune: "Free every terrain tile that is not in use now, in all terrain maps and the elevation map. The console shows how many.",
            forceRender: "Render the main and look views once, so that Three.js frees the textures and geometries that wait to be disposed. The console shows the counts before and after.",
            reset: "Clear the samples that Peak Memory and Average Memory use.",
        },
    },
    situationSetup: {
        mainFov: {
            label: "Main FOV",
            tooltip: "Vertical field of view of the main view's camera, in degrees.",
        },
        lookCameraFov: "Look Camera FOV",
        lookCameraFovTooltip: "Vertical field of view of the look camera, in degrees.",
        azimuth: "azimuth",
        azimuthTooltip: "Camera azimuth, in degrees, from the sitch's azimuth data.\nMoving it jumps to the first frame that reaches this azimuth.",
        jetPitch: "Jet Pitch",
        jetPitchTooltip: "Pitch angle of the jet, in degrees, used in the pod and glare geometry.",
    },
    featureManager: {
        labelText: "Label Text",
        latitude: "Latitude",
        longitude: "Longitude",
        altitude: "Altitude (m)",
        altitudeMSL: "Altitude MSL (m)",
        altitudeHAE: "Altitude HAE (m)",
        arrowLength: "Arrow Length",
        arrowColor: "Arrow Color",
        textColor: "Text Color",
        deleteFeature: "Delete Pin",
        done: "Done",
        labelTextTooltip: "Text of the pin's label. The menu title follows it.",
        latitudeTooltip: "Latitude of the pin, in degrees. While this menu is open, drag the pin to move it.",
        longitudeTooltip: "Longitude of the pin, in degrees. While this menu is open, drag the pin to move it.",
        altitudeMSLTooltip: "Height of the pin above mean sea level (MSL), in meters.",
        altitudeHAETooltip: "Height of the pin above the WGS84 ellipsoid (HAE, height above ellipsoid), in meters.\nThe number in parentheses is the geoid offset: HAE minus MSL.",
        arrowLengthTooltip: "Length on screen of the arrow between the pin point and its label. 0 puts the label on the point.",
        arrowColorTooltip: "Color of the arrow between the label and the pin point.",
        textColorTooltip: "Color of the label text.",
        deleteFeatureTooltip: "Delete this pin. Sitrec asks you to confirm first.",
        doneTooltip: "Close this menu and stop editing the pin. Escape does the same.",
    },
    timelineMarkers: {
        menuTitle: "Timeline: Frame {{frame}}",
        markerTitle: "Marker: {{name}}",
        unnamed: "Frame {{frame}}",
        label: "Label",
        goToMarker: "Go to Marker",
        deleteMarker: "Delete Marker",
        addAtCurrent: "Add Marker at Current Frame ({{frame}})",
        addHere: "Add Marker Here ({{frame}})",
        goToFolder: "Go to Marker ({{count}})",
        goToEntry: "{{name}} — frame {{frame}}",
        deleteAll: "Delete All Markers",
        deleteAllConfirm: "Delete all {{count}} timeline markers?",
        deleteAllTitle: "Delete Markers",
        resetInOut: "Reset In/Out",
        undoAdd: "Add timeline marker",
        undoRename: "Rename timeline marker",
        undoDelete: "Delete timeline marker",
        undoDeleteAll: "Delete all timeline markers",
        undoSet: "Set timeline markers",
        tips: {
            label: "Name of this marker. Leave it empty to show the frame number instead.",
            goToMarker: "Go to the frame of this marker, and pause.",
            deleteMarker: "Delete this marker. You can undo it.",
            addAtCurrent: "Add a timeline marker at the current frame. Not available when that frame has a marker.",
            addHere: "Add a timeline marker at the frame under the pointer. Not available when that frame has a marker.",
            goToFolder: "All the timeline markers. Click one to go to its frame, and pause.",
            goToEntry: "Go to the frame of this marker, and pause.",
            deleteAll: "Delete every timeline marker, after you confirm. You can undo it.",
            resetInOut: "Set the In frame to the first frame and the Out frame to the last frame. You can undo it.",
        },
    },
    panoramaExport: {
        exportLookPanorama: {
            label: "Export Look Panorama",
            tooltip: "Render the look view at each frame from the In frame to the Out frame, and join the frames into one panorama PNG image.\nThe background (the terrain, or a point 50 km away) sets where each frame goes.",
        },
    },
    dateTime: {
        liveMode: {
            label: "Live Mode",
            tooltip: "Show the sitch at the real current time. The frame stays at the middle of the timeline, and the time follows the computer clock.\nMoving the frame, or changing the date or time, turns Live Mode off.",
        },
        startTime: {
            tooltip: "Date and time of the first frame of the sitch, in UTC.",
        },
        currentTime: {
            tooltip: "Date and time of the current frame, in UTC. The date and time sliders below show this time.",
        },
        year: { label: "Year", tooltip: "Year of the current frame.\nThe slider starts at 1947, but you can type an earlier year, or use the Go To box (G), to reach a historic date - the slider range then extends back to 1700." },
        month: { label: "Month", tooltip: "Month (1-12)" },
        day: { label: "Day", tooltip: "Day of month" },
        hour: { label: "Hour", tooltip: "Hour (0-23)" },
        minute: { label: "Minute", tooltip: "Minute (0-59)" },
        second: { label: "Second", tooltip: "Second (0-59)" },
        millisecond: { label: "ms", tooltip: "Millisecond (0-999)" },
        rangeNote: {
            label: "Note",
            tooltip: "Shown only when something about the current date needs care. See Help > Documentation > Historic Skies.",
            outsideEphemeris: "Outside 1700-2200 - Sun, Moon and planet positions degrade",
            preSatellite: "Before 1957 - no artificial satellites existed",
        },
        useTimeZone: {
            label: "Use Time Zone in UI",
            tooltip: "Show the date and time sliders above in the selected Time Zone instead of UTC. Their labels turn pink.\nUse it to work in the local time of the video or the location.",
        },
        timeZone: {
            label: "Time Zone",
            tooltip: "Time zone for the date and time that the views show, such as the time display in the look view.\nThe date and time sliders also use it when Use Time Zone in UI is on.",
        },
        setTimeZoneFromCameraLocation: {
            label: "Set Time Zone from Camera Location",
            tooltip: "Set the Time Zone to the zone at the look camera position, with the daylight saving rule of the sitch start date.\nThe time does not change. Only the zone that shows it changes.\nTime zone borders: © OpenStreetMap contributors, timezone-boundary-builder (ODbL).",
            message: "Time Zone Set to {{zone}}",
        },
        showTimeZones: {
            label: "Show Time Zones",
            tooltip: "Draw the time zones at the Now Time over the globe in the main view, with daylight saving time: a line marks where the clocks on its two sides differ, on land and at sea.\nEach zone has a light color for its UTC offset. A zone on a half or quarter hour (India, UTC+5:30) has stripes of the colors of the two hours next to it.\nA row of labels across the middle of the view names each zone for the sitch date, for example PDT UTC-7.\nThe zones and their offsets are correct for any date since 1970.\nTime zone borders: © OpenStreetMap contributors, timezone-boundary-builder (ODbL).",
            loadFailed: "The time zone borders did not load",
        },
        simSpeed: {
            label: "Simulation Speed",
            tooltip: "The speed of the simulation, 1 is real time, 2 is twice as fast, etc\nThis does not change the video replay speed, just the time calculations for the simulation.",
        },
        sitchFrames: {
            label: "Sitch Frames",
            tooltip: "The number of frames in the sitch. If there's a video then this will be the number of frames in the video, but you can change it if you want to add more frames to the sitch, or if you want to use the sitch without a video",
        },
        sitchDuration: {
            label: "Sitch Duration",
            tooltip: "Duration of the sitch in HH:MM:SS.sss format",
        },
        aFrame: {
            label: "In Frame [I]",
            tooltip: "Limit playback/export to start at the In frame. Press I to set this to the current frame.",
        },
        bFrame: {
            label: "Out Frame [O]",
            tooltip: "Limit playback/export to end at the Out frame. Press O to set this to the current frame.",
        },
        pingPong: {
            label: "In-Out Pingpong",
            tooltip: "When playing, bounce between the In and Out frames instead of wrapping to the start. Video renders use the same In-Out bounce.",
        },
        videoFps: {
            label: "Video FPS",
            tooltip: "Frames per second of the video. It sets how long each frame lasts, so it changes the playback speed and the duration of the sitch in seconds.\nSitrec reads it from the video when it can. Change it to speed up or slow down the video. A value that you set stays after a reload, and when a new video loads.",
        },
        syncTimeTo: {
            label: "Sync Time to",
            tooltip: "Change the sitch time:\nStart Time: go back to the start time that the sitch loaded with.\nNow Time: set the current frame to the real current time.\nA track name: set the sitch start time to the start of that track, and go to frame 0.",
        },
        syncDurationTo: {
            label: "Sync Duration to",
            tooltip: "Set the sitch duration (number of frames) to match the duration of a loaded track",
        },
        timingAnalysis: {
            tooltip: "Show a report on the timing of the MISB metadata (camera data in KLV format) in the sitch: its streams, the video frame times, the KLV intervals, gaps and drift, and whether the GPS positions agree with the speeds.\nNeeds a loaded .ts, .klv or MISB CSV file. You can copy or download the report.",
        },
    },
    jet: {
        frames: {
            time: {
                label: "Time (sec)",
                tooltip: "Current time from the start of the video in seconds (frame / fps)",
            },
            frame: {
                label: "Frame in Video",
                tooltip: "Current frame number in the video",
            },
            paused: {
                label: "Paused",
                tooltip: "Toggle the paused state (also spacebar)",
            },
        },
        controls: {
            pingPong: "A-B Ping-Pong",
            podPitchPhysical: "Pod (Ball) Pitch",
            podRollPhysical: "Pod Head Roll",
            deroFromGlare: "Derotation = Glare Angle",
            jetPitch: "Jet Pitch",
            lookFov: "Narrow FOV",
            elevation: "elevation",
            glareStartAngle: "Glare Start Angle",
            initialGlareRotation: "Glare Initial Rotation",
            scaleJetPitch: "Scale Jet Pitch with Roll",
            horizonMethod: "Horizon Method",
            horizonMethodOptions: {
                humanHorizon: "Human Horizon",
                horizonAngle: "Horizon Angle",
            },
            videoSpeed: "Video Speed",
            podWireframe: "[B]ack Pod Wireframe",
            showVideo: "[V]ideo",
            showGraph: "[G]raph",
            showKeyboardShortcuts: "[K]eyboard Shortcuts",
            showPodHead: "[P]od Head Roll",
            showPodsEye: "Pod's [E]ye views w' dero",
            showLookCam: "[N]AR view w' dero",
            showCueData: "[C]ue Data",
            showGlareGraph: "Sh[o]w Glare Graph",
            showAzGraph: "Show A[Z] Graph",
            declutter: "[D]eclutter",
            jetOffset: "Jet Y offset",
            tas: "TAS True Airspeed",
            integrate: "Integration Steps",
        },
        controlTips: {
            podPitchPhysical: "Pitch of the pod ball, in degrees. A change pauses playback and turns the ball.\nSitrec sets it again from the target direction when the frame changes.",
            podRollPhysical: "Roll of the pod head, in degrees. A change pauses playback and turns the head.\nSitrec sets it again when the frame changes.",
            deroFromGlare: "Set the pod head roll (the derotation) from the measured glare angle, instead of from the ideal roll that points the pod at the target.",
            jetPitch: "Pitch of the jet, in degrees. When Scale Jet Pitch with Roll is on, it is divided by the cosine of the bank angle.",
            lookFov: "Vertical field of view of the look camera, in degrees.",
            glareStartAngle: "Angle, in degrees, added to the measured glare angle on every frame.",
            initialGlareRotation: "Rotation, in degrees, taken off the glare angle at frame 0. The amount falls in a straight line to zero at frame 697.",
            scaleJetPitch: "Divide Jet Pitch by the cosine of the bank angle, so that the pitch increases as the jet banks.",
            horizonMethod: "How Sitrec calculates the horizon angle:\nHuman Horizon: from the jet pitch, roll, azimuth and elevation.\nHorizon Angle: from a simpler formula of the jet pitch, roll and azimuth.",
            podWireframe: "Draw the back of the pod as a wireframe.",
            showVideo: "Show the video view (toggle: V).",
            showGraph: "Show the chart view (toggle: G).",
            showKeyboardShortcuts: "Show the list of keyboard shortcuts on the screen (toggle: K).",
            showPodHead: "Show the view of the pod head roll (toggle: P).",
            showPodsEye: "Show the views from the pod, with derotation (toggle: E).",
            showLookCam: "Show the narrow (NAR) look view and its pod display overlay (toggle: N).",
            showCueData: "Show the cue and azimuth arrows, and their lines in the graph (toggle: C).",
            showGlareGraph: "Show the glare angle in the graph (toggle: X).",
            showAzGraph: "Show the azimuth editor graph (toggle: Z).",
            declutter: "Show or hide the graph views: the azimuth editor, speed, cloud speed, tail angle, fleet speed, altitude and size graphs (toggle: D).",
            jetOffset: "Vertical offset of the jet model from its position, in meters.",
        },
    },
    motionAnalysis: {
        menu: {
            title: "Motion Analysis",
            tooltip: "Measure how the background moves across the video, frame by frame.\nThe results drive the track, CSV, stabilization and panorama tools in this folder.",
            analyzeMotion: {
                label: "Analyze Motion",
                tooltip: "Start or stop live motion analysis. While it is on, arrows and a Motion Angle graph show over the video. Playback waits for each frame to be analyzed.\nTracking Parameters and Speed Overlay appear only while it is on. Stop Analysis also stops a running full-range analysis.",
            },
            createTrack: {
                label: "Create Track from Motion",
                tooltip: "Build a green track on the ground that moves with the image motion, converted to meters. It starts from the traverse, target or camera track, the first that exists.\nIt analyzes the In to Out range first if needed. Each click makes a new track.",
            },
            exportMotion: {
                label: "Export Motion",
                tooltip: "Download a CSV file with the background motion of each frame from In to Out.\nColumns: frame, angle (degrees, 0 = right, clockwise), magnitude (pixels per frame), time and UTC.\nIt analyzes the range first if needed.",
            },
            alignWithFlow: {
                label: "Align with Flow",
                tooltip: "Rotate the video on screen so the background motion points to the right. Works only while Analyze Motion is on.\nIt also rotates the motion panorama when Projection is Similarity (2D) and Rotate Frames (SfM) is off.",
            },
            defence: {
                label: "Start De-Fence",
                tooltip: "Remove a near fence from a panning video, and rebuild the distant scene seen through its gaps.\nIt uses the frames from In to Out, and downloads the result as a PNG image.",
            },
            defenceVideo: {
                label: "Export De-Fence Video",
                tooltip: "Render a video of the de-fence process: a pass of the original video, then the fence dissolving as the scene accumulates, then the final result",
            },
            defenceOptions: {
                title: "De-Fence",
                tooltip: "Remove a near fence from a video that pans past it, and rebuild the distant scene behind it.\nIt does not need Motion Analysis, and it does not use the mask.",
                technique: {
                    label: "Technique",
                    tooltip: "How fence pixels are told from background pixels.\nColor + Motion: uses both the gap color and the motion (default).\nColor only: uses gap brightness and green. Best when the fence is a distinct color.\nMotion only: uses only the motion. Best on fences with little texture.",
                    colourVariance: "Color + Motion",
                    colour: "Color only",
                    variance: "Motion only",
                },
                varThresh: {
                    label: "Variance Threshold",
                    tooltip: "How much a pixel must change (once the fence is aligned) to count as background. Lower = fills holes but lets more fence through; higher = cleaner but more gaps.\nNot used with Technique: Color only.",
                },
                gapThresh: {
                    label: "Gap Brightness",
                    tooltip: "Smallest gap brightness or green (0–1) for a pixel to count as background. Lower keeps darker background, such as a shadowed lower fence. Higher rejects more boards.\nNot used with Technique: Motion only.",
                },
                bgBaseline: {
                    label: "Background Baseline",
                    tooltip: "Frames between samples when estimating the slower background motion. Larger = more reliable parallax separation; too large risks occlusion. ~24 is a good start.",
                },
            },
            panorama: {
                title: "Panorama",
                tooltip: "Stitch the frames from In to Out into one large image or video.\nMotion Pano places frames with the Motion Analysis results. Feature Pano matches features between frames itself.",
                exportImage: {
                    label: "Export Motion Pano Image",
                    tooltip: "Build a panorama PNG from the frames In to Out, placed by the Motion Analysis results, and download it.\nIt analyzes the range first if needed.",
                },
                exportVideo: {
                    label: "Export Motion Pano Video",
                    tooltip: "Create a 4K video showing the motion panorama with the video frame overlaid",
                },
                motionOptions: {
                    title: "Motion Pano Options",
                    tooltip: "Settings for Export Motion Pano Image and Export Motion Pano Video.",
                },
                projection: {
                    label: "Projection",
                    tooltip: "How each frame is placed on the panorama.\nSimilarity (2D): a move, plus a turn with Rotate Frames (SfM) and a scale with Allow Frame Scaling. Fast, but with a pan, tilt or zoom camera the error builds up.\nPerspective (Homography): fits a full perspective warp to each frame, which aligns pan/tilt/zoom footage from edge to edge. If the fit fails, Similarity is used.",
                    similarity: "Similarity (2D)",
                    perspective: "Perspective (Homography)",
                },
                rotateFrames: {
                    label: "Rotate Frames (SfM)",
                    tooltip: "Turn each frame by its measured rotation as well as moving it, so camera roll is followed. When off, frames are only moved.\nUsed only when Projection is Similarity (2D).",
                },
                allowFrameScale: {
                    label: "Allow Frame Scaling",
                    tooltip: "Rotate Frames only: also apply the recovered per-frame SCALE. Off (default) keeps every frame the same size (rigid rotation+translation); on lets frames grow/shrink, which can accumulate scale drift across the panorama",
                },
                exportFeature: {
                    label: "Export Feature Pano Image",
                    tooltip: "Build a panorama PNG from the frames In to Out. Features are matched between frames, and each frame is warped to fit.\nIt does its own alignment, so it needs Motion Analysis only when Feature Source is Motion Tracklets.",
                },
                exportFeatureVideo: {
                    label: "Export Feature Pano Video",
                    tooltip: "Create a video where each frame is warped into its place on the feature-stitched panorama background",
                },
                featureOptions: {
                    title: "Feature Pano Options",
                    tooltip: "Settings for Export Feature Pano Image and Export Feature Pano Video.",
                },
                featureSource: {
                    label: "Feature Source",
                    tooltip: "ORB Features: detect & match ORB corners (re-detected each frame). Motion Tracklets: reuse the Motion Analysis optical-flow tracks (the same points followed across many frames — more consistent on soft/low-contrast content). Motion Tracklets runs a motion-analysis pass over the range first.",
                },
                stabilize: {
                    label: "Stabilize Video",
                    disableLabel: "Disable Stabilization",
                    tooltip: "Shift each frame to cancel the background motion that Motion Analysis measures. It moves the frame only; it does not turn or scale it.\nIt analyzes the In to Out range first if needed. Click Disable Stabilization to see the original video.",
                },
                panoFrameStep: {
                    label: "Pano Frame Step",
                    tooltip: "Use every Nth frame in Export Motion Pano Image (1 = every frame).\nExport Motion Pano Video always uses every frame.",
                },
                crop: {
                    label: "Panorama Crop",
                    tooltip: "Width, in pixels, of a border at each frame edge that is made transparent. Neighboring frames fill it in. 0 = use the whole frame.",
                },
                useMask: {
                    label: "Use Mask in Pano",
                    tooltip: "Make masked pixels (Video > Masking) transparent, so they are not stitched into the panorama.\nUsed only when Enable Mask is on.",
                },
                analyzeWithEffects: {
                    label: "Analyze With Effects",
                    tooltip: "Measure motion on frames with the video adjustments and filters applied (contrast and so on). This changes all Motion Analysis, not only panoramas.\nSet it before you analyze: a change does not clear the stored results.",
                },
                exportWithEffects: {
                    label: "Export With Effects",
                    tooltip: "Apply video adjustments to panorama exports",
                },
                removeOuterBlack: {
                    label: "Remove Outer Black",
                    tooltip: "Make black pixels at the edges of each row transparent",
                },
                featureFrameStep: {
                    label: "Frame Step",
                    tooltip: "Frames to step between each stitched frame (1 = every frame). Higher = faster, fewer frames.",
                },
                featureCrop: {
                    label: "Crop",
                    tooltip: "Pixels to ignore at each edge of the video frames",
                },
                featureUseMask: {
                    label: "Use Mask",
                    tooltip: "Leave masked pixels (Video > Masking) out of feature detection and blending.\nUsed only when Enable Mask is on.",
                },
                featureProjection: {
                    label: "Projection",
                    tooltip: "How frames are warped onto the panorama.\nAuto: Planar, or Rigid when the Planar result fails, stretches too far, or is over 4 times larger than Rigid.\nPlanar: a perspective mosaic.\nRigid: rotation and translation only, a flat unrolling for a turning camera.",
                },
                featureScale: {
                    label: "Feature Scale",
                    tooltip: "Detect features at 1/N resolution. 1 = fine, sharp detail (default). Higher values track larger, blurrier, low-frequency structures (e.g. soft clouds) and ignore pixel noise.\nUsed only when Feature Source is ORB Features.",
                },
                featureContrast: {
                    label: "Feature Contrast",
                    tooltip: "Minimum corner contrast for a feature to register (ORB FAST threshold). Lower picks up faint, low-contrast features (clouds); higher keeps only strong, distinct corners. Default 20.\nUsed only when Feature Source is ORB Features.",
                },
                featureCount: {
                    label: "Feature Count",
                    tooltip: "Maximum number of features to detect per frame. More features can give more matches (slower); fewer is faster. Default 2000.\nUsed only when Feature Source is ORB Features.",
                },
                optimizeFeature: {
                    label: "Optimize Feature Tracking",
                    tooltip: "Find the Feature Scale and Feature Contrast that give the most stable feature tracks on up to 5 frames around the current frame.\nIt tries Feature Scale 1, 2, 4 and 8 with Feature Contrast 20, 10, 5 and 2. It keeps the best pair and sets Feature Count to 3000.\nThese settings apply only when Feature Source is ORB Features.",
                },
            },
            trackingParameters: {
                title: "Tracking Parameters",
                tooltip: "Settings for how Motion Analysis finds and follows features. Shown only while Analyze Motion is on.\nA change clears the results, so the frames are analyzed again.",
                technique: {
                    label: "Technique",
                    tooltip: "Method used to measure the motion between frames. Linear Tracklet is the default.\nA change clears the results and shows the settings for the new method.",
                },
                frameSkip: {
                    label: "Frame Skip",
                    tooltip: "Frames between comparisons (higher = detect slower motion)",
                },
                trackletLength: {
                    label: "Tracklet Length",
                    tooltip: "Number of frame-to-frame steps that each feature is followed for (3 = 4 frames). Longer is stricter about straight, steady motion.",
                },
                skipDuplicateFrames: {
                    label: "Skip Duplicates",
                    tooltip: "Detect adjacent duplicate video frames, cache them as zero motion, and exclude them from motion estimation",
                },
                blurSize: {
                    label: "Blur Size",
                    tooltip: "Size, in pixels, of the Gaussian blur applied to each frame before features are found (odd numbers). Larger values track bigger shapes and ignore fine noise.",
                },
                minMotion: {
                    label: "Min Motion",
                    tooltip: "Motion below this, in pixels per frame, is not rejected, but its quality is multiplied by 0.7. It is then used only if its quality stays above Min Quality.",
                },
                maxMotion: {
                    label: "Max Motion",
                    tooltip: "Largest motion to use, in pixels per frame. Faster features are left out.",
                },
                smoothing: {
                    label: "Smoothing",
                    tooltip: "How strongly the measured motion is smoothed from frame to frame (0.5–0.99). Higher is smoother but slower to react.",
                },
                minVectorCount: {
                    label: "Min Vector Count",
                    tooltip: "Minimum number of motion vectors for a valid frame",
                },
                minConfidence: {
                    label: "Min Confidence",
                    tooltip: "Minimum consensus confidence for a valid frame",
                },
                maxFeatures: {
                    label: "Max Features",
                    tooltip: "Most corner features to find and follow in each frame.",
                },
                minDistance: {
                    label: "Min Distance",
                    tooltip: "Smallest spacing, in pixels, between two features.",
                },
                qualityLevel: {
                    label: "Quality Level",
                    tooltip: "How strong a corner must be to count as a feature, as a fraction of the strongest corner in the frame. Lower finds more, weaker corners.",
                },
                maxTrackError: {
                    label: "Max Track Error",
                    tooltip: "Largest optical-flow tracking error for a feature to be kept. A feature with more error also gets a lower quality.",
                },
                minQuality: {
                    label: "Min Quality",
                    tooltip: "Smallest quality (0–1) for a feature to be used. A feature below it is left out of the measurement and has no arrow.\nQuality falls with tracking error and with slow motion.",
                },
                staticThreshold: {
                    label: "Static Threshold",
                    tooltip: "Motion, in pixels per frame, below which an area counts as static, like burned-in text. Static areas are left out.\nThe features of a very slow pan can also count as static.",
                },
            },
        },
        status: {
            loadingOpenCv: "Loading OpenCV...",
            stopAnalysis: "Stop Analysis",
            analyzingPercent: "Analyzing... {{pct}}%",
            detectingDuplicatesPercent: "Step {{step}}/{{steps}} Detecting duplicate frames... {{pct}}%",
            analyzingStepPercent: "Step {{step}}/{{steps}} Analyzing motion... {{pct}}%",
            fillingMotionGapsPercent: "Step {{step}}/{{steps}} Filling motion gaps... {{pct}}%",
            creatingTrack: "Creating track...",
            buildingPanorama: "Building panorama...",
            buildingPanoramaPercent: "Building panorama... {{pct}}%",
            detectingFeaturesPercent: "Detecting & matching features... {{pct}}%",
            stitchingPercent: "Stitching panorama... {{pct}}%",
            loadingFrame: "Loading frame {{frame}}... ({{current}}/{{total}})",
            loadingFrameSkipped: "Loading frame {{frame}}... ({{current}}/{{total}}) ({{skipped}} skipped)",
            renderingPercent: "Rendering... {{pct}}%",
            panoPercent: "Pano... {{pct}}%",
            renderingVideo: "Rendering video...",
            videoPercent: "Video... {{pct}}%",
            saving: "Saving...",
            buildingStabilization: "Building stabilization...",
            exportProgressTitle: "Exporting pano video...",
            optimizingPercent: "Optimizing feature tracking... {{pct}}%",
            optimizeResult: "Optimized feature tracking:\n\nFeature Scale: {{scale}}\nFeature Contrast: {{contrast}}\nFeature Count: {{count}}\n\nFound {{tracklets}} stable feature tracks around the current frame.",
        },
        defence: {
            analyzing: "De-fence: estimating fence + background motion... {{pct}}%",
            building: "De-fence: reconstructing background... {{pct}}%",
            saving: "De-fence: saving...",
            video: {
                phaseOriginal: "Original video",
                phaseRemoving: "Removing fence…",
                phaseResult: "Reconstructed scene",
                encodingHold: "De-fence: encoding final result… {{pct}}%",
                unsupported: "Video encoding is not supported in this browser.",
            },
        },
        errors: {
            noVideoView: "No video view found.",
            noVideoData: "No video data found.",
            failedToLoadOpenCv: "Failed to load OpenCV: {{message}}",
            noOriginTrack: "No origin track found. Need a target or camera track to determine start position.",
            videoEncodingUnsupported: "Video encoding not supported in this browser",
            exportFailed: "Video export failed: {{reason}}",
            panoVideoExportFailed: "Pano video export failed: {{message}}",
        },
    },
    textExtraction: {
        menu: {
            title: "[BETA] Text Extraction",
            tooltip: "Read text that is burned into the video, frame by frame, with OCR (optical character recognition).\nThe text shows next to each region on the video. There is no export.",
            enable: {
                label: "Enable Text Extraction",
                disableLabel: "Disable Text Extraction",
                tooltip: "Show or hide the text regions and their text on the video. Turn it on before you use the other items here.\nDrag inside a region to move it, or drag a corner to resize it.",
            },
            addRegion: {
                label: "Add Region",
                drawingLabel: "Click and drag on video...",
                tooltip: "Click and drag on video to define a text extraction region",
            },
            removeRegion: {
                label: "Remove Selected Region",
                tooltip: "Remove the selected region (outlined in yellow).",
            },
            clearRegions: {
                label: "Clear All Regions",
                tooltip: "Remove all text extraction regions",
            },
            startExtract: {
                label: "Start Extraction",
                stopLabel: "Stop Extraction",
                tooltip: "Read every region with OCR (optical character recognition) on each frame, from the current frame to the Out frame.\nClick again (Stop Extraction) to stop.",
            },
            fixedWidthFont: {
                label: "Fixed Width Font",
                tooltip: "Split each region into Num Characters equal cells, and read each cell on its own. Use it for fixed-width text, such as sensor overlays.\nNot used when Use Templates is on and templates are learned.",
            },
            numChars: {
                label: "Num Characters",
                tooltip: "Number of equal character cells in the selected region. Used by Fixed Width Font and by templates.",
            },
            learnTemplates: {
                label: "Learn Templates",
                activeLabel: "Click characters to learn...",
                tooltip: "Start or stop learning. While on, click a character cell in the selected region and type the character it shows.\nThe cell's image in this frame becomes the template for that character.",
            },
            clearTemplates: {
                label: "Clear Templates",
                tooltip: "Remove all learned character templates",
            },
            useTemplates: {
                label: "Use Templates",
                tooltip: "Read each character cell by matching it against the learned templates, instead of with OCR. A cell with no close match shows ?.\nUsed only after you learn at least one template.",
            },
        },
        prompts: {
            learnCharacter: "Enter character for cell {{index}}:",
        },
        errors: {
            failedToLoadTesseract: "Failed to load Tesseract.js. Make sure it's installed: npm install tesseract.js",
            noVideoView: "Text extraction requires a video view",
        },
    },
    custom: {
        settings: {
            title: "Settings",
            tooltipLoggedIn: "Your Sitrec preferences, such as language, theme, performance and how a new sitch starts.\nSaved to the server for your account, with a copy in a browser cookie.",
            tooltipAnonymous: "Your Sitrec preferences, such as language, theme, performance and how a new sitch starts.\nSaved in this browser.",
            language: { label: "Language", tooltip: "Select interface language. Changing this reloads the page. You will lose any unsaved work, so save first!" },
            theme: {
                label: "Theme",
                tooltip: "Dark or light colors for the menus and for every view that has a Dark / Light button (graphs, curve editors, notes, chat, audio spectrum). A change here sets all views to the new mode. After that, the button in the header of a view changes that view only, and Shift + click on it changes all views. Classic is the look before themes: dark menus, and each view in its own original colors",
                options: { classic: "Classic", dark: "Dark", light: "Light" },
            },
            maxDetails: { label: "Max Details", tooltip: "Highest zoom level that terrain tiles subdivide to, from 5 to 30. Lower values use fewer, coarser tiles.\nThe maximum zoom of the terrain map still applies." },
            fpsLimit: { label: "Frame Rate Limit", tooltip: "Set maximum frame rate (60, 30, 20, or 15 fps)" },
            tileSegments: { label: "Tile Segments", tooltip: "Mesh resolution for terrain tiles. Higher values = more detail but slower" },
            maxResolution: { label: "Max Resolution", tooltip: "Largest size of decoded video frames, on the longer side.\n1080P = 1920, 720P = 1280, 480P = 854, 360P = 640 pixels. None = full size.\nSmaller frames use less memory." },
            renderScale: { label: "Render Scale", tooltip: "Scales the offscreen render resolution. 50% renders 1/4 of the pixels - the single biggest perf knob on hi-DPI laptops. Lower = faster but blurrier." },
            msaaSamples: { label: "Antialiasing (MSAA)", tooltip: "Multisample antialiasing on the 3D viewport. Off = fastest, removes the multisample resolve pass. Higher = smoother edges but slower." },
            performancePreset: { label: "Performance Preset", tooltip: "Sets all the Performance Tweaks at once. Balanced is the default.\nQuality: full render resolution, 4x MSAA, 60 fps, most terrain detail, video up to 1080P.\nBalanced: 85% render scale, 2x MSAA, 30 fps, video up to 720P.\nFast, Potato: lower render scale and terrain detail, no MSAA, 30 or 20 fps, video up to 480P or 360P.\nCustom: your own values. A change to a tweak selects Custom." },
            aiModel: { label: "AI Model", tooltip: "The AI model that the chat assistant uses.\nThe list holds the models of this server and, when you save a key in API Keys…, the models your own key can use." },
            byokSitrecFocused: {
                label: "Sitrec Focused",
                tooltip: "For models using your own API key or custom endpoint, including voice. "
                    + "On: keep chat to Sitrec and related topics. Off: discuss any topic. "
                    + "Your provider's API charges still apply; longer chats can cost more. "
                    + "Sitrec-provided models always stay focused on Sitrec.",
                costTitle: "API usage costs",
                costWarning: "Replies still use your API key or custom endpoint. Your provider may charge "
                    + "for every request, including the Sitrec instructions and chat history sent with it. "
                    + "Longer conversations and replies can increase costs.\n\n"
                    + "Review usage and set local limits in Settings → API Keys. "
                    + "Set spending caps or budget alerts with your provider for billing protection.",
            },
            voiceModel: {
                label: "Voice Model",
                tooltip: "Which OpenAI realtime model the spoken assistant uses. Needs your "
                    + "own OpenAI key. Cost is only estimated for models with a published "
                    + "price on file; others report tokens used and no dollar figure.",
            },
            aiEffort: {
                label: "AI Effort",
                tooltip: "For models using your own API key or custom endpoint. How much the "
                    + "model thinks before it answers. Higher effort can give better answers "
                    + "to hard questions, but it is slower and uses more tokens, which your "
                    + "provider charges for. Medium is the default. A model that does not "
                    + "take the level you choose uses the nearest level it does take.",
                options: {low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max"},
            },
            aiRefusalFallback: {
                label: "Refusal Fallback",
                tooltip: "For Claude models using your own Anthropic key. When the model "
                    + "declines a request, Anthropic tries it again on a different Claude "
                    + "model that it selects. The second attempt is also charged to your key. "
                    + "Off by default.",
            },
            enableOldAIModels: {
                label: "Enable old AI models",
                tooltip: "Also list superseded model generations from your own API keys. "
                    + "Off, the AI Model list shows only each provider's newest family, "
                    + "which is usually the fastest and cheapest for what it can do.",
            },
            envOverride: {
                label: "SITREC_ ENV Override…",
                dialogTitle: "SITREC_ ENV Override",
                tooltip: "Edit your own values for the SITREC_ settings that this installation lets you change. "
                    + "Each line replaces the value this installation set in shared.env, for you only, in this "
                    + "browser. Saved with your other settings.",
                dialogMessage: "Lines in shared.env format, one setting on each line: SITREC_NAME=value. "
                    + "A line here replaces the setting of the same name from this installation, as if the line "
                    + "were at the end of shared.env. Only names that start with SITREC_ and that this installation "
                    + "allows are used, and only for what this browser reads: a setting that the server reads is not "
                    + "changed. Most settings are read when Sitrec starts, so reload to see a change. A few are read "
                    + "before your settings load, and do not change even after a reload: SITREC_TERRAIN_URL, "
                    + "SITREC_CHANNELS_ENABLED and SITREC_TRACK_STATS.",
                placeholder: "# Example\nSITREC_CUSTOM_SOUNDING_WX_LEVEL_TAG=Level",
                save: "Save",
                saveAndReload: "Save and Reload",
                ignoredMessage: "These lines are not used:",
                ignoredReasons: {
                    notSitrec: "the name does not start with SITREC_",
                    notAllowed: "this installation does not let a user change this setting (ALLOW_OVERRIDE)",
                    secureBuild: "this build does not let a user change this setting",
                },
            },
            apiKeys: {
                label: "API Keys…",
                tooltip: "Use your own accounts instead of Sitrec's shared quota — the AI assistant, "
                    + "map and terrain providers, and data feeds. Keys are stored only in this browser, "
                    + "are never sent to the Sitrec server, and are never shown back to you once saved. "
                    + "Per-provider usage and spending limits live here too.",
            },
            byokKey: {
                title: "Anthropic API Key",
                labelUnset: "AI Key: using Sitrec's",
                // Deliberately carries no part of the key. lil-gui labels are enumerated by
                // CSitrecAPI.getMenuSummary(), which is POSTed to chatbot.php on every
                // server-path chat turn and embedded in the system prompt sent to whichever
                // provider that tier uses — so any key material here would travel exactly
                // where the tooltip promises it never goes.
                labelSet: "AI Key: your own",
                save: "Save",
                tooltip: "Optionally use your own Anthropic API key. The assistant then talks to Anthropic directly and the usage is billed to you. The key is stored only in this browser — it is never sent to the Sitrec server.",
                promptSet: "Paste an Anthropic API key (starts with 'sk-ant-').\n\nThe assistant will then call Anthropic directly with your key, and Anthropic will bill you for that usage. Your key is stored only in this browser and is never sent to the Sitrec server.\n\nNew '(your key)' entries will appear in the AI Model list.",
                promptReplace: "A key is already stored in this browser.\n\nPaste a new key to replace it, or leave the box empty and press Save to remove it and go back to using Sitrec's own AI access.",
            },
            byokUsage: {
                title: "Your AI Usage",
                labelEmpty: "AI Usage: none yet",
                label: "AI Usage: ~{{cost}} ({{requests}} req)",
                reset: "Reset counters",
                resetAsk: "Reset these counters to zero?",
                tooltip: "Estimated tokens and cost billed to your own API key since the counters were last reset. Click for a per-model breakdown.",
                estimateNote: "Estimated from published list prices — your provider's bill is the authority. Cached input is billed at a reduced rate and is counted as such.",
            },
            centerSidebar: { label: "Center Sidebar", tooltip: "Enable center sidebar between split views (drag menus to the divider line)" },
            showAttribution: { label: "Show Attribution", tooltip: "Show map and elevation data source attribution overlay" },
            showFilename: { label: "Show Filename", tooltip: "Show the current video filename centered at the bottom of the viewport and exported videos" },
            startup: {
                title: "New Sitch Startup",
                tooltip: "How a new, empty Custom sitch begins. These do not change the sitch you are looking at.\nBuilt-in sitches and saved sitches keep their own units, camera and terrain.",
            },
            startupUnits: { label: "Units", tooltip: "Unit system a new Custom sitch starts in, for speed, distance and altitude. Built-in and saved sitches keep their own units." },
            startupLocation: { label: "Use Start Location", tooltip: "Start a new sitch at the latitude/longitude/altitude below instead of the sitch's own start position. Loading a track still moves you to the track." },
            startupLat: { label: "Start Latitude", tooltip: "Latitude a new sitch starts at. Accepts decimal degrees, D M S, hemisphere letters or MGRS (Military Grid Reference System) — you can also paste a whole \"lat, lon\" pair here." },
            startupLon: { label: "Start Longitude", tooltip: "Longitude a new sitch starts at." },
            startupAlt: { label: "Start Altitude (m)", tooltip: "Camera height, in meters above the ground, at the start location. 0 = standing on the ground." },
            startupBuildings: { label: "3D Buildings", tooltip: "Turn 3D buildings on when a new sitch starts. Uses your 3D tile quota as soon as the sitch loads." },
        },
        balloons: {
            count: { label: "Count", tooltip: "How many of the nearest weather balloon soundings UWYO Soundings and IGRA2 Soundings load.\nA larger count covers a wider area.\nA new count applies at the next load: click Refresh Wind Data." },
            source: { label: "Source", tooltip: "uwyo = University of Wyoming (needs PHP proxy)\nigra2 = NOAA NCEI archive (direct download)" },
            getNearby: { label: "Get Nearby Weather Balloons", tooltip: "Import the N closest weather balloon soundings to the current camera position.\nUses the 00Z or 12Z launch nearest to the sitch start time, before or after it." },
            importSounding: { label: "Import Sounding...", tooltip: "Pick a station, a source, a date and a launch, and import that one sounding.\nWind Source then changes to Manual Soundings, which blends all the loaded soundings." },
        },
        // Tooltips for the Physics > Wind folder (CustomManagerSetup.js, CNodeWind.js).
        wind: {
            targetFrom: { tooltip: "Direction that the wind at the target comes FROM, in degrees true (0 = north, 90 = east).\nTraverse methods that use air speed, and Manual + Wind targets, use this wind.\nWith the Manual source, you set it, and it also sets the wind lines and arrows.\nWith another Wind Source, it shows the wind at the target on this frame, and you cannot change it.\nThe traverse reads that source on each frame, at the target's position, height and time.\nTo set your own value, turn on Override Target Wind." },
            targetKnots: { tooltip: "Speed of the wind at the target, in the speed unit of Units (in knots when Wind in Knots is on).\nWith a Wind Source other than Manual, it shows the wind at the target on this frame.\nTo set your own value, turn on Override Target Wind." },
            targetOverride: { tooltip: "Use your own Target Wind, not the Wind Source.\nWhen on, you can set Target Wind From and Speed, and the same wind is used at every place, height and time.\nWhen off, Target Wind follows the Wind Source on each frame." },
            localFrom: { tooltip: "Direction that the wind at the camera platform comes FROM, in degrees true (0 = north, 90 = east).\nThe Flight Sim camera moves with this wind.\nWith the Manual source, you set it.\nWith another Wind Source, it shows the wind at the camera on this frame, and you cannot change it.\nTo set your own value, turn on Override Local Wind." },
            localKnots: { tooltip: "Speed of the wind at the camera platform, in the speed unit of Units (in knots when Wind in Knots is on).\nWith a Wind Source other than Manual, it shows the wind at the camera on this frame.\nTo set your own value, turn on Override Local Wind." },
            localOverride: { tooltip: "Use your own Local Wind, not the Wind Source.\nWhen on, you can set Local Wind From and Speed, and the same wind is used at every place, height and time.\nWhen off, Local Wind follows the Wind Source on each frame.\nLocal from Constant Camera turns this on." },
            lockWind: { tooltip: "Make Target Wind the same as Local Wind.\nThe target then uses the Local Wind source (or the Local Wind values, with Manual or Override), read at the target.\nThe Target Wind sliders are hidden while this is on." },
            source: { tooltip: "Where the wind data comes from, for Target Wind, Local Wind, and the wind lines and arrows:" },
            targetSource: { tooltip: "Where the wind data comes from, for Target Wind and the wind lines and arrows:" },
            localSource: { tooltip: "Where the wind data for Local Wind (the camera platform) comes from.\nOnly a telemetry Track entry gives Local Wind data of its own. See Separate Wind Sources.\nThe sources:" },
            sources: {
                gfs: "weather model on a 1° grid, for dates from 22 March 2021 to today",
                uwyo: "weather balloon soundings from the University of Wyoming, from the nearest stations",
                igra2: "weather balloon soundings from the NOAA IGRA2 archive, from the nearest stations",
                "manual-soundings": "a blend of all the soundings that are loaded",
                openmeteo: "wind from the Open-Meteo public weather service",
                manual: "one wind everywhere, from Target Wind From and Target Wind Speed",
                custom: "a wind source that this installation supplies",
                track: "Track: <name>: wind from a loaded track. A telemetry track gives the wind at the current frame. A sounding track gives the wind at the altitude of the target or camera.\nIn the menu, the sounding and profile tracks are under Profiles, and the other tracks are under Telemetry tracks",
            },
            // Headings of the Track entries in the Wind Source menus.
            sourceGroups: {
                profiles: "Profiles (read by height)",
                telemetry: "Telemetry tracks (read by time)",
            },
            sourceSeparate: { tooltip: "Use a different source for Local Wind (the camera platform) than for Target Wind.\nLimit: only one atmospheric data set loads at a time, and Target Wind Source selects it.\nEach load also sets Local Wind. Only a telemetry Track entry gives Local Wind data of its own." },
            altitude: { tooltip: "Altitude above mean sea level of the wind lines, the wind arrows, and the Mouse Cursor readout in Show Wind at.\nTarget Wind and Local Wind do not use it: they use the altitude of each track.\nThe unit is the height unit of Units (Physics > Units): feet, or metres for Metric." },
            lockAltitude: { tooltip: "Make Altitude follow a track while the sitch plays.\nNone: use the altitude that you set.\nCamera: follow the altitude of the camera.\nTarget: follow the altitude of the target.\nTraverse: follow the altitude of the traverse path, where the traverse object is on the current frame." },
            nearbyOnly: { tooltip: "Draw wind lines only within Nearby Radius of the camera. This is faster, and easier to read when you zoom in.\nTurn it off to draw lines everywhere that the source has data.\nIt does not change the wind arrows." },
            nearbyRadius: { tooltip: "Distance from the camera, in km, to which Nearby Wind Only draws wind lines." },
            showLines: { tooltip: "Show moving wind lines (streamlines) at Altitude in the main view.\nThe color of a line shows the wind speed. See Max Speed in Wind Line Style.\nThe first time, this loads the wind data." },
            showArrows: { tooltip: "Show a grid of wind arrows at Altitude in the main view.\nEach arrow points in the direction that the wind blows TO.\nYou can show the arrows and the wind lines together." },
            showAt: { tooltip: "Show the wind speed and direction at the places switched on below, as a readout and an arrow in the main view.\nThe arrow points in the direction that the wind blows TO. The readout gives the direction that the wind comes FROM." },
            showAtCamera: { tooltip: "Show the wind at the camera, at the altitude of the camera.\nThis is the Local Wind that the camera gets there on this frame." },
            showAtTarget: { tooltip: "Show the wind at the target, at the altitude of the target.\nThis is the Target Wind that the target gets there on this frame." },
            showAtTraverse: { tooltip: "Show the wind at the traverse path, where the traverse object is, at its altitude.\nThis is the Target Wind that the target would get there on this frame.\nThe traverse path is not always the target track (Target > Target Track)." },
            showAtCursor: { tooltip: "Show the wind at the mouse cursor in the main view, at Altitude.\nShift-click to add a point that stays. Alt-click to remove the nearest point.\nThe added points show only while this is on." },
            showAtObject: { tooltip: "Show the wind at this object, at the altitude of the object." },
            showAtAutoOn: { message: "Show Wind at is on: the wind at the camera and the target shows in this view. Turn it off in Physics > Wind > Show Wind at." },
            status: { tooltip: "Where the wind comes from: the source, the time of the data, the distance from the target to the nearest data, and the heights that the data covers.\nWhile data loads, or after an error, it shows a message. You cannot edit it." },
            compass: { tooltip: "Compass. The arrow points north.\nYellow triangle: the direction that Target Wind comes FROM.\nGreen triangle: the direction that Local Wind (at the camera) comes FROM.\nWind: the Wind Source (with Separate Wind Sources: target / local)." },
            windInKnots: { tooltip: "Show every wind speed on this panel, and in the Show Wind at readouts, in knots.\nWhen off, wind speeds use the speed unit of Units (Physics > Units).\nHeights always use the height unit of Units." },
            lineStyle: { tooltip: "How the wind lines look: opacity, spacing, and the speed at the top of the color scale." },
            opacity: { tooltip: "Opacity of the wind lines, from 0 (invisible) to 1 (solid)." },
            spacing: { tooltip: "Distance between the wind lines, in degrees of latitude and longitude.\nA larger value gives fewer lines." },
            maxSpeed: { tooltip: "Wind speed at the top of the wind-line color scale, in the speed unit of this panel.\nThe color goes from blue (slow) through cyan, green and yellow to red (this speed or faster)." },
            refresh: { tooltip: "Clear the stored wind data and load it again for the current source.\nUse it after you move the camera a long distance, or after a GFS load fails.\nFor UWYO and IGRA2, it changes to the nearest soundings if the camera moved far or Sounding Count changed." },
            localFromConstantCamera: { tooltip: "Calculate Local Wind from the camera track. It assumes that the camera platform flew at a constant airspeed,\nand finds the one wind that makes the airspeed most nearly constant.\nIt sets Local Wind From and Local Wind Speed, and turns on Override Local Wind.\nThe Wind Source and Target Wind do not change." },
        },
        showHide: {
            keyboardShortcuts: { label: "[K]eyboard Shortcuts", tooltip: "Show or hide the keyboard shortcuts overlay" },
            toggleExtendToGround: { label: "Toggle ALL [E]xtend To Ground", tooltip: "Toggle 'Extend to Ground' for all tracks\nWill set all off if any are on\nWill set all on if none are on" },
            showAllTracks: { label: "Show Tracks in Main", tooltip: "Show or hide every track in the main view at once.\nEach track's own setting is left alone, so turning it back on shows the same tracks as before" },
            showTracksLook: { label: "Show Tracks in Look", tooltip: "Show or hide every track in the look view at once.\nEach track's own setting is left alone, so turning it back on shows the same tracks as before" },
            showEveryTrack: { label: "Show Every Track", tooltip: "Show every track in the main view, including ones switched off one at a time.\nAlso the double-click of Show Tracks on the main view's header bar" },
            syncTracksInLook: { label: "Match Look View to Show Tracks", tooltip: "Show or hide the tracks in the look view to match Show Tracks in Look.\nOnly tracks that are showing are changed.\nAlso what Show Tracks does on the look view's header bar" },
            allTracksExtendToGround: { label: "Extend Tracks to Ground", tooltip: "Extend every track down to the ground.\nTurning it back off restores whichever tracks were extended before" },
            clearAllExtendToGround: { label: "Clear Extend to Ground", tooltip: "Turn 'Extend to Ground' off for every track, and forget what it was" },
            showAllTracksInLook: { label: "All Tracks in Look", tooltip: "Draw every track in the look view, whatever its own Show in look view setting is.\nTurn it off to go back to the setting of each track" },
            limitTracksInOut: { label: "Limit Tracks In/Out", tooltip: "Draw each track only between the In and Out points.\nThe full data tracks are not drawn" },
            showCompassElevation: { label: "Show Compass Elevation", tooltip: "Show compass elevation (angle above the local ground plane) in addition to bearing (azimuth)" },
            filterTracks: { label: "Filter Tracks", tooltip: "Open a dialog that hides the loaded data tracks that fail the filters you set:\nan altitude range, crossing the look camera's view frustum, or moving away from the camera" },
            removeAllTracks: { label: "Remove All Tracks", tooltip: "Remove every track from the sitch.\nObjects that you added with Add Object or the right-click menu are removed too. The camera and traverse objects stay.\nTo get an imported track back, drop its file again" },
            addTrackFromCameraLOS: { label: "Track from Camera LOS", tooltip: "Create a two-point synthetic track along the current camera's line of sight.\nFirst point is at the camera, second point is where the LOS hits the ground,\nor 300 miles along the LOS if it does not hit the ground." },
            importADSBTrace: { label: "Import ADS-B Track...", tooltip: "Fetch an aircraft's last ~24 hours of ADS-B positions from adsb.lol\nby its ICAO 24-bit hex address (e.g. a1b2c3), and add it as a track.\nData: adsb.lol (ODbL)" },
            liveTraffic: {
                label: "Live ADS-B Traffic",
                tooltip: "Show every aircraft that adsb.lol now sees within Traffic Radius of the main view camera.\n"
                    + "Each is colored by altitude, with a short trail. The data updates every 5 seconds.\n"
                    + "Click an aircraft to import its full track.\n"
                    + "Turning this on sets the clock to the current time and pauses playback,\n"
                    + "so the sky and the traffic agree.\n"
                    + "Needs the Sitrec server. Data: adsb.lol (ODbL)",
            },
            liveTrafficRadius: {
                label: "Traffic Radius (nm)",
                tooltip: "How far from the main view camera to look for aircraft, in nautical miles.\nTakes effect on the next update.",
            },
            liveTrafficStatus: {
                label: "Traffic",
                tooltip: "What the live ADS-B feed reports now: the number of aircraft, or an error.\n\"stale\" means adsb.lol could not be reached, so older positions are shown.",
            },
            liveFeedStatus: {
                tooltip: "What the {{name}} feed reports now: the number of markers, \"none\", or a message such as \"needs a key\" or an error.\n"
                    + "When you click one of its markers that has no web page, this row shows that marker's details for 10 seconds.",
            },
            liveFeeds: {
                label: "Live Feeds",
                tooltip: "Live data drawn on the world: civil and military aircraft, ships,\n"
                    + "webcams, road traffic, weather balloons, rocket launches and earthquakes.\n"
                    + "Each feed has a status row under it that shows a count or an error, so an\n"
                    + "empty result can be told apart from a feed that is not working.\n"
                    + "Ships, webcams and road traffic need your own free API key.\n"
                    + "Add one in Sitrec > Settings > API Keys. The others need the Sitrec server.",
            },
        },
        objects: {
            globalScale: { label: "Global Scale", tooltip: "Scale factor applied to all 3D objects in the scene - useful for finding things. Set back to 1 for real size" },
            mainViewScale: { label: "Main View Scale", tooltip: "Extra scale for 3D objects, applied ONLY in the main view - on top of Global Scale.\nLets you find a small object from far out without changing what the look view sees. Set back to 1 for real size" },
            removeAllBuildings: { label: "Remove all Buildings", tooltip: "Delete every synthetic building from the scene.\nClouds and ground overlays are not affected." },
        },
        admin: {
            folder: { tooltip: "Tools for site administrators. Only admin users see this folder" },
            dashboard: { label: "Admin Dashboard", tooltip: "Open the admin dashboard" },
            validateAllSitches: { label: "Validate All Sitches", tooltip: "Load each saved sitch of the current user (or of the Test User ID) with local terrain, and report the errors" },
            testUserID: { label: "Test User ID", tooltip: "Operate as this user ID (0 = disabled, must be > 1)" },
            addMissingScreenshots: { label: "Add Missing Screenshots", tooltip: "Load each sitch that has no screenshot, render it, and upload a screenshot" },
            feature: { label: "Feature", tooltip: "Toggle Featured status for the currently loaded sitch" },
        },
        viewPreset: { label: "View Preset", tooltip: "Arrange the main view, look view and video with a preset layout: side by side, top and bottom, etc.\nThe number keys 1 to 8 also select a preset, in the order of this list" },
        chapters: {
            folder: {
                label: "Sitch Chapters",
                tooltip: "Chapters keep several setups of one sitch. Each chapter has its own views, cameras, time and timeline markers; the rest of the sitch is shared. Edits stay in memory until File → Save",
            },
            addChapter: { label: "Add chapter", tooltip: "Create a chapter from the current views, cameras, time and timeline markers" },
            renameChapter: { label: "Rename chapter", tooltip: "Rename the current chapter" },
            deleteChapter: { label: "Delete chapter", tooltip: "Delete the current chapter, after you confirm, and switch to the next chapter (or to the one before, when it is the last).\nA sitch must keep at least one chapter." },
            revert: { label: "Revert sitch to last save / load", tooltip: "Discard all edits made since the sitch was last saved or loaded" },
            restoreFromServer: { label: "Restore chapter from server version…", tooltip: "Load one chapter from a saved server version into the current chapter" },
            restoreFromFile: { label: "Restore chapter from saved file…", tooltip: "Load one chapter from a saved sitch file into the current chapter" },
            list: { label: "Chapters", tooltip: "Click a chapter to switch to it. ● marks the current chapter" },
            switchTo: "Switch to this chapter. The current chapter keeps the changes you made in it.",
            currentChapter: "The current chapter.",
            satelliteMarkers: {
                label: "Add satellite rise / set markers",
                tooltip: "Add a timeline marker at each time a satellite shown in the sky rises or sets during the sitch, as seen from the look camera's current position",
            },
            satelliteRises: "{{name}} rises",
            satelliteSets: "{{name}} sets",
            noSatelliteData: "Load satellite data first, then try again.",
            noCrossings: "No satellite shown in the sky rises or sets between the first and the last frame of the sitch.",
            captureScope: { label: "Advanced: capture scope", tooltip: "Select which kinds of data a chapter captures", item: "Capture this kind of data in chapters" },
            restoreScope: { label: "Advanced: restore scope", tooltip: "Select which kinds of data are restored when you switch chapters", item: "Restore this kind of data when you switch chapters" },
            scope: {
                views: "Views",
                cameras: "Cameras",
                dateTime: "Date/Time",
                measurement: "Measurement",
                others: "Others",
                markers: "Timeline markers",
            },
            defaultName: "Chapter {{number}}",
            renamePrompt: "Enter chapter name:",
            renameTitle: "Rename chapter",
            keepOne: "Keep at least one chapter.",
            deleteConfirm: "Delete \"{{name}}\"?",
            deleteTitle: "Delete chapter",
            revertConfirm: "Discard all sitch edits since the last successful save or load?",
            revertTitle: "Revert sitch",
            restoreFileError: "Could not restore chapter from file.",
            restoreError: "Could not restore chapter.",
            noChapters: "This save contains no chapters.",
            invalidState: "The chosen chapter has no saved state.",
            chooseChapter: "Choose the chapter to restore.",
            chooseVersion: "Choose a saved version.",
            chooseTitle: "Restore chapter",
            cancel: "Cancel",
            restoreConfirm: "Load the state of \"{{source}}\" into \"{{target}}\"? A recovery chapter keeps your current edits. Other chapters do not change.",
            restoreTitle: "Restore chapter",
            recoveryName: "{{name}} (before restore)",
            noServerVersions: "No saved server versions. Use \"Restore chapter from saved file…\" to load a chapter from a local save.",
        },
        contextMenu: {
            setCameraAbove: "Set Camera Above",
            setCameraOnGround: "Set Camera on Ground",
            setTargetAbove: "Set Target Above",
            setTargetOnGround: "Set Target on Ground",
            dropPin: "Drop Pin",
            addFixedObject: "Add 3D Object",
            createTrackWithObject: "Add Moving Object",
            createInOutObjectTrack: "Add Moving Object (In→Out)",
            createTrackNoObject: "Add Flight Path",
            addBalloon: "Add Balloon",
            addBuilding: "Add Building",
            addClouds: "Add Clouds",
            addGroundOverlay: "Add Ground Overlay",
            addGroundGrid: "Add Ground Grid",
            centerTerrain: "Center Terrain square here",
            googleMapsHere: "Google Maps Here",
            googleEarthHere: "Google Earth Here",
            groupCameraTarget: "Camera and Target",
            groupEdit: "Edit",
            groupAdd: "Add",
            groupTerrain: "Terrain",
            groupExternal: "External Maps",
            editTrackTitle: "Edit: {{name}}",
            addPointHere: "Add Point Here (Frame {{frame}})",
            addPointOnTrack: "Add Point on Track (Frame {{frame}})",
            movePointHere: "Move Point {{frame}} Here",
            showTrackMenu: "Show Track Menu",
            showObjectMenu: "Show Object Menu",
            exitEditMode: "Exit Edit Mode",
            editingBadge: "Editing: {{name}} — Esc to exit",
            tooltips: {
                setCameraAbove: "Move the manual camera position to above this point, at its current altitude.\nThe look camera uses it when Camera > Location > Position is Manual.",
                setCameraOnGround: "Move the manual camera position to this point, 2 m above the ground (eye level).\nThe look camera uses it when Camera > Location > Position is Manual.",
                setTargetAbove: "Move the fixed target position (Target menu) to above this point, at its current altitude.",
                setTargetOnGround: "Move the fixed target position (Target menu) to this point, on the ground.",
                editClouds: "Turn edit mode on or off for the cloud layer at this point.",
                editOverlay: "Turn edit mode on or off for the ground overlay or grid at this point.",
                dropPin: "Add a pin (a labeled marker) at this point, and open its menu so you can type the label.",
                addFixedObject: "Add a 3D object that stays at this point: a gray sphere, 5 m in radius. Its menu opens so you can change it.",
                createTrackWithObject: "Add a new track that starts at this point on the current frame, with a 3D object on it.\nThe track opens in edit mode, so you can add more points.",
                createInOutObjectTrack: "Add a straight track with a 3D object on it, at constant speed. It runs from this point at the In frame to a point 200 screen pixels to the right at the Out frame (the whole sitch when In and Out are not set).\nIts altitude is locked, so raising one point raises the whole track.",
                createTrackNoObject: "Add a new track with no object, which starts at this point on the current frame.\nThe track opens in edit mode, so you can add more points.",
                addBalloon: "Add a simulated balloon launched from the ground at this point. It rises and drifts with the wind.\nYou can then choose it as the camera or target track.",
                addBuilding: "Add a simple 3D building at this point, in edit mode so you can shape it.",
                addClouds: "Add a cloud layer at this point, in edit mode so you can shape it.",
                addGroundOverlay: "Add a ground overlay (an image laid on the terrain) at this point, in edit mode. Set its image in its menu.",
                addGroundGrid: "Add a measurement grid on the ground at this point, in edit mode.",
                centerTerrain: "Move the terrain square so that its center is at this point, and load the terrain there.",
                googleMapsHere: "Open Google Maps at this point in a new browser tab.",
                googleEarthHere: "Download a KML file with a pin at this point. Open the file in Google Earth.",
                addPointHere: "Add a control point to the track at the current frame, at the ground under the pointer.\nNot available when the pointer is on the sky.",
                addPointOnTrack: "Add a control point at the current frame, where the track is now on that frame.",
                movePointHere: "Move the control point of the current frame to the ground under the pointer.\nNot available when the pointer is on the sky.",
                showTrackMenu: "Open the menu of the track being edited. Edit mode stays on.",
                showObjectMenu: "Open the menu of the object on this track. Edit mode stays on.",
                exitEditMode: "Stop editing the track. Esc does the same.",
            },
        },
    },
    view3d: {
        northUp: { label: "Look View North Up", tooltip: "Make north the up direction in the look view, instead of the local vertical. Use it for satellite views and other views that look straight down.\nIt has no effect in PTZ (pan-tilt-zoom) mode." },
        atmosphere: { label: "Atmosphere", tooltip: "Render a sky gradient and distance haze in the look view. Configure them separately in Atmosphere Tweaks." },
        atmoHaze: { label: "Distance haze", tooltip: "Fade distant surfaces into the atmosphere; disable to keep only the sky gradient." },
        atmoVisibility: { label: "Atmo Visibility (km)", tooltip: "Range where a dark target retains 2% contrast in uniform sea-level air (smaller = thicker haze)" },
        toneMapping: {label: "Highlight Rolloff", tooltip: "Use filmic tone mapping in the visible look view, independently of sky and haze"},
        viewExposure: {label: "Look Exposure", tooltip: "Look-view brightness multiplier, combined once with Scene Exposure; works with or without highlight rolloff"},
        opticsBeforeSensor: {label: "Optics Before Sensor Effects", tooltip: "Apply focus and diffraction glare before highlight rolloff, noise, levels, and other sensor effects. Turn off to preserve the older effect order."},
        skyGradient: { label: "Sky Gradient", tooltip: "Draw the look view sky as a gradient from blue at the zenith to haze at the horizon. Off: one flat sky color.\nUsed only when Lighting > Atmosphere is on." },
        atmosphereTweaks: { tooltip: "Settings for the look view atmosphere: distance haze, visibility and the sky gradient.\nUsed only when Lighting > Atmosphere is on." },
        lookViewOutput: { tooltip: "How the look view image is finished: highlight rolloff, exposure, and the order of the optical and sensor effects." },
        atmoHDR: { label: "Atmo HDR", tooltip: "Tone-map HDR highlights and apply exposure to the look view" },
        atmoExposure: { label: "Atmo Exposure", tooltip: "HDR atmosphere tone-mapping exposure multiplier for highlight rolloff" },
        shadowsEnabled: {
            label: "Shadows",
            mainLabel: "Shadows in Main View",
            lookLabel: "Shadows in Look View",
            tooltip: "Draw cast shadows in this view. On by default, but used only when Lighting > Shadows is on.",
        },
        allowMobileShadows: {
            label: "Allow on mobile",
            mainLabel: "Allow Main View shadows on mobile",
            lookLabel: "Allow Look View shadows on mobile",
            tooltip: "Let this view draw shadows on a phone or tablet. Sitrec turns shadows off on mobile devices unless this is on.\nShadows can lower the frame rate a lot.",
        },
        startXR: { label: "Start VR/XR", tooltip: "Start WebXR session for testing (works with Immersive Web Emulator)" },
        effects: { label: "Rendering Effects", tooltip: "Turn all the rendering effects of this view on or off. Off: the view shows the plain render." },
        focusTrack: { label: "Focus Track", tooltip: "Choose a track for the main view camera to look at and orbit around. With no track, the camera orbits the ground." },
        lockTrack: { label: "Lock Track", tooltip: "Choose a track for the main view camera to follow. The camera moves with the track's position and turns with its heading." },
        debug: {
            clearBackground: "Clear Background", renderSky: "Render Sky", renderDaySky: "Render Day Sky",
            renderMainScene: "Render Main Scene", renderEffects: "Render Effects", copyToScreen: "Copy To Screen",
            updateCameraMatrices: "Update Camera Matrices", mainUseLookLayers: "Main Use Look Layers",
            sRGBOutputEncoding: "sRGB Output Encoding", tileLoadDelay: "Tile Load Delay (s)",
            updateStarScales: "Update Star Scales", updateSatelliteScales: "Update Satellite Scales",
            renderNightSky: "Render Night Sky", renderFullscreenQuad: "Render Fullscreen Quad", renderSunSky: "Render Sun Sky",
        },
        debugTips: {
            folder: "Turn single steps of the 3D render on or off, in every view, to find rendering faults.",
            clearBackground: "Clear the color, depth and stencil buffers at the start of each view's render. Off: the new frame draws over the old one.",
            renderSky: "Draw the sky behind the scene: the night sky, the day sky color, and the Sun and Moon. Sky Steps has the separate parts.",
            renderDaySky: "Draw the day sky scene, in sitches that have one.",
            renderMainScene: "Draw the 3D scene: terrain, buildings, objects, tracks and satellites.",
            renderEffects: "Apply the rendering effects of each view.",
            copyToScreen: "Copy the finished image to the screen. Off: the view does not update.",
            updateCameraMatrices: "Update the camera matrices after the day sky is drawn, when the camera moves back from the Earth's center.",
            mainUseLookLayers: "In the main view, show only the terrain and 3D building tiles that the look view draws. Other items in the main view do not change.",
            sRGBOutputEncoding: "Convert the finished image to sRGB as it is copied to the screen. Off: the linear values go to the screen, which looks darker.",
            tileLoadDelay: "Extra wait, in seconds, before each map tile loads, to test how the views behave while tiles load slowly. 0 = no delay.",
            skySteps: "Turn single steps of the sky render on or off.",
            updateStarScales: "Update the star point sizes for each view before the sky is drawn.",
            updateSatelliteScales: "Update the satellite dot size for the look view before the sky is drawn (Satellites > Sat Brightness).",
            renderNightSky: "Draw the night sky: stars, planets, constellation lines and the grid. It is skipped when the day sky hides it.",
            renderFullscreenQuad: "Draw the day sky color or gradient over the night sky.",
            renderSunSky: "Draw the Sun and the Moon.",
        },
        celestial: {
            raHours: "RA (hours)", decDegrees: "Dec (degrees)", magnitude: "Magnitude",
            noradNumber: "NORAD Number", name: "Name",
            objectId: "Intl. Designator", objectType: "Object Type", rcsSize: "Radar Size",
            launchDate: "Launch Date", elementAge: "Element Set Age", positionError: "Position Error",
            elementAgeValue: "{{age}} {{relation}} this time",
            elementAgeAfter: "after", elementAgeBefore: "before",
            positionErrorValue: "roughly {{low}}–{{high}} km, {{lowDeg}}–{{highDeg}}° from the camera",
            positionErrorNoRange: "roughly {{low}}–{{high}} km",
            notLaunched: "Not launched at this time",
            size: "Size (GCAT)", sizeValue: "{{length}} × {{diameter}} m, span {{span}} m",
            starlinkDesign: "Starlink Design (GCAT)",
            starlinkDesigns: {
                v09: "V0.9", v10: "V1.0", visor: "VisorSat", v15: "V1.5",
                v2m: "V2 Mini", v2mo: "V2 Mini Optimized", v2md: "V2 Mini Direct to Cell",
            },
            standardMagnitude: "Standard Magnitude",
            standardMagnitudeValue: "{{mag}} (estimate: fully lit, 1000 km, 90° phase, no flare)",
            satTrack1: "Sat Track 1", satTrack2: "Sat Track 2",
            tips: {
                raHours: "Right ascension (RA): the east-west sky coordinate, in hours (0 to 24).",
                decDegrees: "Declination (Dec): the north-south sky coordinate, in degrees from the celestial equator (+90 = north celestial pole).",
                magnitude: "Apparent brightness on the astronomical magnitude scale. Smaller numbers are brighter.",
                noradNumber: "The satellite's catalog number. Sat Track 1 and Sat Track 2 below use this number.",
                name: "The satellite's name in the loaded satellite data.",
                objectId: "The international designator: launch year, launch number in that year, and piece (for example 1998-067A).",
                objectType: "The object type from the satellite catalog: payload, rocket body, debris or unknown.",
                rcsSize: "Radar cross-section size class from the satellite catalog: Small (under 0.1 m²), Medium (0.1–1 m²) or Large (over 1 m²).",
                launchDate: "The launch date (UTC), from the satellite catalog.",
                size: "Length × diameter, and overall span, in meters, from a satellite size catalog.",
                starlinkDesign: "The Starlink satellite version, from a satellite size catalog.",
                standardMagnitude: "Estimated brightness under standard conditions, so satellites can be compared: fully lit, 1000 km away, 90° phase angle, no flare. Smaller numbers are brighter.",
                elementAge: "How far the epoch of the orbital element set in use is from the current time. Positions from older sets are less accurate.",
                positionError: "A rough estimate of the position error: about 1 km, plus 1 to 3 km for each day of element set age. It is a rule of thumb, not a measurement.\nThe angle is that error as seen from the look camera.",
                satTrack1: "Set Satellites > Satellite to Track to this satellite. The camera or target can then follow its track.",
                satTrack2: "Set Satellites > Satellite to Track 2 to this satellite. The camera or target can then follow its track.",
            },
        },
    },
    nightSky: {
        loadLEO: { label: "Load LEO Satellites For Date", tooltip: "Download the orbits (TLE data) of satellites in low Earth orbit (LEO) for the sitch start date. Payloads only: no rocket bodies or debris.\nFor a date in the last 5 days, it uses the date 5 days ago.\nIf satellites are already loaded, Sitrec asks whether to merge or replace them." },
        loadStarlink: { label: "Load CURRENT Starlink", tooltip: "Download the Starlink orbits as they are now, not for the sitch date.\nUse it for the present, or for an event in the last day or two.\nIf satellites are already loaded, Sitrec asks whether to merge or replace them." },
        loadOperatorSupGP: { label: "Add CURRENT OneWeb, Kuiper, AST, Iridium", tooltip: "Add the CURRENT (now, not historical) orbits that the operators of OneWeb, Kuiper, AST SpaceMobile and Iridium supply, from CelesTrak's supplemental data. For these satellites they are usually more accurate than the general catalog, and new launches appear within hours.\nThey are merged into the satellites already loaded." },
        loadActive: { label: "Load ACTIVE Satellites", tooltip: "Download the orbits of all active satellites as they are now, not for the sitch date.\nIf satellites are already loaded, Sitrec asks whether to merge or replace them." },
        loadSlow: { label: "(Experimental) Load SLOW Satellites", tooltip: "Download the orbits of objects in higher, slower orbits (fewer than about 11.25 orbits per day) for the sitch start date. Rocket bodies and debris are included.\nThe download is large and can time out for recent dates.\nIf satellites are already loaded, Sitrec asks whether to merge or replace them." },
        loadAll: { label: "(Experimental) Load ALL Satellites", tooltip: "Download the orbits of every object in the catalog for the sitch start date.\nThe download is very large and can time out for recent dates.\nIf satellites are already loaded, Sitrec asks whether to merge or replace them." },
        tleRange: {
            fromLabel: "TLEs From",
            fromTooltip: "Date and time (UTC) of the oldest elements in the loaded TLE data. This is the date in the data, not the date you asked for.",
            toLabel: "TLEs To",
            toTooltip: "Date and time (UTC) of the newest elements in the loaded TLE data. This is the date in the data, not the date you asked for.",
            none: "None loaded",
        },
        flareAngle: { label: "Flare Angle Spread", tooltip: "Angle, in degrees, by which the mirror reflection of the Sun off a satellite can miss the camera, for the satellite to count as flaring.\nIt sets Sun Angle Arrows, Flare Lines, Label Flares Only and the Legacy cone brightness.\nThe Photometric estimate does not use it for brightness." },
        brightnessModel: { label: "Satellite Brightness Model", tooltip: "How Sitrec sets the brightness of each satellite in the look view and in long exposures.\nPhotometric estimate: from range, phase angle, sunlight and a flare curve. Starlink uses published flare curves, and Kuiper an estimated one. Other satellites get a diffuse brightness from their size.\nLegacy cone: a set base brightness, plus Flare Brightness inside Flare Angle Spread.\nThe main view always uses the Legacy cone brightness." },
        starlinkProfile: {
            label: "Starlink Design",
            tooltip: "The Starlink version that the Photometric estimate uses for brightness.\nUnknown design: the average of V1.0, VisorSat, V1.5 and V2 Mini. Sitrec does not guess the version from the catalog number or the orbit.\nPer satellite: each satellite's version from the GCAT catalog (J. McDowell). A satellite that GCAT does not list uses Unknown design.\nChoose one version only when another source tells you which one it is.",
            perSatellite: "Per satellite (GCAT catalog)",
        },
        illuminationModel: { label: "Satellite Sunlight", tooltip: "How much sunlight reaches a satellite near the edge of the Earth's shadow.\nFinite Sun + atmosphere: the Sun is a disk, and its light passes through a clear standard atmosphere at the Earth's limb.\nFinite Sun: the Sun is a disk, with no atmosphere.\nLegacy fade: a straight fade over Earth's Penumbra Depth." },
        flareModel: { label: "Flare Model", tooltip: "The flare model treats each satellite as a flat mirror, level with the Earth below it. This sets which way the mirror faces.\nGeocentric Nadir: along the line from the Earth's center to the satellite.\nGeodetic Nadir: along the WGS84 ellipsoid normal at the satellite.\nThe two differ by at most about 0.2°." },
        penumbraDepth: { label: "Earth's Penumbra Depth", tooltip: "Depth, in meters, over which a satellite fades from lit to dark as it goes into the Earth's shadow. The depth is how far below the Earth's surface the line to the Sun passes.\nUsed only when Satellite Sunlight is Legacy fade." },
        sunAngleArrows: { label: "Sun Angle Arrows", tooltip: "For each flaring satellite, draw an arrow from the camera to the satellite, and one from the satellite toward the Sun. Main view only.\nA satellite flares when it is inside Flare Angle Spread." },
        celestialFolder: { tooltip: "Night sky display: stars, constellations, the equatorial grid, star and planet labels, direction vectors to the Sun, Moon and planets, and the shadows of the Earth and the Moon." },
        labelList: { label: "Label List", tooltip: "Show only the labels whose name matches this comma-separated list, e.g. \"Moon, Polaris\".\nApplies to star, planet, Sun/Moon and satellite labels. Leave it empty to label everything.\nMatching is case-insensitive and by prefix. Satellites match on either name: the catalog name (STARLINK-1234) or the abbreviated name on the label (SL-1234)." },
        vectorsOnTraverse: { label: "Vectors On Traverse", tooltip: "If checked, the vectors are shown relative to the traverse object. Otherwise they are shown relative to the look camera." },
        vectorsInLookView: { label: "Celestial Vectors in Look", tooltip: "Show the celestial direction vectors in the look/camera view as well as the main view" },
        showSatellitesGlobal: { label: "Show Satellites (Global)", tooltip: "Master toggle: show or hide all satellites" },
        showStarlink: { label: "Starlink", tooltip: "Show SpaceX Starlink satellites" },
        showISS: { label: "ISS", tooltip: "Show the International Space Station" },
        celestrackBrightest: { label: "CelesTrak's Brightest", tooltip: "Show the satellites on CelesTrak's list of the brightest satellites. Sitrec has a built-in copy of the list." },
        otherSatellites: { label: "Other Satellites", tooltip: "Show satellites not in the above categories" },
        list: { label: "List", tooltip: "Also show the satellites in this comma-separated list of names or NORAD catalog numbers, even when their category is off. To show only these, turn the category switches off.\nName matching is case-insensitive and by prefix (e.g. \"starlink-30\" matches STARLINK-30xx).\n\"SL-\" is shorthand for Starlink, so \"SL-1234\" matches STARLINK-1234." },
        satelliteArrows: { label: "Satellite Arrows", tooltip: "Draw a yellow arrow, 500 km long, on each shown satellite, along its direction of travel.\nOnly within Display Range. Label Flares Only, Label Lit Only and Label Look Visible Only also limit the arrows." },
        flareLines: { label: "Flare Lines", tooltip: "Draw a yellow arrow, 100 km long, on each flaring satellite, along its direction of travel.\nFor lines to the camera and the Sun, use Sun Angle Arrows." },
        satelliteGroundArrows: { label: "Satellite Ground Arrows", tooltip: "Show arrows to the ground below each satellite" },
        satelliteLabelsLook: { label: "Satellite Labels (Look View)", tooltip: "Show satellite name labels in the look/camera view" },
        satelliteLabelsMain: { label: "Satellite Labels (Main View)", tooltip: "Show satellite name labels in the main 3D view" },
        labelFlaresOnly: { label: "Label Flares Only", tooltip: "Label only the satellites that are flaring now (see Flare Angle Spread).\nIt also limits Satellite Arrows and Satellite Ground Arrows to those satellites." },
        labelLitOnly: { label: "Label Lit Only", tooltip: "Label only the satellites in sunlight, not in the Earth's shadow.\nIt also limits Satellite Arrows and Satellite Ground Arrows to those satellites." },
        labelLookVisibleOnly: { label: "Label Look Visible Only", tooltip: "In the main view, label only the satellites inside the look camera's view. Satellite Labels (Look View) must also be on.\nIt also limits Satellite Arrows and Satellite Ground Arrows to those satellites." },
        flareRegion: { label: "Flare Region", tooltip: "Show the sky region where satellite flares are visible from the look camera.\nIt assumes Starlink geometry: a flat surface that faces the Earth, at one altitude of 550 km. It does not check the Flare Band and marks the best match even when no reflection is close, so it is valid only when the camera is inside the Flare Band." },
        flareBand: { label: "Flare Band", tooltip: "Show two fixed circles on the globe, between which horizon flares can be seen: green about 38° and yellow about 62° from the point opposite the Sun.\nThey do not depend on the loaded satellites." },
        filterTLEs: { label: "Filter TLEs", tooltip: "Open a window that narrows the shown satellites by position, name or orbit. A satellite must pass this filter and the category switches.\nLoad satellite data first." },
        clearTLEFilter: { label: "Clear TLE Filter", tooltip: "Remove all TLE spatial/orbital filters, restoring category-based visibility" },
        maxLabelsDisplayed: { label: "Max Labels Displayed", tooltip: "The largest number of satellite labels drawn in each view at one time. The nearest satellites get labels first." },
        starBrightness: { label: "Star Brightness", tooltip: "Scale factor for the brightness of the stars. 1 is normal, 0 is invisible, 2 is twice as bright, etc." },
        physicalPointSources: { label: "Physical Point Sources", tooltip: "Draw stars as points a few pixels wide, and planets at their true angular size. Brightness then sets intensity, not dot size.\nUse it with Camera > Camera Tweaks > Diffraction Glare, whose PSF (point spread function) makes the apparent size and the spikes.\nOff: Sitrec sizes stars and planets by magnitude, so they stay visible at any zoom. Without a PSF, this mode makes them hard to see." },
        starLimit: { label: "Star Limit", tooltip: "Faintest star to draw, as a magnitude. Stars with a higher magnitude (fainter) are hidden, and so are their name labels." },
        planetBrightness: { label: "Planet Brightness", tooltip: "Scale factor for the brightness of the planets (except Sun and Moon). 1 is normal, 0 is invisible, 2 is twice as bright, etc." },
        lockStarPlanetBrightness: { label: "Lock Star Planet Brightness", tooltip: "When checked, the Star Brightness and Planet Brightness sliders are locked together" },
        satBrightness: { label: "Sat Brightness", tooltip: "Scale factor for the size of the satellite dots in the look view, which is how Sitrec shows brightness. The default is 2; 0 hides them.\nIt does not change the main view." },
        flareBrightness: { label: "Flare Brightness", tooltip: "Extra brightness of a flaring satellite in the Legacy cone model. 0 adds none.\nShown only when Satellite Brightness Model is Legacy cone." },
        satCutOff: { label: "Sat Cut-Off", tooltip: "Satellites dimmer than this level are not drawn, in either view. Higher values hide more faint satellites; 0 turns the cut-off off." },
        displayRange: { label: "Display Range (km)", tooltip: "Satellites farther than this, in km, get no name labels or arrows. A label uses the distance from the camera of its view, and an arrow the distance from the look camera.\nSatellites shown by ISS, CelesTrak's Brightest or List still get labels." },
        equatorialGridMain: { label: "Equatorial Grid in Main", tooltip: "Show the celestial equatorial coordinate grid in the main 3D view" },
        constellationLines: { label: "Constellation Lines", tooltip: "Show lines connecting stars in constellations, and label each one with its name" },
        constellationStyle: {
            label: "Asterism Style",
            tooltip: "Which set of stick-figure lines to draw between stars",
            optionD3: "d3-celestial (default)",
            optionAstrometry: "Astrometry.net",
        },
        renderStars: { label: "Render Stars", tooltip: "Show stars in the night sky" },
        equatorialGridLook: { label: "Equatorial Grid in Look", tooltip: "Show the celestial equatorial coordinate grid in the look/camera view" },
        flareRegionLook: { label: "Flare Region in Look View", tooltip: "Also draw the Flare Region arrows and sphere in the look view. Used only when Flare Region is on." },
        satelliteEphemeris: { label: "Satellite Ephemeris", tooltip: "Show a table of the shown satellites above the look camera's horizon, highest first: direction, range, altitude, sunlit state and time until it sets.\nIt appears after satellite data is loaded." },
        skyPlot: { label: "Sky Plot", tooltip: "Show the satellites from the Satellite Ephemeris table on a round map of the sky. The center is straight up and the edge is the horizon, with north at the top.\nIt uses the table's Only VIS setting." },
        celestialVector: { label: "{{name}} Vector", tooltip: "Show a direction vector pointing toward {{name}}" },
    },
    synthClouds: {
        folder: { tooltip: "A synthetic cloud layer: a round patch of flat cloud images at one altitude. Each image always faces the camera.\nTo make a layer, right-click the ground and select Add Clouds." },
        name: { label: "Name" },
        visible: { label: "Visible", tooltip: "Show or hide this cloud layer." },
        editMode: { label: "Edit Mode", tooltip: "Show handles to edit the layer with the mouse, and open a floating edit menu.\nYellow (center): drag up or down to change Altitude.\nCyan (edge): drag to change Radius.\nOrange: drag to move the layer." },
        properties: { tooltip: "Settings for the size, shape and look of the clouds in this layer." },
        altitude: { label: "Altitude", tooltip: "Altitude of the middle of the cloud layer, above the WGS84 ellipsoid (HAE)." },
        radius: { label: "Radius", tooltip: "Radius of the round cloud layer. The number of clouds grows with its area (see Density)." },
        cloudSize: { label: "Cloud Size", tooltip: "Width of each cloud image. Its height is half the width." },
        density: { label: "Density", tooltip: "Number of clouds per area. 1 = about 32 clouds per square kilometer." },
        opacity: { label: "Opacity", tooltip: "How opaque each cloud is. Lower values let more of the background show through." },
        brightness: { label: "Brightness", tooltip: "Brightness of the clouds. 1 = normal sunlit color, less than 1 = darker.\nMore than 1 also adds light that does not depend on the sun, so the clouds glow even at night." },
        sunReflection: { label: "Sun Reflection", tooltip: "Radius, in meters, of a bright patch around the point where the view's camera sees the sun reflected in the layer. Clouds at its center are up to twice as bright.\n0 = off. Used only when the sun is above the horizon." },
        depth: { label: "Depth", tooltip: "Vertical thickness of the layer. Each cloud gets a random height in this range around Altitude.\n0 = all clouds at about the same height." },
        edgeWiggle: { label: "Edge Wiggle", tooltip: "Make the edge of the layer irregular instead of round. Larger values make larger bumps, in proportion to Radius.\n0 = round edge." },
        edgeFrequency: { label: "Edge Frequency", tooltip: "Number of waves that shape the edge. Higher values add smaller, finer bumps.\nUsed only when Edge Wiggle is more than 0." },
        seed: { label: "Seed", tooltip: "Random number seed for the cloud positions and the edge shape. Change it to get a different pattern with the same settings." },
        feather: { label: "Feather", tooltip: "Width of the zone inside the edge where the clouds thin out. 0 = hard edge." },
        wind: { tooltip: "How the cloud layer drifts. The layer is at its set position at frame 0 and moves with the wind after that." },
        windMode: { label: "Wind Mode", tooltip: "Which wind moves the layer.\nNo Wind: the layer does not move.\nUse Local: the Local wind (at the camera) from Physics > Wind.\nUse Target: the Target wind (at the target) from Physics > Wind.\nCustom: Wind From and Wind (knots) below." },
        windFrom: { label: "Wind From (\u00b0)", tooltip: "Direction the wind comes FROM, in degrees true (0 = north, 90 = east). Used only when Wind Mode is Custom." },
        windKnots: { label: "Wind (knots)", tooltip: "Wind speed, in knots. Used only when Wind Mode is Custom." },
        deleteClouds: { label: "Delete Clouds", tooltip: "Delete this cloud layer, after you confirm. You can undo the delete." },
    },
    cloudField: {
        folder: { label: "Cloud Field: {{name}}", tooltip: "A cloud field loaded from a cloud field file (.json). Its clouds are soft glowing spheres that drift together with one wind." },
        visible: { label: "Visible", tooltip: "Show or hide this cloud field." },
        gain: { label: "Brightness", tooltip: "Multiplies the emission of every sphere" },
        minEmission: { label: "Minimum Emission", tooltip: "Hide spheres fainter than this. Removes weak fitted spheres; it does not rescale the others" },
        refraction: { label: "Refraction", tooltip: "Bend the clouds with terrestrial refraction. Turn off for a field fitted to video, whose positions already include it" },
        color: { label: "Color", tooltip: "Color of the clouds. The emission of every sphere is multiplied by this color." },
        blendMode: { label: "Blend", tooltip: "Add brightens the scene (white-hot); Subtract darkens it (black-hot)" },
        windFrom: { label: "Wind From (°)", tooltip: "Direction the wind comes FROM, in degrees true (0 = north, 90 = east). The whole field drifts with this wind." },
        windKnots: { label: "Wind (knots)", tooltip: "Drift speed of the whole field" },
    },
    photoBackdrop: {
        folder: { label: "Photo Backdrop: {{name}}", tooltip: "A picture of the view around a camera that only turns, loaded from a photo backdrop file (.json). The look view draws each pixel in the direction where it was photographed." },
        visible: { label: "Visible", tooltip: "Show or hide this photo backdrop in all views." },
        showSky: { label: "Show Photo", tooltip: "Draw the picture behind everything in the look view" },
        occlude: { label: "Ground Hides Objects", tooltip: "The ground in the picture hides objects farther away than Range" },
        range: { label: "Range (m)", tooltip: "Distance, in meters, at which the ground in the picture is taken to be. It sets which objects that ground hides, and where Show in Main View draws the picture.\nThe picture does not move in the look view." },
        fill: { label: "Fill", tooltip: "Fill the rest of the look view with one color" },
        fillColor: { label: "Fill Color", tooltip: "Color for Fill. Used only when Fill is on." },
        showInMain: { label: "Show in Main View", tooltip: "Draw the photographed part of the picture in the main view, Range meters from the camera, where the ground in it is assumed to be" },
        mainOpacity: { label: "Main View Opacity", tooltip: "Opacity of the picture in the main view. 0 = invisible, 1 = solid. Used only when Show in Main View is on." },
        hideTerrain: { label: "Hide Terrain in Look View", tooltip: "The picture already shows the real ground, so hide the terrain model while the look view draws" },
        followCamera: { label: "Center on Look Camera", tooltip: "Keep the picture centered on the look camera, so its angles stay exact if the camera is a few meters from where the photos were taken" },
        importError: "Can't import photo backdrop \"{{filename}}\": {{message}}",
    },
    mradReticle: {
        menuName: "Milliradian Reticle",
        folder: "Reticle OSD",
        folderTooltip: "Settings for the milliradian (mrad) ranging reticle drawn over the look view.\nThis folder shows only while Show > Views > Milliradian Reticle is on.",
        showClock: { label: "Show Clock", tooltip: "Show the date and time in the lower left of the video image" },
        clockStart: { label: "Clock at Start", tooltip: "What the camera clock read at the start of the sitch, as MM/DD/YY HH:MM:SS. Leave it empty to show the sitch's local time." },
    },
    synthBuilding: {
        name: { label: "Name" },
        visible: { label: "Visible", tooltip: "Show or hide this building." },
        editMode: { label: "Edit Mode", tooltip: "Show handles to change the building in the 3D views: its corners, roof height, ridge and rotation. Only one building can be in Edit Mode at a time." },
        roofEdgeHeight: { label: "Roof Edge Height", tooltip: "Height of the top of the walls (the roof edge) above the highest ground corner, in the current units." },
        ridgelineHeight: { label: "Ridgeline Height", tooltip: "Height of the roof ridge above the highest ground corner, in the current units. Set it equal to Roof Edge Height for a flat roof." },
        ridgelineInset: { label: "Ridgeline Inset", tooltip: "Distance that each end of the ridge moves in from the roof edge, in the current units. 0 gives a gable roof; a larger value gives a hipped roof." },
        roofEaves: { label: "Roof Eaves", tooltip: "Distance that the roof extends out past the walls, in the current units." },
        type: { label: "Type", tooltip: "Material type for the walls and roof.\nbasic: flat color, not lit.\nlambert: lit, matte.\nphong: lit, with shiny highlights.\nphysical: physically based lighting." },
        wallColor: { label: "Wall Color", tooltip: "Color of the walls." },
        roofColor: { label: "Roof Color", tooltip: "Color of the roof." },
        opacity: { label: "Opacity", tooltip: "Opacity of the building, from 0 (transparent) to 1 (opaque). Used only when Transparent is on." },
        transparent: { label: "Transparent", tooltip: "Let the Opacity value take effect. Off: the building is drawn fully opaque." },
        wireframe: { label: "Wireframe", tooltip: "Draw only the edges of the building's triangles." },
        depthTest: { label: "Depth Test", tooltip: "Hide the parts of the building that are behind other objects. Off: the building shows through objects in front of it." },
        deleteBuilding: { label: "Delete Building", tooltip: "Delete this building after you confirm. You can undo it." },
        folder: { tooltip: "A simple 3D building model. Turn on Edit Mode to change its shape in the 3D views." },
        heightFolder: { tooltip: "Holds the heights and the roof shape of the building." },
        materialFolder: { tooltip: "Holds the surface settings of the building." },
    },

    groundOverlay: {
        name: { label: "Name" },
        visible: { label: "Visible", tooltip: "Show or hide this overlay." },
        editMode: { label: "Edit Mode", tooltip: "Show handles to change the overlay in the 3D views. Drag a yellow corner to resize it, the cyan handle to rotate it, or the image to move it.\nRight-click the image to add a lock point (up to 3). Drag a lock point to pull that part of the image to a new place. Alt+right-click a lock point to remove it." },
        lockShape: { label: "Lock Shape", tooltip: "Hide the corner and rotation handles in Edit Mode, so a drag can only move the overlay." },
        freeTransform: { label: "Free Transform", tooltip: "On: each corner moves on its own, so the image can take any four-sided shape. North, South, East, West and Rotation then do not change the shape.\nOff: the image is a rectangle set by its bounds and Rotation. Turning it off discards the free corner positions." },
        showBorder: { label: "Show Border", tooltip: "Always draw a highlight border around the overlay. When off, the border shows only while the pointer is over this folder." },
        properties: { label: "Properties", tooltip: "Holds the image, the bounds, rotation, altitude and display settings." },
        imageURL: { label: "Image URL", tooltip: "Web address (URL) of the image. A change loads the new image." },
        rehostLocalImage: { label: "Rehost Local Image", tooltip: "Pick an image file on your computer, upload it to the Sitrec server, and use its URL for this overlay. You must be logged in." },
        north: { label: "North", tooltip: "Latitude of the north edge of the overlay, in degrees. It does not change the shape while Free Transform is on." },
        south: { label: "South", tooltip: "Latitude of the south edge of the overlay, in degrees. It does not change the shape while Free Transform is on." },
        east: { label: "East", tooltip: "Longitude of the east edge of the overlay, in degrees. It does not change the shape while Free Transform is on." },
        west: { label: "West", tooltip: "Longitude of the west edge of the overlay, in degrees. It does not change the shape while Free Transform is on." },
        rotation: { label: "Rotation", tooltip: "Rotation of the overlay about its center, in degrees. Positive turns it counterclockwise as seen from above. Not used while Free Transform is on." },
        altitude: { label: "Altitude (ft)", tooltip: "Height of the overlay, in feet. 0 drapes the image on the terrain. Above 0, the image is drawn at this height above the ellipsoid (HAE), not on the ground." },
        wireframe: { label: "Wireframe", tooltip: "Draw only the edges of the overlay's triangles." },
        opacity: { label: "Opacity", tooltip: "Opacity of the overlay image, from 0 (transparent) to 1 (opaque)." },
        cloudExtraction: { label: "Cloud Extraction", tooltip: "Make the image transparent except for pixels near the Cloud Color, so that only the clouds show." },
        extractClouds: { label: "Extract Clouds", tooltip: "Keep only the pixels near the Cloud Color and make the rest of the image transparent." },
        cloudColor: { label: "Cloud Color", tooltip: "Color to keep when Extract Clouds is on. Pixels near this color stay visible." },
        fuzziness: { label: "Fuzziness", tooltip: "How far a pixel's color can be from the Cloud Color and stay fully visible, in percent of the largest color difference. A larger value keeps more pixels." },
        feather: { label: "Feather", tooltip: "Width of the soft edge beyond Fuzziness, in percent of the largest color difference. Pixels in this band fade to transparent. 0 gives a hard edge." },
        gotoOverlay: { label: "Go to Overlay", tooltip: "Move the main camera to look down on the overlay, from a height of about 5 times its longest side." },
        deleteOverlay: { label: "Delete Overlay", tooltip: "Delete this overlay after you confirm. You can undo it." },
        folder: { tooltip: "An image placed on the ground. While the pointer is over this folder, the border of the overlay is highlighted." },
    },

    groundGrid: {
        folder: { tooltip: "A measurement grid on the ground, with major lines, minor lines and an outline. Point at this folder to outline the grid in red.\nTo make a grid, right-click the ground and select Add Ground Grid." },
        name: { label: "Name", tooltip: "The name of this grid. Changing it does not change the grid." },
        visible: { label: "Visible", tooltip: "Show or hide this grid." },
        editMode: { label: "Edit Mode", tooltip: "Show handles to edit the grid with the mouse, and open a floating edit menu.\nDrag the grid to move it.\nYellow corners: drag to resize.\nCyan handle: drag to rotate." },
        width: { label: "Width", tooltip: "Size of the grid from west to east, before Rotation." },
        height: { label: "Height", tooltip: "Size of the grid from south to north, before Rotation." },
        majorStep: { label: "Major Step", tooltip: "Distance between major lines. 0 = no major lines.\nNot used when Lat/Lon Grid is on." },
        minorStep: { label: "Minor Step", tooltip: "Distance between minor lines. 0 = no minor lines.\nNot used when Lat/Lon Grid is on." },
        majorLineWidth: { label: "Major Line Width", tooltip: "Width of the major lines and the outline, in screen pixels." },
        minorLineWidth: { label: "Minor Line Width", tooltip: "Width of the minor lines, in screen pixels." },
        minorBrightness: { label: "Minor Brightness", tooltip: "Opacity of the minor lines compared to the major lines. 0 = minor lines hidden, 1 = full strength." },
        latLonGrid: { label: "Lat/Lon Grid", tooltip: "Draw latitude and longitude lines instead of the Major Step and Minor Step lines. Rotation is set to 0.\nEach view picks a spacing that is a power of 10 degrees, from Min and Max Pixel Spacing. Major lines are 10 times the minor spacing.\nA note at the bottom of each view shows the spacing." },
        minPixelSpacing: { label: "Min Pixel Spacing", tooltip: "Smallest gap on the screen, in pixels, between minor latitude and longitude lines.\nUsed only when Lat/Lon Grid is on." },
        maxPixelSpacing: { label: "Max Pixel Spacing", tooltip: "Largest gap on the screen, in pixels, between minor latitude and longitude lines. If it conflicts with Min Pixel Spacing, this value wins.\nUsed only when Lat/Lon Grid is on." },
        rotation: { label: "Rotation", tooltip: "Rotation of the grid around its center, in degrees.\nNot used when Lat/Lon Grid is on." },
        color: { label: "Major Color", tooltip: "Color of the major lines and the outline. When Lock Colors is on, the minor lines use it too." },
        minorColor: { label: "Minor Color", tooltip: "Color of the minor lines. Used only when Lock Colors is off." },
        lockColors: { label: "Lock Colors", tooltip: "Make the minor lines use the Major Color." },
        opacity: { label: "Opacity", tooltip: "Opacity of the whole grid. 0 = invisible, 1 = full strength." },
        altitude: { label: "Altitude", tooltip: "0 = drape the grid over the terrain.\nMore than 0 = draw it as a smooth sheet at this altitude above the WGS84 ellipsoid (HAE), not on the terrain." },
        gotoGrid: { label: "Go to Grid", tooltip: "Move the main view camera to a point above this grid, looking down at it." },
        deleteGrid: { label: "Delete Grid", tooltip: "Delete this grid, after you confirm. You can undo the delete." },
    },

    videoView: {
        folders: {
            videoAdjustments: "Video Adjustments",
            videoProcessing: "Video Processing",
            forensics: "Forensics",
            errorLevelAnalysis: "Error Level Analysis",
            noiseAnalysis: "Noise Analysis",
            grid: "Grid",
        },
        folderTooltips: {
            videoAdjustments: "Change how the video looks: brightness, contrast, levels, curves, tone, color and convolution filters.\nThe title checkbox (Enable Video Effects) turns them all on or off. Right-click the video to open this menu beside it.",
            videoProcessing: "Combine video frames into one image. Echo shows the darkest or lightest value of each pixel over recent frames. The Full A-B modes combine the whole A-B range, and Make Video saves that as a video.",
            forensics: "Tools that examine the video's compression, noise and brightness: error level analysis, noise analysis, the QP graph, the tonal range graph and noise pattern detection.",
            errorLevelAnalysis: "Error level analysis (ELA): compress the frame again as a JPEG and show how much each pixel changes, amplified by Error Scale.\nThe title checkbox turns the overlay on.",
            noiseAnalysis: "Show the fine noise of the frame as an overlay. A high-pass filter on the brightness keeps only the pixel-to-pixel detail and noise.\nThe title checkbox turns the overlay on.",
            grid: "A square grid drawn over the video, spaced in video pixels.\nThe title checkbox turns it on.",
        },
        currentVideo: {
            label: "Current Video",
            tooltip: "Choose which of the videos loaded into this view it shows. This item appears when the view has more than one video.",
        },
        removeVideo: {
            label: "Remove Video",
            tooltip: "Remove the video from this view and put it back the way it was before one "
                + "was loaded - the file is unloaded, the view is hidden again, and the sitch's "
                + "own duration comes back. Anything measured from the footage is not kept.",
        },
        videoRotation: {
            label: "Video Rotation",
            tooltip: "Rotate the video picture: 0°, 90° clockwise (CW), 180° or 90° counterclockwise (CCW). This adds to any rotation stored in the video file.\nA change turns off Point Track stabilization.",
        },
        setCameraToExifGps: {
            label: "Set Camera To EXIF GPS",
            tooltip: "Move the camera to the GPS position in the file's EXIF data. When the file has them, it also sets the start date and time and the camera heading, pitch, roll and vertical field of view.\nThe main view also moves to show the area.",
        },
        expandOutput: {
            label: "Expand Output",
            tooltip: "How to stretch the ELA result so that small differences show:\nNone: no change.\nHistogram Equalization: spread the brightness levels evenly.\nAuto Contrast: stretch the brightness range to full, after ignoring Clip % of the extreme values.\nAuto Contrast Channels: the same, for red, green and blue separately.",
        },
        displayMode: {
            label: "Display Mode",
            tooltip: "How to show the noise:\nNoise Heatmap: color each block by its noise level compared to the median block of the frame. Blue is less, green about the same, yellow and red more. Uses Block Size.\nNoise Residual: show the filtered noise itself, with mid-gray for none. Uses Noise Scale.",
        },
        convolutionFilter: {
            label: "Convolution Filter",
            tooltip: "A 3×3 filter applied to each frame:\nnone: off.\nsharpen: sharpen the edges. Set the strength with Sharpen Amount.\nedgeDetect: show only the edges, in white. Edge Threshold hides the weak ones.\nemboss: a relief effect. Set the strength with Emboss Depth.",
        },
        resetVideoAdjustments: {
            label: "Reset Video Adjustments",
            tooltip: "Reset every Video Adjustments setting to its default, and turn Enable Video Effects back on.\nIt also resets the Echo and Full A-B settings in Video Processing, and the Error Level Analysis and Noise Analysis settings.",
        },
        makeVideo: {
            label: "Make Video",
            tooltip: "Save a video file of the Full A-B Echo, Blend or Exposure as it builds up from frame A to frame B.\nNeeds one of those three on. Video Adjustments are not applied.",
        },
        gridShow: {
            label: "Show",
            tooltip: "Show a grid overlay on the video",
        },
        gridSize: {
            label: "Size",
            tooltip: "Grid cell size in video pixels",
        },
        gridSubdivisions: {
            label: "Subdivisions",
            tooltip: "Number of subdivisions within each grid cell",
        },
        gridXOffset: {
            label: "X Offset",
            tooltip: "Horizontal offset of the grid in video pixels",
        },
        gridYOffset: {
            label: "Y Offset",
            tooltip: "Vertical offset of the grid in video pixels",
        },
        gridColor: {
            label: "Color",
            tooltip: "Color of the grid lines",
        },
    },

    floodSim: {
        flood: {
            label: "Flood",
            tooltip: "Add water at the target on each frame (the fixed target or the target track).\nWater already on the ground keeps flowing when this is off. The simulation runs even while playback is paused.",
        },
        floodRate: {
            label: "Flood Rate",
            tooltip: "How fast water is added.\nFast and PBF: number of particles added per frame.\nHeightMap with Rain: water depth added to each cell in the Drop Radius, at Flood Rate x 0.2 mm per second.\nNot used by HeightMap with DamBurst.",
        },
        sphereSize: {
            label: "Sphere Size",
            tooltip: "Diameter of each water particle, in meters. It also sets the particle spacing in the Fast and PBF physics. Not used by HeightMap.",
        },
        dropRadius: {
            label: "Drop Radius",
            tooltip: "Radius, in meters, of the circle around the target where water is added.",
        },
        maxParticles: {
            label: "Max Particles",
            tooltip: "Maximum number of water particles for the Fast and PBF methods. At the limit, no new particles are added. Not used by HeightMap.",
        },
        method: {
            label: "Method",
            tooltip: "How the water is simulated.\nHeightMap: water depth on a 10 m grid inside the yellow boundary. Drag its corners to change the area.\nFast: particles with a simple pressure model.\nPBF: particles with position-based fluid physics.",
        },
        waterSource: {
            label: "Water Source",
            tooltip: "Where the water comes from. Used only by HeightMap.\nRain: add water inside the Drop Radius over time, at the Flood Rate.\nDamBurst: fill the ground inside the Drop Radius up to the altitude of the target, on each frame.",
        },
        speed: {
            label: "Speed",
            tooltip: "Number of HeightMap simulation steps on each frame, 1 to 20. More steps make the water move faster but use more processing. Used only by HeightMap.",
        },
        manningN: {
            label: "Manning's N",
            tooltip: "Roughness of the ground (Manning's n). A larger value slows the flow. Used only by HeightMap.\n0.01: smooth\n0.03: natural channel\n0.05: rough floodplain\n0.1: dense vegetation",
        },
        edge: {
            label: "Edge",
            tooltip: "What happens at the edges of the HeightMap grid. Used only by HeightMap.\nBlocking: water stops at the edges, as at a wall.\nDraining: water flows out across the edges and is removed.",
        },
        waterColor: {
            label: "Water Color",
            tooltip: "Color of the water particles and of the HeightMap water surface.",
        },
        reset: {
            label: "Reset",
            tooltip: "Remove all the water. While Flood is on, the simulation starts again at the current target position.",
        },
    },

    flowOrbs: {
        folder: {
            tooltip: "Small markers in front of the look camera that drift with the wind at the target. They show how the wind moves things across the view at different distances or altitudes.\nThe checkbox in the title shows or hides them.",
        },
        number: {
            label: "Number",
            tooltip: "Number of flow orbs to display. More orbs may impact performance.",
        },
        spreadMethod: {
            label: "Spread Method",
            tooltip: "Method to spread orbs along the camera look vector. \n'Range' spreads orbs evenly along the look vector between near and far distances. \n'Altitude' spreads orbs evenly along the look vector, between the low and high absolute altitudes (MSL)",
        },
        near: {
            label: "Near (m)",
            tooltip: "Nearest distance from the camera, in meters, at which orbs are placed.\nWith Spread Method = Altitude, this slider is Low (m): the lowest altitude for the orbs.",
        },
        far: {
            label: "Far (m)",
            tooltip: "Farthest distance from the camera, in meters, at which orbs are placed.\nWith Spread Method = Altitude, this slider is High (m): the highest altitude for the orbs.",
        },
        high: { label: "High (m)" },
        low: { label: "Low (m)" },
        colorMethod: {
            label: "Color Method",
            tooltip: "Method to determine the color of the flow orbs. \n'Random' assigns a random color to each orb. \n'User' assigns a user-selected color to all orbs. \n'Hue From Altitude' assigns a color based on the altitude of the orb. \n'Hue From Distance' assigns a color based on the distance of the orb from the camera.",
        },
        userColor: {
            label: "User Color",
            tooltip: "Select a color for the flow orbs when 'Color Method' is set to 'User'.",
        },
        hueRange: {
            label: "Hue Range",
            tooltip: "The altitude or distance span, in meters, over which the orb color goes once through the full spectrum. The colors then repeat.\nUsed only when Color Method is Hue From Altitude or Hue From Distance.",
        },
        windWhilePaused: {
            label: "Wind While Paused",
            tooltip: "If checked, wind will still affect the flow orbs even when the simulation is paused. Useful for visualizing wind patterns.",
        },
    },

    graphControls: {
        title: "Title",
        show: "Show",
        dark: "Dark",
        darkLight: "Dark / Light",
        toggleLegend: "Toggle Legend",
        xAxis: "X",
        y1Axis: "Y1 (left)",
        y2Axis: "Y2 (right)",
        y3Axis: "Y3 (right)",
        remove: "Remove",
    },
    pointFrequency: {
        menu: "Frequency Analysis",
        tooltip: "Show a window with the frequency spectrum of the tracked object's recorded brightness in the In/Out region. Needs a Point Track over that region.\nMeasures signed aperture flux minus local background, removes a linear trend, and applies a Hann window. Uses source video timing.",
        title: "Point Track Frequency Analysis",
        settings: "Frequency Analysis Settings",
        settingsTooltip: "Settings for Frequency Analysis: the measuring aperture, the units and peak label of the graph, and CSV export.",
        radius: "Object radius (px)",
        radiusTooltip: "Aperture radius in original video pixels. Include the whole object; keep other objects outside. The background ring is 1.75–2.5 times this radius. Uses Point Track Output Smoothing for positions only.",
        percent: "Amplitude as percent",
        percentTooltip: "Show the semi-amplitude as a percent of the object's mean flux (its brightness above the background, summed over the aperture). Off: show it in DN·pixels (DN = digital number, the recorded pixel value).\nIf the mean flux is zero, the graph uses DN·pixels.",
        showBackground: "Show local background",
        showBackgroundTooltip: "Also draw the spectrum of the local background ring around the object, scaled to the aperture area. Use it to compare the object's peaks with the background's.",
        refreshTooltip: "Measure the object in the video frames again and redraw the spectrum. The graph also updates by itself when the track, the In/Out region or the mask changes.",
        exportTooltip: "Save the spectrum, the analysis settings and the measurement of each frame to PointTrackFrequency.csv. Does nothing until a spectrum shows.",
        minPeakHz: "Peak search floor (Hz)",
        minPeakHzTooltip: "Label the largest peak only at or above this frequency. The value is in Hz, also when Flashes per minute is on. Slow brightness drift that the linear detrend and Hann window do not remove can otherwise win the label. The spectrum does not change. The default, 0.5 Hz (30 a minute), is below the slowest aircraft beacon. Above a flash rate, the floor labels one of its harmonics. Set 0 to turn the floor off: the search then starts about one bin above 0 Hz.",
        noTrack: "Use Point Track to measure the object through the In/Out region first",
        unavailable: "No spectrum for the selected range",
        invalidAperture: "An aperture overlaps the mask or video edge, or has too little background. Adjust the radius, mask or In/Out region",
        window: "In {{a}} – Out {{b}} · {{count}} samples · {{duration}} s · {{fps}} fps · bin spacing {{resolution}} {{frequencyUnit}}",
        peak: "Largest peak above one bin: {{frequency}} {{frequencyUnit}} · semi-amplitude {{amplitude}} {{unit}} (not a significance test)",
        peakAboveFloor: "Largest peak above {{floor}} {{frequencyUnit}}: {{frequency}} {{frequencyUnit}} · semi-amplitude {{amplitude}} {{unit}} (not a significance test)",
        floorAboveNyquist: "No peak labeled: the peak search floor ({{floor}} {{frequencyUnit}}) is at or above the Nyquist limit ({{nyquist}} {{frequencyUnit}}). Lower it in Frequency Analysis Settings",
        flat: "No varying signal above numerical precision",
        xLabel: "Frequency (Hz) — ends at Nyquist limit",
        xLabelPerMinute: "Frequency (flashes per minute) — ends at Nyquist limit",
        hz: "Hz",
        perMinuteUnit: "flashes/min",
        perMinute: "Flashes per minute",
        perMinuteTooltip: "Show frequencies as flashes per minute (Hz × 60) instead of Hz. The axis covers the same range.",
        yPercent: "Semi-amplitude (% of |mean object flux|)",
        yFlux: "Semi-amplitude (DN·pixels)",
        targetLegend: "Object − background",
        backgroundLegend: "Local background × aperture area",
        method: "Linear detrend · Hann window · radius {{radius}} px · position smoothing {{smoothing}} frames",
        clipped: "Aperture reaches black/white code limits; amplitudes may be distorted",
        irregularTiming: "Irregular frame timing ({{min}}–{{max}} fps): each frame is placed at its real time. Peaks above {{limit}} {{frequencyUnit}} may be aliases",
    },
    vfr: {
        fix: {
            label: "VFR Fix",
            tooltip: "This video has a variable frame rate: its frames are not evenly spaced in time ({{min}}–{{max}} fps). "
                + "Without the fix, Sitrec plays every frame at the mean rate of {{mean}} fps, so some parts play too slow and others too fast, "
                + "and the time of a frame can be wrong by up to {{drift}} s. "
                + "With the fix, Sitrec uses a constant {{fps}} fps timeline and shows each frame at its real time, repeating a frame where the video is slower. "
                + "Turning it on or off changes the frame numbers; the In/Out markers, point tracks and other frame data move with them.",
            blocked: "The fix is off: this sitch has frame data that Sitrec cannot yet move to new frame numbers ({{kinds}}).",
            blockedError: "VFR Fix was not changed: this sitch has frame data that Sitrec cannot yet move to new frame numbers ({{kinds}}).",
        },
        kinds: {
            chapters: "chapters",
            groundTrack: "ground track keyframes",
            cameraState: "camera state keys",
            fovEditor: "FOV editor curve",
            groundTrackSwitch: "camera switch-to-ground-track frame",
            starTracker: "star tracker pose track",
            frameOffset: "frame number offset",
            trackToTrackStop: "track-to-track stop frame",
            unknown: "the sitch could not be checked",
        },
    },
    videoTonal: {
        menu: "Tonal Range Graph",
        tooltip: "Per-frame recorded brightness distribution: median and percentile bands, or a histogram over time. Uses unmasked pixels when Enable Mask is on. Values are recorded intensity, not temperature.",
        title: "Video Tonal Range",
        settings: "Tonal Range Settings",
        display: "Display",
        displayTooltip: "What the graph shows for each frame:\nPercentile bands: the median, with bands for the middle 50% and 90% of pixel values.\nHistogram over time: how common each brightness level is.\nObject − local background: the tracked object's mean minus the median of the ring around it.\nContrast / local IQR: that difference divided by the ring's spread from the 25th to the 75th percentile.\nThe last two need a Point Track.",
        percentiles: "Percentile bands",
        histogram: "Histogram over time",
        contrast: "Object − local background",
        relativeContrast: "Contrast / local IQR",
        showMean: "Show mean",
        showMeanTooltip: "Also draw the mean pixel value of each frame. Not used in the two object displays.",
        showExtremes: "Show min/max",
        showExtremesTooltip: "Also draw the darkest and brightest pixel value (min and max) of each frame. Not used in the two object displays.",
        targetAnalysis: "Tracked object",
        targetAnalysisTooltip: "Also draw the tracked object's mean and the median of the ring around it, from the Point Track positions. Object radius (px) sets the size. Not used in the two object displays, which always measure the object.",
        targetRadius: "Object radius (px)",
        targetTooltip: "Uses existing Point Track positions, in original video pixels. The object aperture has this radius; the local background ring spans 2–4 times the radius. Masked pixels are excluded from both. The graph updates by itself when the track changes.",
        refresh: "Recalculate",
        refreshTooltip: "Measure every frame of the video again and redraw the graph. The graph also updates by itself when the video, the mask or the track changes.",
        exportCSV: "Export CSV",
        exportTooltip: "Save the values of every frame to VideoTonalRange.csv. Does nothing until the graph has a result.",
        frame: "Frame",
        luma: "Recorded luma (0–255)",
        scaledLuma: "Recorded luma ({{bits}}-bit scaled to 0–255)",
        displayGray: "Display gray (0–255)",
        masked: "Mask applied",
        wholeFrame: "Whole frame",
        bandLegend: "Bands: middle 90% and middle 50% of pixels",
        contrastLegend: "Object aperture mean − local background median",
        relativeLegend: "Signed contrast divided by the local 75th–25th percentile span",
        density: "Histogram density: dark = rare, bright = common (fixed log scale, 0.001%–10% per level)",
        p05: "5th percentile",
        median: "Median",
        p95: "95th percentile",
        mean: "Mean",
        target: "Object mean",
        local: "Local median",
        readout: "Frame {{frame}}: P5 {{low}} · median {{median}} · P95 {{high}} · span {{span}} · {{count}} pixels",
        targetReadout: "Frame {{frame}}: object {{target}} · local {{local}} · difference {{contrast}} · relative {{relative}}",
        noVideo: "No video is loaded",
        loading: "Waiting for the video to load",
        loadingMask: "Waiting for the saved mask to load",
        noFrames: "Load an encoded video to analyze its frames",
        noTrack: "Use Point Track to measure object positions first; missing frames remain gaps",
        emptyMask: "No background pixels remain after exclusions",
        analyzing: "Measuring video frames: {{percent}}%",
        failed: "Video analysis failed: {{reason}}",
    },
    videoQP: {
        menu: {
            label: "QP Graph",
            tooltip: "Graph of the H.264 quantization parameter (QP) of the video: the maximum, mean and minimum QP of the 16x16 macroblocks in each frame. A higher QP is more compression loss. The values are read from the video bitstream, not estimated from the pixels",
        },
        title: "Video QP",
        titleBlocks: "{{name}}: all {{blocks}} blocks in each frame",
        xLabel: "Frame",
        yLabel: "Luma quantization parameter (QP)",
        legend: {
            max: "Maximum",
            mean: "Mean",
            min: "Minimum",
        },
        readout: "Frame {{frame}} ({{type}}): max {{max}}, mean {{mean}}, min {{min}}, slice start {{sliceQP}}",
        status: {
            loading: "Waiting for the video to load",
            analyzing: "Reading the bitstream: {{percent}}%",
            noVideo: "No video is loaded",
            noEncodedVideo: "This video has no encoded frames to read (it is an image or a frame sequence)",
            notH264: "The QP graph needs an H.264 video. This video uses a different codec",
            unsupported: "This H.264 stream uses a feature that the QP reader does not support: {{reason}}",
            failed: "The QP reader failed: {{reason}}",
        },
    },
    videoNoisePattern: {
        folderScan: {
            title: "NPD Folder Scan",
            tooltip: "Scan videos in a chosen folder and all its subfolders for repeating noise",
            description: "Recursively scan videos in a folder. Green rows mark repeating noise; amber rows mark repeating pictures. Select Details for frame ranges, controls and errors.",
            close: "Close", choose: "Choose Folder", rescan: "Scan Again", stop: "Stop", export: "Export CSV",
            limit: "Limit to (minutes)", limitHelp: "Analyze only the beginning of each video, up to this duration. Default: 2 minutes",
            capped: "limited", unknownError: "Unable to analyze this file",
            autoReduced: "auto-reduced",
            openVideo: "Open this video in a fresh Sitrec tab and run NPD with these settings and the same scan region",
            onlyRepeats: "Repeats only", filter: "Filter paths", ready: "Choose a folder to scan.", folders: "Folders",
            file: "Video / relative path", result: "Result", period: "Period", strength: "Strength", curve: "Channel",
            coverage: "Reference coverage", matched: "Matched / tested", frames: "Decoded / frames", details: "Details",
            usable: "Usable",
            usableHelp: "Decoded frames with enough noise detail, excluding held or near-identical pictures. The repeat search needs at least 136 usable frames",
            strengthHelp: "Median detrended Z score at period multiples; isolated peaks show their strongest Z score. Uses RMS deviation if the robust scale is zero. This is a search score, not a probability.",
            coverageHelp: "Fraction of reference frames supporting the repeat",
            matchedHelp: "Frames matching the detected period, tested against control pairs",
            idle: "Ready", walking: "Finding videos", scanning: "Scanning", done: "Complete", stopped: "Stopped", error: "Error",
            queued: "Queued", working: "Analyzing", noiseRepeat: "Repeating noise", pictureRepeat: "Repeating pictures",
            offsetCandidates: "{{count}} offset texture candidates", offsetError: "Offset search incomplete",
            offsetNone: "No column repeat; no offset candidates in sampled set",
            isolated: "Isolated peaks", cannot: "Insufficient usable frames", none: "No repeat detected",
            cannotReason: "Too few usable frames: {{usable}}/{{required}} needed; {{held}} held",
            progress: "{{folder}} — {{status}}: {{done}}/{{total}} videos; {{repeats}} repeats; {{errors}} errors",
            options: "First {{limit}} minutes · longest lag {{lag}} · strip detail {{detail}} px · vertical search {{vertical}} · held frames: {{held}}",
            folderCount: "Folders ({{count}})",
            folderRow: "{{folder}} — {{total}} videos, {{repeats}} repeats, {{errors}} errors",
        },
        menu: {
            label: "Noise Pattern Detection",
            tooltip: "Finds noise that appears again in later frames, such as a looping noise layer, also when the layer is cut into vertical strips that change order or when it moves sideways. A camera makes new noise in every frame, so noise that repeats was added to the video. Opens a results window and analyzes the whole video in background workers",
        },
        settings: {
            folder: "Noise Pattern Settings",
            longestLag: "Longest lag (frames)",
            offsetSearch: "Search offset patches",
            offsetSearchTooltip: "Additional CPU search for texture patches displaced in either direction. Samples up to 128 distinct pictures, proposes 2-D translations, then checks native-resolution temporal residuals. Preserves the column search; adds processing time. A negative sampled search is not exhaustive.",
            longestLagTooltip: "The longest time between two frames that the lag scan compares. Also limited to a quarter of the analyzed frames",
            detail: "Strip detail",
            detailTooltip: "Width of the columns of the strip profiles. 4 px finds narrower strips, uses twice the memory and takes about four times as long to search",
            detailFast: "8 px (fast)",
            detailFine: "4 px",
            vertical: "Vertical search",
            verticalTooltip: "Also compares the frames moved up and down by whole bands (a band is 1/45 of the picture height), for a noise layer that moves vertically, for example with an object. Runs on the CPU workers",
            verticalOff: "Off",
            verticalOne: "±1 band",
            verticalThree: "±3 bands",
            held: "Held frames",
            heldTooltip: "A held frame repeats the previous picture. Leave out: held frames are not analyzed and lags are in frames. Count as one picture: each run of identical frames is one picture and lags are in pictures",
            heldLeave: "Leave out",
            heldPicture: "Count as one picture",
            frames: "Frames",
            framesTooltip: "Analyze the whole video, or only the frames between the A and B markers of the timeline",
            framesAll: "Whole video",
            framesAB: "A-B range",
            searchOn: "Search on",
            searchOnTooltip: "Where the strip search runs. Fastest (measured) runs the first 512 pairs on both the GPU and the CPU workers and uses the faster one",
            searchFastest: "Fastest (measured)",
            searchGPU: "GPU",
            searchCPU: "CPU workers",
            run: "Run",
            runTooltip: "Run the analysis again with these settings. Features of the frames are kept, so a change of Longest lag, Vertical search or Search on does not decode the video again",
            stop: "Stop",
            stopTooltip: "Stop the analysis that is running. Press Run to start it again.",
            exportCSV: "Export CSV",
            exportTooltip: "Save the lag curves, the result of every frame and the refined pairs as a CSV file",
            benchmark: "Benchmark CPU and GPU",
            benchmarkTooltip: "Decode the video again on the CPU workers, and run the lag scan and the precise pass on both the CPU workers and the GPU. The times are in Details",
        },
        view: {
            title: "Noise Pattern Detection",
            run: "Run",
            stop: "Stop",
            lagChart: "Repeat score by lag",
            where: "Where the repeat is",
            whereLegend: "Green: the noise repeats (brighter = more strips match). Gray: tested, no repeat. Hatched: not tested. Yellow: current frame. Click or drag to go to a frame.",
            pair: "Frame pair",
            offsetTitle: "Offset texture candidates",
            offsetRotated: "Both residual crops rotated 90° for display: source above, target below; shared contrast.",
            offsetPrevious: "◀ Previous offset candidate",
            offsetNext: "Next offset candidate ▶",
            offsetSummaryUnavailable: "Local-offset search has not run.",
            offsetSummaryPending: "Local-offset search pending.",
            offsetSummaryUnchecked: "{{count}} texture matches await background/phase screening. Run the analysis with an updated build; these are not yet noise candidates.",
            offsetSummaryDisabled: "Local-offset search disabled.",
            offsetSummaryError: "Local-offset search failed: {{error}}",
            offsetSummaryDone: "Local-offset search: {{count}} residual candidates pass screening; {{suppressed}} background/ambiguous matches excluded. {{sampled}} sampled frames, {{pairs}} tested pairs. Passing these checks does not establish synthetic noise.",
            offsetAmbiguous: "Include ambiguous matches",
            offsetResidual: "Residuals on video",
            offsetOriginalPositions: "Original positions",
            offsetScreening: "{{status}} · background NCC: band {{band}}, broad {{broad}}, surround {{context}} · phase advantage {{gain}}",
            offsetScreen: {passed: "Passes preliminary screening", background: "Ambiguous: background also matches", phase: "Ambiguous: temporal control fails", unchecked: "Not screened; rerun analysis"},
            offsetMatchLabel: "Candidate {{index}} / {{count}} · frames {{source}} → {{target}} (lag {{lag}}) · {{plane}} · source luma ROI {{sourceROI}} · target luma ROI {{targetROI}} · dx {{dx}}, dy {{dy}} · native NCC {{score}}",
            offsetInterpretation: "Candidates are local image similarities, not a fabrication verdict; scene motion and compression can also produce them.",
            offsetLimits: "Bounded search: up to 128 distinct pictures (up to 64 contiguous, remainder spread through the clip); Y, Cb and Cr; 48 translation proposals and 24 native checks per plane, spread across lag ranges; up to 72 raw candidates. No rotation/scale search. Small, faint or unsampled patches can be missed. Participation rank below 1.5 is excluded. Default shortlist also excludes matching temporal-mean backgrounds (absolute band NCC >=0.6, broad or surrounding NCC >=0.9) and requires both same-phase correlations to exceed zero and the larger crossed-phase correlation by at least 0.15. These development heuristics can hide genuine noise, especially weak mixtures or noise on repeated imagery; Include ambiguous matches and CSV retain those results. Display: preceding-distinct-picture subtraction and Gaussian sigma 1 minus 6 in native-plane pixels, shared crop contrast. Thresholds are not p-values or proof of noise origin.",
            previous: "◀ Previous",
            next: "Next ▶",
            goSource: "Go to source",
            goTarget: "Go to target",
            blink: "Blink (2 Hz)",
            aligned: "Aligned",
            showOnVideo: "Show on video",
            maxContrast: "Max contrast",
            details: "Details",
            memory: "The features of this video need about {{mb}} MB of memory, more than the {{limit}} MB limit. Analyze the A-B range of the timeline instead?",
            memoryTitle: "Noise Pattern Detection",
            useAB: "Use the A-B range",
            analyzeAnyway: "Analyze the whole video",
            cancel: "Cancel",
            frames: "frames",
            pictures: "pictures",
            planeY: "luma (Y)",
            planeCb: "blue-difference (Cb)",
            planeCr: "red-difference (Cr)",
            planeYfine: "fine luma, at the same position",
            planeCbmid: "Cb, at the same position",
            backend: {
                gpu: "search on GPU",
                cpu: "search on CPU workers",
            },
            hover: "Lag {{lag}}: {{values}}",
            notScored: "(not scored: shorter than 17)",
            noPair: "No pair selected. Click a peak in the lag chart, or a green part of the strip.",
            targetImage: "Target, frame {{frame}}",
            sourceImage: "Source, frame {{frame}}",
            sourceAligned: "Source, frame {{frame}}, columns moved to line up",
            pairLabel: "Pair {{source}} → {{target}} (lag {{lag}}): {{confident}} of {{valid}} strips match. Score {{score}}, threshold {{tau}}",
            pairXor: "Strip c of the target shows strip c XOR {{d}} of the source ({{fit}}% of {{probes}} probes inside strips)",
            pairShift: "Most common shift: {{shift}} px ({{fit}}% of the matching probes)",
        },
        chart: {
            xLag: "Lag (frames)",
            xLagPictures: "Lag (pictures)",
            yScore: "z (robust)",
            empty: "The lag scan has not run yet",
            tooShort: "Too few frames for a lag scan",
        },
        status: {
            noVideo: "No video is loaded",
            loading: "Waiting for the video to load",
            downloading: "Waiting for the video to finish downloading",
            noFrames: "This video has no encoded frames to analyze (it is an image or a frame sequence)",
            noKeyFrames: "This video has no key frames, so it cannot be decoded",
            benchmarkNeedsRun: "Run the analysis to completion before the benchmark",
            settingsChanged: "Settings changed – Run",
            benchmarking: "Benchmarking…",
            stopped: "Stopped",
            failed: "Failed: {{reason}}",
            done: "Done in {{time}} · {{backend}}",
            stage: {
                spawn: "Starting workers",
                ingest: "Decoding frames",
                held: "Finding held frames",
                prep: "Preparing features",
                coarse: "Lag scan",
                precise: "Testing every frame",
                longRange: "Testing long lags",
                refine: "Mapping strips",
                offsetDecode: "Reading offset-search pictures",
                offsetSearch: "Searching 2-D offsets on CPU",
                offsetVerify: "Checking native-resolution patches",
                done: "Done",
            },
        },
        verdict: {
            idle: "Not run yet",
            analyzing: "Analyzing…",
            stopped: "Stopped",
            failed: "The analysis failed: {{reason}}",
            cannot: "Cannot analyze: {{reason}}",
            reason: {
                tooFew: "too few usable frames ({{frames}}); at least 136 are needed",
            },
            none: "No column-profile repeat found (lags {{from}}–{{to}} {{unit}} checked)",
            isolated: "No regular repeat. Isolated repeats at lag {{list}} {{unit}}",
            repeat: "The noise repeats every {{period}} {{unit}}",
            strength: "Strength {{strength}} ({{label}}; a strength above 6 is unlikely without a repeat), seen from {{coverage}} of {{references}} reference frames, in the {{plane}} plane",
            label: {
                strong: "strong",
                clear: "clear",
                weak: "weak",
            },
            where: "Where: frames {{runs}} ({{matched}} of {{tested}} tested frames match)",
            incomplete: "Incomplete: {{failed}} of {{frames}} frames could not be decoded ({{segments}} segments skipped), so this result covers the other frames only",
            rule: {
                xor: "Strips {{width}} px wide change order by an XOR of their numbers (fits {{fit}} of {{total}} refined pairs)",
                cyclic: "Strips {{width}} px wide move round by whole strips (fits {{fit}} of {{total}} refined pairs)",
                translation: "The noise moves sideways between repeats (fits {{fit}} of {{total}} refined pairs)",
                none: "Strip edges {{width}} px apart; no single re-ordering rule fits",
            },
            longest: "The same noise returns up to {{lag}} frames later",
            pictureRepeat: "The picture itself repeats (looped footage or copied frames), not only the noise",
        },
        details: {
            none: "No results yet.",
            video: "VIDEO",
            decoded: "decoded as {{mode}} ({{accel}})",
            displayRGB: "display RGB (BT.709 conversion)",
            nativeYUV: "native YUV planes, {{bits}}-bit",
            range: "frames {{from}}–{{to}}",
            settings: "settings: longest lag {{lag}}, strip detail {{detail}} px, vertical search ±{{vertical}} bands, held frames {{held}}, frames {{frames}}, search on {{search}}",
            frames: "FRAMES",
            counts: "decoded {{decoded}} of {{frames}} (failed {{failed}}), held {{held}}, usable Y {{y}} / Cb {{cb}} / Cr {{cr}}, sequence {{sequence}} {{unit}}",
            mergedKeyFrames: "{{n}} key frames hold no IDR slice (a decoder cannot start there); each was merged into the group before it",
            decodeErrors: "{{n}} decode segments reported an error: {{prerolled}} recovered by decoding from the previous key frame, {{skipped}} skipped; last error: {{error}}",
            lagScan: "LAG SCAN ({{references}} reference frames, lags 1–{{lmax}} {{unit}}, scored from {{lagMin}})",
            verdict: "VERDICT",
            isolated: "significant lags that are not multiples of the period: {{list}}",
            matches: "MATCHES (each frame against the frame one period later)",
            matchCounts: "tested {{tested}}, matched {{matched}} (in runs; {{raw}} before the run filter), {{pairs}} pairs, {{controls}} control pairs, threshold floor {{floor}}",
            runs: "runs: {{runs}}",
            longest: "longest return: {{lag}} frames, {{source}} → {{target}}, score {{score}} (threshold {{tau}})",
            picture: "same picture repeated: {{repeats}} (median thumbnail correlation {{matched}} for matched pairs, {{control}} for controls)",
            yes: "yes",
            no: "no",
            lattice: "STRIP LATTICE",
            latticeLine: "width {{w}} px, origin {{origin}} px, {{n}} strip edges, R {{R}}, accepted {{accepted}}",
            rule: "RULE",
            ruleLine: "{{kind}}: fits {{fit}} of {{total}} refined pairs (width {{w}} px, origin {{origin}} px, numbering offset {{k0}})",
            selected: "SELECTED PAIR {{source}} → {{target}} (lag {{lag}})",
            selectedLine: "score {{score}}, threshold {{tau}}, {{valid}} usable probes, shift {{shift}} px; dense map: {{confident}} confident probes, {{inStrip}} inside strips, {{whole}}% move by whole strips",
            selectedXor: "XOR d = {{d}} for {{fit}}% of {{probes}} probes inside strips",
            stripMap: "strip map (target ← source (margin); ? = less than 70% agree):",
            timings: "TIMINGS (page visible at start: {{start}}, at end: {{end}})",
            timingSpawn: "spawn {{spawn}} ({{lanes}} workers, {{decodeLanes}} decoding)",
            timingCached: "ingest, held frames and preparation: reused from the previous run",
            timingIngest: "ingest {{time}} ({{fps}} frames/s, decoder {{accel}})",
            timingPrep: "held frames {{held}}, preparation {{prep}}",
            timingGpuSetup: "GPU start and upload {{time}}",
            timingCalibration: "calibration {{time}}: {{pairs}} pairs, CPU workers {{cpu}} pairs/s, GPU {{gpu}} pairs/s, max |ΔC| {{delta}}",
            timingCoarse: "lag scan {{time}} (search {{search}}, {{rate}} pairs/s on {{backend}})",
            timingRest: "precise pass {{precise}}, long lags {{longRange}}, strip mapping {{refine}}",
            timingTotal: "total {{total}}; longest page-thread slice {{slice}} ms",
            backend: "search backend: {{search}} ({{reason}})",
            adapter: "GPU: {{vendor}} {{architecture}}, packed 8-bit dot product: {{packed}}",
            benchmark: "BENCHMARK",
        },
        exportFade: {
            button: "Export overlap fade",
            tooltip: "MP4 of the original frames, shifted to center the selected region. Hold source 0.5 s, fade 1 s, hold target 0.5 s, then reverse (4 s total). Native size; black padding; no video adjustments or residual filtering.",
            cancel: "Cancel export",
            preparing: "Preparing original frames…",
            progress: "Exporting overlap fade: {{percent}}%",
            saved: "Downloaded {{filename}}",
            cancelled: "Overlap fade export cancelled.",
            failed: "Overlap fade export failed: {{error}}",
            invalid: "Select a valid offset match first.",
            unsupported: "MP4 encoding unavailable: {{reason}}",
            frameUnavailable: "Could not decode original frame {{frame}}.",
            dimensions: "Decoded frame dimensions differ from the analyzed video. Run the analysis again.",
        },
        overlay: {
            offsetResidualCaption: "Processed residuals: {{source}} cyan, {{target}} yellow · temporal difference + band-pass · shared contrast",
            offsetCaption: "Original pixels: {{source}} cyan, {{target}} yellow · offset {{dx}}, {{dy}} px · pasted crop aligned beside match",
            offsetOriginalCaption: "Original pixels: {{source}} cyan, {{target}} yellow · each crop at its original position",
            offsetResidualOriginalCaption: "Processed residuals: {{source}} cyan, {{target}} yellow · original positions · shared contrast",
            offsetOtherFrame: "Offset match at frames {{source}} and {{target}}; use Go to source or Go to target",
            offsetTransform: "Turn off video stabilization and rotation to show the offset match",
            caption: "Frame {{target}} shows noise from frame {{source}} (lag {{lag}})",
            noMatch: "No matched repeat at frame {{frame}}; use Previous or Next, or go to a green part of the strip",
        },
    },
    osdController: {
        seriesFolder: {
            tooltip: "One OSD data series. Click its text box on the video to type its values.",
        },
        seriesName: {
            label: "Name",
            tooltip: "Name of this series. It is the folder title, the name in the Graph axis lists, and the column and file name in Export All Data.",
        },
        seriesType: {
            label: "Type",
            tooltip: "What the values are.\nMake Track uses MGRS Zone, East and North, or Latitude and Longitude. It also uses Altitude (m) or Altitude (ft), read as height above mean sea level. With no altitude series, the track is put on the ground.\nSlant Range is only stored, graphed and exported.",
        },
        seriesShow: {
            label: "Show",
            tooltip: "Show this series' text box on the video. A hidden series cannot be edited.\nMake Track skips a hidden series when another series has the same Type.",
        },
        seriesLock: {
            label: "Lock",
            tooltip: "Stop edits to this series: a click on its text box does nothing, and Tab skips it. Its text shows in gray.\nMake Track skips a locked series when another series has the same Type.",
        },
        removeTrack: {
            label: "Remove Track",
            tooltip: "Delete this series and all its values. You cannot undo this.",
        },
        folderTitle: {
            label: "OSD Tracker",
            tooltip: "Type in the values that the video's OSD (on-screen display) text shows, frame by frame. Then graph them, export them, or make a position track from them.",
        },
        addNewTrack: {
            label: "Add New OSD Data Series",
            tooltip: "Add a data series: a text box over the video that holds one value per frame.\nClick the box to type the value for the current frame. A value stays until the next frame that has one.\n[ and ] step one frame. Page Up and Page Down jump between keyframes. Tab goes to the next series. Enter or Esc stops editing.",
        },
        makeTrack: {
            label: "Make Track",
            tooltip: "Make a 3D position track from the series: MGRS Zone, East and North, or Latitude and Longitude, plus an altitude series if there is one. When a Type has more than one series, the shown, unlocked one is used.\nThe track gets a sphere marker and is added to the track menus as OSD_0, OSD_1, ...",
        },
        showAll: {
            label: "Show All",
            tooltip: "Toggle visibility of all OSD data series",
        },
        exportAllData: {
            label: "Export All Data",
            tooltip: "Download OSDData.zip for the In to Out frames. It holds one CSV of the typed values for each series, and combined CSVs at every keyframe, every second and every frame.\nIn the combined files, numbers are interpolated between keyframes and text carries forward.",
        },
        graphFolder: {
            tooltip: "Plot OSD data series against the frame number or against each other, in the OSD Graph window.",
        },
        graphShow: {
            label: "Show",
            tooltip: "Show the OSD Graph window. It needs a series in Y1 Axis or Y2 Axis.",
        },
        xAxis: {
            label: "X Axis",
            tooltip: "What goes on the horizontal axis.\nNone or Frame: the frame number, all frames.\nFrame A→B: the frame number, In to Out frames only.\nA series: that series' values, In to Out frames only.",
        },
        y1Axis: {
            label: "Y1 Axis",
            tooltip: "Data series for the left vertical axis",
        },
        y2Axis: {
            label: "Y2 Axis",
            tooltip: "Data series for the right vertical axis",
        },
    },

    videoInfo: {
        folderTitle: {
            label: "Video Readout",
            tooltip: "The on-screen readout drawn over the video: frame counter, timecode, timestamp and dates",
        },
        showVideoInfo: {
            label: "Show Video Readout",
            tooltip: "Master toggle - enable or disable every item in the video readout. With nothing chosen yet, switching it on adds the frame number",
        },
        filename: {
            label: "Filename",
            tooltip: "Show the current video filename",
        },
        frameCounter: {
            label: "Frame Number",
            tooltip: "Show the current frame number (virtual frame when video is patched)",
        },
        sourceFrame: {
            label: "Source Frame Number",
            tooltip: "Show the underlying decoded source frame number (differs from Frame Number during held bursts when video is patched)",
        },
        offsetFrame: {
            label: "Offset Frame",
            tooltip: "Show the current frame number plus an offset value",
        },
        offsetValue: {
            label: "Offset Value",
            tooltip: "Number added to the current frame number for the Offset Frame item",
        },
        timecode: {
            label: "Timecode",
            tooltip: "Show the time from frame 0 as MM:SS:FF (minutes, seconds, frames). Hours are added (HH:MM:SS:FF) when the sitch is one hour or longer",
        },
        timestamp: {
            label: "Timestamp",
            tooltip: "Show the time from frame 0 as MM:SS.SS (seconds to two decimal places). Hours are added when the sitch is one hour or longer",
        },
        dateLocal: {
            label: "Date (Local)",
            tooltip: "Show the date of the current frame in the time zone set in Time > Time Zone",
        },
        timeLocal: {
            label: "Time (Local)",
            tooltip: "Show the time of the current frame in the time zone set in Time > Time Zone",
        },
        dateTimeLocal: {
            label: "DateTime (Local)",
            tooltip: "Show the date and time of the current frame, with the zone name, in the time zone set in Time > Time Zone",
        },
        dateUTC: {
            label: "Date (UTC)",
            tooltip: "Show the date of the current frame in UTC",
        },
        timeUTC: {
            label: "Time (UTC)",
            tooltip: "Show the time of the current frame in UTC",
        },
        dateTimeUTC: {
            label: "DateTime (UTC)",
            tooltip: "Show the date and time of the current frame in UTC",
        },
        fontSize: {
            label: "Font Size",
            tooltip: "Text size of the readout items. The value is in pixels for a picture 1080 pixels high, and the text scales with the picture",
        },
    },

    simInfo: {
        folderTitle: {
            label: "Look View Readout",
            tooltip: "The on-screen readout drawn over the look view: simulation date/time and traverse figures (independent of the Video Readout)",
        },
        showSimInfo: {
            label: "Show Look View Readout",
            tooltip: "Master toggle - enable or disable every item in the look view readout. With nothing chosen yet, switching it on adds the UTC clock",
        },
        traverseSpeed: {
            label: "Traverse Speed",
            tooltip: "Show the traverse object's total 3D speed in the selected units (knots/mph/km/h)",
        },
        traverseGroundSpeed: {
            label: "Traverse Ground Speed",
            tooltip: "Show the traverse object's horizontal ground speed (vertical component removed)",
        },
        traverseAirSpeed: {
            label: "Traverse Air Speed",
            tooltip: "Show the traverse object's horizontal air speed: its motion with the target wind subtracted. Shown only when the sitch has a target wind",
        },
        traverseGForce: {
            label: "Traverse g-force",
            tooltip: "Show the traverse object's total g-force (acceleration ÷ 9.81)",
        },
        traverseAltMSL: {
            label: "Traverse Alt (MSL)",
            tooltip: "Show the traverse object's altitude above mean sea level (geoid)",
        },
        traverseAltAGL: {
            label: "Traverse Alt (AGL)",
            tooltip: "Show the traverse object's altitude above ground level (terrain directly below)",
        },
    },

    terrainUI: {
        mapType: {
            label: "Map Type",
            tooltip: "Source of the map images drawn on the terrain. Elevation Type sets the ground heights separately.\nNo map images load while 3D Buildings shows Google Photorealistic tiles, because those tiles replace the terrain.",
        },
        elevationType: {
            label: "Elevation Type",
            tooltip: "Source of the ground heights. The data gives heights above mean sea level (MSL). Sitrec adds the EGM96 geoid height to get the height above the ellipsoid (HAE).\nGround below sea level is drawn at sea level.\nFlat: no height data.",
        },
        lat: {
            label: "Latitude",
            tooltip: "Latitude of the center of the terrain",
        },
        lon: {
            label: "Longitude",
            tooltip: "Longitude of the center of the terrain",
        },
        zoom: {
            label: "Zoom Level",
            tooltip: "Zoom level of the terrain tiles. Each step up doubles the detail and halves the width of a tile. 2 is the whole world; 15 is a few city blocks.",
        },
        nTiles: {
            label: "Tiles per Side",
            tooltip: "Number of tiles along each side of the square terrain area (N x N tiles at the zoom level). More tiles cover a larger area at the same detail, but take longer to load.",
        },
        refresh: {
            label: "Refresh",
            tooltip: "Load the terrain again with the current settings. Tiles that failed to load are tried again.\nUse it after a network error leaves tiles missing.",
        },
        debugGrids: {
            label: "Debug Grids",
            tooltip: "Draw an outline of each terrain tile, high above the ground.\nGreen: map image tiles.\nBlue: elevation tiles.\nGray: inactive tiles.",
        },
        elevationScale: {
            label: "Elevation Scale",
            tooltip: "Scale factor for the elevation data. 1 is normal, 0.5 is half height, 2 is double height",
        },
        terrainOpacity: {
            label: "Terrain Opacity",
            tooltip: "Opacity of the terrain, from 0 (fully transparent) to 1 (fully opaque). It also fades the 3D building tiles.",
        },
        textureDetail: {
            label: "Texture Detail",
            tooltip: "Multiplier for the detail of the map images. 1 is normal. 2 loads finer tiles, which means more downloads; 0.5 loads coarser tiles.\nUsed only when Dynamic Subdivision is on.",
        },
        elevationDetail: {
            label: "Elevation Detail",
            tooltip: "Multiplier for the detail of the elevation data. 1 is normal. 2 loads finer tiles, which means more downloads; 0.5 loads coarser tiles.\nUsed only when Dynamic Subdivision is on.",
        },
        disableDynamicSubdivision: {
            label: "Disable Dynamic Subdivision",
            tooltip: "Disable dynamic subdivision of terrain tiles. Freezes the terrain at the current level of detail. Useful for debugging.",
        },
        dynamicSubdivision: {
            label: "Dynamic Subdivision",
            tooltip: "On: load terrain tiles at the detail that each view needs, from the whole globe down to street level.\nOff: load a fixed square of tiles set by Latitude, Longitude, Zoom Level and Tiles per Side.\nIt stays on while 3D Buildings is on.",
        },
        showBuildings: {
            label: "3D Buildings",
            tooltip: "Show 3D building tiles from Google Photorealistic or Cesium OSM Buildings. The tiles load from the provider and use your 3D tile quota.\nGoogle Photorealistic tiles replace the terrain. Cesium OSM buildings are drawn on top of it.\nTurning it on also turns on Dynamic Subdivision and Use Ellipsoid Earth Model.",
        },
        buildingEdges: {
            label: "Building Edges",
            tooltip: "Draw the edges of the 3D building tiles as lines. Used only with Cesium OSM Buildings.",
        },
        oceanSurface: {
            label: "Ocean Surface (Beta)",
            tooltip: "Draw a translucent blue water surface at mean sea level (the EGM96 geoid) where the elevation data is no more than 2 m above sea level.\nShown only while 3D Buildings shows Google Photorealistic tiles. Experimental.",
        },
        buildingsSource: {
            label: "Buildings Source",
            tooltip: "Provider of the 3D building tiles.\nGoogle Photorealistic: photographic 3D tiles of the ground and buildings. They replace the terrain.\nCesium OSM Buildings: plain building shapes from OpenStreetMap, drawn on top of the terrain.",
        },
        buildingMaterial: {
            label: "Building Material",
            tooltip: "Surface style of the 3D building tiles.\nPhoto: the original photo texture.\nFlat: one plain color (Building Flat Color).\nHalf-photo: the photo texture at 60% brightness.\nIt applies only to tiles that load after the change. Turn 3D Buildings off and on to restyle all tiles.",
            modes: {
                photo: "Photo",
                flat: "Flat",
                halfPhoto: "Half-photo",
            },
        },
        buildingFlatColor: {
            label: "Building Flat Color",
            tooltip: "Color of the 3D building tiles when Building Material is Flat. The default depends on the source: warm concrete for Google Photorealistic, neutral gray for Cesium OSM.\nIt applies only to tiles that load after the change.",
        },
        useEllipsoid: {
            label: "Use Ellipsoid Earth Model",
            tooltip: "On: the Earth is the WGS84 ellipsoid, which is accurate. Off: the Earth is a sphere, the legacy model.\nIt stays on while 3D Buildings is on, because the building tiles need it.",
        },
        layer: {
            label: "Layer",
            tooltip: "Image layer to use from the current Map Type. Most map types have only one layer. A change loads the map images again.",
        },
    },

    displayTrack: {
        folder: {
            tooltip: "How this track is drawn: its line, color and width, a wall down to the ground, and a contrail.\nHover over the title to highlight the track line in white",
        },
        visible: {
            label: "Show Track Line",
            tooltip: "Show or hide the line of this track, and its wall. The object on the track and the contrail do not change.\nOff greys the rows that change only the line",
        },
        extendToGround: {
            label: "Extend To Ground",
            tooltip: "Draw a see-through wall, with vertical lines, from the track down to the ground. Poly Color sets its color",
        },
        displayStep: {
            label: "Display Step",
            tooltip: "Frame step between displayed track points (1 = every frame)",
        },
        contrail: {
            label: "Contrail",
            tooltip: "Show a contrail ribbon behind this track, adjusted for wind",
            folderTooltip: "A contrail ribbon behind this track that drifts and spreads with the wind.\nThe check box in the title turns it on",
        },
        contrailSecs: {
            label: "Contrail Secs",
            tooltip: "Duration of the contrail in seconds",
        },
        contrailWidth: {
            label: "Contrail Width m",
            tooltip: "Maximum width of the contrail ribbon in meters",
        },
        contrailInitialWidth: {
            label: "Contrail Initial Width m",
            tooltip: "Width of the contrail at the exhaust point in meters",
        },
        contrailRamp: {
            label: "Contrail Ramp m",
            tooltip: "Distance over which the contrail width ramps up in meters",
        },
        contrailSpread: {
            label: "Contrail Spread m/s",
            tooltip: "Rate at which the contrail spreads outward in m/s",
        },
        lineColor: {
            label: "Line Color",
            tooltip: "Color of the track line",
        },
        colorMode: {
            label: "Color Mode",
            tooltip: "Color a sonde track by a gradient over its measured temperature, altitude or pressure — or Flat to use the Line Color",
        },
        polyColor: {
            label: "Poly Color",
            tooltip: "Color of the wall that Extend To Ground draws below the track",
        },
        gotoTrack: {
            label: "Go to Track",
            tooltip: "Move the main view camera to 200 m above this track's position at the current frame, looking down at it",
        },
    },

    ptzUI: {
        panAz: {
            label: "Pan (Az)",
            tooltip: "Direction the camera points, in degrees clockwise from true north (0 = north, 90 = east).\nWith Relative Heading on, it is measured from the heading of the camera's track instead.",
        },
        pan360: {
            label: "Use 0-360 for Pan",
            tooltip: "Show the Pan (Az) slider as a 0-360 compass bearing instead of " +
                "-180 to +180.\n\nThis only changes how the angle is WRITTEN - 270 and " +
                "-90 are the same direction, and everything else in Sitrec is unaffected " +
                "either way. Typing a value above 180 into Pan ticks this automatically, " +
                "so the number you typed is the number you keep.",
        },
        tiltEl: {
            label: "Tilt (El)",
            tooltip: "Angle of the camera above the local horizon, in degrees.\n0 = level, 89 = almost straight up, -89 = almost straight down.",
        },
        zoomFov: {
            label: "VFOV (deg)",
            tooltip: "Camera VERTICAL field of view in degrees, across the full height of the " +
                "frame.\n\nThis is the value the camera actually stores; HFOV below is this " +
                "angle read through the aspect ratio.",
        },
        hfov: {
            label: "HFOV (deg)",
            tooltip: "Camera HORIZONTAL field of view in degrees, across the full width of the " +
                "frame.\n\nDerived from VFOV and the aspect ratio below — editing it sets VFOV " +
                "to match. An HFOV means nothing without saying what frame it spans, which is " +
                "what the aspect ratio is for.",
        },
        focal35: {
            label: "35mm Equiv (mm)",
            tooltip: "The lens that would give this field of view on a 36x24mm full-frame " +
                "camera.\n\nMeasured across the frame's LONG axis, so the number only moves if " +
                "the frame was actually cropped. A camera shooting 3:2 stills and 16:9 video " +
                "cuts the top and bottom off the same sensor through the same lens, and reports " +
                "the same number for both; so does turning the camera to shoot portrait, which " +
                "crops nothing at all. Editing it sets HFOV and VFOV to match.",
        },
        lens: {
            label: "Lens (EXIF)",
            tooltip: "The real focal length and lens recorded by the camera in the imported " +
                "photo, straight from its EXIF.\n\nThis is the TRUE focal length on that " +
                "camera's sensor, not a 35mm equivalent - on a full-frame body the two match, " +
                "on a smaller sensor the equivalent above will be the longer number. Hidden " +
                "when no photo with lens metadata is loaded.",
        },
        aspect: {
            label: "Aspect Ratio",
            tooltip: "Width divided by height of the frame that VFOV and HFOV are quoted " +
                "against.\n\nWith Lock Aspect on and a video loaded, this is the video's shape, " +
                "shown with its own pixel dimensions. With Lock Aspect on and no video, it is " +
                "the pinned value. With Lock Aspect off, it is taken from the view pane, which " +
                "changes when you resize the window.",
        },
        lockAspect: {
            label: "Lock Aspect",
            tooltip: "Hold the aspect ratio fixed instead of letting it follow the view pane, " +
                "so HFOV stays put when the window is resized.\n\nLoading a video turns this on " +
                "at the video's aspect, because the video defines the frame. Turn it off to " +
                "quote HFOV against the view pane instead. Turning it on again locks to the " +
                "video's aspect if a video is loaded, and to the view pane's current aspect if " +
                "not.\n\nThis is separate from Match Video Aspect, which changes how the 3D is " +
                "RENDERED rather than what the FOV numbers mean.",
        },
        roll: {
            label: "Roll",
            tooltip: "Rotation of the camera around its line of sight, in degrees. 0 keeps the horizon level.\nUsed when Camera Heading is Manual or To Target.",
        },
        xOffset: {
            label: "xOffset",
            tooltip: "Turn the rendered look view left or right by this angle, in degrees. Positive turns it right.\nUse it to line up a target that is not at the center of the video frame.\nOnly the picture moves: the camera's line of sight does not change.",
        },
        yOffset: {
            label: "yOffset",
            tooltip: "Turn the rendered look view up or down by this angle, in degrees. Positive turns it down.\nUse it to line up a target that is not at the center of the video frame.\nOnly the picture moves: the camera's line of sight does not change.",
        },
        nearPlane: {
            label: "Near Plane (m)",
            tooltip: "Camera near clipping plane distance in meters, sometimes useful for very close objects, or to exclude near-field objects from the frustum",
        },
        lockForward: {
            label: "Lock Forward Vector",
            tooltip: "When the camera moves, keep it pointing in the same direction in space.\nPan, Tilt and Roll change to match, so the view of the sky does not change.\nManual heading only, and not with Relative Heading.",
        },
        relative: {
            label: "Relative Heading",
            tooltip: "Measure Pan (Az) from the heading of the camera's track, instead of from true north.\nPan 0 then looks forward along the track, and Pan 90 looks to the right. Tilt is still measured from the horizon.",
        },
        satellite: {
            label: "Satellite Mode",
            tooltip: "Steer the camera in screen space, with no gimbal lock when it looks nearly straight up or down.\nDragging in the look view turns the view around the screen axes. Pan, Tilt and Roll are hidden, and Rotation is shown.\nUse it for satellite tracking and other steep camera angles.",
        },
        rotation: {
            label: "Rotation",
            tooltip: "Turn the view around the camera's line of sight, in degrees. Shown only in Satellite Mode.\nWhen you turn Satellite Mode off, this rotation becomes part of Roll.",
        },
    },

    nodes3dObject: {
        folder: {
            tooltip: "Settings for this 3D object: its model or geometry, size, material and visibility.\nThe check box in the title shows or hides the object",
        },
        material: {
            tooltip: "Surface settings of this object: shading type, color, opacity and more.\nFor a 3D model, this folder shows only when Apply Material is on",
        },
        lights: {
            tooltip: "The lights that come with this 3D model. Each folder holds the settings of one light",
        },
        // Labels for the geometry and material parameter keys that a plain split of the key
        // would get wrong or leave unclear. Other keys are split at their capitals.
        paramLabels: {
            rotateX: "Rotate X°",
            rotateY: "Rotate Y°",
            rotateZ: "Rotate Z°",
            material: "Material Type",
            ior: "Index of Refraction",
        },
        // A size parameter's label: its dimensions are meters in every sitch.
        sizeParamLabel: "{{label}} (m)",
        deleteObject: {
            label: "Delete Object",
            tooltip: "Remove this object from the sitch. Its track, if it has one, stays",
            confirm: "Delete object \"{{name}}\"?",
        },
        showTrackMenu: {
            label: "Show Track Menu",
            tooltip: "Open the menu of the track this object moves along",
        },
        meshDetail: {
            label: "Mesh Detail",
            tooltip: "How many segments the shape is made of. More segments look smoother and draw more slowly",
        },
        modelOrGeometry: {
            label: "Model or Geometry",
            tooltip: "Select whether to use a 3D Model or a generated geometry for this object",
        },
        model: {
            label: "Model",
            tooltip: "Select a 3D Model to use for this object",
        },
        displayBoundingBox: {
            label: "Display Bounding Box",
            tooltip: "Display the bounding box of the object with dimensions",
        },
        forceAboveSurface: {
            label: "Force Above Surface",
            tooltip: "Force the object to be fully above the ground surface",
        },
        forceAboveSurfaceAlongLOS: {
            label: "Raise Toward Camera",
            tooltip: "When forcing the object above the surface, slide it along the line "
                + "from the camera instead of lifting it straight up. This keeps the object "
                + "on the same line of sight, so it stays at the same point in the camera's "
                + "view and only its range changes. Use it for tracks that were fitted to "
                + "lines of sight, where the direction is measured and the range is not. "
                + "Falls back to lifting straight up when the sightline is too flat to help.",
        },
        hideOutsideTrackData: {
            label: "Hide Outside Track Data",
            tooltip: "Hide the object on frames before its track's first data point and after "
                + "its last. Without this, the object continues in a straight line from its first "
                + "or last two data points (extrapolated), so a track that covers only part of the "
                + "sitch shows the object where there is no data.",
        },
        exportToKML: {
            label: "Export to KMZ with Track",
            tooltip: "Export this object as a KMZ file for Google Earth: the object as a 3D model at its "
                + "current position, plus the track it is on, sampled once per second",
        },
        startAnalysis: {
            label: "Start Analysis",
            tooltip: "Cast rays from the camera to find reflection directions",
        },
        gridSize: {
            label: "Grid Size",
            tooltip: "Number of sample points per axis for the reflection grid",
        },
        cleanUp: {
            label: "Clean Up",
            tooltip: "Remove all reflection analysis arrows from the scene",
        },
        flock: {
            label: "Flock",
            tooltip: "Draw this object as a flock of birds that follows its track in formation, "
                + "in place of the one object. Each bird is this object's model or geometry.",
            folder: "Flock Parameters",
            folderTooltip: "Settings of the flock: the species, the number of birds, the formation and how the birds move.\nShown only when Flock is on",
            species: {
                label: "Species",
                tooltip: "Set the flock up as one kind of bird flies, from field measurements where there are any. "
                    + "It is a place to start: change any control and this goes back to Custom. It does not set the "
                    + "number of birds. It cannot set the size of a bird or the speed of the flock: those are this "
                    + "object's geometry and its track.",
            },
            count: {
                label: "Number of Birds",
                tooltip: "How many birds are in the flock. One bird flies a wavering path about the track. "
                    + "Push against the top of the slider to extend its range.",
            },
            formation: {
                label: "Formation",
                tooltip: "V, Echelon (one arm of a V) and Line Astern (one behind another) have a leader. "
                    + "Line Abreast is side by side. Irregular Front is a broad, shallow band with a ragged "
                    + "edge, as gulls, waders and ducks fly. Cluster is a rounded mass, as starlings and pigeons fly. "
                    + "Murmuration is a starling flock over its roost, simulated bird by bird: it turns, stretches, "
                    + "and changes shape by itself, about this object's position.",
            },
            vNess: {
                label: "V-ness",
                tooltip: "How closely the birds hold the lines of the formation. "
                    + "1 is a clean formation. 0 is a loose cluster with no lines.",
            },
            vAngle: {
                label: "V Angle",
                tooltip: "Angle between the two arms of the V, in degrees. It varies widely in real flocks: "
                    + "one radar study of 54 flocks of Canada geese measured 72 degrees, give or take 23.",
            },
            asymmetry: {
                label: "Asymmetry",
                tooltip: "How unequal the two arms are. 0 is an even V. Towards 1 the right arm is longer, "
                    + "and towards -1 the left: a J shape. In geese the even V is the least common shape, "
                    + "then the J, and the Echelon is the most common. "
                    + "For an Echelon only the sign is used, to choose the side.",
            },
            shapeDrift: {
                label: "Shape Drift",
                tooltip: "How freely the flock changes shape as birds change places. At 0 the two arms keep "
                    + "their lengths. Above 0, a leader that drops back may join the other arm, and a bird at "
                    + "the end of one arm may cross to the other, so a V becomes a J and a J an Echelon. "
                    + "The Asymmetry is the shape the flock keeps coming back to. Real flocks of geese do this.",
            },
            groupSize: {
                label: "Birds per Formation",
                tooltip: "The most birds in one line formation. A larger flock flies as several formations "
                    + "near each other, as large flocks of geese do.",
            },
            frontDepth: {
                label: "Front Depth",
                tooltip: "Depth of the front from its leading edge to its trailing edge, as a fraction of its width",
            },
            elongation: {
                label: "Elongation",
                tooltip: "Length of the cluster's long horizontal axis as a multiple of its short one. "
                    + "Starling flocks measure about 2.",
            },
            longAxis: {
                label: "Long Axis (deg)",
                tooltip: "Direction of the cluster's long axis, in degrees from the direction of flight. 0 is along "
                    + "the flight and 90 is across it. In starling flocks it has no link to the direction of flight.",
            },
            spacing: {
                label: "Spacing (m)",
                tooltip: "Distance between neighboring birds, in meters. In a V or an Echelon it is measured across "
                    + "the direction of flight, where birds keep about one wingspan apart. "
                    + "The V Angle then sets how far behind each bird is.",
            },
            looseness: {
                label: "Looseness",
                tooltip: "How far each bird wanders from its place, as a fraction of the spacing",
            },
            snaking: {
                label: "Snaking",
                tooltip: "How far the line swings from side to side, as a fraction of the spacing. Each bird "
                    + "follows the path of the bird ahead, so the swing travels down the line from front to back.",
            },
            wanderPeriod: {
                label: "Wander Period (s)",
                tooltip: "Time, in seconds, that a bird takes to wander away from its place and back",
            },
            verticalSpread: {
                label: "Vertical Spread",
                tooltip: "Height of the flock as a fraction of its shorter horizontal dimension. Real flocks are "
                    + "thin: starling flocks measure 0.36.",
            },
            placeChange: {
                label: "Change of Place (s)",
                tooltip: "How often each bird changes place, in seconds. A bird trades places with the bird next to "
                    + "it: in a formation with a leader, with the bird ahead of it, which is how the lead changes "
                    + "hands. Ibises in a V were measured to change places about once every 45 seconds. 0 means the birds never change places.",
            },
            wheeling: {
                label: "Wheeling (m)",
                tooltip: "How far the whole flock swings away from the track, in meters. "
                    + "Over a fixed point the flock circles it. Along a moving track it weaves from side to side.",
            },
            wheelPeriod: {
                label: "Wheel Period (s)",
                tooltip: "Time, in seconds, for one full swing or circle of the wheeling",
            },
            turnLag: {
                label: "Turn Lag (s)",
                tooltip: "How long the formation takes to turn to a new direction of flight, in seconds. "
                    + "Small for geese, whose V points where they fly. Large for starlings and pigeons, whose "
                    + "flock keeps its arrangement through a turn, so that birds at the front come out of it on the side.",
            },
            murmurationSpeed: {
                label: "Cruise Speed (m/s)",
                tooltip: "Speed at which the birds of the murmuration fly. The starling flocks measured over "
                    + "their roost in Rome flew at 7 to 15 m/s.",
            },
            roostRadius: {
                label: "Roost Radius (m)",
                tooltip: "How far from this object the murmuration ranges, in meters. Birds that fly beyond it "
                    + "turn back, and the flock sweeps around this area.",
            },
            simulating: "working out the flock: {{percent}}%",
            failed: "could not work out the flock; change a setting to try again",
            seed: {
                label: "Random Seed",
                tooltip: "Changes the random arrangement and motion. The same seed always gives the same flock.",
            },
        },
    },

    trackingOverlay: {
        folderTooltip: "Track an object by hand. Ctrl-click (Cmd-click on Mac) the video to place a keyframe at the current frame. Drag a keyframe to move it, or Alt-click (Option-click on Mac) it to delete it. A curve joins the keyframes.\nTraverse > LOS Source > Camera + Object Track uses this curve as the line of sight.",
        showTracking: {
            label: "Show Tracking",
            tooltip: "Show or hide the manual tracking keyframes and curve on the video. While they are hidden, you cannot add or edit keyframes.",
        },
        reset: {
            label: "Reset",
            tooltip: "Reset manual tracking to an empty state, removing all keyframes and draggable items",
        },
        limitAB: {
            label: "Limit In/Out to Tracked Range",
            tooltip: "Set the In/Out (A-B) range to the span of the tracking keyframes, plus a 10% margin at each end. This keeps playback and analysis near the frames you actually tracked, instead of running over the whole clip where the curve is only extrapolated. Turn it off to restore the full clip.",
        },
        curveType: {
            label: "Curve Type",
            tooltip: "How the curve runs between keyframes:\nSpline: natural cubic spline.\nSpline2: centripetal Catmull-Rom spline.\nLinear: straight lines.\nPerspective: uses the first 3 keyframes, for an object that moves in a straight line at constant speed, seen in perspective. Choosing it also sets Traverse > LOS Traverse Method to Perspective and runs Minimize Ground Speed.\nWith 2 keyframes, every type is a straight line.",
        },
        minimizeGroundSpeed: {
            label: "Minimize Ground Speed",
            tooltip: "Set Tgt Start Dist to the value that makes the Perspective traverse move the shortest straight-line distance between the first and last keyframes. That is the lowest average speed.\nNeeds 3 or more keyframes. Use it with Curve Type Perspective and Traverse > LOS Source Camera + Object Track.",
        },
        minimizeAirSpeed: {
            label: "Minimize Air Speed",
            tooltip: "Like Minimize Ground Speed, but it first subtracts how far the target wind carries the object between the first and last keyframes. That gives the lowest average air speed.",
        },
        usePointB: {
            label: "Use Size Point",
            tooltip: "Add a second point to each keyframe, 20 pixels away to start with. Drag it to the far side of the object, so the pair spans a known real-world length. The angle the two points subtend then gives the range.\n\nWhere the two overlap, hold shift to drag the size point rather than the tracked point.",
        },
        abSize: {
            tooltip: "The real-world distance between the tracked point and the size point on the object.\n\nAssumes that line is side-on to the camera. A line angled away from the camera looks shorter than it is, which reads as a longer range and so a higher speed.",
        },
        sizeRange: {
            label: "Size Range",
            tooltip: "Distance to the tracked point at each keyframe where a size point has been placed, derived from the angle the two points subtend and the Assumed Size.",
        },
        sizeSpeed: {
            label: "Size Speed",
            tooltip: "Speed between the first and last measured keyframes, from their size-derived positions. Needs a size point placed on at least two keyframes.\n\nThis is a straight first-to-last average, and it does not use the Perspective curve fit.",
        },
        setStartDistanceFromSize: {
            label: "Set Start Dist from Size",
            tooltip: "Set Tgt Start Dist to the size-derived range at the first measured keyframe.\n\nIn Perspective mode this is all the calibration needed: the three keyframe positions already fix every depth ratio, leaving the start distance as the only free parameter.",
        },
    },

    cameraFrustum: {
        frustumGroundQuad: {
            label: "Frustum Ground Quad",
            tooltip: "Show the camera frustum intersection with the ground",
        },
        videoInFrustum: {
            label: "Video in Frustum",
            tooltip: "Show the current video frame as a flat picture inside the frustum, at Video Distance from the camera.\nNeeds a loaded video",
        },
        videoOnGround: {
            label: "Video on Ground",
            tooltip: "Project the current video frame onto the ground, where the corners of the camera view meet the terrain or the globe.\nIt is hidden when a corner of the view misses the ground. Needs a loaded video",
        },
        groundVideoInLookView: {
            label: "Ground Video in Look",
            tooltip: "Also show the ground-projected video in the look view. Off = main view only.\nUsed only when Video on Ground is on",
        },
        matchVideoAspect: {
            label: "Match Video Aspect",
            tooltip: "Crop the look view to match the video's aspect ratio, and adjust the frustum accordingly",
        },
        videoOpacity: {
            label: "Video Opacity",
            tooltip: "Opacity of the projected video: 0 = invisible, 1 = opaque.\nApplies to Video in Frustum and Video on Ground",
        },
        videoDistance: {
            tooltip: "Distance from the camera to the picture that Video in Frustum draws.\nUsed only when Video in Frustum is on",
        },
        frustumDistance: {
            label: "Frustum Distance",
            tooltip: "Distance from the camera to the far end of the displayed frustum",
        },
        showFrustumDistance: {
            label: "Show Frustum Distance",
            tooltip: "Show a label with the frustum distance at the far end of the frustum",
        },
        frustumColor: {
            label: "Frustum Color",
            tooltip: "Color of the frustum edges, sides and ground quad",
        },
        showFrustumEdges: {
            label: "Show Frustum Edges",
            tooltip: "Show the lines along the edges of the frustum. Always on when the sides are hidden",
        },
        shadedFrustum: {
            label: "Show Frustum Sides",
            tooltip: "Fill the four sides of the frustum with a transparent version of the frustum color, shaded lighter on top and darker underneath",
        },
        frustumSidesPercent: {
            label: "Frustum Sides %",
            tooltip: "Opacity of the shaded frustum sides, in percent: 0 = invisible, 100 = opaque.\nUsed only when Show Frustum Sides is on",
        },
    },

    displayName: {
        label: "Name",
        tooltip: "The name shown for this in menus, labels and lists. Changing it does not change anything else",
    },

    measurements: {
        add: {
            label: "Add Measurement",
            tooltip: "Measure the altitude of something, or the distance between two things: the camera, the traverse, a track, a satellite, a 3D object, a pin or a building",
        },
        entry: {
            tooltip: "Click to change, hide or delete this measurement",
            showTooltip: "Show or hide this measurement",
        },
        describe: {
            altitude: "Altitude: {{from}}",
            distance: "Distance: {{from}} → {{to}}",
        },
        kinds: {
            camera: "Camera",
            traverse: "Traverse",
            track: "Track",
            satellite: "Satellite",
            object: "3D Object",
            pin: "Pin",
            building: "Building",
            node: "Other",
        },
        dialog: {
            addTitle: "Add Measurement",
            type: "Measurement Type",
            altitude: "Altitude",
            altitudeHint: "Height above the ground and above mean sea level",
            distance: "Distance",
            distanceHint: "Straight-line distance between two things",
            from: "From",
            to: "To",
            point: "Measure the altitude of",
            nothingToPick: "There is nothing else in this sitch to measure to",
            missing: "{{id}} (not found)",
            filterPlaceholder: "Type a name or number to filter the list",
            moreItems: "{{count}} more. Type in the box above to find them.",
            label: "Label",
            labelPlaceholder: "Optional text shown above the value",
            color: "Color",
            lineWidth: "Line Width",
            units: "Units",
            unitsDefault: "Sitch units",
            unitsMeters: "Meters",
            unitsKilometers: "Kilometers",
            unitsFeet: "Feet",
            unitsMiles: "Statute Miles",
            unitsNautical: "Nautical Miles",
            show: "Show",
            add: "Add",
            ok: "OK",
            cancel: "Cancel",
            delete: "Delete",
        },
    },

    labels3d: {
        measurements: {
            label: "Measurements in Main",
            tooltip: "Show measurement arrows and their labels, such as distances and altitudes, in the main 3D view.",
        },
        measurementsInLook: {
            label: "Measurements in Look",
            tooltip: "Show measurement arrows and their labels, such as distances and altitudes, in the look/camera view.",
        },
        labelsInMain: {
            label: "Labels in Main",
            tooltip: "Show track/object labels in the main 3D view",
        },
        labelsInLook: {
            label: "Labels in Look",
            tooltip: "Show track/object labels in the look/camera view",
        },
        featuresInMain: {
            label: "Pins in Main",
            tooltip: "Show feature markers (pins) in the main 3D view",
        },
        featuresInLook: {
            label: "Pins in Look",
            tooltip: "Show feature markers in the look/camera view",
        },
    },

    // Show > Lat/Lon Grid (src/LatLonGrid.js): the latitude/longitude graticule over the globe.
    latLonGrid: {
        inMain: {
            label: "Lat/Lon Grid in Main",
            tooltip: "Show a latitude/longitude grid over the globe in the main 3D view. Lines are 10° apart; the equator and prime meridian are brighter.\nIt is drawn over the terrain, but not on the far side of the Earth.",
        },
        inLook: {
            label: "Lat/Lon Grid in Look",
            tooltip: "Show a latitude/longitude grid over the globe in the look/camera view. Lines are 10° apart; the equator and prime meridian are brighter.\nIt is drawn over the terrain, but not on the far side of the Earth.",
        },
    },

    // The two-line UTC + local date/time readout overlaid on the look view
    // (src/UIHelpers.js). Only the NOUN is translated: the row name is composed at
    // runtime as "<thing> in <view>", because the overlay follows whichever view
    // the sitch attached it to.
    timeDisplay: {
        thing: "Time Display",
        tooltip: "Show the UTC and local date/time readout overlaid on this view",
    },

    // Short labels for the per-view header menus (src/ViewUIBarMenus.js). These name the SAME
    // controllers as the long-form entries elsewhere in this file — a header row is a mirror of
    // a global-menu row, not a second control. They can be shorter because the menu you opened
    // already names the view: "Measurements in Look" is just "Measurements" under Look. The
    // tooltip is inherited from the original control, so the full explanation is still there.
    // Keys are slot names from VIEW_UIBAR_MENUS, shared across views where the meaning is.
    viewMenus: {
        freeLook: "Free Look",
        measurements: "Measurements",
        labels: "Labels",
        features: "Pins",
        los: "Lines of Sight",
        currentLos: "Current LOS",
        frustum: "Camera Frustum",
        showTracks: "Show Tracks",
        showSatellites: "Satellites",
        extendToGround: "Extend Tracks to Ground",
        mainViewScale: "Object Scale",
        allTracks: "All Tracks",
        compass: "Compass",
        timeDisplay: "Time Display",
        northUp: "North Up",
        yCompress: "Y-Compress",
        fov: "Field of View",
        starNames: "Star Names",
        onlyPlanets: "Only Label Planets",
        equatorialGrid: "Equatorial Grid",
        latLonGrid: "Lat/Lon Grid",
        celestialVectors: "Celestial Vectors",
        overlayTransparency: "Transparency %",
        overlayKeyColor: "Key Color",
        overlayKeyTolerance: "Key Tolerance %",
        groundVideo: "Ground Video",
        zoom: "Zoom %",
        rotation: "Rotation",
        simInfo: "Readout",
        videoInfo: "Readout",
        grid: "Grid",
        annotations: "Annotations",
        exifPanel: "EXIF / Metadata",
        vfrFix: "VFR Fix",
        removeVideo: "Remove Video",
        effects: "Enable Effects",
        brightness: "Brightness",
        contrast: "Contrast",
        mask: "Enable Mask",
        maskEdit: "Edit Mask",
        maskShow: "Show Mask",
        folders: {
            nightSky: "Night Sky",
            videoOverlay: "Video Overlay",
            adjustments: "Adjustments",
            masking: "Masking",
        },
    },

    // Tooltips for the view header ICONS, keyed by slot. Only for an icon that does something
    // its control's own label does not describe — a toggle icon borrows the control's wording.
    viewIcons: {
        declutter: "Declutter — hide every overlay in this view; press again to bring back exactly the ones that were showing",
        zoom: "Video zoom 100% — press again to go back to the previous zoom",
        overlayTransparency: "Video overlay — click to switch it off and back on; hover for its transparency",
    },

    traverseAnalysis: {
        analyzeButton: "Analyze Traverse Methods...",
    },

    fireballs: {
        menuItem: "Recorded fireballs…",
        menuTooltip: "Open the Recorded fireballs dialog. Import a GMN (Global Meteor Network) trajectory summary, find the fireballs near a time and place, and load the observed path of one into the sitch.",
        close: "Close",
        limits: "Only imported records are searched. GMN coverage varies with station location, night, weather and successful multi-station detection. No match does not rule out a meteor. Magnitudes are absolute at 100 km, not brightness at your camera. Saturation can affect bright events.",
        track: {
            jumpToStart: "Jump to observed start",
            jumpToStartTooltip: "Go to the time of the first observed sample of the fireball, and pause. If that time is outside the timeline, the sitch start time moves to it.",
            jumpToEstimatedPeak: "Jump to estimated peak",
            jumpToMeasuredPeak: "Jump to measured peak",
            peakUnavailable: "Peak time unavailable",
            peakTooltip: "{{label}}.\nGo to the peak time, and pause. If that time is outside the timeline, the sitch start time moves to it.",
            sourceAndLimits: "Fireball source & limits",
            sourceAndLimitsTooltip: "Show where this fireball record comes from, how its path and peak time were found, and the limits of the data.",
        },
        details: {
            title: "Fireball {{id}}",
            conventions: "{{network}} · {{license}}. {{pathMethod}}. Heights: meters above WGS84 ellipsoid. UTC timestamps render to milliseconds; printed digits do not establish measurement accuracy. No light curve is synthesized. Positions between samples are interpolated; the marker holds the endpoint outside the observed interval and does not represent continued flight.",
            originalSource: "Original source",
            gmnConventions: "GMN conventions",
            peak: "{{label}}: {{time}}",
            noPeak: "No usable peak time or peak height is supplied.",
        },
        peak: {
            recorded: "Recorded peak UTC",
            brightest: "Brightest measured sample (sampling limited)",
            estimated: "Estimated peak UTC (height fraction × duration; constant speed)",
        },
        browser: {
            title: "Recorded fireballs",
            intro: "Import a GMN daily/monthly summary (.txt), or a sitrec-fireball-v1 JSON with measured samples. Search covers only this file. Download a modest period; maximum import is 100 MB. GMN archives start in December 2018 and are updated; there is no bundled global archive.",
            dailyFiles: "GMN daily files",
            monthlyFiles: "GMN monthly files",
            references: "Source & references",
            importLabel: "Import fireball records",
            sourcePlaceholder: "Exact original GMN .txt download URL (required for summaries)",
            sourceLabel: "Original summary source URL",
            noRecords: "No records imported. Supply the exact original download URL to preserve provenance.",
            fields: {
                utc: "UTC",
                latitude: "Latitude",
                longitude: "Longitude",
                hours: "Time window hours",
                radius: "Radius km",
                faintest: "Faintest absolute magnitude",
            },
            find: "Find nearby records",
            invalidSearch: "Enter valid UTC ending in Z, coordinates and nonnegative windows.",
            matches: "{{count}} matches. Records with unknown brightness are included. Distance is to the nearest supplied sample, not visibility or distance to every point of the interpolated path. Showing at most 100; narrow filters for more.",
            match: "{{id}} · {{time}} · abs mag {{magnitude}} · {{distance}} km · Δ {{hours}} h",
            unknownMagnitude: "unknown",
            loadPath: "Load observed path",
            loadFinished: "Import request finished. If accepted, the path appears under Contents → Fireball with start/peak and source controls.",
            sourcePeakMethod: "Source / peak method",
            tooLarge: "Import exceeds 100 MB; choose a daily or smaller summary.",
            reading: "Reading records…",
            needGMNURL: "Provide the exact HTTPS GMN .txt download URL, not an archive directory.",
            noTrajectories: "No usable trajectories in this file.",
            imported: "{{count}} records; {{rejected}} rejected. UTC {{first}} to {{last}}. Sample extent lat {{latMin}}…{{latMax}}, lon {{lonMin}}…{{lonMax}} (not a surveyed coverage boundary).",
        },
        errors: {
            notGMN: "Not a GMN trajectory summary (missing column header).",
            missingColumn: "Missing GMN column: {{column}}",
            utcLayout: "Unsupported GMN UTC column layout.",
            provenance: "Fireball needs ID, network, HTTPS source URL and license.",
            altitudeReference: "Altitude must explicitly use WGS84 ellipsoid, meters.",
            pathMethod: "Specify the path measurement/interpolation method.",
            twoSamples: "At least two samples required.",
            endpointSamples: "Endpoint summaries must have exactly two samples.",
            invalidSample: "Invalid UTC sample, coordinates, height or time order.",
            recordedPeak: "Recorded peak must be UTC within the observed path.",
        },
    },

    losErrorAnalysis: {
        button: {
            label: "Analyze LOS Error…",
            tooltip: "Open a panel that compares the pointing LOS (line of sight) with the bearings to a loaded truth track in the A-B range.\nIt shows the error at the original rate, 10 Hz and 1 Hz, and fits a statistical noise model that you can export.",
        },
        title: "LOS error analysis",
        close: "Close",
        intro: "Compare the selected pointing LOS with platform-to-truth bearings in A–B. Check time alignment first: track errors and timing offsets also contribute to this residual. Analysis stays in this browser.",
        truthTrack: { label: "Truth track", ariaLabel: "LOS error truth track", choose: "Choose a truth track" },
        pointing: { label: "Pointing LOS", ariaLabel: "LOS error pointing source", current: "Current traverse LOS", recorded: "Recorded angles: {{id}}" },
        originalHz: {
            label: "Original Hz override (optional)",
            placeholder: "auto",
            ariaLabel: "Original recording rate override",
            tooltip: "For LOS without recorded timestamps. Use only when the source cadence is known. Recorded attitude timestamps take precedence.",
        },
        modelFamily: { label: "Noise model", ariaLabel: "LOS error model family", operator: "Operator: drift, reaction, correction", ar: "Statistical: Gaussian autoregression" },
        start: "Choose a truth track, then Analyze.",
        analyze: "Analyze",
        needInputs: "Select a loaded truth track and a pointing LOS.",
        fitProgress: "Fitting operator feedback statistics: {{done}} / {{total}} parameter combinations…",
        result: "{{cadenceSource}}. {{hz}} Hz; {{valid}} valid samples; {{excluded}} excluded; {{gaps}} time gaps. LOS: {{los}}. Lower rates select nearest original samples without filtering or new noise draws. If pointing was constructed by aiming at the truth target, this measures that construction rather than independent pointing error.",
        originalRate: "Original",
        comparisonHeading: "Measured errors and fresh synthetic errors",
        plotRate: { label: "Plot samples at", ariaLabel: "LOS error plot rate", unavailable: "{{rate}} (unavailable)" },
        chartsNote: "Solid lines show measurements. Dashed lines at 50% opacity show a fresh realization of the portable model; they are generated automatically and do not replay the measured errors.",
        frameNote: "H/V are angular offsets in a local horizontal/vertical tangent frame, not Euler azimuth/elevation differences. Positive H is to the left of the truth bearing (counter-clockwise seen from above); positive V is up. Bias is the clip mean; σ and correlation are demeaned. Near zenith/nadir, horizontal orientation is ambiguous. 10 Hz and 1 Hz are decimation, so high-frequency error can alias.",
        modelHeading: "Portable statistical noise model",
        operatorExplanation: "Operator model: smooth wandering error accumulates until a notice threshold is crossed; after a reaction delay, a correction slews toward the center with imperfect accuracy. It also supports independent jitter, anisotropy, mean bias and a delay in following the target’s changing bearing. Parameters fit aggregate statistics using independent simulations, not the observed sequence. They are descriptive equivalents, not uniquely identified human reaction times.",
        arExplanation: "This stationary Gaussian autoregressive model estimates amplitude, cross-axis coupling and temporal memory. It does not reproduce operator corrections, non-Gaussian tails or changing regimes exactly. Use the comparisons above to assess the approximation; a new seed generates a different sequence. The calibration rate is part of the model.",
        operatorFit: "Operator fit: {{candidates}} combinations, two calibration seeds each, up to the first 90 seconds. Effective following delay {{delay}} s; motion explains {{explained}}% of demeaned error variance in the delay diagnostic. Clock skew can produce the same signature. At 1 Hz, subsecond reaction details are weakly constrained.",
        shortClip: "Short clip: the portable model estimates bias, amplitude and cross-axis correlation only, with independent Gaussian samples. At least 20 original samples are needed to fit operator behavior or temporal memory.",
        amplitude: "Noise amplitude multiplier",
        amplitudeRange: "Amplitude multiplier must be between 0 and 100.",
        includeBias: "Include measured mean bias",
        seed: { label: "New seed", ariaLabel: "Synthetic noise seed" },
        generateWithSeed: "Generate with seed",
        freshSeed: "Fresh seed",
        exportModel: "Export parameter model",
        importModel: "Import model",
        modelTooLarge: "Model file is too large.",
        exportCSV: "Export synthetic LOS CSV",
        generateFirst: "Generate a fresh realization first.",
        exportNote: "Parameter JSON contains only statistical model parameters and rates. It excludes track geometry, dates, names, original seeds and measured samples. Synthetic CSV includes the current platform and truth positions in ECEF meters and newly generated LOS directions.",
        editParameters: "Edit model parameters (advanced)",
        editorAriaLabel: "LOS statistical model parameters",
        tuning: {
            amplitude: "Notice threshold °",
            driftSpeed: "Wander °/s",
            reactionTime: "Reaction delay s",
            correctionSpeed: "Correction °/s",
            accuracy: "Centering accuracy 0–1",
            trackingDelaySeconds: "Following delay s",
        },
        stationarity: "Stationarity check, successive thirds: radial RMS {{rms}}; H/V means {{means}}. Large changes suggest segmentation instead of one stationary model. Finite clips give uncertain means, tails and long-lag correlations; this is a statistical characterization, not a physical sensor calibration.",
        table: {
            series: "Series / rate",
            count: "N",
            bias: "Bias H / V ° (+ left / + up)",
            sigma: "σ H / V °",
            radialRms: "Radial RMS °",
            radialTails: "Radial p95 / p99 °",
            stepRms: "Step RMS °",
            correlation: "H/V 1 s correlation",
            kurtosis: "H/V excess kurtosis",
            unavailable: "Unavailable: fewer than two samples, or above source rate",
        },
        series: { measured: "Measured", synthetic: "Synthetic", model: "Model" },
        seriesRate: "{{series}} {{rate}}",
        charts: {
            error: "Angular error · {{rate}}",
            time: "Time from first valid sample (s)",
            degrees: "Degrees",
            distribution: "Radial error distribution",
            separation: "Angular separation (°)",
            cumulative: "Cumulative fraction",
            correlation: "Demeaned temporal correlation",
            lag: "Lag (s)",
        },
        data: {
            needInputs: "Choose a pointing LOS and a truth track first.",
            ptsUnavailable: "Recorded LOS timing uses video PTS, but the original timestamp arrays are unavailable.",
            rateTooHigh: "Original rate must be positive and no higher than the scene rate.",
            notEnough: "Not enough overlapping valid pointing and truth samples in A–B.",
            syntheticMismatch: "Synthetic samples do not match the geometry.",
            syntheticInvalid: "Synthetic angular error is too large or geometry is invalid.",
            cadencePTS: "Original attitude PES timestamps paired to video PTS (raw angles; current platform/truth positions)",
            cadenceRecorded: "Original recorded attitude timestamps (raw angle columns; current platform/truth positions)",
            cadenceUser: "User-specified recording cadence, nearest scene frames",
            cadenceScene: "Scene frames; original recording cadence unverified",
        },
        model: {
            twoSamples: "Need at least two valid LOS/truth samples.",
            invalidOperator: "Invalid operator feedback model.",
            invalidModel: "Invalid or unsupported LOS noise model.",
            timesIncrease: "Generation times must increase.",
            rateTooHigh: "This model cannot synthesize a higher recording rate than its calibration rate.",
            operatorTooLarge: "Requested operator realization is too large.",
            syntheticTooLarge: "Requested synthetic realization is too large.",
            delayNeedsGeometry: "A tracking-delay model needs synchronized platform and target geometry.",
            operatorSamples: "Need at least 20 valid samples to estimate operator error.",
            operatorCancelled: "Operator fit cancelled.",
        },
    },

    losFitPhysics: {
        folder: "Physics Fit Results",
        folderTooltip: "Read-only results of the last Global Fit: Physics run. They update when a new fit finishes.",
        model: {
            label: "Model",
            tooltip: "Physics model that the fit used (Traverse > Physics Model).",
        },
        avgError: {
            label: "Avg Error",
            tooltip: "Mean angle, in degrees, between the fitted path and the LOS in the A-B range. Lower is a closer fit.",
        },
        windSpeed: {
            label: "Wind Speed (kt)",
            tooltip: "Wind speed, in knots, that the fit solved for.",
        },
        windFrom: {
            label: "Wind From (\u00B0)",
            tooltip: "Direction that the solved wind comes FROM, in degrees true (0 = north, 90 = east).",
        },
    },

    losFitPlausible: {
        folder: "Minimum Acceleration Fit Results",
        folderTooltip: "Read-only results of the last Global Fit: Minimum Acceleration run.",
        range: {
            label: "Found Range",
            tooltip: "Start range, in nautical miles, that the fit found along the first LOS in the A-B range.",
        },
        speed: {
            label: "Speed Target",
            tooltip: "Target Speed that the fit used as a soft tiebreaker. \"not needed (geometry)\" means the geometry alone picked the range.",
        },
        score: {
            label: "Plausibility (lower=better)",
            tooltip: "Score of the path: a weighted sum of its g-load, turn-rate changes and climb, plus size and wind penalties. Lower is a smoother, more level path. Compare it only between runs on the same clip.",
        },
    },

    misbData: {
        startTime: {
            label: "Start Time",
            tooltip: "Start time for this track, whose file has only relative times. Partial input works, for example '10:30', 'Jan 15' or '2024-01-15T10:30:00Z'.\nLeave it blank to start the track at the sitch start time.",
        },
        filterTooltip: "Fix or remove track points that would need an acceleration above Max G. These points are treated as bad data.",
        enableFilter: {
            label: "Enable Filter",
            tooltip: "Turn on the filter. Each point's acceleration is measured against neighbors at least 0.5 s away, and points above Max G are removed from the track.",
        },
        tryAltitudeFirst: {
            label: "Try Altitude First",
            tooltip: "Before removing a bad point, try replacing only its altitude with a value interpolated from its neighbors.\nThe point stays if that brings it under Max G.",
        },
        maxG: {
            label: "Max G",
            tooltip: "Largest acceleration allowed, in g (1 g = 9.81 m/s²). Points that need more are fixed or removed.",
        },
    },

    positionLLA: {
        aboveGroundLevel: {
            label: "Above Ground Level",
            tooltip: "Altitude is relative to ground level, not sea level. Switching it keeps " +
                "the position and converts the altitude.",
        },
        allowSmallAltitudes: {
            label: "Allow Small Altitudes",
            tooltip: "Let the Alt slider zoom in to very small heights.\n" +
                "When you drag past the left end of the slider, its range gets smaller.\n" +
                "Off: the range stops at 100 ft, and the slider moves in steps of 1 ft.\n" +
                "On: the range can go down to 1 ft, with very small steps.\n" +
                "A value that you type is not rounded.",
        },
        lookup: {
            label: "Lookup",
            tooltip: "Enter coordinates in any format (decimal, degrees/minutes/seconds, N/S/E/W, MGRS, lat/lon/altitude, or ECEF x,y,z in meters) or a place name to move to",
        },
        geolocate: {
            label: "Geolocate from IP Address",
            tooltip: "Set this position to your approximate location, 3 m above the ground.\nThe location comes from your internet (IP) address, through an online lookup service",
        },
        goTo: {
            label: "Go To the above position",
            tooltip: "Move the main view camera to 100 km above this position, looking down at it",
        },
    },

    controllerVarious: {
        stopAt: {
            label: "Stop At",
            tooltip: "Stop the camera target movement at this frame, even if the target track continues. This is useful for simulating the loss of lock on a moving target. Set to 0 to disable.",
        },
        horizonMethod: {
            label: "Horizon Method",
            tooltip: "How the tilt of the horizon in the look view is worked out from the jet's attitude.\nHuman Horizon: the tilt that a person in the jet sees, from the jet's pitch and roll and the camera azimuth and elevation.\nHorizon Angle: a formula that uses only the jet's pitch and roll and the camera azimuth",
        },
        lookFOV: {
            label: "Look FOV",
            tooltip: "Vertical field of view of the look camera, in degrees",
        },
        celestialObject: {
            label: "Celestial Object",
            tooltip: "Name of the body or star that the camera points at, for example Moon, Venus, Jupiter or Sirius.\nUsed only when Camera Heading is Celestial Lock",
        },
    },

    trackingWobble: {
        folder: "Tracking Wobble",
        folderTooltip: "Add a simulated hand-tracking error to the look camera, on top of any Camera Heading source.\nThe aim drifts off the target, and the operator brings it back late and not exactly.\nTurn it on with the checkbox in the folder title.",
        enabled: {
            label: "Tracking Wobble",
            tooltip: "Simulate manual tracking: the camera drifts off the target and is imperfectly re-centered",
        },
        amplitude: {
            label: "Amplitude (deg)",
            tooltip: "How far off-center (degrees) the drift gets before the operator reacts",
        },
        driftSpeed: {
            label: "Drift Speed (deg/s)",
            tooltip: "Typical speed, in degrees per second, at which the aim wanders off the target.\nThe drift direction changes at random about once a second.",
        },
        reactionTime: {
            label: "Reaction Time (s)",
            tooltip: "Operator delay between noticing the drift and starting the correction",
        },
        correctionSpeed: {
            label: "Recenter Speed (deg/s)",
            tooltip: "How fast the operator slews back toward the target",
        },
        accuracy: {
            label: "Recenter Accuracy",
            tooltip: "1 = corrections stop dead-center; lower values leave residual error",
        },
        seed: {
            label: "Random Seed",
            tooltip: "Change for a different (but still repeatable) wobble pattern",
        },
    },

    cameraState: {
        folder: "Camera Data",
        folderTooltip: "Per-frame camera state from a dropped camera data file (CSV): sensor mode, focal length, digital zoom and polarity.\nShown only when such a file is loaded.",
        source: {
            label: "Source",
            tooltip: "The camera data file these rows came from. The sitch saves the rows, so a file that has only camera data is not uploaded.",
        },
        rows: {
            label: "Rows",
            tooltip: "Each row is a change of mode, focal length, digital zoom or polarity, and holds until the next row's frame.",
            value: "{{rows}} rows, frames {{first}} to {{last}}",
        },
        modes: {
            label: "Modes",
            tooltip: "Each sensor mode in the data and the band it is drawn in: IR for a mode that starts with IR, MWIR or LWIR, otherwise EO (visible).",
        },
        driveLookView: {
            label: "Drive Look View",
            tooltip: "Use this data, frame by frame, for the look view's band (infrared or visible light), the lens step and polarity of the thermal sensor, and the mode, focal length and digital zoom on the MX overlay. The field of view does not follow the data: it comes from the Camera FOV setting. Off: they keep their saved settings.",
        },
        remove: {
            label: "Remove Camera Data",
            tooltip: "Remove these rows from the sitch. Drop the file again to get them back.",
        },
        noNode: "Can't use camera data from \"{{file}}\": this sitch has no look camera.",
        importError: "Can't read camera data from \"{{file}}\": {{message}}",
    },

    spriteGroup: {
        folder: {
            tooltip: "Small colored balls spread in front of the look camera. They drift with the wind, so they show how the air moves in the camera view.",
        },
        visible: {
            label: "Visible",
            tooltip: "Show or hide the flow orbs",
        },
        size: {
            label: "Size (m)",
            tooltip: "Diameter in meters.",
        },
        viewSizeMultiplier: {
            label: "View Size Multiplier",
            tooltip: "Adjusts the size of the flow orbs in the main view, but does not change the size in other views.",
        },
    },

    imageAnalysis: {
        bestAngleFull: {
            label: "Best Angle, full 180, refined",
            tooltip: "Rotate the region to the angle where one column of the gray profile stands out most from the others. It searches the full 180° in 1° steps, then refines within 2° of the best angle.",
        },
        bestAngle5: {
            label: "Best angle within 5\u00B0 of current",
            tooltip: "Rotate the region to the angle, within 5° of the current angle, where one column of the gray profile stands out most from the others.",
        },
    },

    // Refreshing the satellite data a saved sitch was made with (src/TLERefresh.js).
    tleRefresh: {
        failedTitle: "Refresh failed",
    },

    misc: {
        // The button that closes a notice.
        ok: "OK",
        freeLookCamera: {
            label: "Free Look Camera",
            tooltip: "Fly the look camera by hand, exactly like the main view camera.\n" +
                "Left-drag moves the world, middle-drag orbits the point under the cursor,\n" +
                "right-drag looks around, the wheel moves in and out, and WASD walks.\n" +
                "While this is on, the Location and Heading sources are suspended, but not\n" +
                "the field of view - so you can still frame what you have flown to.\n" +
                "Where you fly to is written into the camera's Location as you go, so\n" +
                "turning this off keeps the camera at the new position. It keeps the new\n" +
                "heading only when Camera Heading is Manual.\n" +
                "An 'above ground level' camera keeps its AGL height and only moves horizontally.",
        },
        // Shown over the look view when a hand edit to Camera > Location or Heading takes the
        // camera back off the mouse (src/FreeLookGuard.js). Sentence case, because it is a
        // statement about what just happened, not the name of the control.
        freeLookDisabled: "Free look disabled",
        snapshotCamera: {
            label: "Snapshot Camera",
            tooltip: "Save the current camera position and heading for use with 'Reset Camera'",
        },
        resetCamera: {
            label: "Reset Camera",
            tooltip: "Reset the camera to the default, or to last snapshot position and heading\nAlso Numpad-.",
        },
        exportCameraKML: {
            label: "Export Camera as KML (Photo)",
            tooltip: "Save the look camera as a Google Earth PhotoOverlay (.kmz), with the current\n" +
                "video frame embedded as the photo. Open it in Google Earth Pro and it flies to\n" +
                "the camera's position, heading, tilt and field of view, and hangs the frame in\n" +
                "front of you — so you can check Sitrec's camera against Google's terrain,\n" +
                "imagery and 3D buildings.\n" +
                "If the sitch has a traverse, its whole path is included as a yellow line.\n" +
                "With no video frame available it writes a plain .kml with just the camera viewpoint.",
        },
        showMoonShadow: {
            label: "Show Moon's Shadow",
            tooltip: "Show the Moon's shadow in the main view, for solar eclipses: the gold umbra cone, and the outlines of the umbra and penumbra on the ground.",
        },
        shadowSegments: {
            label: "Shadow Segments",
            tooltip: "Number of segments along the length of the Moon's shadow cones. More is smoother but slower.",
        },
        showEarthShadow: {
            label: "Show Earth's Shadow",
            tooltip: "Show the Earth's shadow: the umbra (light blue) and penumbra (dark blue) cones and circles, out to Earth's Shadow Altitude on the side away from the Sun.",
        },
        earthShadowAltitude: {
            label: "Earth's Shadow Altitude",
            tooltip: "Distance from Earth's center to the plane at which to render Earth's shadow cone (in meters).",
        },
        exportTLE: {
            label: "Export TLE",
            tooltip: "Save the loaded satellite orbit data to a file: satellites.csv for CSV catalog data, otherwise satellites.tle.\nMerged data is saved together in one file.",
        },
        backgroundFlowIndicator: {
            label: "Background Flow Indicator",
            tooltip: "In the look view, draw an arrow where the camera's line of sight meets the ground. It shows how far that point moves by the next frame. A gray arrow 20 times longer shows the direction.\nUse it to sync the sim with the video, with View > Vid Overlay Trans % above 0.",
        },
        defaultSnap: {
            label: "Default Snap",
            tooltip: "On: a dragged point moves only horizontally or only vertically, set by your first movement.\nOff: a dragged point moves freely, and snaps to the height of other points and to the current frame.\nHold Shift while you drag to use the other mode",
        },
        recalcNodeGraph: {
            label: "Recalc Node Graph",
            tooltip: "Lay out the node graph view again from the current nodes, for example after a track is loaded.",
        },
        downloadVideo: {
            label: "Download Video",
            tooltip: "Download the file of the current video, with its original file name. This is the source file, not a render.",
        },
        banking: {
            label: "Banking",
            tooltip: "How the object turns to match its motion along its track. The one in the Physics menu orients the look camera along the camera track.\nNo Banking: points along the track, with no roll.\nPhysical Banking: points along the track and rolls by the bank angle of a coordinated turn at the speed and turn rate of the track.\nFixed Heading: points at Fixed Heading° and ignores the direction of travel.\nfrontPointing points along the track. bottomPointing points its bottom along the track. axialPush and axialPull tilt the vertical axis toward the acceleration, with gravity (the ZeroG variants leave out gravity).",
        },
        fixedHeading: {
            label: "Fixed Heading°",
            tooltip: "Compass heading (true) the model points at in 'Fixed Heading' mode, instead of pointing along its track. Use it for an object that translates without turning — crabbing sideways, drifting, or holding an attitude while it moves.",
        },
        tiltAngle: {
            label: "Tilt°",
            tooltip: "Fixed lean of the object from vertical, added after the banking mode. The top leans toward Tilt Direction. An estimated input: for example a sky lantern or a balloon pushed over by wind or by its tether.",
        },
        tiltDirection: {
            label: "Tilt Direction°",
            tooltip: "Compass direction (true) toward which the top of the object leans, for both the fixed tilt and the sway.",
        },
        swayAmplitude: {
            label: "Sway°",
            tooltip: "Amplitude of a pendulum-like swing about the fixed tilt, in the plane of Tilt Direction. An estimated input: there is no measured value for a given object. Zero turns the sway off.",
        },
        swayPeriod: {
            label: "Sway Period (s)",
            tooltip: "Time for one full swing of the sway.",
        },
        angularTraverse: {
            label: "Angular Traverse",
            tooltip: "Angle, in degrees, that Zaine Triangulation turns the A-frame and B-frame lines of sight about the local vertical.",
        },
        smoothingMethod: {
            label: "Smoothing Method",
            tooltip: "How this track's positions are smoothed. None turns off this stage only; camera, angle and traverse filters are separate.\nmoving, movingPolyEdge: moving average, with polynomial fits at the ends (movingPolyEdge has settings for them).\nsliding: smooths the velocity, then rebuilds the positions from it.\nsavgol: Savitzky–Golay filter, a moving polynomial fit.\nspline: smooth curve through the recorded data points, or through smoothed points at regular intervals.\nThe traverse analysis filtering summary lists the active processing.",
        },
        showInLookView: {
            label: "Show in look view",
            tooltip: "Draw this track in the look view, not only in the main view.\nShow > All Tracks in Look draws every track there, whatever this setting is",
        },
        windFrom: {
            tooltip: "True heading the wind blows FROM (0=North, 90=East)",
        },
        windKnots: {
            tooltip: "Wind speed in knots",
        },
        fetchWind: {
            tooltip: "Fetch real wind data from weather services for this location and time",
        },
        debugConsole: {
            label: "Debug Console",
            tooltip: "Show or hide the Debug Console view, a text window of debug messages.",
        },
        aiAssistant: {
            label: "AI Assistant",
            tooltip: "Show or hide the AI Assistant chat window. Ask it in plain language to change the sitch, for example \"go to London at 12pm yesterday\".\nThe Tab key also shows and hides it.",
        },
        voice: {
            start: "Talk to the assistant (needs your own OpenAI key — Settings, API Keys)",
            stop: "Stop listening",
            // Said once when the connection is live, so the user knows the microphone is
            // open and that the assistant is waiting rather than thinking.
            listening: "Listening — just talk. Press the microphone again to stop.",
            stopped: "Voice stopped. The microphone is off.",
            modelInUse: "The spoken assistant's model. Change it in Settings, Voice Model.",
        },
        chat: {
            modelInUse: "The model answering typed questions. Change it in Settings, AI Model.",
        },
        hide: {
            label: "Hide",
            tooltip: "Hide this tabbed canvas view\nTo show it again, use the 'Show/Hide -> Views' menu.",
        },
        notes: {
            label: "Notes",
            tooltip: "Show/Hide the notes editor. Notes are saved with the sitch and can contain clickable hyperlinks.",
        },
    },

    showHiders: {
        linesOfSight: {
            label: "Lines of Sight",
            tooltip: "Show the lines of sight (LOS) from the camera in the direction it looks, at regular frame intervals.\nLines outside the In/Out (A-B) range are dark gray. (toggle: O)",
        },
        hideSomeLOS: {
            label: "Hide Some LOS",
            tooltip: "Thin out the displayed lines of sight: 0 shows all, n shows only every 2ⁿ-th line (3 = every 8th)",
        },
        currentLOS: {
            label: "Current LOS",
            tooltip: "Draw the line of sight for the current frame as a white line.\nIt shows even when the other lines of sight are hidden",
        },
        physicalPointer: {
            label: "Physical Pointer",
            tooltip: "Show the pointer rod on the ATFLIR pod model. It sticks straight out of the front of the pod, along the pod's long axis.",
        },
        jet: {
            label: "[J]et",
            tooltip: "Show the F/A-18 jet model that carries the ATFLIR pod (toggle: J)",
        },
        horizonGrid: {
            label: "[H]orizon Grid",
            tooltip: "Show a flat yellow grid in the local horizontal plane at the jet (toggle: H)",
        },
        wingPlaneGrid: {
            label: "[W]ing Plane Grid",
            tooltip: "Show a flat cyan grid in the plane of the jet's wings. It tilts with the jet's pitch and bank (toggle: W)",
        },
        sphericalBoresightGrid: {
            label: "[S]pherical Boresight Grid",
            tooltip: "Show the pod's pitch and roll grid on a sphere around the jet. Blue lines are every 10° of roll, red circles every 10° of pitch.\nThe grid turns, pitches and banks with the jet (toggle: S)",
        },
        azimuthElevationGrid: {
            label: "[A]zimuth/Elevation Grid",
            tooltip: "Show an azimuth and elevation grid on a sphere around the jet, level with the horizon and turned to the jet's heading.\nLines are every 10°, out to 90° on each side of the nose (toggle: A)",
        },
        frustumOfCamera: {
            label: "F[R]ustum of camera",
            tooltip: "Show the ATFLIR camera's field of view as a cyan pyramid from the pod. It turns with the pod's ball (toggle: R)",
        },
        trackLine: {
            label: "[T]rack line",
            tooltip: "Show a white circle around the jet at the current elevation angle, through all azimuths (toggle: T)",
        },
        globe: {
            label: "[G]lobe",
            tooltip: "Show the globe: a smooth ellipsoid model of the Earth's surface (toggle: G).",
            tooltip: "Show the textured globe of the whole Earth. Sitrec draws it only when Terrain > Terrain Tweaks > Dynamic Subdivision is off. (toggle: G)",
        },
        showErrorCircle: {
            label: "showErrorCircle",
            tooltip: "Show a green circle, 5° in radius, around the direction that the pod physically points. It also shows in the pod's-eye view (toggle: O)",
        },
        glareSprite: {
            label: "Glare Spr[I]te",
            tooltip: "Show a glare image over the target in the pod's-eye and look views. While it shows, it replaces the target sphere in the pod's-eye view (toggle: I)",
        },
        cameraViewFrustum: {
            label: "Camera View Frustum",
            tooltip: "Show the camera's viewing frustum in the 3D scene",
        },
        zaineTriangulation: {
            label: "Zaine Triangulation",
            tooltip: "Show a triangulation from the LOS (lines of sight) at the A frame (blue) and the B frame (orange).\nMagenta and red show the same two LOS turned by Angular Traverse in opposite directions about the local vertical.\nThe white line joins the points where the crossed pairs pass closest.",
        },
    },

    lighting: {
        ambientIntensity: {
            label: "Ambient Intensity",
            tooltip: "Strength of the ambient light, which lights all surfaces equally, day and night. 0 is none and 1 is full brightness.\nSun Scattering adds more ambient light while the Sun is up.",
        },
        irAmbientIntensity: {
            label: "IR Ambient Intensity",
            tooltip: "Ambient light strength used in place of Ambient Intensity when a view renders in IR (infrared) mode with its effects on.",
        },
        sunIntensity: {
            label: "Sun Intensity",
            tooltip: "Strength of direct sunlight. 0 is none and 1 is full brightness. It fades as the Sun goes down to the horizon and below it.",
        },
        sunScattering: {
            label: "Sun Scattering",
            tooltip: "Extra ambient light from sunlight scattered by the sky, as a fraction of Sun Intensity. It fades out around sunset.",
        },
        sunBoost: {
            label: "Sun Boost (HDR)",
            tooltip: "Multiplier, from 1 to 100, for direct sunlight only. It makes HDR (high dynamic range) highlights, such as Sun reflections, brighter.\nLower Scene Exposure to compensate.",
        },
        sceneExposure: {
            label: "Scene Exposure",
            tooltip: "Brightness multiplier for the look view image. It is multiplied by Lighting > Look View Output > Look Exposure, and it works with or without Atmosphere and Highlight Rolloff.\nLower it when you raise Sun Boost.",
        },
        ambientOnly: {
            label: "Ambient Only",
            tooltip: "Turn off direct sunlight and sun scattering, so only Ambient Intensity lights the scene.",
        },
        daylightSky: {
            label: "Daylight Sky",
            tooltip: "Render the daylight (blue) sky\nTurn off to remove the daylight sky contribution, useful for seeing stars in daylight or debugging night-sky objects.",
        },
        noMainLighting: {
            label: "No Lighting in Main View",
            tooltip: "Light the main view evenly, with full ambient light and no sunlight, so the night side is as bright as the day side. The look view does not change.",
        },
        noCityLights: {
            label: "No City Lights on Globe",
            tooltip: "Hide the city lights image on the night side of the globe sphere.\nLighting > City Lights is a separate control, for lights on the 3D building tiles.",
        },
        shadowsEnabled: {
            label: "Shadows",
            tooltip: "Master switch for shadows cast by the Sun. Off by default.\nEach view also has its own switch in Shadow tweaks, and a view draws shadows only when both are on. Shadows slow down rendering.",
        },
        shadowTweaks: {
            label: "Shadow tweaks",
            tooltip: "Shadow settings: the switch for each view, terrain shadows, and the shadow map size, bias and update rate.\nMost users do not need to change the sliders.",
        },
        shadowMapSize: {
            label: "Shadow map size",
            tooltip: "Resolution of the depth texture used for shadow rendering. Larger = sharper shadows, more GPU memory.",
        },
        shadowRadius: {
            label: "Shadow min radius (m)",
            tooltip: "Smallest half-width, in meters, of the area that gets shadows. The area fits itself to what the view can see. This sets a minimum for close-up views, so they still get a useful patch of shadow.",
        },
        shadowBias: {
            label: "Shadow bias",
            tooltip: "Small depth offset for the shadow test, in normalized depth units. A negative value stops shadow acne (stripes of false shadow on lit surfaces). Too negative makes shadows separate from the objects that cast them.",
        },
        shadowNormalBias: {
            label: "Shadow normal bias",
            tooltip: "Offset of the shadow test along the surface normal, in meters. It also stops shadow acne. About one shadow-map pixel is typical.",
        },
        shadowUpdateInterval: {
            label: "Shadow update interval (ms)",
            tooltip: "Minimum time between shadow re-renders. Lower = smoother but more GPU cost.",
        },
        shadowUpdateAngle: {
            label: "Shadow update angle (°)",
            tooltip: "Sun-direction change required to trigger a shadow re-render. Lower = smoother during slow time movement.",
        },
        terrainReceivesShadow: {
            label: "Terrain receives shadows",
            tooltip: "Let cast shadows darken the terrain. On by default.\nTurn it off to make the terrain draw faster.",
        },
    },
    helpFunctions: {
        adsbReplay: {
            label: "ADSB Replay for this time and location",
            tooltip: "Open ADS-B Exchange Replay in a new tab, at the look camera's position and the time of the current frame.\nNot available for times in the last 30 minutes",
        },
        googleMapsLink: {
            label: "Google Maps for this location",
            tooltip: "Open Google Maps in a new tab, at the look camera's position",
        },
        inTheSkyLink: {
            label: "In-The-Sky for this time and location",
            tooltip: "Open the In-The-Sky.org satellite map in a new tab, for the look camera's position and the time of the current frame",
        },
        fr24Replay: {
            tooltip: "Open Flightradar24 playback in a new tab, at the look camera's position and the time of the current frame",
        },
        earthNullSchoolLink: {
            tooltip: "Open the earth.nullschool.net wind map in a new tab, at the look camera's position and the time of the current frame.\nIt shows the wind at the 250 hPa pressure level",
        },
    },
    nodeLabels: {
        // Keys must match the node ID (property key in sitch data),
        // NOT the desc text. When no explicit id is set, desc becomes the id.
        renderCameraTrackTraverse: "Render Camera Use Traverse Track",
        focus: "Defocus",
        canvasResolution: "Resolution",
        "Noise Amount": "Noise Amount",
        "TV In Black": "TV In Black",
        "TV In White": "TV In White",
        "TV Gamma": "TV Gamma",
        "Tv Out Black": "Tv Out Black",
        "Tv Out White": "Tv Out White",
        "JPEG Artifacts": "JPEG Artifacts",
        pixelZoom: "Pixel Zoom %",
        videoBrightness: "Brightness",
        videoContrast: "Contrast",
        videoShadows: "Shadows",
        videoHighlights: "Highlights",
        videoDehaze: "Dehaze",
        videoBlur: "Blur Amount",
        videoSharpenAmount: "Sharpen Amount",
        videoGreyscale: "Greyscale",
        videoHue: "Hue Shift",
        videoInvert: "Invert",
        videoSaturate: "Saturation",
        abSize: "Assumed Size",
        startDistanceGUI: "Start Distance",
        targetVCGUI: "Target Vert. Speed",
        targetSpeedGUI: "Target Speed",
        lockWind: "Lock Target Wind to Local",
        jetTAS: "TAS",
        turnRate: "Turn Rate",
        totalTurn: "Total Turn",
        jetHeadingManual: "Jet Heading",
        headingSmooth: "Heading Smooth",
        turnRateControl: "Turn Rate Control",
        cameraSmoothWindow: "Camera Smooth Window",
        targetSmoothWindow: "Target Smooth Window",
        cameraFOV: "Camera FOV",
        "Tgt Start Dist": "Tgt Start Distance",
        "Target Speed": "Target Speed",
        "Tgt Relative Heading": "Tgt Relative Heading",
        "KF Process": "KF Process",
        "KF Noise": "KF Noise",
        "MC Num Trials": "MC Num Trials",
        "MC LOS Uncertainty (deg)": "MC LOS Uncertainty (deg)",
        "MC Polynomial Order": "MC Polynomial Order",
        "Physics Max Iterations": "Physics Max Iterations",
        "Physics Wind Speed (kt)": "Physics Wind Speed (kt)",
        "Physics Wind From (°)": "Physics Wind From (°)",
        "Physics Initial Range (m)": "Physics Initial Range (m)",
        "Tgt Start Altitude": "Tgt Start Altitude",
        "Tgt Vert Spd": "Tgt Vert Speed",
        "Cloud Altitude": "Cloud Altitude",
    },
};

export default en;
