import {MQ9TrackingModel} from "../src/MQ9TrackingModel";

const observation = (time, extra = {}) => ({id: "balloon", x: 320, y: 240, width: 6, height: 6,
    position: [100 + time * 2, 0, 0], confidence: 1, visible: true, ...extra});
function locked() {
    const model = new MQ9TrackingModel(); model.command("acquire", 0);
    for (let f = 0; f <= 150; f++) model.step(f/30, [observation(f/30)]);
    expect(model.state).toBe("tracking"); return model;
}

test("square expands from the boresight, then corners refine over forty frames", () => {
    const m = new MQ9TrackingModel(); m.command("acquire", 0);
    expect(m.box(0)).toMatchObject({x: 320, y: 240, width: 2, height: 2, style: "square"});
    expect(m.box(.45).width).toBeCloseTo(91);
    for (let f = 0; f <= 27; f++) m.step(f/30, [observation(f/30)]);
    expect(m.state).toBe("refining"); expect(m.box(.9).style).toBe("corners");
    for (let f = 28; f <= 66; f++) m.step(f/30, [observation(f/30)]);
    expect(m.state).toBe("refining");
    m.step(67/30, [observation(67/30)]);
    expect(m.state).toBe("tracking"); expect(m.box(67/30)).toMatchObject({width: 10, height: 10});
});

test("coast ignores rejected positions, flashes off/on at 0.25 seconds, and recovers", () => {
    const m = locked(); m.step(5.1, [observation(5.1, {confidence: 0, position: [9000,0,0]})]);
    expect(m.state).toBe("coasting");
    expect(m.estimate(5.9)[0]).toBeCloseTo(111.8);
    for (const [dt, visible] of [[0,false],[.249,false],[.25,true],[.499,true],[.5,false],[.75,true],[1,false],[1.25,true]]) {
        expect(m.box(5.1+dt).visible).toBe(visible);
    }
    m.step(6.1, [observation(6.1)]);
    expect(m.state).toBe("tracking"); expect(m.box(6.1).visible).toBe(true);
});

test("three unsuccessful flashes drop to ground without retaining a target box", () => {
    const m = locked(); m.step(5.1, []); m.step(6.599, []);
    expect(m.state).toBe("coasting");
    m.step(6.6, [observation(6.6)]);
    expect(m.state).toBe("ground"); expect(m.box(6.6)).toBeNull(); expect(m.estimate(7)).toBeNull();
});

test("partial acquisition and an object leaving its gate both coast and time out", () => {
    const m = new MQ9TrackingModel(); m.command("acquire", 0);
    m.step(.1, [observation(.1)]); m.step(.2, [observation(.2, {x: 600})]);
    expect(m.state).toBe("coasting"); m.step(1.7, []); expect(m.state).toBe("ground");
    m.command("acquire", 2); m.step(3, [observation(3)]); m.step(4, [observation(4)]);
    expect(m.state).toBe("refining"); m.step(4.1, []); m.step(5.6, []);
    expect(m.state).toBe("ground");
});

test("manual selection releases lock, and offscreen/other-object detections cannot rescue it", () => {
    const m = locked(); m.step(5.1, [observation(5.1, {visible: false})]);
    m.step(5.2, [observation(5.2, {id: "crosshair"})]); expect(m.state).toBe("coasting");
    m.command("manual", 5.3); expect(m.cameraMode).toBe("manual"); expect(m.box(5.3)).toBeNull();
});
