import {BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3} from "three";
import {solarSurfaceState, solarSurfaceTemperature, surfaceRecoveryTemperature, surfaceHeatingFlux, STEFAN_BOLTZMANN} from "../tools/thermal/solarSurface.js";
import {SolarSurfacePatches} from "../src/rendering/SolarSurfacePatches";

test("steady equilibrium satisfies energy balance and separates solar absorption from emissivity", () => {
    const s = solarSurfaceState({airTemperatureK: 250, mach: .7, radiationTemperatureK: 230});
    for (const mu of [-1, 0, .3, 1]) {
        const t = solarSurfaceTemperature(s, mu);
        const q = s.convectionWm2K * (t - surfaceRecoveryTemperature(s)) +
            s.coolingEmissivity * STEFAN_BOLTZMANN * (t ** 4 - s.radiationTemperatureK ** 4);
        expect(q).toBeCloseTo(s.solarAbsorptivity * s.solarIrradianceWm2 * Math.max(0, mu), 7);
    }
    const lit = solarSurfaceTemperature(s, 1), dark = solarSurfaceTemperature(s, 0);
    expect(lit).toBeGreaterThan(dark);
    expect(solarSurfaceTemperature({...s, convectionWm2K: 200}, 1) - solarSurfaceTemperature({...s, convectionWm2K: 200}, 0)).toBeLessThan(lit - dark);
    expect(solarSurfaceTemperature({...s, emissivityMWIR: .1}, 1)).toBe(lit);
});

test("zero radiation gives the exact absorbed-sun / h limit and uniform no-sun equilibrium", () => {
    const s = solarSurfaceState({coolingEmissivity: 0});
    expect(solarSurfaceTemperature(s, 1)).toBeCloseTo(s.airTemperatureK + .6 * 1000 / 20, 10);
    expect(solarSurfaceTemperature(s, -1)).toBeCloseTo(s.airTemperatureK, 10);
    expect(solarSurfaceTemperature(solarSurfaceState(), 0)).toBeCloseTo(293, 10);
});

test("estimated configuration round trips and rejects invalid physical coefficients", () => {
    const s = solarSurfaceState({enabled: true, mach: .8, convectionWm2K: 123,
        internalHeatFluxWm2: 3000, internalHeatCenterFraction: -.6, internalHeatSigmaFraction: .4});
    expect(solarSurfaceState(JSON.parse(JSON.stringify(s)))).toEqual(s);
    expect(solarSurfaceState().enabled).toBe(false);
    expect(solarSurfaceState().internalHeatFluxWm2).toBe(0);
    for (const value of [{convectionWm2K: 0}, {solarAbsorptivity: 2}, {airTemperatureK: NaN},
        {internalHeatSigmaFraction: 0}, {internalHeatCenterFraction: 2}, {internalHeatFluxWm2: -1}])
        expect(() => solarSurfaceState(value)).toThrow(RangeError);
});

test("internal Gaussian is a surface flux with the specified body-axis center and sigma", () => {
    const s = solarSurfaceState({internalHeatFluxWm2: 3000, internalHeatCenterFraction: -.5,
        internalHeatSigmaFraction: .4, solarIrradianceWm2: 800, convectionWm2K: 150,
        airTemperatureK: 246.2, mach: .67, radiationTemperatureK: 240});
    expect(surfaceHeatingFlux(s, 0, -.5)).toBe(3000);
    expect(surfaceHeatingFlux(s, 0, -.1)).toBeCloseTo(3000 * Math.exp(-.5), 10);
    expect(surfaceHeatingFlux(s, 1, -.5)).toBe(3480);
    for (const z of [-1, -.5, 0, 1]) for (const mu of [0, .5, 1]) {
        const t = solarSurfaceTemperature(s, mu, z);
        const loss = s.convectionWm2K * (t - surfaceRecoveryTemperature(s)) +
            s.coolingEmissivity * STEFAN_BOLTZMANN * (t ** 4 - s.radiationTemperatureK ** 4);
        expect(loss).toBeCloseTo(surfaceHeatingFlux(s, mu, z), 7);
    }
    const peakT = solarSurfaceTemperature(s, 0, -.5);
    expect(peakT).toBeGreaterThan(284); expect(peakT).toBeLessThan(286);
    const solarOnly = solarSurfaceState();
    expect(solarSurfaceTemperature(solarOnly, .5, -1)).toBe(solarSurfaceTemperature(solarOnly, .5, 1));
});

