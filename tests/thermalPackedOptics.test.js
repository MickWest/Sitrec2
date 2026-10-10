import {kernelReach, nearConvolutionPlan, farConvolutionPlan, contrastSourceRegion, ThermalPipeline} from "../tools/thermal/ThermalPipeline.js";

// CPU model of the packed near convolution with the shaders' index rules: each tile's circular convolution on the
// plan's FFT grid (what the FFT computes; fftPackFragment places the tile at the origin and fftPrepareFragment places
// the kernel center at index 0), then the overlap-add assembly of overlapAddFragment.
function packedConvolution(image, width, height, kernel, plan, outputSize = [width,height]) {
    const nw = plan.fftWidth, nh = plan.fftHeight, cx = Math.floor(kernel.width / 2), cy = Math.floor(kernel.height / 2);
    const tiles = [];
    for (let ty = 0; ty < plan.tilesY; ty++) for (let tx = 0; tx < plan.tilesX; tx++) {
        const ox = tx * plan.tileWidth, oy = ty * plan.tileHeight;
        const ex = Math.min(plan.tileWidth, width - ox), ey = Math.min(plan.tileHeight, height - oy);
        const buffer = new Float64Array(nw * nh);
        for (let y = 0; y < ey; y++) for (let x = 0; x < ex; x++) {
            const value = image[(oy + y) * width + ox + x];
            for (let ky = 0; ky < kernel.height; ky++) for (let kx = 0; kx < kernel.width; kx++) {
                const u = ((x + kx - cx) % nw + nw) % nw, v = ((y + ky - cy) % nh + nh) % nh;
                buffer[v * nw + u] += value * kernel.data[ky * kernel.width + kx];
            }
        }
        tiles.push({ox, oy, ex, ey, buffer});
    }
    const [outputWidth,outputHeight] = outputSize, [originX,originY] = plan.sourceOrigin ?? [0,0];
    const result = new Float64Array(outputWidth * outputHeight);
    for (let y = 0; y < outputHeight; y++) for (let x = 0; x < outputWidth; x++) {
        let sum = 0;
        for (const tile of tiles) {
            if (tile.ex <= 0 || tile.ey <= 0) continue;
            const lx = x - originX - tile.ox, ly = y - originY - tile.oy;
            if (lx < -plan.reach.low[0] || ly < -plan.reach.low[1] ||
                lx >= tile.ex + plan.reach.high[0] || ly >= tile.ey + plan.reach.high[1]) continue;
            sum += tile.buffer[((ly + nh) % nh) * nw + (lx + nw) % nw];
        }
        result[y * outputWidth + x] = sum;
    }
    return result;
}

function directConvolution(image, width, height, kernel) {
    const cx = Math.floor(kernel.width / 2), cy = Math.floor(kernel.height / 2), result = new Float64Array(width * height);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++)
        for (let ky = 0; ky < kernel.height; ky++) for (let kx = 0; kx < kernel.width; kx++) {
            const u = x + kx - cx, v = y + ky - cy;
            if (u >= 0 && u < width && v >= 0 && v < height) result[v * width + u] += image[y * width + x] * kernel.data[ky * kernel.width + kx];
        }
    return result;
}

const random = seed => () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

test.each([[23, 17, 7, 5], [16, 16, 4, 6], [31, 9, 9, 3], [5, 3, 6, 4]])(
    "packed overlap-add equals the direct linear convolution (%i × %i image, %i × %i kernel)", (width, height, kw, kh) => {
        // Odd sizes leave a short last tile; even kernel widths make the support asymmetric about the center.
        const next = random(width * 31 + kw);
        const image = Float64Array.from({length: width * height}, () => next() - .3);
        const kernel = {width: kw, height: kh, data: Float64Array.from({length: kw * kh}, () => next())};
        const reach = kernelReach([kernel]), expected = directConvolution(image, width, height, kernel);
        for (const tiles of [[2, 2], [2, 1], [1, 2]]) {
            const plan = nearConvolutionPlan(width, height, reach, {fftWidth: 0, fftHeight: 0}, {tiles});
            expect(plan.packed).toBe(true);
            // Zero circular wrap: each tile's convolution fits its FFT grid.
            expect(plan.fftWidth).toBeGreaterThanOrEqual(plan.tileWidth + reach.low[0] + reach.high[0]);
            expect(plan.fftHeight).toBeGreaterThanOrEqual(plan.tileHeight + reach.low[1] + reach.high[1]);
            const actual = packedConvolution(image, width, height, kernel, plan);
            const scale = Math.max(...expected.map(Math.abs));
            expect(Math.max(...actual.map((value, i) => Math.abs(value - expected[i])))).toBeLessThan(1e-12 * scale);
        }
    });

