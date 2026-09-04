const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const read = relativePath => fs.readFileSync(path.join(ROOT, relativePath), "utf8");

describe("deployment examples", () => {
    test("the target terrain defaults use registered source keys", () => {
        const target = read("deploy/aws/target.tfvars.example");
        expect(target).toContain('DEFAULT_MAP_TYPE                      = "CustomMap_INTERNAL"');
        expect(target).toContain('DEFAULT_ELEVATION_TYPE                = "CustomElevation_INTERNAL"');
    });

    test("the load balancer suppresses its identifying response header", () => {
        const edge = read("deploy/aws/edge.tf");
        expect(edge).toMatch(/routing_http_response_server_enabled\s*=\s*false/);
    });

    test("the Kubernetes credential check prints names, not the generated file", () => {
        const readme = read("docs/dev/k8s-example/README.md");
        expect(readme).not.toMatch(/kubectl exec deploy\/sitrec -- cat .*shared\.env\.php/);
        expect(readme).toContain("\\1=<set>");
    });

    test("the tile-segment menu does not offer values rejected by both sanitizers", () => {
        const customSupport = read("src/CustomSupport.js");
        expect(customSupport).toContain('"tileSegments", [16, 32, 64, 128]');
        expect(customSupport).not.toContain('"tileSegments", [8, 16');
    });
});
