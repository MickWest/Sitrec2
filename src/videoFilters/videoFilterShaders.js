// GLSL ES 3.00 fragment shaders for the video export filter chain.
//
// The analog stage is a genuine composite-video round trip rather than a bag of
// look-alike effects: MODULATE encodes RGB onto a colour subcarrier exactly as a
// broadcast or tape encoder does, and DEMODULATE separates it back out with a notch
// or comb filter. Dot crawl, cross-colour rainbowing, chroma bleed and luma/chroma
// crosstalk then emerge from the arithmetic instead of being drawn on, which is why
// they respond correctly to picture content (fine stripes rainbow, sharp edges crawl).
//
// Everything vertical is indexed by the SIGNAL's line count (uLines: 486 for NTSC,
// 576 for PAL), never by the render raster. A 1080p export of an NTSC signal has 486
// scan lines spread over 1080 rows of pixels, which is what a real upscale looks like;
// keying off the raster instead would give it 1080 scan lines and 1080-line dot crawl.

const COMMON = `
precision highp float;
in vec2 vUV;
out vec4 fragColor;

const float TAU = 6.283185307179586;

float hash11(float p) {
    p = fract(p * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

float luma601(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
`;

// ─── Source resample ─────────────────────────────────────────────────────────
// Fits the exporter's composite canvas into the working raster, letterboxing when the
// chosen signal format has a different aspect (a 16:9 viewport onto 4:3 tape).

export const RESAMPLE_SHADER = `#version 300 es
${COMMON}
uniform sampler2D uSrc;
uniform vec2 uScale;      // fraction of the working raster the picture covers
uniform vec2 uOffset;

void main() {
    vec2 uv = (vUV - uOffset) / uScale;
    if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
        fragColor = vec4(0.0, 0.0, 0.0, 1.0);
        return;
    }
    fragColor = vec4(texture(uSrc, uv).rgb, 1.0);
}`;

// ─── Composite encode ────────────────────────────────────────────────────────
// RGB -> band-limited luma plus chroma modulated onto the colour subcarrier. Also
// where the geometric tape faults live, because on real hardware they displace the
// signal before anything gets a chance to decode it.

