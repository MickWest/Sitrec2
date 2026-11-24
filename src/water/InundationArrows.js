import {BufferGeometry, DoubleSide, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial} from "three";
import {latitudeAtMercatorY} from "./InundationGrid";
import {seaLevelPoint} from "./SeaLevelSurface";

// Wide ribbons follow the actual cell route, including bends around barriers.
// Draw as an overlay so a seawall or roof cannot hide the entry indicator.
export class InundationArrows extends Group {
    constructor(layerMask) {
        super();
        this.name = "Inundation flow arrows";
        this.layers.mask = layerMask;
        this.material = new MeshBasicMaterial({color: 0xff0000, side: DoubleSide,
            transparent: true, opacity: 1, depthTest: false, depthWrite: false, toneMapped: false});
    }

    update(routes, rect, size, level) {
        this.visible = !!routes?.length;
        if (!routes || routes === this.routes) return;
        this.routes = routes;
        for (const mesh of this.children) mesh.geometry.dispose();
        this.clear();
        this.position.copy(seaLevelPoint(latitudeAtMercatorY(rect.v0 + rect.du / 2), (rect.u0 + rect.du / 2) * 360 - 180, level + 2));
        const toPoint = (x, y) => seaLevelPoint(latitudeAtMercatorY(rect.v0 + (y + 0.5) / size * rect.du),
            (rect.u0 + (x + 0.5) / size * rect.du) * 360 - 180, level + 2).sub(this.position);
        for (const route of routes) {
            const points = route.cells.map(i => [i % size, Math.floor(i / size)]);
            const vertices = [], indices = [];
            // Half-width is in grid units; the arrowhead is wider than the shaft.
            const halfWidth = 0.55;
            for (let k = 0; k + 1 < points.length; k++) {
                const [x, y] = points[k], previous = points[Math.max(0, k - 1)], next = points[k + 1];
                const dx = next[0] - x, dy = next[1] - y, length = Math.hypot(dx, dy);
                const px = k ? x - previous[0] : dx, py = k ? y - previous[1] : dy, pl = Math.hypot(px, py);
                let nx = -dy / length - py / pl, ny = dx / length + px / pl;
                const nl = Math.hypot(nx, ny); nx /= nl; ny /= nl;
                const half = halfWidth / Math.max(0.5, nx * (-dy / length) + ny * dx / length);
                toPoint(x + nx * half, y + ny * half).toArray(vertices, vertices.length);
                toPoint(x - nx * half, y - ny * half).toArray(vertices, vertices.length);
                if (k) { const n = k * 2; indices.push(n - 2, n - 1, n, n, n - 1, n + 1); }
            }
            const [ax, ay] = points.at(-2), [bx, by] = points.at(-1);
            const length = Math.hypot(bx - ax, by - ay), nx = -(by - ay) / length, ny = (bx - ax) / length;
            const n = vertices.length / 3;
            for (const [x, y] of [[ax + nx * 1.3, ay + ny * 1.3], [ax - nx * 1.3, ay - ny * 1.3], [bx, by]]) {
                toPoint(x, y).toArray(vertices, vertices.length);
            }
            indices.push(n, n + 1, n + 2);
            const geometry = new BufferGeometry();
            geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
            geometry.setIndex(indices);
            const mesh = new Mesh(geometry, this.material);
            mesh.layers.mask = this.layers.mask;
            mesh.renderOrder = 10000;
            mesh.userData.inundationRoute = route;
            this.add(mesh);
        }
    }

    dispose() {
        for (const mesh of this.children) mesh.geometry.dispose();
        this.material.dispose();
        this.clear();
    }
}