test("kernel support adds the core and scatter reaches, centered at floor(width / 2)", () => {
    expect(kernelReach([{width: 5, height: 3}, {width: 4, height: 7}])).toEqual({low: [4, 4], high: [3, 4]});
    expect(kernelReach([{width: 257, height: 257}, {width: 513, height: 513}])).toEqual({low: [384, 384], high: [384, 384]});
});

test.each([[0,0],[5,3],[16,12]])("cropped contrast preserves the complete kernel halo and image-edge clipping (origin %i,%i)", (x,y) => {
    const width = 23, height = 17, w = 7, h = 5, next = random(x+y+73);
    const crop = Float64Array.from({length:w*h},()=>next()-.4), image = new Float64Array(width*height);
    for(let row=0;row<h;row++) for(let column=0;column<w;column++) image[(row+y)*width+column+x]=crop[row*w+column];
    const kernel = {width:6,height:7,data:Float64Array.from({length:42},()=>next())};
    const reach = kernelReach([kernel]), plan = {...nearConvolutionPlan(w,h,reach,{}, {tiles:[2,1]}),sourceOrigin:[x,y]};
    const actual = packedConvolution(crop,w,h,kernel,plan,[width,height]), expected = directConvolution(image,width,height,kernel);
    expect(Math.max(...actual.map((v,i)=>Math.abs(v-expected[i])))).toBeLessThan(1e-12);
});

test("contrast bounds include patch backgrounds and clouds, and keep unknown occluders", () => {
    expect(contrastSourceRegion([[317.1,253.2,323.8,258.7],[]],[[316,252,8,8]],[[0,0,640,52]],640,512)).toEqual([0,0,640,261]);
    expect(contrastSourceRegion([[20,30,24,33]],[],[],640,512)).toEqual([19,29,6,5]);
    for(const unknown of [null,undefined,[NaN,0,1,1]])
        expect(contrastSourceRegion([unknown],[],[],640,512)).toEqual([0,0,640,512]);
});

test("the 675 mm far branch packs a power-of-two boundary overflow without changing support",()=>{
    const reach=kernelReach([{width:17,height:17},{width:339,height:339}]);
    expect(farConvolutionPlan(160,128,reach,false)).toMatchObject({packed:false,fftWidth:1024,fftHeight:512});
    expect(farConvolutionPlan(160,128,reach)).toMatchObject({packed:true,singleComplex:true,
        fftWidth:512,fftHeight:512,tileWidth:80,tileHeight:128,reach});
    expect(farConvolutionPlan(64,64,reach).packed).toBe(false);
});

test("packed coarse scattering retains the one-pixel interpolation halo on all four edges",()=>{
    const width=11,height=9,next=random(89),image=Float64Array.from({length:width*height},()=>next()-.4);
    const kernel={width:7,height:6,data:Float64Array.from({length:42},()=>next())};
    const reach=kernelReach([kernel]),plan={...nearConvolutionPlan(width,height,reach,{}, {tiles:[2,1]}),sourceOrigin:[1,1]};
    const actual=packedConvolution(image,width,height,kernel,plan,[width+2,height+2]),padded=new Float64Array((width+2)*(height+2));
    for(let y=0;y<height;y++)padded.set(image.subarray(y*width,(y+1)*width),(y+1)*(width+2)+1);
    const expected=directConvolution(padded,width+2,height+2,kernel);
    expect(Math.max(...actual.map((v,i)=>Math.abs(v-expected[i])))).toBeLessThan(1e-12);
});