export const MODULATE_SHADER = `#version 300 es
${COMMON}
uniform sampler2D uSrc;
uniform vec2 uSize;          // working raster, pixels
uniform float uLines;        // scan lines in the signal format
uniform float uSubcarrier;   // subcarrier cycles across one active line
uniform float uLinePhase;    // subcarrier phase advance per scan line, radians
uniform float uFramePhase;   // phase advance per frame - drives the 4/8-field sequence
uniform float uLumaSigma;    // luma bandwidth limit, pixels
uniform float uChromaSigma;  // chroma bandwidth limit, pixels
uniform float uChromaDelay;  // chroma-to-luma timing error, pixels
uniform float uSharpen;      // pre-emphasis overshoot (VHS edge ringing)
uniform float uJitter;       // time-base error
uniform float uHeadSwitch;   // head-switching tear across the bottom of the frame
uniform float uFrame;
uniform float uMono;         // 1 = monochrome, no subcarrier
uniform float uPal;          // 1 = PAL, V axis alternates per line
uniform float uHueError;     // residual subcarrier phase error the receiver cannot lock out

const int TAPS = 13;

void main() {
    float scan = (1.0 - vUV.y) * uLines;   // 0 at the top line
    float line = floor(scan);
    float vFrac = scan / uLines;

    // Time-base error: a per-line random displacement from the tape's mechanical
    // noise, plus a slow wobble that is strongest just after vertical sync where the
    // capstan servo is still recovering - the wavy top edge of a VHS frame.
    float lineRand = hash21(vec2(line, floor(uFrame))) - 0.5;
    float topSettle = exp(-vFrac / 0.025);
    float wobble = sin(scan * 0.35 + uFrame * 0.7) * topSettle;
    float dx = uJitter * (lineRand * 0.004 + wobble * 0.010);

    // Head switching: the last few lines are read back by the other head and arrive
    // misaligned, tearing the bottom of the picture sideways.
    float headBand = smoothstep(0.014, 0.0, 1.0 - vFrac);
    dx += uHeadSwitch * headBand * (0.02 + 0.05 * (hash11(uFrame * 3.7 + line) - 0.5));

    float texelX = 1.0 / uSize.x;

    // Luma: two gaussians from one set of taps. The narrow one is the bandwidth
    // limit; its difference from the wide one is the pre-emphasis overshoot that
    // makes VHS edges ring. Tap spacing follows the wide sigma so both stay sampled.
    float lumaWide = max(uLumaSigma * 2.2, 0.6);
    float lumaStep = max(lumaWide / 2.5, 0.5);
    float yNarrow = 0.0, yWide = 0.0, wNarrow = 0.0, wWide = 0.0;
    for (int i = 0; i < TAPS; i++) {
        float t = float(i - TAPS / 2) * lumaStep;
        float u = vUV.x + dx + t * texelX;
        // Past either end of the active line there is blanking, not picture. Taking the
        // clamped edge texel instead would hand the decoder a sample whose subcarrier
        // phase does not match where it thinks that sample sits, and it dutifully
        // decodes the mismatch as a bright stripe of colour down the edge of frame.
        // The weights are still normalised over the full kernel, so the picture fades
        // into blanking over a few samples - which is what the real edge does.
        float inside = step(0.0, u) * step(u, 1.0);
        float y = luma601(texture(uSrc, vec2(u, vUV.y)).rgb) * inside;
        float wn = exp(-(t * t) / (2.0 * max(uLumaSigma * uLumaSigma, 0.02)));
        float ww = exp(-(t * t) / (2.0 * lumaWide * lumaWide));
        yNarrow += y * wn; wNarrow += wn;
        yWide += y * ww;   wWide += ww;
    }
    yNarrow /= wNarrow;
    yWide /= wWide;
    float Y = yNarrow + uSharpen * (yNarrow - yWide);

    // Chroma is a far narrower band than luma on every analog format, and on VHS
    // narrower still: colour is recorded under the luma at 629 kHz with about
    // 400 kHz of bandwidth, which is why VHS colour smears past object edges.
    float chromaStep = max(uChromaSigma / 2.5, 0.5);
    vec3 chromaRGB = vec3(0.0);
    float wChroma = 0.0;
    for (int i = 0; i < TAPS; i++) {
        float t = float(i - TAPS / 2) * chromaStep;
        float u = vUV.x + dx + (t + uChromaDelay) * texelX;
        float inside = step(0.0, u) * step(u, 1.0);
        float w = exp(-(t * t) / (2.0 * max(uChromaSigma * uChromaSigma, 0.02)));
        chromaRGB += texture(uSrc, vec2(u, vUV.y)).rgb * w * inside;
        wChroma += w;
    }
    chromaRGB /= wChroma;

    // NTSC modulates the YIQ axes, PAL the YUV axes.
    float c1, c2;
    if (uPal > 0.5) {
        c1 = dot(chromaRGB, vec3(-0.14713, -0.28886, 0.436));    // U
        c2 = dot(chromaRGB, vec3(0.615, -0.51499, -0.10001));    // V
    } else {
        c1 = dot(chromaRGB, vec3(0.5959, -0.2746, -0.3213));     // I
        c2 = dot(chromaRGB, vec3(0.2115, -0.5227, 0.3112));      // Q
    }
    if (uMono > 0.5) { c1 = 0.0; c2 = 0.0; }

    // PAL inverts the V axis on alternate lines, which is what lets a receiver
    // average phase errors away instead of showing them as hue shifts.
    float palSign = (uPal > 0.5 && mod(line, 2.0) >= 1.0) ? -1.0 : 1.0;

    // Phase is referenced to the UNDISPLACED position even though the picture is
    // sampled at the displaced one. That is what real hardware does: the time-base
    // error moves the colour burst along with the picture, and the receiver relocks its
    // oscillator to the burst every line, so the error shows up as geometry and not as
    // hue. Modulating at vUV.x + dx instead makes every wobble a hue shift too, which
    // at VHS jitter levels is a 45-degree swing per line and turns the picture to
    // confetti. What the receiver genuinely cannot lock out is uHueError.
    float hueError = uHueError * ((hash11(uFrame * 0.37) - 0.5) * 1.2
                                + (hash21(vec2(line, floor(uFrame))) - 0.5) * 0.5);
    float phase = TAU * uSubcarrier * vUV.x + line * uLinePhase + uFramePhase + hueError;
    float composite = Y + c1 * sin(phase) + c2 * palSign * cos(phase);

    // R is the composite signal the decoder sees. G/B/A carry the clean Y/C so that a
    // partial "Y/C separation" (S-Video, or a component feed) can bypass the subcarrier.
    fragColor = vec4(composite, Y, c1, c2 * palSign);
}`;

