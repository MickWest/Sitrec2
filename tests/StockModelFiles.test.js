import {findStockModelKey} from "../src/StockModelFiles";

const modelFiles = {
    "A-10": {file: "data/models/A-10.glb"},
    "737 MAX 8 BA": {file: "data/models/B737Max8.glb"},
    "Shahed Drone": {file: "data/models/shahed~L3.5m~.glb"},
    "my-dropped.glb": {file: "my-dropped.glb"},
};
const modelAliases = {
    "data/models/737 MAX 8 BA.glb": "data/models/B737Max8.glb",
};

const find = (fileRef) => findStockModelKey(fileRef, modelFiles, modelAliases);

describe("findStockModelKey", () => {
    test.each([
        ["data/models/A-10.glb", "A-10"],
        ["models/A-10.glb", "A-10"],
        ["data/models/A-10.glb?v=1", "A-10"],
        ["data/models/shahed~L3.5m~.glb", "Shahed Drone"],
    ])("%s is stock", (fileRef, key) => {
        expect(find(fileRef)).toBe(key);
    });

    test.each([
        ["data/models/737 MAX 8 BA.glb"],
        ["data/models/737%20MAX%208%20BA.glb"],
        ["models/737%20MAX%208%20BA.glb"],
    ])("the old name %s gives the current model", (fileRef) => {
        expect(find(fileRef)).toBe("737 MAX 8 BA");
    });

    test.each([
        ["my-dropped.glb"],
        ["A-10.glb"],
        ["data/models/not-a-stock-model.glb"],
        ["https://example.com/models/A-10.glb"],
        ["https://example.com/data/models/A-10.glb"],
        ["https://www.metabunk.org/sitrec/data/models/A-10.glb"],
        ["https://sitrec.s3.example.com/123/my%20model.glb"],
        ["models/100%.glb"],
        ["F/A-18F"],
        [undefined],
    ])("%s is not stock", (fileRef) => {
        expect(find(fileRef)).toBeNull();
    });
});
