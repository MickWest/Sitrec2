// Worker: reads the per-macroblock QP of H.264 access units (see H264QPParser.js)
// and returns the mean, minimum and maximum QP of each picture.
//
// Messages in:
//   {type: "init", avcC}                 avcC = ArrayBuffer of the MP4 configuration record, or null
//   {type: "chunks", items: [{index, data}]}   data = ArrayBuffer of one access unit
// Messages out:
//   {type: "results", mbWidth, mbHeight, items: [{index, mean, min, max, sliceQP, pictureType}]}
//       A picture with no slice data gives {index, empty: true}.
//   {type: "error", unsupported, message}      the parse cannot continue

import {H264QPParser, H264QPUnsupportedError} from "../H264QPParser";

let parser = null;

self.onmessage = (event) => {
    const msg = event.data;
    try {
        if (msg.type === "init") {
            parser = new H264QPParser();
            if (msg.avcC) parser.setAvcC(new Uint8Array(msg.avcC));
        } else if (msg.type === "chunks") {
            const items = [];
            for (const chunk of msg.items) {
                const pic = parser.parseAccessUnit(new Uint8Array(chunk.data));
                if (!pic) {
                    items.push({index: chunk.index, empty: true});
                    continue;
                }
                items.push({
                    index: chunk.index,
                    mean: pic.mean, min: pic.min, max: pic.max,
                    sliceQP: pic.sliceQPs[0],
                    pictureType: pic.pictureType,
                });
            }
            self.postMessage({type: "results", items, mbWidth: parser.mbWidth, mbHeight: parser.mbHeight});
        }
    } catch (e) {
        self.postMessage({
            type: "error",
            unsupported: e instanceof H264QPUnsupportedError,
            message: e.message,
        });
    }
};