// ─── Composite decode ────────────────────────────────────────────────────────

export const DEMODULATE_SHADER = `#version 300 es
${COMMON}
uniform sampler2D uSignal;
uniform vec2 uSize;
uniform float uLines;
uniform float uSubcarrier;
uniform float uLinePhase;
uniform float uFramePhase;
uniform float uComb;          // 0 = notch filter only (heavy dot crawl), 1 = full line comb
uniform float uYCSeparation;  // 0 = composite, 1 = clean Y/C (S-Video / component)

const int NOTCH_TAPS = 8;

// Separates luma, and multiplies the signal by the reconstructed subcarrier. The
// product still carries a component at twice the subcarrier frequency; removing that,
// and band-limiting the colour, is CHROMA_LOWPASS_SHADER's job. Splitting the two is
// not just tidiness: the low-pass has to sample at a fraction of a subcarrier period
// to cancel that component, which is a different tap spacing from this pass entirely.
void main() {
    float texelX = 1.0 / uSize.x;
    float lineStep = 1.0 / uLines;
    float line = floor((1.0 - vUV.y) * uLines);
    float period = uSize.x / max(uSubcarrier, 1.0);

    vec4 centre = texture(uSignal, vUV);

    // Luma path A: notch. Averaging over exactly one subcarrier period cancels the
    // chroma, at the cost of every luma detail near the subcarrier frequency - and
    // whatever chroma survives becomes the crawling dots along coloured edges.
    float yNotch = 0.0;
    for (int i = 0; i < NOTCH_TAPS; i++) {
        float t = (float(i) / float(NOTCH_TAPS) - 0.5) * period;
        yNotch += texture(uSignal, vec2(vUV.x + t * texelX, vUV.y)).r;
    }
    yNotch /= float(NOTCH_TAPS);

    // Luma path B: comb. Adjacent lines carry the subcarrier in antiphase, so
    // averaging them cancels chroma without touching horizontal luma detail. It
    // fails on vertical colour transitions, where it leaves hanging dots instead.
    float up = texture(uSignal, vec2(vUV.x, vUV.y + lineStep)).r;
    float down = texture(uSignal, vec2(vUV.x, vUV.y - lineStep)).r;
    float yComb = 0.25 * up + 0.5 * centre.r + 0.25 * down;

    float Y = mix(mix(yNotch, yComb, uComb), centre.g, uYCSeparation);

    // The chroma-bearing part of the signal, then synchronous demodulation against the
    // reconstructed subcarrier. Luma energy near the subcarrier survives into this and
    // comes back out as colour - the rainbow on fine stripes.
    float sig = mix(centre.r, centre.r - 0.5 * (up + down), uComb);
    float phase = TAU * uSubcarrier * vUV.x + line * uLinePhase + uFramePhase;

    fragColor = vec4(Y, 2.0 * sig * sin(phase), 2.0 * sig * cos(phase), 1.0);
}`;

