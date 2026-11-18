import {ConstellationLabelLayout} from "../src/ConstellationLabelLayout";

const rect = {x: 0, y: 60, w: 500, h: 640};
const label = (id, x, y) => ({id, x, y, w: 96, h: 16});
const intersects = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x
    && a.y < b.y + b.h && a.y + a.h > b.y;

test("edge names fit wholly inside the picture, including letterbox margins", () => {
    const layout = new ConstellationLabelLayout();
    const placed = layout.place([label("Perseus", -10, 400), label("Triangulum", 497, 65)], rect);
    expect(placed).toHaveLength(2);
    for (const {box} of placed) {
        expect(box.x).toBeGreaterThanOrEqual(8);
        expect(box.x + box.w).toBeLessThanOrEqual(492);
        expect(box.y).toBeGreaterThanOrEqual(68);
        expect(box.y + box.h).toBeLessThanOrEqual(692);
    }
});

test("edge attachment tolerates motion, then releases names that leave the field", () => {
    const layout = new ConstellationLabelLayout();
    const place = x => layout.place([label("Perseus", x, 400)], rect);
    expect(place(-45)).toHaveLength(1);
    expect(place(-60)).toHaveLength(1);
    expect(place(-65)).toHaveLength(0);
    expect(place(-60)).toHaveLength(0);
    expect(place(-45)).toHaveLength(1);
    expect(place(-200)).toHaveLength(0);
});

test("a displaced name avoids point labels and retains its slot as space opens", () => {
    const layout = new ConstellationLabelLayout();
    const anchor = label("Perseus", 240, 380);
    const obstacle = {x: 210, y: 372, w: 60, h: 16};
    const [first] = layout.place([anchor], rect, [obstacle]);
    expect(intersects(first.box, obstacle)).toBe(false);
    expect([first.x, first.y]).not.toEqual([anchor.x, anchor.y]);
    // Small motion must not send the name back and forth between nearby gaps.
    for (const delta of [0.5, -0.5, 1, -1, 0]) {
        const [next] = layout.place([{...anchor, x: anchor.x + delta}], rect,
            [{...obstacle, x: obstacle.x + delta}]);
        expect(next.x).toBeCloseTo(first.x + delta);
        expect(next.y).toBe(first.y);
    }
    expect(layout.place([anchor], rect)[0].offset).toEqual(first.offset);
});

test("a new region name does not displace an existing name, and both avoid overlap", () => {
    const layout = new ConstellationLabelLayout();
    const old = label("Perseus", 240, 380);
    const [first] = layout.place([old], rect);
    const placed = layout.place([label("Andromeda", 240, 380), old], rect);
    expect(placed).toHaveLength(2);
    const retained = placed.find(p => p.id === old.id);
    expect([retained.x, retained.y]).toEqual([first.x, first.y]);
    expect(intersects(placed[0].box, placed[1].box)).toBe(false);
});

test("a crowded name is omitted instead of covering point names or travelling across the view", () => {
    const layout = new ConstellationLabelLayout();
    expect(layout.place([label("Perseus", 240, 380)], rect, [rect])).toEqual([]);
    expect(layout.place([label("Perseus", 240, 380)], {x: 0, y: 0, w: 60, h: 30})).toEqual([]);
});