test("the live 640 × 512 detector at 4× packs four tiles into one 2048² transform; analysis keeps the reference", () => {
    // Measured live: the single 4096² transform took about 200 ms of GPU time per frame.
    const reach = kernelReach([{width: 257, height: 257}, {width: 513, height: 513}]);
    const reference = {fftWidth: 4096, fftHeight: 4096};
    expect(nearConvolutionPlan(2560, 2048, reach, reference, true)).toMatchObject(
        {packed: true, tilesX: 2, tilesY: 2, tileWidth: 1280, tileHeight: 1024, fftWidth: 2048, fftHeight: 2048});
    expect(nearConvolutionPlan(2560, 2048, reach, reference, false)).toMatchObject(
        {packed: false, tilesX: 1, tilesY: 1, fftWidth: 4096, fftHeight: 4096});
    // A layout is chosen only when its calculated cost is lower: an image whose padded size fills its power of two
    // (1000 + 24 = 1024) keeps the single RG transform, since four tiles would still need 1024² at twice the bytes.
    expect(nearConvolutionPlan(1000, 1000, {low: [12, 12], high: [12, 12]}, {fftWidth: 1024, fftHeight: 1024}, true).packed).toBe(false);
});

// Mirror of _fftPacked's passes along one axis, with the index and twiddle rules of fftButterflyPackedFragment (radix 2,
// first pass when the stage count is odd) and fftButterfly4PackedFragment (radix 4: two radix-2 stages per pass).
function packedAxisPasses(values, inverse) {
    const size = values.length, sign = inverse ? 1 : -1;
    const rotate = ([a, b], [c, s]) => [a * c - b * s, a * s + b * c];
    const twiddle = phase => [Math.cos(phase), Math.sin(phase)];
    let x = values;
    const radix2 = span => x.map((_, coordinate) => {
        const half = span / 2, offset = coordinate % half, base = Math.floor(coordinate / span) * span;
        const rotated = rotate(x[base + offset + half], twiddle(sign * 2 * Math.PI * offset / span));
        const s = coordinate % span < half ? 1 : -1, scale = inverse ? .5 : 1, even = x[base + offset];
        return [(even[0] + s * rotated[0]) * scale, (even[1] + s * rotated[1]) * scale];
    });
    const radix4 = span => x.map((_, coordinate) => {
        const quarter = span / 4, base = Math.floor(coordinate / span) * span, offset = coordinate - base;
        const r = offset % quarter, t = Math.floor(offset / quarter), odd = t === 1 || t === 3;
        const [a0, a1, a2, a3] = [0, 1, 2, 3].map(k => x[base + r + k * quarter]);
        const w1 = twiddle(sign * 2 * Math.PI * r / (2 * quarter)), w2 = twiddle(sign * 2 * Math.PI * r / span);
        const b1 = rotate(a1, w1), b3 = rotate(a3, w1), d = odd ? -1 : 1;
        const y0 = [a0[0] + d * b1[0], a0[1] + d * b1[1]], y2 = [a2[0] + d * b3[0], a2[1] + d * b3[1]];
        const z = rotate(y2, odd ? (inverse ? [-w2[1], w2[0]] : [w2[1], -w2[0]]) : w2);
        const s = t < 2 ? 1 : -1, scale = inverse ? .25 : 1;
        return [(y0[0] + s * z[0]) * scale, (y0[1] + s * z[1]) * scale];
    });
    let span = 1;
    if (Math.log2(size) % 2 === 1) x = radix2(span = 2);
    for (span *= 4; span <= size; span *= 4) x = radix4(span);
    return x;
}

test.each([2, 4, 8, 16, 32, 64, 2048])("the radix-4 pass sequence equals the DFT (%i points, forward and inverse)", size => {
    const next = random(size + 7), reverse = value => {
        let reversed = 0;
        for (let bit = 1; bit < size; bit *= 2) { reversed = reversed * 2 + value % 2; value = Math.floor(value / 2); }
        return reversed;
    };
    const input = Array.from({length: size}, () => [next() - .5, next() - .5]);
    for (const inverse of [false, true]) {
        // fftPackFragment and fftReversePackedFragment place element reverseBits(i) at index i.
        const actual = packedAxisPasses(input.map((_, i) => input[reverse(i)]), inverse);
        const sign = inverse ? 1 : -1, scale = inverse ? 1 / size : 1;
        let error = 0, peak = 0;
        for (let k = 0; k < size; k++) {
            let re = 0, im = 0;
            for (let n = 0; n < size; n++) {
                const c = Math.cos(sign * 2 * Math.PI * k * n / size), s = Math.sin(sign * 2 * Math.PI * k * n / size);
                re += input[n][0] * c - input[n][1] * s; im += input[n][0] * s + input[n][1] * c;
            }
            error = Math.max(error, Math.hypot(actual[k][0] - re * scale, actual[k][1] - im * scale));
            peak = Math.max(peak, Math.hypot(re * scale, im * scale));
        }
        expect(error).toBeLessThan(1e-10 * peak);
    }
});

