import fs from 'node:fs';
import path from 'node:path';
import {parse} from '@babel/parser';
import {Group, Quaternion} from 'three';

// Exercise the real render lifecycle without importing the object's browser-only
// loader/worker dependencies. Duplicate methods are significant: JavaScript
// silently keeps the last one, which can discard existing rendering work.
const source = fs.readFileSync(path.join(__dirname, '../src/nodes/CNode3DObject.js'), 'utf8');
const declaration = parse(source, {sourceType: 'module'}).program.body
    .find(node => node.type === 'ExportNamedDeclaration' && node.declaration?.id?.name === 'CNode3DObject').declaration;
const selected = declaration.body.body.filter(node => ['preRender', 'applyViewScale', 'postRender'].includes(node.key?.name));

test('the object render lifecycle has no silently overwritten methods', () => {
    const methods = declaration.body.body.filter(node => node.type === 'ClassMethod' && node.kind === 'method');
    const keys = methods.map(node => `${node.static}:${node.key.name}`);
    expect(new Set(keys).size).toBe(keys.length);
});

test.each([1, 3])('main-view scale %s preserves rotation, material updates and look-view size', exaggeration => {
    const Globals = {objectScaleMain: exaggeration};
    const Lifecycle = new Function('Globals', `return class {${selected.map(node => source.slice(node.start, node.end)).join('\n')}}`)(Globals);
    const node = Object.assign(new Lifecycle(), {baseScale: 2, _viewScale: 2,
        group: new Group(), common: {rotateZ: 90}, updateEnvMap: jest.fn()});
    node.group.scale.setScalar(2);
    const material = {userData: {sitrecPLYPointCloud: true}, uniforms: {viewportHeight: {value: 0}}};
    node.model = {traverse: callback => callback({material, userData: {}})};
    const main = {id: 'mainView', heightPx: 600};
    node.preRender(main);
    expect(node.group.scale.x).toBe(2 * exaggeration);
    expect(node.group.rotation.z).toBeCloseTo(Math.PI / 2);
    expect(material.uniforms.viewportHeight.value).toBe(600);
    expect(node.updateEnvMap).toHaveBeenLastCalledWith(main);
    node.postRender(main);
    expect(node.group.quaternion.angleTo(new Quaternion())).toBeCloseTo(0);
    const look = {id: 'lookView', heightPx: 300};
    node.preRender(look);
    expect(node.group.scale.x).toBe(2);
    expect(node.group.rotation.z).toBeCloseTo(Math.PI / 2);
    expect(material.uniforms.viewportHeight.value).toBe(300);
    expect(node.updateEnvMap).toHaveBeenLastCalledWith(look);
    node.postRender(look);
    expect(node.group.quaternion.angleTo(new Quaternion())).toBeCloseTo(0);
});
