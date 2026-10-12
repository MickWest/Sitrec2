import {CapsuleGeometry, CylinderGeometry, Vector3} from "three";
import {refineAxialThermalGeometry} from "../src/rendering/SolarSurfacePatches";

function power(geometry, sigma = .15) {
    const p = geometry.attributes.position, index = geometry.index;
    let sum = 0;
    for (let i = 0; i < (index?.count ?? p.count); i += 3) {
        const v = [0,1,2].map(j => new Vector3().fromBufferAttribute(p, index ? index.getX(i+j) : i+j));
        const z = (v[0].z + v[1].z + v[2].z)/18;
        const area = v[1].sub(v[0]).cross(v[2].sub(v[0])).length()/2;
        sum += area * 15000 * Math.exp(-.5*(z/sigma)**2);
    }
    return sum;
}

test("narrow Gaussian power converges to analytic cylinder barrel power after axial refinement", () => {
    const source = new CylinderGeometry(1.6,1.6,12,8,1,true).rotateX(Math.PI/2);
    const before = source.attributes.position.array.slice(), indices = source.index.array.slice();
    // Integral over z = [-6,6]; omitted Gaussian tails are below 3e-11.
    const expected = 2*8*1.6*Math.sin(Math.PI/8)*15000*6*.15*Math.sqrt(2*Math.PI);
    expect(Math.abs(power(source)/expected-1)).toBeGreaterThan(.4);
    const errors = [.1,.05,.025].map(maxAxialSpanFraction => {
        const refined = refineAxialThermalGeometry(source, {maxAxialSpanFraction, maxTriangles: 200000});
        const error = Math.abs(power(refined)/expected-1);
        const p = refined.attributes.position, normals = refined.attributes.normal;
        let largestSpan = 0;
        for (let i=0;i<p.count;i+=3) {
            const zs = [p.getZ(i),p.getZ(i+1),p.getZ(i+2)];
            largestSpan = Math.max(largestSpan, Math.max(...zs)-Math.min(...zs));
        }
        expect(largestSpan).toBeLessThanOrEqual(6*maxAxialSpanFraction+1e-6);
        let normalError = 0;
        for (let i=0;i<normals.count;i++)
            normalError = Math.max(normalError, Math.abs(new Vector3().fromBufferAttribute(normals,i).length()-1));
        expect(normalError).toBeLessThan(1e-6);
        expect(refined.attributes.uv.count).toBe(p.count);
        let uvError = 0;
        for (let i=0;i<p.count;i++)
            uvError = Math.max(uvError, Math.abs(refined.attributes.uv.getY(i) - (.5 + p.getZ(i)/12)));
        expect(uvError).toBeLessThan(1e-6);
        expect(refined.attributes.position.array).not.toBe(source.attributes.position.array);
        refined.dispose();
        return error;
    });
    expect(errors[0]).toBeLessThan(.01);
    expect(errors[1]).toBeLessThan(errors[0]);
    expect(errors[2]).toBeLessThan(errors[1]);
    expect(source.attributes.position.array).toEqual(before);
    expect(source.index.array).toEqual(indices);
    expect(source.boundingBox).toBeNull();
    source.dispose();
});

test("refinement cap rejects under-resolved results without changing the source", () => {
    const source = new CylinderGeometry(1,1,12,8,1,true).rotateX(Math.PI/2);
    const before = source.attributes.position.array.slice();
    expect(() => refineAxialThermalGeometry(source,{maxTriangles: 20})).toThrow(/cap exceeded/);
    expect(source.attributes.position.array).toEqual(before);
    source.dispose();
});


test("12 m capsule thermal copy resolves the axial barrel within the default cap", () => {
    const source = new CapsuleGeometry(1.6,8.8,8,32).rotateX(Math.PI/2);
    const refined = refineAxialThermalGeometry(source);
    const p = refined.attributes.position;
    let span = 0;
    for (let i=0;i<p.count;i+=3) {
        const zs = [p.getZ(i),p.getZ(i+1),p.getZ(i+2)];
        span = Math.max(span,Math.max(...zs)-Math.min(...zs));
    }
    expect(span).toBeLessThanOrEqual(.600001);
    expect(p.count/3).toBeLessThanOrEqual(32768);
    refined.dispose(); source.dispose();
});