export const CHROMA_LOWPASS_SHADER = `#version 300 es
${COMMON}
uniform sampler2D uDemod;     // R = luma, G/B = raw demodulated chroma
uniform sampler2D uSignal;    // the encoder's output, for the clean Y/C bypass
uniform vec2 uSize;
uniform float uLines;
uniform float uSubcarrier;
uniform float uChromaSigma;   // decoder chroma bandwidth, pixels
uniform float uChromaGain;
uniform float uYCSeparation;
uniform float uMono;
uniform float uPal;

const int TAPS = 33;

void main() {
    float texelX = 1.0 / uSize.x;
    float line = floor((1.0 - vUV.y) * uLines);
    float period = uSize.x / max(uSubcarrier, 1.0);

    // Tap spacing must stay at or under a quarter of a subcarrier period. The
    // demodulation product carries a term at twice the subcarrier frequency, and four
    // taps spread evenly across one period sum it to zero; spacing them a whole period
    // apart instead samples that term at the same phase every time, and it survives
    // the filter as a violent colour ripple rather than being removed by it.
    float step = min(period * 0.25, max(uChromaSigma * 0.25, 0.25));

    float c1 = 0.0, c2 = 0.0, wsum = 0.0;
    for (int i = 0; i < TAPS; i++) {
        float t = float(i - TAPS / 2) * step;
        float w = exp(-(t * t) / (2.0 * max(uChromaSigma * uChromaSigma, 0.02)));
        vec4 d = texture(uDemod, vec2(vUV.x + t * texelX, vUV.y));
        c1 += d.g * w;
        c2 += d.b * w;
        wsum += w;
    }
    c1 = c1 / wsum * uChromaGain;
    c2 = c2 / wsum * uChromaGain;

    float palSign = (uPal > 0.5 && mod(line, 2.0) >= 1.0) ? -1.0 : 1.0;
    c2 *= palSign;

    // Bypass toward the clean chroma the encoder stashed, for S-Video / component.
    vec4 clean = texture(uSignal, vUV);
    c1 = mix(c1, clean.b, uYCSeparation);
    c2 = mix(c2, clean.a * palSign, uYCSeparation);

    float Y = texture(uDemod, vUV).r;

    vec3 rgb;
    if (uMono > 0.5) {
        rgb = vec3(Y);
    } else if (uPal > 0.5) {
        rgb = vec3(
            Y + 1.13983 * c2,
            Y - 0.39465 * c1 - 0.58060 * c2,
            Y + 2.03211 * c1
        );
    } else {
        rgb = vec3(
            Y + 0.956 * c1 + 0.619 * c2,
            Y - 0.272 * c1 - 0.647 * c2,
            Y - 1.106 * c1 + 1.703 * c2
        );
    }

    fragColor = vec4(rgb, 1.0);
}`;

// ─── Tape and display artifacts ──────────────────────────────────────────────
// What happens to the decoded picture rather than to the signal: tape grain,
// dropouts, the interlace comb, phosphor persistence, scan lines.

