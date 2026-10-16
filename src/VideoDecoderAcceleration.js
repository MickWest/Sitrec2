// The hardwareAcceleration value for an analysis VideoDecoder. Hardware
// decoding is preferred for speed. A caller can prefer software instead (Noise
// Pattern needs decode errors reported, which hardware decoders conceal). When
// the preferred kind is unavailable for this codec (Chrome decodes HEVC only in
// hardware), "no-preference" lets the browser use whatever decoder it has.
// Returns null when the browser cannot decode the configuration.
const support = new Map();

export async function chooseDecoderAcceleration(config, preferred = "prefer-hardware") {
    const key = `${config.codec}|${config.codedWidth}x${config.codedHeight}|${preferred}`;
    if (support.has(key)) return support.get(key);
    let chosen = null;
    for (const candidate of [preferred, "no-preference"]) {
        try {
            const answer = await VideoDecoder.isConfigSupported({...config, hardwareAcceleration: candidate});
            if (answer.supported) { chosen = candidate; break; }
        } catch { /* try the next */ }
    }
    support.set(key, chosen);
    return chosen;
}
