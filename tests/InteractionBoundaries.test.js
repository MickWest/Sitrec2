import fs from "fs";
import path from "path";
import {NATIVE_INTERACTION_BOUNDARIES} from "../src/GestureActions";

// Guard against reintroducing an independent app drag route alongside the
// shared session. GUI/native widgets deliberately keep their own lifecycle.
test("first-party drag listeners stay inside declared infrastructure or native widgets", () => {
    const root = path.resolve(__dirname, "../src"), unexpected = [];
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
            const file = path.join(directory, entry.name), relative = path.relative(root, file);
            if (entry.isDirectory()) { if (relative !== "js") walk(file); continue; }
            if (!file.endsWith(".js") || NATIVE_INTERACTION_BOUNDARIES[relative]) continue;
            const source = fs.readFileSync(file, "utf8");
            // Raw up listeners are a reliable sign of a second drag lifecycle;
            // read-only hover and menu-dismiss observers remain allowed.
            if (/addEventListener\(\s*["'](?:pointerup|mouseup|touchend)["']/.test(source)
                && /addEventListener\(\s*["'](?:pointermove|mousemove|touchmove)["']/.test(source)) unexpected.push(relative);
        }
    };
    walk(root);
    expect(unexpected).toEqual([]);
});
