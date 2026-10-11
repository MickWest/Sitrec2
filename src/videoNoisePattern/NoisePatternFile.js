import {ALL_FORMATS, BlobSource, BufferSource, EncodedPacketSink, Input} from "mediabunny";
import {createNoisePatternWorkerSession, estimateFeatureBytes, NOISE_PATTERN_CACHE_LIMIT, startNoisePatternJob} from "./NoisePatternJob";

export const isNoisePatternVideoName = name => /\.(mp4|mov|m4v|webm|mkv|avi|ts|mts|m2ts|flv|ogv)$/i.test(name);

export function normalizeNoisePatternFolderLimit(value) {
    const minutes = Number(value);
    return Number.isFinite(minutes) && minutes > 0 ? Math.max(0.1, Math.min(120, minutes)) : 2;
}

export function checkNoisePatternAbort(signal) {
    if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
}

// Keep decode order in chunks and presentation order in the timestamp map. B frames
// must not turn the lag measurement into a measurement of packet order.
export function noisePatternSourceFromPackets(config, packets, filename) {
    const chunks = packets.map(packet => ({
        type: packet.type,
        timestamp: Math.round(packet.timestamp * 1e6),
        duration: Math.round(packet.duration * 1e6),
        byteLength: packet.data.byteLength,
        copyTo: destination => new Uint8Array(destination).set(packet.data),
    }));
    const timestampToChunkIndex = new Map(chunks.map(c => c.timestamp).sort((a, b) => a - b).map((timestamp, i) => [timestamp, i]));
    return {filename, config, chunks, timestampToChunkIndex,
        groups: chunks.flatMap((chunk, frame) => chunk.type === "key" ? [{frame}] : [])};
}

export async function readNoisePatternFile(file, options, {signal, onProgress} = {}) {
    checkNoisePatternAbort(signal);
    const source = typeof Blob !== "undefined" && file instanceof Blob
        ? new BlobSource(file) : new BufferSource(await file.arrayBuffer());
    const input = new Input({source, formats: ALL_FORMATS});
    const abort = () => input.dispose();
    signal?.addEventListener("abort", abort, {once: true});
    try {
        checkNoisePatternAbort(signal);
        const track = await input.getPrimaryVideoTrack();
        if (!track) throw new Error("No video track found");
        const config = await track.getDecoderConfig();
        if (!config) throw new Error("Unsupported video codec");
        if (typeof VideoDecoder !== "undefined" && !(await VideoDecoder.isConfigSupported(config)).supported) {
            throw new Error(`Video decoder does not support ${config.codec}`);
        }
        const limitMinutes = normalizeNoisePatternFolderLimit(options.limitMinutes);
        const firstTime = await track.getFirstTimestamp();
        const duration = await track.getDurationFromMetadata();
        const cutoff = firstTime + limitMinutes * 60;
        const packets = [];
        let encodedBytes = 0, analysisFrames = 0, capped = false, autoReduced = false, lastKeyIndex = 0;
        for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, {verifyKeyPackets: true})) {
            checkNoisePatternAbort(signal);
            // Finish the GOP containing the cutoff so B frames before the cutoff
            // retain their future reference pictures. Only the prefix is analyzed.
            if (packet.type === "key" && packet.timestamp >= cutoff) { capped = true; break; }
            const nextFrames = analysisFrames + (packet.timestamp < cutoff ? 1 : 0);
            const featureBytes = estimateFeatureBytes(config.codedWidth, nextFrames, options.detail);
            if (featureBytes > NOISE_PATTERN_CACHE_LIMIT || encodedBytes + packet.byteLength > 512 * 1024 * 1024) {
                // Prefer a complete GOP. A source with one very long GOP can also
                // decode a packet prefix: reference packets precede their B frames.
                if (lastKeyIndex > 0) packets.length = lastKeyIndex;
                analysisFrames = packets.filter(p => p.timestamp < cutoff).length;
                capped = autoReduced = true;
                break;
            }
            if (packet.type === "key") lastKeyIndex = packets.length;
            packets.push(packet);
            analysisFrames = nextFrames;
            if (packet.timestamp >= cutoff) capped = true;
            encodedBytes += packet.byteLength;
            if (packets.length % 256 === 0) {
                onProgress?.({stage: "reading", progress: {done: packets.length, total: 0}});
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }
        checkNoisePatternAbort(signal);
        if (!analysisFrames) throw new Error("No video frames fit in the scan region");
        const video = noisePatternSourceFromPackets(config, packets, file.name);
        const lastEnd = packets.reduce((end, p) => Math.max(end, p.timestamp + p.duration), firstTime);
        video.scan = {limitMinutes, analysisFrames, autoReduced, capped: capped || duration > cutoff,
            analyzedSeconds: Math.min(limitMinutes * 60, lastEnd - firstTime), videoDurationSeconds: duration == null ? null : duration - firstTime};
        return video;
    } finally {
        signal?.removeEventListener("abort", abort);
        input.dispose();
    }
}

export async function analyzeNoisePatternFile(file, options, {signal, onProgress} = {}) {
    const source = await readNoisePatternFile(file, options, {signal, onProgress});
    checkNoisePatternAbort(signal);
    const session = createNoisePatternWorkerSession();
    let job;
    const abort = () => { job?.cancel(); session.dispose(); };
    try {
        job = startNoisePatternJob(source, {...options, range: {from: 0, to: source.scan.analysisFrames - 1}, frames: "all"}, {...session.hooks, onUpdate: onProgress});
        signal?.addEventListener("abort", abort, {once: true});
        if (signal?.aborted) abort();
        const result = await job.promise;
        checkNoisePatternAbort(signal);
        result.scan = source.scan;
        return result;
    } finally {
        signal?.removeEventListener("abort", abort);
        session.dispose();
    }
}
