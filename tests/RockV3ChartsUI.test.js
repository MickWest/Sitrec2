import {fitFigureTo, scaleFigureHeight} from "../src/analysis/charts/RockV3ChartsUI";

describe("chart height scaling", () => {
    const figure = {
        key: "errorBySolver",
        layout: {width: 1500, height: 456, annotations: []},
        data: [],
    };

    test("scales from the authored height without changing the source figure", () => {
        expect(scaleFigureHeight(figure, 150).layout.height).toBe(684);
        expect(scaleFigureHeight(figure, 80).layout.height).toBe(365);
        expect(figure.layout.height).toBe(456);
    });

    test("limits the slider scale to 50 through 200 percent", () => {
        expect(scaleFigureHeight(figure, 10).layout.height).toBe(228);
        expect(scaleFigureHeight(figure, 300).layout.height).toBe(912);
    });

    test("uses 100 percent for a nonnumeric value", () => {
        expect(scaleFigureHeight(figure, "unknown").layout.height).toBe(456);
    });
});

describe("chart width fitting", () => {
    test("uses the available width while preserving the requested height", () => {
        const figure = {
            layout: {
                width: 1500,
                height: 600,
                annotations: [{xref: "paper", yanchor: "top", text: "A caption that is rewrapped to the new width."}],
            },
            data: [],
        };
        const fitted = fitFigureTo(figure, 1780, 720);
        expect(fitted.layout).toMatchObject({width: 1780, height: 720});
        expect(figure.layout).toMatchObject({width: 1500, height: 600});
    });
});
