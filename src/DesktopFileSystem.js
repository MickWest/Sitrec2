function createFsError(name, message) {
    if (typeof DOMException === "function") {
        return new DOMException(message, name);
    }

    const error = new Error(message);
    error.name = name;
    return error;
}

function toUint8Array(data) {
    if (data instanceof Uint8Array) {
        return data;
    }

    if (ArrayBuffer.isView(data)) {
        return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }

    if (data instanceof ArrayBuffer) {
        return new Uint8Array(data);
    }

    if (Array.isArray(data)) {
        return Uint8Array.from(data);
    }

    throw new Error("Unsupported binary payload from desktop filesystem bridge");
}

function createVirtualFile(name, bytes) {
    return {
        arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        async text() {
            return new TextDecoder().decode(bytes);
        },
        lastModified: Date.now(),
        name,
        size: bytes.byteLength,
        type: "",
    };
}

function getBridge() {
    return window.sitrecDesktop?.fs ?? null;
}

export function isDesktopFileSystemAvailable() {
    return getBridge() !== null;
}

export function getDesktopFileSystemBridge() {
    return getBridge();
}

export function createDesktopFileHandle(filePath) {
    const bridge = getBridge();
    if (!bridge) {
        throw new Error("Desktop filesystem bridge is unavailable");
    }

    return {
        kind: "file",
        name: filePath.split(/[\\/]/).pop(),
        path: filePath,
        async createWritable() {
            let pendingData = new Uint8Array();

            return {
                async close() {
                    await bridge.writeFile(filePath, pendingData, { createParents: true });
                },
                async write(data) {
                    if (data && typeof data === "object" && data.type === "write" && data.data !== undefined) {
                        pendingData = data.data;
                        return;
                    }

                    pendingData = data;
                },
            };
        },
        async getFile() {
            const bytes = toUint8Array(await bridge.readFile(filePath));
            return createVirtualFile(this.name, bytes);
        },
        async queryPermission() {
            return "granted";
        },
        async requestPermission() {
            return "granted";
        },
    };
}

export function createDesktopDirectoryHandle(dirPath) {
    const bridge = getBridge();
    if (!bridge) {
        throw new Error("Desktop filesystem bridge is unavailable");
    }

    return {
        kind: "directory",
        name: dirPath.split(/[\\/]/).pop(),
        path: dirPath,
        async *entries() {
            for (const entry of await bridge.listDirectory(dirPath)) {
                yield [entry.name, entry.kind === "directory"
                    ? createDesktopDirectoryHandle(entry.path)
                    : createDesktopFileHandle(entry.path)];
            }
        },
        async getDirectoryHandle(name, { create = false } = {}) {
            const childPath = await bridge.resolvePath(dirPath, name);
            if (create) {
                await bridge.ensureDirectory(childPath);
                return createDesktopDirectoryHandle(childPath);
            }

            const info = await bridge.stat(childPath);
            if (!info.exists || info.kind !== "directory") {
                throw createFsError("NotFoundError", `Directory not found: ${childPath}`);
            }

            return createDesktopDirectoryHandle(childPath);
        },
        async getFileHandle(name, { create = false } = {}) {
            const filePath = await bridge.resolvePath(dirPath, name);
            if (!create) {
                const info = await bridge.stat(filePath);
                if (!info.exists || info.kind !== "file") {
                    throw createFsError("NotFoundError", `File not found: ${filePath}`);
                }
            }

            return createDesktopFileHandle(filePath);
        },
        async queryPermission() {
            return "granted";
        },
        async requestPermission() {
            return "granted";
        },
    };
}