export const TAPE_SHADER = `#version 300 es
${COMMON}
uniform sampler2D uSrc;
uniform sampler2D uPrev;
uniform vec2 uSize;
uniform float uLines;
uniform float uNoiseLevel;        // 0-1 master tape noise level
uniform float uLumaNoiseCell;     // luma grain width, pixels - set by the luma bandwidth
uniform float uChromaNoiseCell;   // chroma smear width, pixels - set by the chroma bandwidth
uniform float uDropouts;
uniform float uInterlace;
uniform float uGhosting;
uniform float uScanlines;
uniform float uChromaVBlur;    // PAL delay line / VHS vertical chroma smear
uniform float uFrame;
uniform float uMono;
uniform float uPal;

// Smooth band-limited noise along one scan line, in cells cellPx wide. Interpolated
// rather than stepped, because a stepped one reads as a mosaic of hard rectangles and
// nothing on a tape looks like that. A head reads one line per pass, so successive
// lines - and successive frames - draw completely independent fields.
float lineNoise(float xPx, float lineSeed, float seed, float cellPx) {
    float p = xPx / max(cellPx, 0.5);
    float i = floor(p);
    float f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(hash21(vec2(i, lineSeed + seed)), hash21(vec2(i + 1.0, lineSeed + seed)), f) - 0.5;
}

// The luma grain of one line. FM demodulation noise has a triangular spectrum, so
// most of its power sits in the finest octave the luma channel carries - which is
// what makes tape grain fine horizontal texture rather than blobs.
float tapeLumaNoise(float xPx, float lineSeed, float cellPx) {
    return lineNoise(xPx, lineSeed, 11.0, cellPx) * 0.4
         + lineNoise(xPx, lineSeed, 37.0, max(cellPx * 0.4, 1.0)) * 0.6;
}

// One dropout, as it STARTS on line l: vec4(hit, xStart, xLength, concealed).
//
// A dropout is the head losing RF contact with the tape - a missing patch of
// oxide, a crease, debris. Two things about the real artifact drive this:
//
//  - It costs a FRACTION of a scan line. A line is 63.5 us and a dropout rarely
//    reaches that, so lengths are skewed hard toward short.
//  - Almost every VCR CONCEALS it. The dropout compensator detects the RF
//    envelope collapsing and switches in the previous line from a 1H delay, and
//    a defect spanning several lines keeps repeating that same last good line.
//    The classic bright streak is the unconcealed minority.
vec4 dropoutStart(float l, float frame, float amount) {
    if (hash21(vec2(l, frame * 17.0)) >= amount * 0.045) return vec4(0.0);
    float r1 = hash21(vec2(l + 5.0, frame * 23.0));
    float r2 = hash21(vec2(l + 9.0, frame * 31.0));
    float r3 = hash21(vec2(l + 13.0, frame * 41.0));
    float len = 0.012 + 0.30 * r2 * r2 * r2;      // cubic: mostly a few percent of the line
    return vec4(1.0, r1 * (1.0 - len), len, step(0.22, r3));
}

void main() {
    float lineStep = 1.0 / uLines;
    float scan = (1.0 - vUV.y) * uLines;
    float line = floor(scan);

    vec3 c = texture(uSrc, vUV).rgb;

    // Vertical chroma smear: keep this line's luma, average its colour with the
    // neighbours. PAL does it deliberately in the delay line; VHS gets it for free
    // from recording colour at a fraction of the luma bandwidth.
    if (uChromaVBlur > 0.001) {
        vec3 up = texture(uSrc, vec2(vUV.x, vUV.y + lineStep)).rgb;
        vec3 dn = texture(uSrc, vec2(vUV.x, vUV.y - lineStep)).rgb;
        vec3 avg = (up + dn + c) / 3.0;
        float y = luma601(c);
        c = mix(c, avg + (y - luma601(avg)), uChromaVBlur);
    }

    // Interlace: alternate lines come from the previous field, so anything moving
    // splits into the comb-toothed edges that give interlaced video away.
    if (uInterlace > 0.001 && mod(line, 2.0) == mod(uFrame, 2.0)) {
        c = mix(c, texture(uPrev, vUV).rgb, uInterlace);
    }

    // Phosphor persistence / tape ghosting.
    if (uGhosting > 0.001) {
        c = mix(c, max(c, texture(uPrev, vUV).rgb * 0.92), uGhosting);
    }

    // Tape noise. Luma and chroma are recorded through completely different channels
    // on a colour-under format, so their noise looks completely different too, and the
    // cell widths come from each channel's own bandwidth rather than a fixed number.
    if (uNoiseLevel > 0.0005) {
        float xPx = vUV.x * uSize.x;
        float lineSeed = line + floor(uFrame) * 131.0;

        // Head-to-tape contact is worst approaching the switch point, so the bottom of
        // the frame is reliably the noisiest part of any tape.
        float wear = 1.0 + 1.2 * smoothstep(0.88, 1.0, scan / uLines);

        float nLuma = tapeLumaNoise(xPx, lineSeed, uLumaNoiseCell);

        // FM noise amplitude barely depends on the signal, but it reads far more
        // strongly against a dark picture than a bright one.
        c += vec3(nLuma) * (uNoiseLevel * 0.35 * wear * (0.75 + 0.5 * (1.0 - luma601(c))));

        if (uMono < 0.5) {
            // Colour rides a far narrower channel than luma, so its noise arrives as
            // broad horizontal smears - about ten times the width of the luma grain -
            // rather than as speckle. Two independent fields drive the two
            // colour-difference axes, so the hue wanders instead of sliding up and
            // down a single red-green line; and because the delta is built from those
            // axes it moves colour without disturbing luma.
            float n1 = lineNoise(xPx, lineSeed, 61.0, uChromaNoiseCell);
            float n2 = lineNoise(xPx, lineSeed, 89.0, uChromaNoiseCell);
            vec3 delta = (uPal > 0.5)
                ? vec3(1.13983 * n2, -0.39465 * n1 - 0.58060 * n2, 2.03211 * n1)
                : vec3(0.956 * n1 + 0.619 * n2, -0.272 * n1 - 0.647 * n2, -1.106 * n1 + 1.703 * n2);
            c += delta * (uNoiseLevel * 0.5 * wear);
        }
    }

    // Dropouts. See dropoutStart() for what the artifact actually is; here we look
    // back up to three lines for a defect that started there and still covers this
    // one, so a tall defect repeats ONE source line rather than each line copying
    // its own neighbour.
    if (uDropouts > 0.001) {
        float frame = floor(uFrame);
        float xPx = vUV.x * uSize.x;
        for (int k = 0; k < 3; k++) {
            float l0 = line - float(k);
            vec4 d = dropoutStart(l0, frame, uDropouts);
            float height = 1.0 + floor(2.99 * hash21(vec2(l0 + 21.0, frame * 53.0)));
            if (d.x < 0.5 || float(k) >= height) continue;

            // No hard edges: the RF envelope collapses and recovers over a few
            // microseconds, so a dropout fades in and out along the line.
            float edge = min(d.z * 0.35, 0.005);
            float m = smoothstep(d.y, d.y + edge, vUV.x)
                    * (1.0 - smoothstep(d.y + d.z - edge, d.y + d.z, vUV.x));
            if (m < 0.002) continue;

            vec3 repl;
            if (d.w > 0.5) {
                // Concealed: the 1H delay serves the last good line. It serves the
                // line as PLAYED, grain and all, so carry that line's grain across
                // too - a patch that is cleaner than its surroundings reads as a
                // paste, which is exactly what the old flat bar looked like.
                float srcY = min(vUV.y + lineStep * (float(k) + 1.0), 1.0);
                repl = texture(uSrc, vec2(vUV.x, srcY)).rgb;
                if (uNoiseLevel > 0.0005) {
                    float n = tapeLumaNoise(xPx, (l0 - 1.0) + frame * 131.0, uLumaNoiseCell);
                    repl += vec3(n) * (uNoiseLevel * 0.35 * (0.75 + 0.5 * (1.0 - luma601(repl))));
                }
            } else {
                // Unconcealed: the demodulator is running with no carrier, so this
                // is noise pinned near the top of the range - bright and grainy,
                // never a flat bar. Chroma drops out with it, hence monochrome.
                float n = lineNoise(xPx, l0 + frame * 7.0, 61.0, max(uLumaNoiseCell, 1.5));
                repl = vec3(clamp(0.72 + n * 0.55, 0.0, 1.0));
            }
            c = mix(c, repl, m);
        }
    }

    if (uScanlines > 0.001) {
        c *= 1.0 - uScanlines * 0.5 * (0.5 - 0.5 * cos(scan * TAU));
    }

    fragColor = vec4(c, 1.0);
}`;

