/** @jest-environment jsdom */
// The PES sidecar is rehosted with a shared sitch. The TS stream names come from
// private PMT descriptors, so the uploaded sidecar keeps only the numbers. A save to
// the user's own folder keeps the names.
import {TextDecoder, TextEncoder} from 'node:util';
import {saveMethods} from '../src/CFileManagerSave';

global.TextEncoder ??= TextEncoder;

const entry = {
    pesEntries: [{offset: 0, ptsUs: 1000}],
    videoFirstPESus: 0,
    streamIndex: 1,
    streamType: 0x15,
    tsIds: {
        pesStreamIds: [0xFC],
        pmtName: "OPERATOR TEXT",
        continuityErrors: 2,
        otherStreams: [{pid: 0x1003, codec: "unknown", streamType: 0x06, name: "PRIVATE NAME", packets: 12, bytes: 2048}],
    },
};

const read = buffer => JSON.parse(new TextDecoder().decode(buffer));

test('the rehosted sidecar keeps the TS numbers and drops the stream names', () => {
    const sidecar = read(saveMethods._makePesSidecarBuffer(entry));
    expect(sidecar.tsIds).toEqual({
        pesStreamIds: [0xFC],
        pmtName: null,
        continuityErrors: 2,
        otherStreams: [{pid: 0x1003, codec: "unknown", streamType: 0x06, name: null, packets: 12, bytes: 2048}],
    });
    expect(JSON.stringify(sidecar)).not.toMatch(/OPERATOR TEXT|PRIVATE NAME/);
    expect(sidecar.pesEntries).toEqual(entry.pesEntries);
});

test('a save to the user\'s own folder keeps the stream names', () => {
    const sidecar = read(saveMethods._makePesSidecarBuffer(entry, {keepNames: true}));
    expect(sidecar.tsIds).toEqual(entry.tsIds);
});

test('a stream without TS ids still writes a sidecar', () => {
    const sidecar = read(saveMethods._makePesSidecarBuffer({...entry, tsIds: undefined}));
    expect(sidecar.tsIds).toBeNull();
});
