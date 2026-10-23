/** @jest-environment jsdom */

// A file over the upload size limit is refused before any upload starts. The refusal is shown
// in Sitrec's own error dialog (showError), like every other upload failure, not in the
// browser's native alert().

import {afterEach, beforeEach, expect, jest, test} from "@jest/globals";

jest.mock("../src/showError", () => ({showError: jest.fn()}));
jest.mock("../src/Globals", () => ({Globals: {}, withTestUser: url => url}));
jest.mock("../src/configUtils", () => ({isAdmin: () => false, SITREC_SERVER: "/sitrecServer/"}));
jest.mock("../src/utils", () => ({initUploadProgress: jest.fn(), updateUploadProgress: jest.fn()}));
jest.mock("../src/envUtils", () => ({getEnvBool: () => false, getEnvNumber: (name, value, fallback) => fallback}));

import {showError} from "../src/showError";
import {Globals} from "../src/Globals";
import {CRehoster} from "../src/CRehoster";

let alertSpy;
beforeEach(() => {
    showError.mockClear();
    alertSpy = jest.spyOn(window, "alert").mockImplementation(() => {});
    Globals.userData = {maxFileSizeMB: 1};
});
afterEach(() => {
    alertSpy.mockRestore();
    delete Globals.userData;
});

test("a file over the limit shows the size message in the error dialog and is not uploaded", async () => {
    const rehoster = new CRehoster();
    const upload = jest.spyOn(rehoster, "rehostFilePromise").mockResolvedValue("never");
    const data = new ArrayBuffer(2 * 1024 * 1024);

    await expect(rehoster.rehostFile("big.mp4", data)).rejects.toThrow("File is too big to rehost: big.mp4");

    expect(alertSpy).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(
        "File is too big to rehost: big.mp4 size: 2097152 bytes. Please use a smaller file. Limit = 1 MB");
    expect(upload).not.toHaveBeenCalled();
    expect(rehoster.rehostPromises).toHaveLength(0);
});

test("a file under the limit uploads with no dialog", async () => {
    const rehoster = new CRehoster();
    const upload = jest.spyOn(rehoster, "rehostFilePromise").mockResolvedValue("https://example.com/small.mp4");

    await expect(rehoster.rehostFile("small.mp4", new ArrayBuffer(1024))).resolves.toBe("https://example.com/small.mp4");

    expect(alertSpy).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
    expect(upload).toHaveBeenCalledTimes(1);
});
