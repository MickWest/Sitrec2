/** @jest-environment jsdom */
import {Matrix4, PerspectiveCamera, Vector3} from "three";
import {parseXml} from "../src/parseXml";
import {parsePowerNetwork} from "../src/PowerNetworkFormat";
import {createPowerNetworkGeometry} from "../src/PowerNetworkGeometry";

const a = [-81,38], bend = [-81.001,38.001], b = [-81.002,38.002];
const line = {power:"line", cables:"3"}, tower = {power:"tower", height:"100 ft"}, pole = {power:"pole"};
const feature = (properties,type,coordinates) => ({type:"Feature",properties,geometry:{type,coordinates}});
const geo = {type:"FeatureCollection",features:[feature(line,"LineString",[a,bend,b]),
    feature(tower,"Point",a), feature(pole,"Point",b)]};

test("Overpass KML, GeoJSON and raw node references reproduce the same power network", () => {
    const placemark = (tags,type,coords) => '<Placemark><ExtendedData>' +
        Object.entries(tags).map(([key,v]) => '<Data name="'+key+'"><value>'+v+'</value></Data>').join("") +
        '</ExtendedData><'+type+'><coordinates>'+coords+'</coordinates></'+type+'></Placemark>';
    const kml = '<kml><Document><Folder>'+placemark(line,"LineString",[a,bend,b].join(" "))+
        placemark(tower,"Point",a)+placemark(pole,"Point",b)+'</Folder></Document></kml>';
    const expected = parsePowerNetwork(geo);
    expect(parsePowerNetwork(parseXml(kml))).toEqual(expected);
    const elements = [a,bend,b].map(([lon,lat],id) => ({type:"node",id,lon,lat}));
    const raw = parsePowerNetwork({elements:[{type:"way",tags:line,nodes:[0,1,2]},
        {...elements[0],tags:tower},{...elements[2],tags:pole},...elements]});
    expect(raw.ways[0].path.map(i => raw.points[i])).toEqual(expected.points);
    expect(expected.points[0].height).toBeCloseTo(30.48);
    expect(expected.points.map(p => p.kind)).toEqual(["pylon",undefined,"pole"]);
    expect(parsePowerNetwork({type:"FeatureCollection",features:[feature({},"LineString",[a,b])]})).toBeNull();
    expect(parsePowerNetwork(parseXml("<kml><Document><Placemark><Point/></Placemark></Document></kml>"))).toBeNull();
});

test("incomplete Overpass ways split at missing nodes", () => {
    const geometry = [a,b,null,bend,a].map(p => p && {lon:p[0],lat:p[1]});
    const network = parsePowerNetwork({elements:[{type:"way",tags:line,geometry}]});
    expect(network.ways.map(w => w.path)).toEqual([[0,1],[2,0]]);
});

test("a linked editable pole takes the place of its mapped instance and anchors the wires", () => {
    const network = parsePowerNetwork(geo);
    network.points[0].objectId = "exampleTower";
    const display = createPowerNetworkGeometry(network, (lat,lon) => new Vector3(lon,lat,0));
    try {
        const near = display.group.children[0].children[0];
        const mesh = near.children.find(o => o.isInstancedMesh);
        const line = near.children.find(o => o.isLineSegments).geometry.attributes.position;
        const local = new Matrix4(), before = line.getY(0);
        mesh.getMatrixAt(0,local);
        const mappedTransform = local.clone();
        const link = {matrix:new Matrix4().makeTranslation(-81,38,0),parameters:{
            groundKind:"pylon",towerStyle:"horizontal",armSpan:40,height:51}};
        display.syncLinkedSupports(id => id === "exampleTower" ? link : null);
        mesh.getMatrixAt(0,local); expect(local.determinant()).toBe(0);
        expect(line.getY(0)).toBeCloseTo(51*.80,4);
        const version = line.version;
        display.syncLinkedSupports(() => link);
        expect(line.version).toBe(version);
        display.syncLinkedSupports(() => null);
        mesh.getMatrixAt(0,local); expect(local.equals(mappedTransform)).toBe(true);
        expect(line.getY(0)).toBeCloseTo(before,4);
    } finally {display.dispose();}
});

test("a cell instances both support models, batches wires and switches detail per camera", () => {
    const network = parsePowerNetwork(geo);
    let height = 100;
    const groundAt = (lat,lon) => new Vector3((lon+81)*85000, height, (lat-38)*111000);
    const display = createPowerNetworkGeometry(network, groundAt);
    try {
        const cell = display.group.children.find(c => c.children[0].children.some(o => o.isLineSegments));
        const [near,far] = cell.children;
        const fullLines = near.children.find(o => o.isLineSegments);
        expect(fullLines.geometry.attributes.position.count).toBe(2 * 3 * 6 * 2);
        expect(far.children.find(o => o.isLineSegments).geometry.attributes.position.count).toBe(4);
        expect(near.children.filter(o => o.isInstancedMesh)).toHaveLength(2);
        const camera = new PerspectiveCamera(40,1,.1,1e7);
        camera.position.copy(cell.position);
        display.setView(camera, 1000);
        expect(near.visible).toBe(true);
        camera.position.y += 20000;
        display.setView(camera, 1000);
        expect(far.visible).toBe(true);
        expect(near.visible).toBe(false);
        const vertices = fullLines.geometry.attributes.position;
        const oldY = vertices.getY(0);
        height += 20;
        display.refreshGround();
        expect(fullLines.geometry.attributes.position).toBe(vertices);
        expect(vertices.getY(0)-oldY).toBeCloseTo(20,3);
    } finally { display.dispose(); }
});

test("wire links connect consecutive supports across bends and retain each branch and the clipped ends", () => {
    const {importedWireLinks, wirePorts} = require("../src/PowerObjectLinks");
    const network = {points:[{}, {kind:"pole",objectId:"A"}, {}, {kind:"pole",objectId:"B"},
        {kind:"pole",objectId:"C"}, {kind:"pole",objectId:"D"}],
        ways:[{path:[0,1,2,3,4]},{path:[3,5]}]};
    const links = importedWireLinks(network);
    expect(links.map(link => [link.from,link.to,link.path])).toEqual([
        [undefined,"A",[0,1]],["A","B",[1,2,3]],["B","C",[3,4]],["B","D",[3,5]],
    ]);
    expect(wirePorts).toEqual({from:"out",to:"in"});
});

test("only edited support IDs are resolved and moving one updates its adjoining wire buffers", () => {
    const network = parsePowerNetwork(geo);
    Object.assign(network.points[0],{objectId:"tower",batched:true});
    Object.assign(network.points[2],{objectId:"pole",batched:true});
    const display = createPowerNetworkGeometry(network, (lat,lon) => new Vector3(lon,lat,0));
    try {
        const resolve = jest.fn();
        display.syncLinkedSupports(resolve);
        expect(resolve).not.toHaveBeenCalled();
        display.watchSupport("tower");
        const matrix = new Matrix4().makeTranslation(-81,38,0);
        const parameters = {groundKind:"pylon",towerStyle:"horizontal",armSpan:40,height:51};
        resolve.mockReturnValue({matrix,parameters});
        display.syncLinkedSupports(resolve);
        const wires = display.group.children[0].children[0].children.find(o => o.isLineSegments).geometry.attributes.position;
        const before = wires.getX(0);
        matrix.elements[12] += 5;
        display.syncLinkedSupports(resolve);
        expect(wires.getX(0)-before).toBeCloseTo(5);
        expect(resolve.mock.calls).toEqual([["tower","pylon"],["tower","pylon"]]);
    } finally {display.dispose();}
});
