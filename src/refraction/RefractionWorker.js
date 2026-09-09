import {buildRayTable} from "./RefractionPhysics";

self.onmessage = ({data: {id, request}}) => {
    try {
        const start = performance.now();
        const result = buildRayTable(request);
        result.milliseconds = performance.now() - start;
        const transfer = [result.data.buffer, result.distances.buffer];
        for (const l of result.lasers) transfer.push(l.center.buffer, l.upper.buffer, l.lower.buffer, l.distances.buffer);
        self.postMessage({id, result}, transfer);
    } catch (error) {
        self.postMessage({id, error: error.message});
    }
};
