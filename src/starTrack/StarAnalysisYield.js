// Yield a real task so input and rendering can run. Timer-based yields can be
// delayed by seconds in a background tab, dwarfing the actual star search.
export function yieldStarAnalysis() {
    if (typeof globalThis.scheduler?.yield === "function") return globalThis.scheduler.yield();
    if (typeof MessageChannel === "undefined") return new Promise(resolve => setTimeout(resolve, 0));
    return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
        };
        channel.port2.postMessage(0);
    });
}