// Descending DIF: natural input, binary-reversed output. Compare with the independently tested DIT transform,
// then feed that output straight into the inverse DIT, as the live renderer does after spectral multiplication.
test.each([2, 4, 8, 16, 32, 64, 2048])("DIF ordering and the inverse round trip preserve complex samples (%i points)", size => {
    const next = random(size + 19), input = Array.from({length:size}, () => [next()-.5,next()-.5]);
    const reverse = value => {
        let result=0;
        for(let bit=1;bit<size;bit*=2) {result=result*2+value%2;value=Math.floor(value/2);}
        return result;
    };
    const add=(a,b)=>[a[0]+b[0],a[1]+b[1]], sub=(a,b)=>[a[0]-b[0],a[1]-b[1]];
    const rotate=(a,phase)=>[a[0]*Math.cos(phase)-a[1]*Math.sin(phase),a[0]*Math.sin(phase)+a[1]*Math.cos(phase)];
    let values=input;
    for(let span=size;span>=2;span/=4) {
        const radix4=span>=4, part=span/(radix4?4:2), previous=values;
        values=previous.map((_,coordinate)=>{
            const base=Math.floor(coordinate/span)*span,r=(coordinate-base)%part,t=Math.floor((coordinate-base)/part);
            const a=previous[base+r],b=previous[base+r+part],phase=-2*Math.PI*r/span;
            if(!radix4)return t===0?add(a,b):rotate(sub(a,b),phase);
            const c=previous[base+r+2*part],d=previous[base+r+3*part],even=add(a,c),odd=add(b,d);
            if(t<2)return t===0?add(even,odd):rotate(sub(even,odd),2*phase);
            const y=rotate(sub(a,c),phase),z=rotate(sub(b,d),phase-Math.PI/2);
            return t===2?add(y,z):rotate(sub(y,z),2*phase);
        });
    }
    const expected=packedAxisPasses(input.map((_,i)=>input[reverse(i)]),false);
    const restored=packedAxisPasses(values,true);
    const peak=Math.max(...expected.map(([re,im])=>Math.hypot(re,im)));
    expect(Math.max(...values.map((a,i)=>Math.hypot(a[0]-expected[reverse(i)][0],a[1]-expected[reverse(i)][1])))).toBeLessThan(1e-12*peak);
    expect(Math.max(...restored.map((a,i)=>Math.hypot(a[0]-input[i][0],a[1]-input[i][1])))).toBeLessThan(1e-12);
});

test.each([8,16,32,64,1024,2048])("three-stage DIF groups equal the independent DIT transform (%i points)", size=>{
    const next=random(size+23),input=Array.from({length:size},()=>[next()-.5,next()-.5]);
    const reverse=(value,bits)=>{let result=0;for(let i=0;i<bits;i++){result=result*2+value%2;value=Math.floor(value/2);}return result;};
    let values=input;
    for(let span=size;span>=2;) {
        const radix=span>=8?8:span>=4?4:2,q=span/radix,previous=values;
        values=previous.map((_,coordinate)=>{
            const base=Math.floor(coordinate/span)*span,r=(coordinate-base)%q,t=Math.floor((coordinate-base)/q);
            const k=reverse(t,Math.log2(radix));let re=0,im=0;
            for(let j=0;j<radix;j++) {
                const [a,b]=previous[base+r+j*q],phase=-2*Math.PI*(j*k/radix+r*k/span);
                re+=a*Math.cos(phase)-b*Math.sin(phase);im+=a*Math.sin(phase)+b*Math.cos(phase);
            }
            return [re,im];
        });
        span/=radix;
    }
    const expected=packedAxisPasses(input.map((_,i)=>input[reverse(i,Math.log2(size))]),false);
    const peak=Math.max(...expected.map(([re,im])=>Math.hypot(re,im)));
    expect(Math.max(...values.map((a,i)=>{
        const b=expected[reverse(i,Math.log2(size))];return Math.hypot(a[0]-b[0],a[1]-b[1]);
    }))).toBeLessThan(1e-12*peak);
});

