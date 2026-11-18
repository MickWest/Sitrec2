import {PerspectiveCamera, Vector3} from "three";
import {CNodeLOSFromCamera} from "../src/nodes/CNodeLOSFromCamera";

test("sampling the current or another frame cannot publish controls or replace the registered camera", () => {
    const camera = new PerspectiveCamera();
    camera.position.set(6379000, 0, 0);
    const live = {
        _object: camera,
        get camera() { return this._object; },
        postApplyControllers: jest.fn(),
        recordedLOS: {frame: 498},
        update(frame) {
            expect(live.camera).toBe(camera);
            expect(this.camera).not.toBe(camera);
            this.camera.position.y = frame;
            this.recordedLOS = {frame};
            this.postApplyControllers?.(frame);
            if (frame < 0) throw new Error("failed to read sample");
        },
    };
    const los = Object.assign(Object.create(CNodeLOSFromCamera.prototype), {
        inputs: {cameraNode: live}, dummyCamera: new PerspectiveCamera(), useRecorded: true,
    });
    for (const frame of [498, 0, 498]) expect(los.getValueFrame(frame)).toEqual({frame});
    los.useRecorded = false;
    expect(los.getValueFrame(25).position.y).toBe(25);
    expect(() => los.getValueFrame(-1)).toThrow("failed to read sample");
    expect(live.camera).toBe(camera);
    expect(camera.position).toEqual(new Vector3(6379000, 0, 0));
    expect(live.recordedLOS).toEqual({frame: 498});
    expect(live.postApplyControllers).not.toHaveBeenCalled();
});
