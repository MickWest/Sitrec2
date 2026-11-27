import {BoxGeometry, Color, ExtrudeGeometry, Shape, Vector3} from "three";

// Runs follow the model's length axis (+Z). The outer ends sit at ±length/2.
function postPositions(p, footprint) {
    const span = p.length - footprint;
    const bays = Math.max(1, Math.ceil(span / p.postSpacing));
    return Array.from({length: bays + 1}, (_, i) => span * (i / bays - .5));
}

export function brickWall(p, parts) {
    const joint = .01, rows = Math.max(1, Math.round(p.height / .075)), columns = Math.max(1, Math.round(p.length / .225));
    const rise = p.height / rows, run = p.length / columns;
    parts.box("Mortar", p.mortarColor, 0, p.height / 2, 0, p.thickness - joint, p.height - joint, p.length - joint);
    const names = ["Brick", "Darker bricks", "Lighter bricks"];
    const shades = [1, .85, 1.08].map(tint => new Color(p.brickColor).multiplyScalar(tint));
    const box = new BoxGeometry(1, 1, 1).toNonIndexed();
    for (let row = 0; row < rows; row++) {
        const offset = (row % 2) / 2;
        const count = columns + row % 2;
        const y0 = row * rise + (row === 0 ? 0 : joint / 2);
        const y1 = (row + 1) * rise - (row === rows - 1 ? 0 : joint / 2);
        for (let col = 0; col < count; col++) {
            const start = Math.max(0, (col - offset) * run);
            const end = Math.min(p.length, (col + 1 - offset) * run);
            const z0 = start + (col === 0 ? 0 : joint / 2);
            const z1 = end - (col === count - 1 ? 0 : joint / 2);
            const shade = (row * 3 + col * 7 + row % 3 * col) % 11;
            const tone = shade < 2 ? 1 : shade < 4 ? 2 : 0;
            parts.add(names[tone], shades[tone],
                box.clone().scale(p.thickness, y1 - y0, z1 - z0).translate(0, (y1 + y0) / 2, (z1 + z0 - p.length) / 2));
        }
    }
}

export function chainLink(p, parts) {
    const radius = .027, posts = postPositions(p, 2 * radius), first = posts[0], last = posts.at(-1);
    const tube = (name, a, b, r) => parts.beam(name, p.frameColor, a, b, r, r, 10);
    for (const z of posts) tube("Galvanized posts", new Vector3(0, 0, z), new Vector3(0, p.height, z), radius);
    const bottom = .04, top = p.height - .038;
    for (const [y, r] of [[top, .02], [bottom, .006]])
        tube("Rails and tension wire", new Vector3(0, y, first), new Vector3(0, y, last), r);

    // Clip two families of diagonal wires to the ends and rails. One cylinder spans many open diamonds.
    const span = last - first, rise = top - bottom, pitch = p.meshOpening, wireRadius = .003;
    for (let i = -Math.ceil(rise / pitch); i < Math.ceil(span / pitch); i++) {
        const intercept = i * pitch, a = Math.max(0, intercept), b = Math.min(span, intercept + rise);
        if (b - a < .0001) continue;
        for (const sign of [-1, 1]) {
            const end = z => new Vector3(radius + sign * wireRadius, bottom + z - intercept, sign * (first + z));
            parts.beam("Diamond wire mesh", p.wireColor, end(a), end(b), wireRadius, wireRadius, 4);
        }
    }
}

// Extrude the actual board outline so both faces and the cut edges survive GLB export.
function fenceBoard(width, height, thickness, pointed) {
    const half = width / 2, cut = pointed ? half : width * .2;
    const shape = new Shape();
    shape.moveTo(-half, 0);
    shape.lineTo(half, 0);
    shape.lineTo(half, height - cut);
    shape.lineTo(half - cut, height);
    if (!pointed) shape.lineTo(-half + cut, height);
    shape.lineTo(-half, height - cut);
    shape.closePath();
    return new ExtrudeGeometry(shape, {depth: thickness, bevelEnabled: false})
        .translate(0, 0, -thickness / 2).rotateY(-Math.PI / 2);
}

export function woodFence(p, parts) {
    const shadowbox = p.boardStyle === "shadowbox", post = .105, cap = post + .015;
    const railDepth = .04, boardDepth = .018, bottom = .035;
    const posts = postPositions(p, cap);
    for (const z of posts) {
        parts.box("Fence posts", p.frameColor, 0, (p.height - .025) / 2, z, post, p.height - .025, post);
        parts.box("Post caps", p.frameColor, 0, p.height - .0125, z, cap, .025, cap);
    }
    for (let bay = 1; bay < posts.length; bay++) {
        const start = posts[bay - 1] + post / 2, end = posts[bay] - post / 2, clear = end - start;
        for (const level of [.24, .74])
            parts.box("Wood rails", p.frameColor, 0, p.height * level, (start + end) / 2, railDepth, .075, clear);
        const count = Math.max(1, Math.round(clear / (p.boardWidth * (shadowbox ? .82 : 1.55))));
        // The two faces of a shadowbox overlap slightly when seen square-on.
        const width = Math.min(p.boardWidth, clear);
        const spacing = count === 1 ? 0 : (clear - width) / (count - 1);
        const board = fenceBoard(width, p.height * .96 - bottom, boardDepth, p.boardStyle === "pointed");
        for (let i = 0; i < count; i++) {
            const side = shadowbox && i % 2 ? 1 : -1;
            const z = count === 1 ? (start + end) / 2 : start + width / 2 + spacing * i;
            parts.add("Fence boards", p.boardColor, board.clone().translate(side * (railDepth + boardDepth) / 2, bottom, z));
        }
    }
}

export function railing(p, parts) {
    const pipe = p.railStyle === "pipe", foot = .105, posts = postPositions(p, foot);
    const metal = p.metalColor, topRadius = .025;
    for (const z of posts) {
        parts.box("Mounting plates", metal, 0, .006, z, foot, .012, foot);
        if (pipe) parts.beam("Pipe posts", metal, new Vector3(0, 0, z), new Vector3(0, p.height - topRadius, z), .023, .023, 12);
        else parts.box("Railing posts", metal, 0, p.height / 2, z, .05, p.height, .05);
    }
    if (pipe) {
        for (const [y, r] of [[p.height - topRadius, topRadius], [p.height * .52, .019], [p.height * .18, .019]])
            parts.beam("Horizontal pipe rails", metal, new Vector3(0, y, -p.length / 2), new Vector3(0, y, p.length / 2), r, r, 12);
    } else {
        const bottom = p.height * .13, top = p.height - .04;
        parts.box("Top rail", metal, 0, p.height - .02, 0, .062, .04, p.length);
        parts.box("Bottom rail", metal, 0, bottom - .015, 0, .033, .03, p.length);
        for (let bay = 1; bay < posts.length; bay++) {
            const span = posts[bay] - posts[bay - 1], gaps = Math.ceil(span / .125);
            for (let i = 1; i < gaps; i++)
                parts.box("Vertical balusters", metal, 0, (bottom + top) / 2, posts[bay - 1] + span * i / gaps, .018, top - bottom, .018);
        }
    }
}
