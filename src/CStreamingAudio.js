// Schedule decoded audio pieces on the audio clock. Each source owns immutable
// samples; extending the download never changes a buffer that's already playing.
export class CStreamingAudio {
    constructor(owner) {
        this.owner = owner;
        this.buffers = [];
        this.sources = new Set();
        this.bufferedUntil = 0;
        this.complete = false;
    }

    append(data) {
        const context = this.owner.audioContext;
        const buffer = context.createBuffer(data.numberOfChannels, data.numberOfFrames, data.sampleRate);
        for (let channel = 0; channel < data.numberOfChannels; channel++) {
            data.copyTo(buffer.getChannelData(channel), {planeIndex: channel, format: 'f32-planar'});
        }
        const start = data.timestamp / 1e6;
        this.buffers.push({buffer, start, end: start + buffer.duration});
        this.bufferedUntil = start + buffer.duration;
    }

    isReady(frame, fps) {
        return this.owner.isMuted || !this.owner.isInitialized || this.complete ||
            frame / (this.owner.originalFps || fps) + 0.05 <= this.bufferedUntil;
    }

    play(frame, fps, speed = 1) {
        const owner = this.owner;
        const context = owner.audioContext;
        if (!context || owner.isMuted || speed <= 0) { this.pause(); return; }
        if (context.state === 'suspended') context.resume().catch(() => {});
        const now = context.currentTime;
        const position = frame / (owner.originalFps || fps);
        const rate = speed * fps / (owner.originalFps || fps);
        const predicted = this.anchor ? this.anchor.position + (now - this.anchor.time) * this.anchor.rate : NaN;
        if (!this.anchor || this.anchor.rate !== rate || Math.abs(predicted - position) > 0.08) {
            this.pause();
            this.anchor = {position, time: now, rate};
            this.next = this.buffers.findIndex(part => part.end > position);
            if (this.next < 0) this.next = this.buffers.length;
        }
        owner.isPlaying = true;
        owner.gainNode.gain.value = owner.volume;
        while (this.next < this.buffers.length) {
            const part = this.buffers[this.next];
            const when = this.anchor.time + (part.start - this.anchor.position) / rate;
            if (when > now + 1) break;
            this.next++;
            const offset = Math.max(0, (now - when) * rate);
            if (offset >= part.buffer.duration) continue;
            const source = context.createBufferSource();
            source.buffer = part.buffer;
            source.playbackRate.value = rate;
            source.connect(owner.gainNode);
            this.sources.add(source);
            source.onended = () => { this.sources.delete(source); source.disconnect(); };
            source.start(Math.max(now, when), offset);
        }
    }

    pause() {
        for (const source of this.sources) {
            source.onended = null;
            try { source.stop(); } catch (_) { /* already ended */ }
            source.disconnect();
        }
        this.sources.clear();
        this.anchor = null;
        this.owner.isPlaying = false;
    }

    dispose() { this.pause(); this.buffers = []; }
}
