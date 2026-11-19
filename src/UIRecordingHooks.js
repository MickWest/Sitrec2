// A separate observer keeps recording out of the application's onChange callbacks.
// No observer is installed for accounts that are not being recorded.
let observer;

export function setUIRecordingObserver(callback) {
    observer = callback;
}

export function notifyUIRecordingObserver(controller, finished = false) {
    try { observer?.(controller, finished); } catch (_) { /* recording cannot break a control */ }
}
