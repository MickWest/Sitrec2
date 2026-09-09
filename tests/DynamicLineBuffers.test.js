import {LineSegmentsGeometry} from "three/addons/lines/LineSegmentsGeometry.js";
import {updateLineSegmentPositions} from "../src/SceneLineGeometry";

test("moving frustum segments reuse buffers; repeated float32 positions do not upload", () => {
    const geometry = new LineSegmentsGeometry();
    const positions = [0, 0, 0, 1 / 3, 2, 3];
    expect(updateLineSegmentPositions(geometry, positions)).toBe(true);
    const data = geometry.attributes.instanceStart.data;
    const version = data.version;
    expect(updateLineSegmentPositions(geometry, positions)).toBe(false);
    expect(data.version).toBe(version);
    positions[3] = 100;
    expect(updateLineSegmentPositions(geometry, positions)).toBe(true);
    expect(geometry.attributes.instanceStart.data).toBe(data);
    expect(geometry.boundingBox.max.x).toBe(100);
    expect(data.version).toBe(version + 1);
    const dispose = jest.spyOn(geometry, "dispose");
    expect(updateLineSegmentPositions(geometry, [...positions, 0, 0, 0, 2, 3, 4])).toBe(true);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(geometry.instanceCount).toBe(2);
});