// ─── Bloom helpers for the off-a-screen stage ────────────────────────────────

export const BRIGHT_SHADER = `#version 300 es
${COMMON}
uniform sampler2D uSrc;
uniform float uThreshold;

void main() {
    vec3 lin = pow(max(texture(uSrc, vUV).rgb, 0.0), vec3(2.2));
    float over = max(luma601(lin) - uThreshold, 0.0) / max(1.0 - uThreshold, 0.001);
    fragColor = vec4(lin * over, 1.0);
}`;

export const BLUR_SHADER = `#version 300 es
${COMMON}
uniform sampler2D uSrc;
uniform vec2 uDirection;    // one texel step along the axis being blurred

const int TAPS = 9;

void main() {
    vec3 sum = vec3(0.0);
    float wsum = 0.0;
    for (int i = 0; i < TAPS; i++) {
        float t = float(i - TAPS / 2);
        float w = exp(-(t * t) / 8.0);
        sum += texture(uSrc, vUV + uDirection * t).rgb * w;
        wsum += w;
    }
    fragColor = vec4(sum / wsum, 1.0);
}`;

// ─── Recorded off a screen ───────────────────────────────────────────────────
// A phone pointed at a monitor: the lens and its distortions, the screen's pixel
// grid beating against the sensor grid, the refresh beat bar, an auto-exposure that
// clips what it cannot hold, reflections in the glass, and an unsteady pair of hands.

