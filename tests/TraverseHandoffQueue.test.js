jest.mock("../src/FileHandoff", () => ({putFileHandoff: jest.fn(async () => "test-handoff")}));
jest.mock("../src/showError", () => ({showError: jest.fn()}));

import {openHandoffWindow} from "../src/TraverseHandoff";
import {putFileHandoff} from "../src/FileHandoff";

test("the popup opens on click, but files wait for queued set-aside actions", async () => {
    const originalWindow = global.window;
    const popup = {document: {open: jest.fn(), write: jest.fn()}, location: {}, close: jest.fn()};
    global.window = {open: jest.fn(() => popup)};
    try {
        let finishAnimation;
        const dismissed = new Set();
        const ready = new Promise(resolve => { finishAnimation = resolve; })
            .then(() => { dismissed.add("weak"); });
        const buildFiles = jest.fn(() => ({
            files: ["consistent", "weak"].filter(name => !dismissed.has(name)).map(name => ({name})),
        }));
        let done;
        const completed = new Promise(resolve => { done = resolve; });
        openHandoffWindow({ready, buildFiles, urlFor: key => `?handoff=${key}`, onDone: done});

        expect(window.open).toHaveBeenCalledWith("", "_blank");
        await Promise.resolve();
        expect(buildFiles).not.toHaveBeenCalled();
        expect(putFileHandoff).not.toHaveBeenCalled();

        finishAnimation();
        await completed;
        expect(buildFiles).toHaveBeenCalledTimes(1);
        expect(putFileHandoff).toHaveBeenCalledWith([{name: "consistent"}], expect.any(Object));
        expect(popup.location.href).toBe("?handoff=test-handoff");
    } finally {
        global.window = originalWindow;
    }
});
