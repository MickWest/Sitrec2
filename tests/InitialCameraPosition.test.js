import {beginInitialCameraPosition, canPlaceInitialCamera, noteCameraPositionChange,
    withInitialCameraPlacement} from '../src/InitialCameraPosition';

function initial(allowed = true) {
    const position = {_LLA: [34, -118, 10000], agl: false};
    beginInitialCameraPosition(position, allowed);
    return position;
}

test('saved or uninitialized camera positions cannot be replaced', () => {
    expect(canPlaceInitialCamera(initial(false), 'fixedCamera')).toBe(false);
    expect(canPlaceInitialCamera({_LLA: [34, -118, 10]}, 'fixedCamera')).toBe(false);
    expect(canPlaceInitialCamera(undefined, 'fixedCamera')).toBe(false);
});

test('altitude edits are protected even without a position event', () => {
    const position = initial();
    position._LLA[2] = 100;
    expect(canPlaceInitialCamera(position, 'fixedCamera')).toBe(false);
});

test('moving a camera and then undoing does not make it a default camera again', () => {
    const position = initial();
    position._LLA[0] = 40;
    noteCameraPositionChange(position);
    position._LLA[0] = 34;
    expect(canPlaceInitialCamera(position, 'fixedCamera')).toBe(false);
    withInitialCameraPlacement(position, () => { position._LLA = [36, 128, 3]; });
    expect(canPlaceInitialCamera(position, 'fixedCamera')).toBe(false);
});

test('track sources and Free Look protect the observer', () => {
    expect(canPlaceInitialCamera(initial(), 'flightSimCamera')).toBe(false);
    expect(canPlaceInitialCamera(initial(), 'fixedCamera', true)).toBe(false);
    const position = initial();
    noteCameraPositionChange(position, true);
    expect(canPlaceInitialCamera(position, 'fixedCamera')).toBe(false);
});

test('changing time, heading, or terrain elevation does not change the position baseline', () => {
    const position = initial();
    position.ecef = {x: 1, y: 2, z: 3};
    expect(canPlaceInitialCamera(position, 'fixedCamera')).toBe(true);
});
