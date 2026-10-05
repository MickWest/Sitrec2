// The built-in sitches whose look-camera field of view comes from a camera
// data CSV that SituationSetup reads by row index (the "wescamFOV" setup
// entry). Found by scanning the sitch files in data/, not by name, so the tests
// that must keep those rows unchanged follow whatever sitches use the entry.
import fs from "fs";
import path from "path";

const DATA = path.resolve(__dirname, "../../data");

export function legacyCameraDataFiles() {
    const found = [];
    for (const folder of fs.readdirSync(DATA, {withFileTypes: true})) {
        if (!folder.isDirectory()) continue;
        for (const file of fs.readdirSync(path.join(DATA, folder.name))) {
            if (!/^Sit.*\.js$/.test(file)) continue;
            const sitchPath = path.join(DATA, folder.name, file);
            if (!/\bwescamFOV\s*:/.test(fs.readFileSync(sitchPath, "utf8"))) continue;
            for (const sitch of Object.values(require(sitchPath))) {
                const spec = sitch?.wescamFOV;
                if (!spec) continue;
                found.push({
                    name: sitch.name,
                    frames: sitch.frames,
                    focalIndex: spec.focalIndex,
                    modeIndex: spec.modeIndex,
                    fileId: spec.file,   // the id the sitch loads the file under
                    csvPath: path.join(DATA, sitch.files[spec.file]),
                });
            }
        }
    }
    return found;
}