export const SCREEN_SHADER = `#version 300 es
${COMMON}
uniform sampler2D uSrc;
uniform sampler2D uBloom;
uniform vec2 uSize;
uniform float uAspect;        // output raster w/h
uniform float uCameraAspect;  // the camera's own frame w/h, letterboxed into the output
uniform vec2 uFill;           // fraction of the camera frame the screen covers, x and y
uniform vec4 uHandheld;       // x/y offset (frame-height units), rotation (radians), extra zoom
uniform float uBarrel;
uniform float uKeystone;
uniform float uAberration;
uniform float uEdgeSoftness;
uniform float uGridPitch;     // source pixels per screen pixel - what the moire beats against
uniform float uGridDepth;
uniform float uBeat;
uniform float uBeatBars;
uniform float uBeatPos;
uniform float uExposure;
uniform float uKnee;
uniform float uClip;
uniform float uBlackCrush;
uniform float uBlackLift;
uniform float uBloomAmount;
uniform float uGlare;
uniform vec2 uGlarePos;
uniform vec2 uBezel;          // bezel width around the screen, in screen uv (x, y)
uniform float uBezelLevel;    // bezel brightness, LINEAR light
uniform float uVignette;
uniform float uNoise;
uniform float uFrame;

// Map an output pixel back to the point on the screen being filmed.
//
// Three coordinate systems, in order: the output raster, the camera's own frame (which is
// letterboxed into the output when their aspects differ), and the screen the camera is
// pointed at. How much of the frame that screen covers is uFill, worked out on the CPU
// from the lens angle, the screen's width and how far away it is - so moving the camera
// back really does make the screen smaller and let more of the dark room in.
//
// The framed output parameter comes back 0 outside the camera's frame - the letterbox bar.
vec2 screenUV(vec2 uv, float scale, out float framed) {
    // Output raster -> camera frame.
    float fitX = (uCameraAspect > uAspect) ? 1.0 : uCameraAspect / uAspect;
    float fitY = (uCameraAspect > uAspect) ? uAspect / uCameraAspect : 1.0;
    vec2 c = vec2((uv.x - 0.5) / fitX, (uv.y - 0.5) / fitY);
    framed = step(abs(c.x), 0.5) * step(abs(c.y), 0.5);

    // Into an isotropic space, so rotation and barrel distortion stay circular.
    vec2 p = vec2(c.x * uCameraAspect, c.y);

    // Undo the handheld camera motion.
    p -= uHandheld.xy;
    float s = sin(-uHandheld.z), co = cos(-uHandheld.z);
    p = vec2(p.x * co - p.y * s, p.x * s + p.y * co);

    // Barrel distortion, as a phone's wide lens has: dividing (rather than
    // multiplying) pulls the sampled radius in, so the picture stretches outward at
    // the edges rather than exposing anything past them.
    float r2 = dot(p, p);
    p /= 1.0 + uBarrel * r2 + uBarrel * 0.35 * r2 * r2;
    p *= scale;

    // The phone is never quite square-on to the screen.
    p.x *= 1.0 + uKeystone * p.y;
    p.y *= 1.0 + uKeystone * 0.35 * p.x;

    // Camera frame -> the screen in it. uHandheld.w is a manual crop on top of the
    // framing the physical setup already decided.
    vec2 fill = max(uFill * max(uHandheld.w, 0.01), vec2(0.001));
    return vec2(0.5 + (p.x / uCameraAspect) / fill.x, 0.5 + p.y / fill.y);
}

void main() {
    float framed, ignored;
    vec2 uvG = screenUV(vUV, 1.0, framed);
    vec2 uvR = screenUV(vUV, 1.0 - uAberration, ignored);
    vec2 uvB = screenUV(vUV, 1.0 + uAberration, ignored);

    // Past the edge of the screen is the monitor's bezel and then the dark room behind
    // it; past the edge of the camera's frame is the letterbox.
    float onScreen = step(0.0, uvG.x) * step(uvG.x, 1.0) * step(0.0, uvG.y) * step(uvG.y, 1.0);
    float inside = framed * onScreen;

    // The bezel is the screen's rectangle grown by uBezel and with the screen taken back
    // out. It is a real object in the room, so it goes in before the exposure curve and
    // gets metered, vignetted and grained along with everything else.
    float onBezel = step(-uBezel.x, uvG.x) * step(uvG.x, 1.0 + uBezel.x)
                  * step(-uBezel.y, uvG.y) * step(uvG.y, 1.0 + uBezel.y);
    float bezel = framed * onBezel * (1.0 - onScreen);

    // Lenses are softest at the edge of frame.
    vec2 blurStep = (uEdgeSoftness * dot(uvG - 0.5, uvG - 0.5) * 4.0) / uSize;
    vec3 c = vec3(
        texture(uSrc, uvR + blurStep).r,
        texture(uSrc, uvG).g,
        texture(uSrc, uvB - blurStep).b
    ) * inside;

    vec3 lin = pow(max(c, 0.0), vec3(2.2));

    // The screen's own pixel structure. Aliasing between this pitch and the output
    // raster is what produces the moire - it is not drawn on, it is the beat itself.
    if (uGridDepth > 0.001) {
        float gx = 0.5 + 0.5 * cos(TAU * uvG.x * uSize.x * uGridPitch);
        float gy = 0.5 + 0.5 * cos(TAU * uvG.y * uSize.y * uGridPitch);
        lin *= mix(1.0, 1.0 - uGridDepth * (0.6 * gy + 0.4 * gx), inside);
    }

    // Refresh beat: the shutter and the display refresh are not locked, so a soft
    // band drifts through the frame.
    if (uBeat > 0.001) {
        lin *= 1.0 + uBeat * sin(TAU * (uvG.y * uBeatBars - uBeatPos));
    }

    // Sampled where the SCREEN is, not where the output pixel is. The bloom texture is
    // built from the unwarped screen content, so reading it at the output position adds a
    // full-size ghost of the picture over a picture the camera geometry has since moved,
    // scaled and rotated. Harmless while the geometry was near enough the identity;
    // glaringly wrong the moment the camera stands back and the screen shrinks in frame.
    lin += texture(uBloom, uvG).rgb * uBloomAmount * inside;

    // A reflection sitting on the glass - and only on the glass. Unmasked it spread
    // across the whole frame, and since auto exposure opens up for a mostly dark frame it
    // was then multiplied into a bright fog with the screen adrift in the middle of it.
    if (uGlare > 0.001) {
        vec2 g = (vUV - uGlarePos) * vec2(uAspect, 1.0);
        lin += uGlare * exp(-dot(g, g) * 6.0) * inside;
    }

    lin += uBezelLevel * bezel;

    lin *= uExposure;

    // Auto-exposure shoulder. Below the knee the response is linear; above it the
    // sensor runs out of well capacity and everything folds toward white. uClip
    // straightens the shoulder into a hard clip - a phone that has metered for a
    // dark room and let the screen blow out completely.
    vec3 over = max(lin - uKnee, 0.0);
    float span = max(1.0 - uKnee, 0.001);
    vec3 shoulder = uKnee + span * (1.0 - exp(-over / span));
    lin = mix(mix(lin, shoulder, step(uKnee, lin)), min(lin, 1.0), uClip);

    vec3 srgb = pow(max(lin, 0.0), vec3(1.0 / 2.2));

    // Crushed blacks, then the sensor's own black lift on top of them.
    srgb = max(srgb - uBlackCrush, 0.0) / max(1.0 - uBlackCrush, 0.001);
    srgb = srgb * (1.0 - uBlackLift) + uBlackLift * inside;

    if (uVignette > 0.001) {
        vec2 v = (vUV - 0.5) * vec2(uAspect, 1.0);
        srgb *= 1.0 - uVignette * pow(clamp(dot(v, v) * 1.6, 0.0, 1.0), 1.5);
    }

    if (uNoise > 0.001) {
        srgb += (hash21(vUV * uSize + uFrame * 13.7) - 0.5) * uNoise * (1.4 - luma601(srgb));
    }

    fragColor = vec4(clamp(srgb, 0.0, 1.0), 1.0);
}`;

