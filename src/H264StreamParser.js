// Emits complete Annex-B keyframe groups. Retains split start codes and slices
// across network chunks, using a growing buffer to avoid rescanning/copying the file.
export class H264StreamParser {
    constructor() {
        this.buffer = new Uint8Array(65536);
        this.length = 0;
        this.scan = 0;
        this.hasKeyframe = false;
    }

    append(bytes) {
        if (this.length + bytes.length > this.buffer.length) {
            const next = new Uint8Array(Math.max(this.buffer.length * 2, this.length + bytes.length));
            next.set(this.buffer.subarray(0, this.length));
            this.buffer = next;
        }
        this.buffer.set(bytes, this.length);
        this.length += bytes.length;
        const groups = [];
        while (this.scan + 5 < this.length) {
            const i = this.scan;
            const b = this.buffer;
            const prefix = b[i] === 0 && b[i + 1] === 0
                ? (b[i + 2] === 1 ? 3 : b[i + 2] === 0 && b[i + 3] === 1 ? 4 : 0) : 0;
            if (!prefix) { this.scan++; continue; }
            // first_mb_in_slice == 0 is encoded as a leading one bit.
            if ((b[i + prefix] & 31) === 5 && (b[i + prefix + 1] & 128)) {
                if (this.hasKeyframe) {
                    groups.push(b.slice(0, i).buffer);
                    b.copyWithin(0, i, this.length);
                    this.length -= i;
                    this.scan = 0;
                }
                this.hasKeyframe = true;
            }
            this.scan += prefix + 1;
        }
        return groups;
    }

    finish() {
        const result = this.buffer.slice(0, this.length).buffer;
        this.length = 0;
        this.buffer = new Uint8Array(0);
        return result.byteLength ? [result] : [];
    }
}
