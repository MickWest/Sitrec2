import {fftInPlace} from "../src/audio/AudioFFT";

test("shared audio FFT agrees with an independent direct DFT",()=>{
    const source=[0.3,1,-0.2,0.6,0.1,-0.5,0.9,0.2];
    for(const ArrayType of [Float32Array,Float64Array]) {
        const re=new ArrayType(source),im=new ArrayType(source.length);
        fftInPlace(re,im);
        for(let k=0;k<source.length;k++) {
            let expectedRe=0,expectedIm=0;
            for(let j=0;j<source.length;j++) {
                expectedRe+=source[j]*Math.cos(-2*Math.PI*k*j/source.length);
                expectedIm+=source[j]*Math.sin(-2*Math.PI*k*j/source.length);
            }
            expect(re[k]).toBeCloseTo(expectedRe,5);expect(im[k]).toBeCloseTo(expectedIm,5);
        }
    }
});