test.each([8,16,32,64,128,1024,2048])("three-stage inverse groups equal the independent inverse DIT (%i points)", size => {
    const next = random(size + 41), input = Array.from({length: size}, () => [next() - .5, next() - .5]);
    const rotate = (a, phase) => [a[0] * Math.cos(phase) - a[1] * Math.sin(phase),
        a[0] * Math.sin(phase) + a[1] * Math.cos(phase)];
    const reverse3 = k => ((k & 1) << 2) | (k & 2) | ((k & 4) >> 2);
    let values = input, span = 1;
    const remainder = Math.log2(size) % 3;
    if (remainder) {
        span = 2 ** remainder;
        values = values.flatMap((_, i) => i % span ? [] : packedAxisPasses(values.slice(i, i + span), true));
    }
    for (span *= 8; span <= size; span *= 8) {
        const previous = values, q = span / 8;
        values = previous.map((_, coordinate) => {
            const base = Math.floor(coordinate / span) * span, r = (coordinate - base) % q,
                t = Math.floor((coordinate - base) / q);
            let re = 0, im = 0;
            for (let k = 0; k < 8; k++) {
                const v = rotate(previous[base + r + reverse3(k) * q], 2 * Math.PI * (r * k / span + t * k / 8));
                re += v[0]; im += v[1];
            }
            return [re / 8, im / 8];
        });
    }
    const expected = packedAxisPasses(input, true);
    expect(Math.max(...values.map((a, i) => Math.hypot(a[0] - expected[i][0], a[1] - expected[i][1])))).toBeLessThan(1e-12);
});

test.each([[8,16],[16,32],[1024,2048]])("single-complex FFT fuses stages on both axes without losing a stage (%i × %i)", (width, height) => {
    const pipeline = new ThermalPipeline({}, {analysis:false});
    const passes = [];
    pipeline._target = name => ({texture: name});
    pipeline._pass = (name, fragment, uniforms) => passes.push({name, ...uniforms});
    for (const mode of [0,1,2]) {
        passes.length = 0;
        pipeline._fft("source", width, height, mode, [width,height]);
        expect(passes[0].name).toBe("fftPrepare");
        for (const axis of [0,1]) {
            const axisPasses = passes.filter(p => p.axis === axis), size = axis ? height : width;
            expect(axisPasses).toHaveLength(Math.ceil(Math.log2(size)/2));
            expect(axisPasses.reduce((n, p) => n + (p.name === "fftButterfly4" ? 2 : 1), 0)).toBe(Math.log2(size));
            expect(axisPasses.at(-1).span).toBe(size);
            expect(axisPasses.every(p => p.inverse === (mode === 2))).toBe(true);
        }
    }
});

test("deferred spectra multiply one kernel per frame and stay separate from the active response",()=>{
    const pipeline=new ThermalPipeline({}, {analysis:false});
    const core={width:3,height:3},scatter={width:5,height:5},farCore={width:3,height:3},farScatter={width:5,height:5};
    const kernels={core,scatter,farCore,farScatter,split:{factor:4,fftWidth:64,fftHeight:64}};
    pipeline._prepareSpectrum=jest.fn();
    const work=pipeline._buildOptics(kernels,32,24,true);
    for(let i=0;i<4;i++) {
        expect(work.next().done).toBe(false);
        expect(pipeline._prepareSpectrum).toHaveBeenCalledTimes(i+1);
    }
    expect(work.next().done).toBe(true);
    const calls=pipeline._prepareSpectrum.mock.calls;
    expect(calls.map(c=>[c[0],c[1][0],c[4]])).toEqual([
        ["pendingOpticalSpectrum",core,false],["pendingOpticalSpectrum",scatter,true],
        ["pendingFarSpectrum",farCore,false],["pendingFarSpectrum",farScatter,true]]);
});