// Brings the analog chain's wider internal raster back to the export raster. A box
// average over exactly the decimation ratio, because a plain bilinear shrink would
// alias the dot crawl into a coarse crawling pattern that was never in the signal.
export const DOWNSAMPLE_SHADER = `#version 300 es
${COMMON}
uniform sampler2D uSrc;
uniform float uRatio;      // source pixels per destination pixel
uniform float uSrcWidth;

const int MAX_TAPS = 8;

void main() {
    float taps = clamp(floor(uRatio), 1.0, float(MAX_TAPS));
    if (taps <= 1.0) {
        fragColor = vec4(texture(uSrc, vUV).rgb, 1.0);
        return;
    }
    vec3 sum = vec3(0.0);
    for (int i = 0; i < MAX_TAPS; i++) {
        if (float(i) >= taps) break;
        float offset = (float(i) + 0.5) / taps - 0.5;   // spread across one output pixel
        sum += texture(uSrc, vec2(vUV.x + offset * uRatio / uSrcWidth, vUV.y)).rgb;
    }
    fragColor = vec4(sum / taps, 1.0);
}`;

// Straight copy to the output canvas when the off-a-screen stage is switched off.
export const COPY_SHADER = `#version 300 es
${COMMON}
uniform sampler2D uSrc;

void main() {
    fragColor = vec4(clamp(texture(uSrc, vUV).rgb, 0.0, 1.0), 1.0);
}`;
