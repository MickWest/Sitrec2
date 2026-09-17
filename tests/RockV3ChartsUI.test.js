import {fitFigureTo, flipFigureXAxis, scaleFigureHeight} from "../src/analysis/charts/RockV3ChartsUI";

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

describe("X-axis direction", () => {
    const figure = {
        data: [{x: [0, 1, 2], y: [3, 2, 1]}],
        layout: {
            xaxis: {tickvals: [0, 1, 2], ticktext: ["20", "40", "60"]},
            xaxis2: {range: [10, 100]},
            yaxis: {range: [0, 5]},
        },
    };

    test("reverses automatic and explicit X axes without changing their labels or data", () => {
        const flipped = flipFigureXAxis(figure, true);
        expect(flipped.layout.xaxis).toMatchObject({autorange: "reversed", ticktext: ["20", "40", "60"]});
        expect(flipped.layout.xaxis2.range).toEqual([100, 10]);
        expect(flipped.layout.yaxis.range).toEqual([0, 5]);
        expect(flipped.data).toBe(figure.data);
        expect(figure.layout.xaxis.autorange).toBeUndefined();
        expect(figure.layout.xaxis2.range).toEqual([10, 100]);
    });

    test("leaves the authored figure unchanged when the checkbox is off", () => {
        expect(flipFigureXAxis(figure, false)).toBe(figure);
    });

    test("inverts an axis that is already authored as reversed", () => {
        const reversed = {...figure, layout: {...figure.layout, xaxis: {autorange: "reversed"}}};
        expect(flipFigureXAxis(reversed, true).layout.xaxis.autorange).toBe(true);
    });
});
