// A resumable, sequential byte source. Consumers receive contiguous bytes only;
// complete file bytes are exposed only after a verified EOF.
export class CVideoByteStream {
    constructor(url, {onChunk, onProgress = () => {}, timeoutMs = 10000} = {}) {
        this.url = url;
        this.onChunk = onChunk;
        this.onProgress = onProgress;
        this.timeoutMs = timeoutMs;
        this.received = 0;
        this.total = null;
        this.parts = [];
        this.controller = new AbortController();
        this.status = 'downloading';
    }

    async download() {
        this.status = 'downloading';
        this.error = null;
        let retries = 0;
        while (this.total === null || this.received < this.total) {
            try {
                await this.readResponse();
                retries = 0;
            } catch (error) {
                if (this.controller.signal.aborted) throw error;
                if ((error.name === 'TimeoutError' || error.name === 'TypeError') && retries++ < 1) {
                    this.status = 'retrying';
                    this.onProgress(this);
                    continue;
                }
                this.status = 'failed';
                // Only transport failures leave the parser safe to resume.
                // Bad content or changed objects need a fresh parser/download.
                this.canResume = error.name === 'TimeoutError' || error.name === 'TypeError';
                this.error = error;
                this.onProgress(this);
                throw error;
            }
        }
        const data = new Uint8Array(this.received);
        let offset = 0;
        for (const part of this.parts) {
            data.set(part, offset);
            offset += part.byteLength;
        }
        this.parts = [];
        this.status = 'complete';
        this.onProgress(this);
        return data.buffer;
    }

    async readResponse() {
        const request = new AbortController();
        const abort = () => request.abort(this.controller.signal.reason);
        this.controller.signal.addEventListener('abort', abort, {once: true});
        if (this.controller.signal.aborted) abort();
        let timer;
        const timed = async operation => {
            timer = setTimeout(() => request.abort(new DOMException('Video download stalled', 'TimeoutError')), this.timeoutMs);
            try { return await operation(); }
            catch (error) { throw request.signal.aborted ? request.signal.reason : error; }
            finally { clearTimeout(timer); }
        };
        let reader;
        try {
            const start = this.received;
            const response = await timed(() => fetch(this.url, {
                headers: {Range: `bytes=${start}-`}, signal: request.signal,
            }));
            if (!response.ok) throw new Error(`Video download failed (HTTP ${response.status})`);
            const etag = response.headers.get('etag');
            if (this.etag && etag && etag !== this.etag) throw new Error('Video changed during download. Reload it to continue.');
            if (etag) this.etag = etag;
            let responseEnd;
            let skip = 0;
            if (response.status === 206) {
                const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '');
                if (!range || Number(range[1]) !== start || Number(range[2]) < start || Number(range[2]) >= Number(range[3])) {
                    throw new Error('Invalid video byte-range response');
                }
                responseEnd = Number(range[2]) + 1;
                const total = Number(range[3]);
                if (this.total !== null && total !== this.total) throw new Error('Video size changed during download');
                this.total = total;
            } else if (response.status === 200) {
                // A server may ignore Range. On a retry discard the prefix we
                // already delivered, rather than duplicating it in the parser.
                skip = start;
                const length = response.headers.get('content-length');
                if (length !== null && !response.headers.get('content-encoding')) {
                    responseEnd = Number(length);
                    if (this.total !== null && this.total !== responseEnd) throw new Error('Video size changed during download');
                    this.total = responseEnd;
                }
            } else {
                throw new Error(`Unexpected video response (HTTP ${response.status})`);
            }
            this.status = 'downloading';
            this.onProgress(this);
            reader = response.body?.getReader();
            if (!reader) throw new Error('Streaming video response has no readable body');
            while (true) {
                const {done, value} = await timed(() => reader.read());
                if (done) break;
                const discarded = Math.min(skip, value.byteLength);
                skip -= discarded;
                const bytes = value.subarray(discarded);
                if (!bytes.byteLength) continue;
                if (responseEnd !== undefined && this.received + bytes.byteLength > responseEnd) {
                    throw new Error('Video response exceeded its declared byte range');
                }
                // Parsing errors must not be mistaken for retryable network errors.
                try { await this.onChunk(bytes, this.received); }
                catch (error) { throw new Error(`Cannot parse streamed video: ${error.message}`); }
                if (this.controller.signal.aborted) throw this.controller.signal.reason;
                this.parts.push(bytes);
                this.received += bytes.byteLength;
                this.onProgress(this);
            }
            if (skip || (responseEnd !== undefined && this.received !== responseEnd)) {
                throw new TypeError('Video response ended before all expected bytes arrived');
            }
            if (this.total === null) this.total = this.received;
        } finally {
            clearTimeout(timer);
            this.controller.signal.removeEventListener('abort', abort);
            if (reader) {
                try { await reader.cancel(); } catch (_) { /* already closed */ }
                reader.releaseLock();
            }
        }
    }

    dispose() {
        this.controller.abort(new DOMException('Video disposed', 'AbortError'));
        this.parts = [];
    }
}
