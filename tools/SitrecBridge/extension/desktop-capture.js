import {DEV_MODE} from "./dev-mode.js";

const video = document.getElementById("video");
const status = document.getElementById("status");
const startButton = document.getElementById("start");
const stopButton = document.getElementById("stop");
let stream = null;
let picker = null;
let generation = 0;

function stop() {
    generation++;
    if (picker !== null) chrome.desktopCapture.cancelChooseDesktopMedia(picker);
    picker = null;
    stream?.getTracks().forEach(track => track.stop());
    stream = null;
    video.srcObject = null;
    startButton.disabled = !DEV_MODE;
    stopButton.disabled = true;
    status.textContent = "No screen shared.";
}

function start() {
    if (!DEV_MODE) return;
    stop();
    const attempt = generation;
    startButton.disabled = true;
    stopButton.disabled = false;
    status.textContent = "Choose a source in Chrome’s screen picker.";
    picker = chrome.desktopCapture.chooseDesktopMedia(["screen", "window", "tab"], async streamId => {
        picker = null;
        if (attempt !== generation) return;
        if (!streamId) { stop(); return; }
        try {
            const selected = await navigator.mediaDevices.getUserMedia({audio: false,
                video: {mandatory: {chromeMediaSource: "desktop", chromeMediaSourceId: streamId}}});
            if (attempt !== generation) { selected.getTracks().forEach(track => track.stop()); return; }
            stream = selected;
            stream.getVideoTracks()[0].addEventListener("ended", stop, {once: true});
            video.srcObject = stream;
            await video.play();
            if (attempt !== generation) return;
            status.textContent = "Sharing is active. The assistant can now capture screenshots. Switch back to your work when ready.";
            startButton.disabled = false;
        } catch (error) {
            if (attempt !== generation) return;
            stop();
            status.textContent = `Capture failed: ${error.message}`;
        }
    });
}

function capture({quality = 75, maxWidth = 1920}) {
    if (!stream?.active || video.readyState < 2) throw new Error("No screen frame available. Select a source and wait for sharing to become active.");
    const scale = Math.min(1, maxWidth / video.videoWidth, Math.sqrt(16000000 / (video.videoWidth * video.videoHeight)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
    return {imageData: canvas.toDataURL("image/jpeg", quality / 100).split(",")[1], mimeType: "image/jpeg",
        width: canvas.width, height: canvas.height};
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
    // Content scripts have sender.tab; only the extension's own background may request frames.
    if (!DEV_MODE || sender.id !== chrome.runtime.id || sender.tab || message.type !== "dev-desktop-command") return;
    try {
        if (message.action === "stop") stop();
        respond(message.action === "capture" ? capture(message) : {
            status: stream?.active ? "sharing" : picker !== null ? "selecting" : "stopped",
            width: video.videoWidth, height: video.videoHeight,
        });
    } catch (error) { respond({error: error.message}); }
});
startButton.addEventListener("click", start);
stopButton.addEventListener("click", stop);
window.addEventListener("pagehide", stop);
startButton.disabled = !DEV_MODE;
if (DEV_MODE) start();
