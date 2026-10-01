// rateWorker.js — a Web Worker that runs the flare-rate model (rateModel.js) off the main
// thread, so that a slider never waits on it: the rate page's night profile (about 80 ms for
// both kinds on a desktop, four times more on a phone), the formula page's breakdown chart
// (365 nights x ~40 ms), and the rate page's year curve when its precomputed table cannot be
// loaded.
//
// Message in:  { id, channel, lat, kind, days: [n, ...], profile }
//   days     nights of the span (rateModel.SPAN) to compute, in the order wanted
//   profile  true: also return each night's 5-minute rate profile and hour bins
// Messages out, in batches as the nights are done:
//   { id, channel, results: [{ day, total, byGroup, times?, rates?, hour? }, ...] }
//   { id, channel, done: true }
// A newer message on the same channel cancels the one before it (its remaining batches are
// dropped, and a request that has not started is dropped whole), so a page can post on every
// slider move.

const VERSION = new URL(self.location.href).search;
const model = await import("./rateModel.js" + VERSION);

const current = new Map();          // channel -> id of the newest request
self.onmessage = (e) => {
    const { id, channel, lat, kind, days, profile } = e.data;
    current.set(channel, id);
    const BATCH = profile ? 2 : 8;
    let i = 0;
    const step = () => {
        if (current.get(channel) !== id) return;
        const results = [];
        for (let k = 0; k < BATCH && i < days.length; k++, i++) {
            const p = model.nightProfile(lat, days[i], kind);
            const r = { day: days[i], total: p.total, byGroup: p.byGroup };
            if (profile) { r.times = p.times; r.rates = p.rates; r.hour = p.hour; }
            results.push(r);
        }
        if (results.length) self.postMessage({ id, channel, results });
        if (i < days.length) setTimeout(step, 0);         // let a newer message cancel this one
        else self.postMessage({ id, channel, done: true });
    };
    // Not step() here: the messages already waiting (a slider posts one per frame, and a
    // night takes longer than a frame) must set `current` first, so that only the newest
    // of them is computed. Otherwise every one is computed in full, and the night chart lags
    // seconds behind the slider.
    setTimeout(step, 0);
};
self.postMessage({ ready: true });
