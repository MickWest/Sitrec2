export const SITMAP_TOOLS = [
    {name: "sitmap_status", description: "Read the native SitMap app's camera, rendering fidelity, and live-sync statistics. SitMap.app must be running on this Mac.",
        inputSchema: {type: "object", properties: {}}},
    {name: "sitmap_set_view", description: "Set SitMap's eye location, orientation and vertical FOV. Altitudes are meters MSL; elevation is degrees above the horizon. Calibrated image projection compensates for FOV and clamped pitch within the captured area. Inspect fidelity in the response.",
        inputSchema: {type: "object", required: ["camera"], properties: {camera: {type: "object",
            required: ["latitude", "longitude", "altitudeMSL", "heading", "elevation"], properties: {
                latitude: {type: "number"}, longitude: {type: "number"}, altitudeMSL: {type: "number"},
                groundAltitudeMSL: {type: "number", description: "Ground height estimate beneath the eye; defaults to sea level."},
                groundTarget: {type: "object", description: "Surface hit at the center of the look camera, including its elevation and 3D range. Used instead of a flat ground assumption.",
                    required: ["latitude", "longitude", "altitudeMSL", "distance"], properties: {
                        latitude: {type: "number"}, longitude: {type: "number"}, altitudeMSL: {type: "number"}, distance: {type: "number"}
                    }},
                sourceGroundTarget: {type: "object", description: "Surface hit along MapKit's accepted native pitch, measured from the same eye. Refines terrain positioning when pitch is clamped.",
                    required: ["latitude", "longitude", "altitudeMSL", "distance", "pitch"], properties: {
                        latitude: {type: "number"}, longitude: {type: "number"}, altitudeMSL: {type: "number"},
                        distance: {type: "number"}, pitch: {type: "number", minimum: 0, maximum: 85}
                    }},
                heading: {type: "number"}, elevation: {type: "number"}, roll: {type: "number"},
                verticalFov: {type: "number"}, aspect: {type: "number"},
                renderScale: {type: "number", minimum: 0.5, maximum: 2, description: "Optional fixed render-size multiplier. Omit for automatic sizing that balances MapKit pitch and zoom limits. Inspect projection errors."},
                style: {type: "string", enum: ["imagery", "hybrid", "standard"]}, requireExact: {type: "boolean"}
            }}}}},
    {name: "sitmap_snapshot", description: "Get a PNG from native MapKit's snapshot renderer with the current SitMap camera and crop. This may differ from live 3D. Up to 4096 pixels per axis and 8 megapixels total.",
        inputSchema: {type: "object", properties: {width: {type: "integer"}, height: {type: "integer"}}}},
    {name: "sitrec_send_to_sitmap", description: "Send a displayed Sitrec perspective camera to the native SitMap app through SitrecBridge. Defaults to the look camera. Inspect returned fidelity for MapKit limitations.",
        inputSchema: {type: "object", properties: {tab: {type: ["string", "number"]}, view: {type: "string", default: "lookView"},
            groundAltitudeMSL: {type: "number"}, style: {type: "string", enum: ["imagery", "hybrid", "standard"]}}}},
    {name: "sitrec_sync_sitmap", description: "Start or stop live Sitrec-to-SitMap camera following, or read connection/latency status. Sends every changed rendered camera pose, coalesces pending poses, and applies on SitMap's 60 Hz update loop. Defaults to lookView.",
        inputSchema: {type: "object", properties: {tab: {type: ["string", "number"]}, enabled: {type: "boolean", default: true},
            statusOnly: {type: "boolean"}, view: {type: "string", default: "lookView"}, groundAltitudeMSL: {type: "number"}}}}
];
