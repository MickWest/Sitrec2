#!/usr/bin/env python3
"""
Write a minimal glTF-binary model that is nothing but a punctual point light.

Sitrec turns KHR_lights_punctual point lights found in a model into CNode3DLight
billboards, which are scaled up with distance so the light stays visible as a
star-like dot however far away it is. A geometry sphere cannot do that - past a
few km it falls below a pixel and disappears - so a "light" that has to read at
20+ km has to come in as a model light.

The mesh is a 10 cm black cube purely so the model has valid geometry and a
bounding sphere; at any realistic range it is invisible.
"""
import json, struct, sys

OUT = (sys.argv[1] if len(sys.argv) > 1 else ".") + "/point-light.glb"
INTENSITY = 900.0     # CNode3DLight billboard world size = intensity/100 = 9 m

S = 0.05
P = [(-S,-S,-S), (S,-S,-S), (S,S,-S), (-S,S,-S), (-S,-S,S), (S,-S,S), (S,S,S), (-S,S,S)]
IDX = [0,2,1, 0,3,2, 4,5,6, 4,6,7, 0,1,5, 0,5,4, 1,2,6, 1,6,5, 2,3,7, 2,7,6, 3,0,4, 3,4,7]

pos = b"".join(struct.pack("<3f", *p) for p in P)
idx = b"".join(struct.pack("<H", i) for i in IDX)
pad = lambda b, n=4: b + b"\x00" * ((n - len(b) % n) % n)
pos_p, idx_p = pad(pos), pad(idx)
bin_chunk = pos_p + idx_p

gltf = {
    "asset": {"version": "2.0", "generator": "sitrec point-light generator"},
    "extensionsUsed": ["KHR_lights_punctual"],
    "extensions": {"KHR_lights_punctual": {"lights": [
        {"type": "point", "color": [1.0, 1.0, 1.0], "intensity": INTENSITY,
         "name": "PointLight"}
    ]}},
    "scene": 0,
    "scenes": [{"nodes": [0, 1]}],
    "nodes": [
        {"mesh": 0, "name": "Body"},
        {"extensions": {"KHR_lights_punctual": {"light": 0}}, "name": "PointLight"},
    ],
    "meshes": [{"name": "Body", "primitives": [
        {"attributes": {"POSITION": 0}, "indices": 1, "material": 0}
    ]}],
    "materials": [{
        "name": "Black",
        "pbrMetallicRoughness": {"baseColorFactor": [0, 0, 0, 1],
                                 "metallicFactor": 0.0, "roughnessFactor": 1.0},
    }],
    "accessors": [
        {"bufferView": 0, "componentType": 5126, "count": len(P), "type": "VEC3",
         "min": [-S, -S, -S], "max": [S, S, S]},
        {"bufferView": 1, "componentType": 5123, "count": len(IDX), "type": "SCALAR"},
    ],
    "bufferViews": [
        {"buffer": 0, "byteOffset": 0, "byteLength": len(pos), "target": 34962},
        {"buffer": 0, "byteOffset": len(pos_p), "byteLength": len(idx), "target": 34963},
    ],
    "buffers": [{"byteLength": len(bin_chunk)}],
}

# glTF requires the JSON chunk to be padded with trailing SPACES (0x20), not nulls
json_chunk = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
json_chunk += b" " * ((4 - len(json_chunk) % 4) % 4)

out = struct.pack("<III", 0x46546C67, 2, 12 + 8 + len(json_chunk) + 8 + len(bin_chunk))
out += struct.pack("<II", len(json_chunk), 0x4E4F534A) + json_chunk
out += struct.pack("<II", len(bin_chunk), 0x004E4942) + bin_chunk
open(OUT, "wb").write(out)
print("wrote", OUT, len(out), "bytes")
