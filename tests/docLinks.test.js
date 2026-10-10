// rewriteMdLinks turns links between our own doc pages from .md into .html when
// webpack.common.js renders docs/*.md and README.md. Links to other sites must pass
// through unchanged: the published UserDataEgressCheck page once linked to a GitHub 404
// because an absolute https://github.com/.../x.md link was rewritten to x.html.

const { rewriteMdLinks } = require("../scripts/docLinks");

describe("rewriteMdLinks", () => {
    test.each([
        ["[a](Foo.md)", "[a](Foo.html)"],
        ["[a](Foo.md#bar)", "[a](Foo.html#bar)"],
        ["[a](./Foo.md)", "[a](./Foo.html)"],
        ["[a](docs/Foo.md#6-install-or-update-local-compute)", "[a](docs/Foo.html#6-install-or-update-local-compute)"],
        ["[a](dev/Foo.md)", "[a](dev/Foo.html)"],
    ])("rewrites the relative link %s", (input, expected) => {
        expect(rewriteMdLinks(input)).toBe(expected);
    });

    test.each([
        "[a](https://github.com/MickWest/Sitrec2/blob/main/scripts/egress-review-prompt.md)",
        "[a](https://github.com/MickWest/Sitrec2/blob/main/tools/SitrecBridge/README.md#setup)",
        "[a](http://example.com/notes.md)",
        "[a](//example.com/notes.md)",
    ])("leaves the absolute link %s unchanged", (input) => {
        expect(rewriteMdLinks(input)).toBe(input);
    });

    test("rewrites a link whose text wraps onto the next line", () => {
        expect(rewriteMdLinks("see [File Rehosting and\nObject References](dev/FileRehosting.md)."))
            .toBe("see [File Rehosting and\nObject References](dev/FileRehosting.html).");
    });

    test("rewrites only the relative link when both share a line, in either order", () => {
        expect(rewriteMdLinks("[a](Foo.md) and [b](https://x.org/y.md)"))
            .toBe("[a](Foo.html) and [b](https://x.org/y.md)");
        expect(rewriteMdLinks("[b](https://x.org/y.md) and [a](Foo.md#z)"))
            .toBe("[b](https://x.org/y.md) and [a](Foo.html#z)");
    });
});
