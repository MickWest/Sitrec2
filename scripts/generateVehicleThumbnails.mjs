// Run after npm run build. The tool uses the same geometry and camera as the picker.
import {chromium} from "playwright";
import {mkdir, writeFile} from "node:fs/promises";
import path from "node:path";

const url = process.argv[2] || "https://local.metabunk.org/procedural/tools/vehicles/";
const output = path.resolve("tools/vehicles/thumbnails");
await mkdir(output,{recursive:true});
const browser = await chromium.launch({headless:true});
try {
    const page = await browser.newPage({ignoreHTTPSErrors:true,viewport:{width:1200,height:800},deviceScaleFactor:1});
    await page.goto(url,{waitUntil:"networkidle"});
    const ids = await page.evaluate(async () => {
        const [{PRESETS},{createVehiclePreview},{createVehicleRecipe}] = await Promise.all([import("./vehicleParameters.js"),import("./preview.js"),import("./recipe.js")]);
        const mount = document.createElement("div"); mount.style.cssText = "position:fixed;inset:0;width:600px;height:400px;z-index:1000";
        document.body.append(mount); window.thumbnailPreview = createVehiclePreview(mount); window.thumbnailPresets = PRESETS.map(p => ({id:p.id,recipe:createVehicleRecipe(p.parameters,p.name,p.id)}));
        return PRESETS.map(p => p.id);
    });
    for (const id of ids) {
        if (!/^[a-z0-9_-]+$/i.test(id)) throw new Error(`Invalid preset ID: ${id}`);
        const image = await page.evaluate(id => {
            const preset = window.thumbnailPresets.find(p => p.id === id);
            window.thumbnailPreview.set(preset.recipe);
            return window.thumbnailPreview.thumbnail().split(",")[1];
        },id);
        await writeFile(path.join(output,`${id}.jpg`),Buffer.from(image,"base64"));
    }
    console.log(`Generated ${ids.length} vehicle thumbnails in ${output}`);
} finally {await browser.close();}