test("combined-flux bands conserve supplied power and internal pattern survives world rotation", () => {
    const source = new Mesh(new BoxGeometry(3.2, 3.2, 12, 1, 1, 24), new MeshBasicMaterial());
    const parent = new Group(); parent.add(source); parent.updateMatrixWorld(true);
    const patches = new SolarSurfacePatches(source);
    const settings = solarSurfaceState({internalHeatFluxWm2: 3000, internalHeatCenterFraction: -.5,
        solarIrradianceWm2: 0, convectionWm2K: 150});
    let activeSun = new Vector3(1,0,0);
    const signature = () => patches.bands.map(mesh => ({indices: Array.from(mesh.geometry.index.array.slice(0,mesh.geometry.drawRange.count)),
        temperatureK: mesh.userData.thermal.temperatureK}));
    const checkEnergy = () => {
        const report = patches.heatingReport;
        const lossW = patches.bands.reduce((total, mesh, i) => {
            const t = mesh.userData.thermal.temperatureK;
            return total + report.bandAreaM2[i] * (settings.convectionWm2K * (t - surfaceRecoveryTemperature(settings)) +
                settings.coolingEmissivity * STEFAN_BOLTZMANN * (t ** 4 - settings.radiationTemperatureK ** 4));
        },0);
        expect(lossW).toBeCloseTo(report.suppliedPowerW, 6);
        expect(report.suppliedPowerW).toBeGreaterThan(0);
        // Independently integrate the input over transformed triangles, rather
        // than trusting the band's own area/power accounting.
        const index = source.geometry.index, p = source.geometry.attributes.position;
        let inputPower = 0;
        for (let i = 0; i < index.count; i += 3) {
            const v = [0,1,2].map(j => new Vector3().fromBufferAttribute(p,index.getX(i+j)));
            const z = (v[0].z+v[1].z+v[2].z)/18;
            const internal = 3000*Math.exp(-.5*((z+.5)/.4)**2);
            v.forEach(point => point.applyMatrix4(source.matrixWorld));
            const cross = v[1].sub(v[0]).cross(v[2].sub(v[0]));
            const area = cross.length()/2, mu = Math.max(0,cross.normalize().dot(activeSun));
            inputPower += area*(internal + .6*settings.solarIrradianceWm2*mu);
        }
        expect(report.suppliedPowerW).toBeCloseTo(inputPower, 6);
        expect(report.areaM2).toBeCloseTo(2 * (3.2*3.2 + 2*3.2*12), 4);
        expect(patches.bands.length).toBe(33);
        expect(patches.bands.reduce((n,m) => n+m.geometry.drawRange.count,0)).toBe(source.geometry.index.count);
    };
    patches.update(settings, new Vector3(1,0,0), false); checkEnergy();
    const first = signature(), power = patches.heatingReport.suppliedPowerW;
    parent.rotation.set(.4,1.3,.7); parent.updateMatrixWorld(true);
    patches.update(settings, new Vector3(0,1,0), false); checkEnergy();
    signature().forEach((row,i) => {expect(row.indices).toEqual(first[i].indices); expect(row.temperatureK).toBeCloseTo(first[i].temperatureK,10);});
    expect(patches.heatingReport.suppliedPowerW).toBeCloseTo(power,7);
    // With sunlight on, preserve the combined input, without a second set of draws.
    settings.solarIrradianceWm2 = 800;
    activeSun = new Vector3(1,0,0);
    patches.update(settings, activeSun, true); checkEnergy();
    expect(patches.heatingReport.suppliedPowerW).toBeGreaterThan(power);
    patches.dispose();
});

test("patches preserve triangles, follow world normals, restore visibility and own no material", () => {
    const parent = new Group(), source = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    parent.add(source); parent.updateMatrixWorld(true);
    const materialDispose = jest.spyOn(source.material, "dispose");
    const patches = new SolarSurfacePatches(source), s = solarSurfaceState({enabled: true});
    const sun = new Vector3(1, 0, 0);
    patches.update(s, sun, true);
    const count = () => patches.bands.reduce((n, m) => n + m.geometry.drawRange.count, 0);
    expect(count()).toBe(patches.geometry.attributes.position.count);
    const originalIds = patches.bands.flatMap(m => Array.from(m.geometry.index.array.slice(0, m.geometry.drawRange.count))).sort((a,b) => a-b);
    expect(originalIds).toEqual(Array.from({length: patches.geometry.attributes.position.count}, (_, i) => i));
    const hotIndices = () => Array.from(patches.bands[32].geometry.index.array.slice(0, patches.bands[32].geometry.drawRange.count));
    const firstHot = hotIndices();
    parent.rotation.y = Math.PI; parent.scale.set(2, 3, 4); parent.updateMatrixWorld(true);
    patches.update(s, sun, true);
    expect(hotIndices()).not.toEqual(firstHot);
    expect(count()).toBe(patches.geometry.attributes.position.count);
    patches.show(); expect(source.visible).toBe(false); expect(patches.group.visible).toBe(true);
    patches.hide(); expect(source.visible).toBe(true); expect(patches.group.visible).toBe(false);
    patches.update(s, sun, false);
    expect(patches.bands[0].geometry.drawRange.count).toBe(patches.geometry.attributes.position.count);
    patches.dispose(); expect(parent.children).toEqual([source]); expect(materialDispose).not.toHaveBeenCalled();
});
