// CNode3DObject.js - CNode3DObject
// a 3D object node - a sphere, cube, etc., with generated geometry and material from the input parameters
// encapsulates a THREE.Object3D object, like:
// - THREE.Mesh (default)
// - THREE.LineSegments (if wireframe or edges)

import {CNode3DLight} from "./CNode3DLight";
import {CNode3DGroup} from "./CNode3DGroup";
import * as LAYER from "../LayerMasks";
import {fastComputeVertexNormals} from "../FastComputeVertexNormals";
import {
    Box3,
    BoxGeometry,
    CapsuleGeometry,
    CircleGeometry,
    Color,
    ConeGeometry,
    CubeCamera,
    CurvePath,
    CylinderGeometry,
    DataTexture,
    DodecahedronGeometry,
    EdgesGeometry,
    HalfFloatType,
    IcosahedronGeometry,
    LatheGeometry,
    LinearFilter,
    LineCurve3,
    LineSegments,
    Matrix3,
    Mesh,
    MeshBasicMaterial,
    MeshLambertMaterial,
    MeshPhongMaterial,
    MeshPhysicalMaterial,
    NearestFilter,
    OctahedronGeometry,
    QuadraticBezierCurve3,
    Raycaster,
    RGBAFormat,
    RingGeometry,
    ShaderMaterial,
    Sphere,
    SphereGeometry,
    TetrahedronGeometry,
    TorusGeometry,
    TorusKnotGeometry,
    TubeGeometry,
    UnsignedByteType,
    Vector2,
    Vector3,
    WebGLCubeRenderTarget,
    WireframeGeometry
} from "three";
import {FileManager, Globals, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {assert} from "../assert";
import {
    DebugArrowAB,
    disposeScene,
    patchMaterialForLinearOutput,
    propagateLayerMaskObject,
    removeDebugArrow
} from "../threeExt";
import {CNodeViewText} from "./CNodeViewText";
import {loadModelAsset} from "../ModelLoader";
import {V3} from "../threeUtils";
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';
import {CNodeLabel3D, CNodeMeasureAB} from "./CNodeLabels3D";
import {ECEFToLLAVD_radii} from "../LLA-ECEF-ENU";
import {getLocalUpVector} from "../SphericalMath";

import {findRootTrack} from "../FindRootTrack";
import {GlobalScene} from "../LocalFrame";
import {sharedUniforms} from "../js/map33/material/SharedUniforms";
import {par} from "../par";
import {CNodeGUIValue} from "./CNodeGUIValue";
import {t} from "../i18n";
import {
    CapsuleGeometryTL,
    EllipsoidGeometry,
    SuperEggGeometry,
    TicTacGeometry,
    commonMaterialParams,
    commonParams,
    computeCenterToLowestPoint,
    computeGroupBoundingSphere,
    computeLocalBoundingBox,
    computePointAtDistance,
    createCapGeometry,
    createCheckerboardTexture,
    createGradientTexture,
    createTube,
    gTypes,
    getBoundingBoxCorners,
    gradientFragmentShader,
    gradientPalettes,
    gradientVertexShader,
    materialTypes,
} from "./CNode3DObjectGeometry";
import {reflectionMethods} from "./CNode3DObjectReflection";

// Map old/renamed model file paths to their current equivalents.
// Used to remap file paths in loadedFiles and model name references in serialized sitches.
export const ModelAliases = {
    "data/models/737 MAX 8 BA.glb": "data/models/B737Max8.glb",
    "data/models/737%20MAX%208%20BA.glb": "data/models/B737Max8.glb",
    "data/models/PA28-181.glb": "data/models/PA28.glb",
};

// Resolve a model name or file path through ModelAliases, returning the canonical value.
// Also checks if an alias maps to a known ModelFiles key.
export function resolveModelAlias(name) {
    const alias = ModelAliases[name];
    if (alias) {
        // If the alias is a file path, find the ModelFiles key that uses it
        for (const [key, value] of Object.entries(ModelFiles)) {
            if (value.file === alias) return key;
        }
        return alias;
    }
    return name;
}

// Note these files are CASE SENSIVE. Mac OS is case insensitive, so be careful. (e.g. F-15.glb will not work on my deployed server)
export const ModelFiles = {
// TODO: X1-B
    "737 MAX 8 BA":         { file: 'data/models/B737Max8.glb',},
    "A340-600":             { file: 'data/models/A340-600.glb',},
    "A-10":                 { file: 'data/models/A-10.glb',},
    "AC690 Rockwell":       { file: 'data/models/AC690.glb',},
    "Bell 206 Helicopter":  { file: 'data/models/Bell-206.glb',},
    "F/A-18F" :             { file: 'data/models/FA-18F.glb',},
    "F-15":                 { file: 'data/models/f-15.glb',},
    "Lear 75":              { file: 'data/models/Lear-75.glb',},
    "MiG-29":               { file: 'data/models/MiG-29.glb',},
    "MQ-9 (loaded)":        { file: 'data/models/MQ9.glb',},
    "MQ-9 (clean)":         { file: 'data/models/MQ9-clean.glb',},
    "SR-71":                { file: 'data/models/SR-71.glb',},
    "PA-28-181":            { file: 'data/models/PA28.glb',},
    "Shahed Drone":             { file: 'data/models/shahed~L3.5m~.glb',},
 //   "737 MAX 8 (White)":    { file: 'data/models/737_MAX_8_White.glb',},
 //   "777-200ER (Malyasia)": { file: 'data/models/777-200ER-Malaysia.glb',},
//    "DC-10":                { file: 'data/models/DC-10.glb',},
   // "WhiteCube":            { file: 'data/models/white-cube.glb',},
   // "PinkCube":             { file: 'data/models/pink-cube.glb',},
   // "ATFLIR":               { file: 'data/models/ATFLIR.glb',},

    "X-37":                 { file: 'data/models/X-37.glb',},
    "Saucer":               { file: 'data/models/saucer01a.glb',},
    "TR-3B":               { file: 'data/models/tr-3b.glb',},
    "LCS":                 { file: 'data/models/LCS.glb',},

}


// Custom geometries

// SuperEggGeometry
// https://en.wikipedia.org/wiki/Superellipsoid

export class CNode3DObject extends CNode3DGroup {
    constructor(v) {
        v.layers ??= LAYER.MASK_LOOKRENDER;
        v.color ??= "white"
        v.size ??= 1;

        // patch DON'T convert the color to a constant node
        const oldColor = v.color;
        super(v);
        v.color = oldColor;

        this.input("size", true); // size input is optional

        this.color = v.color;
        this.layers = v.layers; // usually undefined, as the camera handles layers

        this.menuName = this.props.name ?? this.id;
        /// if more that 20 characters, truncate from the middle
        if (this.menuName.length > 20) {
            this.menuName = this.menuName.substring(0, 10) + "..." + this.menuName.substring(this.menuName.length - 7);
        }

        this.gui = guiMenus.objects.addFolder(this.menuName).close()
        this.common = {}
        this.geometryParams = {};
        this.materialParams = {};
        this.lights = []; // Initialize lights array

        this.common.material = v.material ?? "lambert";
        this.materialFolder = this.gui.addFolder("Material").close();
        this.materialFolder.isCommon = true; //temp patch - not needed?  not a controller???
        this.addParams(commonMaterialParams, this.common, this.materialFolder, true);
        this.rebuildMaterial();

        this.modelOrGeometry = v.modelOrGeometry;
        // if we don't have one, infer it from the presence of either "model" or geometry" in the parameters
        if (this.modelOrGeometry === undefined) {
            if (v.model !== undefined) {
                this.modelOrGeometry = "model";
            } else {
                this.modelOrGeometry = "geometry";
            }
        }

        this.modelOrGeometryMenu = this.gui.add(this, "modelOrGeometry", ["geometry", "model"]).listen().name(t("nodes3dObject.modelOrGeometry.label")).onChange((v) => {
            this.rebuild();
            setRenderOne(true)
        }).tooltip(t("nodes3dObject.modelOrGeometry.tooltip"))
            .listen();

        this.modelOrGeometryMenu.isCommon = true;

        this.selectModel = resolveModelAlias(v.model ?? "F/A-18F");
        this.modelMenu = this.gui.add(this, "selectModel", Object.keys(ModelFiles)).name(t("nodes3dObject.model.label")).onChange((v) => {
            this.modelOrGeometry = "model"
            this.rebuild();
            setRenderOne(true)
        })
            .listen()
            .tooltip(t("nodes3dObject.model.tooltip"));

        this.modelMenu.isCommon = true;

        // add the common parameters to the GUI
        // note we set isCommon to true to flag them as common
        // so they don't get deleted when we rebuild the GUI after object type change
        this.addParams(commonParams, this.common, this.gui, true); // add the common parameters to the GUI

        this.common.modelLength ??= v.modelLength ?? v.longestSide ?? v.targetLength ?? v.length ?? 0;
        this.modelLengthNode = new CNodeGUIValue({
            id: this.id + "_modelLength",
            value: this.common.modelLength,
            start: 0,
            end: 500,
            step: 0.1,
            desc: "Model Length",
            unitType: "small",
            tooltip: "Model length along the local Z axis. Set to 0 to disable automatic Z-length scaling.",
            onChange: () => {
                this.common.modelLength = this.modelLengthNode.value;
                this.recalculate();
                this.rebuildBoundingBox();
                setRenderOne(true);
            }
        }, this.gui);
        this.modelLengthController = this.modelLengthNode.guiEntry;
        this.modelLengthController.isCommon = true;

        this.displayBoundingBox = false;

        this.gui.add(this, "displayBoundingBox").name(t("nodes3dObject.displayBoundingBox.label")).listen().onChange((v) => {
            this.rebuild();
            setRenderOne(true)
        })
            .tooltip(t("nodes3dObject.displayBoundingBox.tooltip"))
            .isCommon = true;

        this.forceAboveSurface = v.forceAboveSurface ?? true;
        this.addSimpleSerial("forceAboveSurface");

        this.gui.add(this, "forceAboveSurface").name(t("nodes3dObject.forceAboveSurface.label")).listen().onChange((v) => {
            setRenderOne(true)
        })
            .tooltip(t("nodes3dObject.forceAboveSurface.tooltip"))
            .isCommon = true;

        const visibleController = this.gui.add(this, "visible").name("Visible").listen().onChange((v) => {
            this.show(v);
            setRenderOne(true);
        })
            .tooltip("Toggle visibility of this object in the 3D scene")
            .moveToFirst();
        visibleController.isCommon = true;

        // Add export to KML button
       this.gui.add(this, "exportToKML").name(t("nodes3dObject.exportToKML.label"))
            .tooltip(t("nodes3dObject.exportToKML.tooltip"))
            .isCommon = true;

        // Reflection Analysis
        this.reflectionGridSize = 50;
        this.reflectionArrowIds = [];

        this.reflectionFolder = this.gui.addFolder("Reflection Analysis").close();
        this.reflectionFolder.isCommon = true;

        this.reflectionFolder.add(this, "startReflectionAnalysis")
            .name(t("nodes3dObject.startAnalysis.label")).tooltip(t("nodes3dObject.startAnalysis.tooltip")).isCommon = true;

        this.reflectionFolder.add(this, "reflectionGridSize", 5, 100, 1)
            .name(t("nodes3dObject.gridSize.label")).tooltip(t("nodes3dObject.gridSize.tooltip"))
            .onFinishChange(() => {
                if (this.reflectionArrowIds.length > 0) this.startReflectionAnalysis();
            }).isCommon = true;

        this.reflectionFolder.add(this, "cleanUpReflectionAnalysis")
            .name(t("nodes3dObject.cleanUp.label")).tooltip(t("nodes3dObject.cleanUp.tooltip")).isCommon = true;

        this.rebuild();

        // move the material folder to the end
        this.materialFolder.moveToEnd();

        if (v.label !== undefined) {
            this.addLabel(v.label)
        }

        // Apply initial visibility (e.g. v.visible:false) to the group/label.
        // CNode super sets this.visible from v.visible but never propagates
        // it to this.group.visible.
        this.show(this.visible);
    }


    // We can use objects as data sources for things like labels
    // so we need to be able to get the value of the object
    // Note this just gets the CURRENT position of the object
    getValueFrame(frameFloat) {
        return {position: this.group.position.clone()};
    }

    show(visible=true) {
        super.show(visible);
        if (this.label !== undefined) {
            this.label.show(visible)
        }
    }


    addLabel( label ) {

        this.label = new CNodeLabel3D({
            id: this.id + "_label",
            text: label,
            position: this,
            offsetY:40, // this is vertical offset in screen pixels.
            color: "white",
            size:12,
            groupNode: "LabelsGroupNode",

        })

    }

    // Export the 3D object as a KML file for Google Earth
    async exportToKML() {
        try {
            // Get the current position of the object in ECEF coordinates
            const ecefPosition = this.group.position.clone();
            
            // Convert ECEF position to LLA (Latitude, Longitude, Altitude)
            const lla = ECEFToLLAVD_radii(ecefPosition);
            const latitude = lla.x;   // degrees
            const longitude = lla.y;  // degrees  
            const altitude = lla.z;   // meters above sea level
            
            // Get object properties
            const objectName = this.props.name || this.id;
            const geometryType = this.common.geometry || 'sphere';
            
            // Get sitch name for filename prefix
            const sitchName = Sit.sitchName || Sit.name;
            // Generate COLLADA file content
            const colladaResult = this.generateColladaContent(objectName, geometryType);
            const colladaContent = colladaResult.content;
            const colladaFilename = `${objectName}_${geometryType}.dae`;
            
            // Create KML content that references the COLLADA model in files/ directory
            const kmlContent = this.generateKMLContent(objectName, latitude, longitude, altitude, geometryType, `files/${colladaFilename}`);
            
            // Create a KMZ file containing doc.kml and files/model.dae with sitch name prefix
            const kmzFilename = `${sitchName}_${objectName}_${geometryType}.kmz`;
            
            await this.saveAsKMZ(kmlContent, colladaContent, objectName, geometryType, kmzFilename);
            console.log(`KMZ file exported successfully as: ${kmzFilename}`);
            console.log(`COLLADA contains ${colladaResult.vertexCount} vertices, ${colladaResult.triangleCount} triangles`);
            console.log(`Material: ${colladaResult.materialInfo.color}, opacity: ${colladaResult.materialInfo.opacity}`);
            
            alert(`3D object exported successfully!\n\nFile saved:\n- ${kmzFilename} (KMZ archive with embedded 3D model)\n\nIMPORTANT:\n1. Open the KMZ file directly in Google Earth\n2. The 3D object will appear at the specified location\n3. No extraction needed - everything is packaged together!\n\nNote: KMZ is the standard format for 3D models in Google Earth.`);
            
        } catch (error) {
            console.error('Error exporting to KML:', error);
            alert('Error exporting to KML: ' + error.message);
        }
    }

    // Generate KML content for the 3D object
    generateKMLContent(name, latitude, longitude, altitude, geometryType, colladaFilename) {
        // Get object dimensions based on geometry type
        const dimensions = this.getObjectDimensions(geometryType);
        
        // Get material properties
        const materialInfo = this.getMaterialInfo();
        
        // Create description with object details
        const description = `
            <![CDATA[
            <h3>3D Object: ${name}</h3>
            <p><strong>Type:</strong> ${geometryType}</p>
            <p><strong>Position:</strong></p>
            <ul>
                <li>Latitude: ${latitude.toFixed(6)}°</li>
                <li>Longitude: ${longitude.toFixed(6)}°</li>
                <li>Altitude: ${altitude.toFixed(2)} m</li>
            </ul>
            <p><strong>Dimensions:</strong></p>
            <ul>
                ${dimensions.map(dim => `<li>${dim.name}: ${dim.value.toFixed(3)} ${dim.unit}</li>`).join('')}
            </ul>
            <p><strong>Material:</strong></p>
            <ul>
                <li>Type: ${materialInfo.type}</li>
                <li>Color: ${materialInfo.color}</li>
                <li>Opacity: ${materialInfo.opacity.toFixed(2)}</li>
                ${materialInfo.transparent ? '<li>Transparent: Yes</li>' : ''}
            </ul>
            <p><em>Exported from Sitrec</em></p>
            ]]>
        `;

        // Get object scale for proper sizing in Google Earth
        const scale = this.getObjectScale();

        // Generate KML with 3D model reference
        const kml = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
    <Document>
        <name>${name} - ${geometryType}</name>
        <description>3D Object exported from Sitrec</description>
        
        <Placemark>
            <name>${name}</name>
            <description>${description}</description>
            <Model>
                <altitudeMode>absolute</altitudeMode>
                <Location>
                    <longitude>${longitude}</longitude>
                    <latitude>${latitude}</latitude>
                    <altitude>${altitude}</altitude>
                </Location>
                <Orientation>
                    <heading>0</heading>
                    <tilt>0</tilt>
                    <roll>0</roll>
                </Orientation>
                <Scale>
                    <x>${scale.x}</x>
                    <y>${scale.y}</y>
                    <z>${scale.z}</z>
                </Scale>
                <Link>
                    <href>${colladaFilename}</href>
                </Link>
            </Model>
        </Placemark>
    </Document>
</kml>`;

        return kml;
    }

    // Get object dimensions based on geometry type
    getObjectDimensions(geometryType) {
        const dimensions = [];
        
        switch (geometryType) {
            case 'sphere':
                if (this.geometryParams.radius !== undefined) {
                    dimensions.push({ name: 'Radius', value: this.geometryParams.radius, unit: 'm' });
                }
                break;
                
            case 'ellipsoid':
                if (this.geometryParams.radius !== undefined) {
                    dimensions.push({ name: 'Horizontal Radius', value: this.geometryParams.radius, unit: 'm' });
                }
                if (this.geometryParams.aspect !== undefined && this.geometryParams.radius !== undefined) {
                    dimensions.push({ name: 'Vertical Radius', value: this.geometryParams.radius * this.geometryParams.aspect, unit: 'm' });
                }
                break;
                
            case 'box':
                if (this.geometryParams.width !== undefined) {
                    dimensions.push({ name: 'Width', value: this.geometryParams.width, unit: 'm' });
                }
                if (this.geometryParams.height !== undefined) {
                    dimensions.push({ name: 'Height', value: this.geometryParams.height, unit: 'm' });
                }
                if (this.geometryParams.depth !== undefined) {
                    dimensions.push({ name: 'Depth', value: this.geometryParams.depth, unit: 'm' });
                }
                break;
                
            case 'capsule':
                if (this.geometryParams.radius !== undefined) {
                    dimensions.push({ name: 'Radius', value: this.geometryParams.radius, unit: 'm' });
                }
                if (this.geometryParams.totalLength !== undefined) {
                    dimensions.push({ name: 'Total Length', value: this.geometryParams.totalLength, unit: 'm' });
                }
                break;
                
            case 'cylinder':
                if (this.geometryParams.radiusTop !== undefined) {
                    dimensions.push({ name: 'Top Radius', value: this.geometryParams.radiusTop, unit: 'm' });
                }
                if (this.geometryParams.radiusBottom !== undefined) {
                    dimensions.push({ name: 'Bottom Radius', value: this.geometryParams.radiusBottom, unit: 'm' });
                }
                if (this.geometryParams.height !== undefined) {
                    dimensions.push({ name: 'Height', value: this.geometryParams.height, unit: 'm' });
                }
                break;
                
            default:
                // For other geometry types, try to get common parameters
                if (this.geometryParams.radius !== undefined) {
                    dimensions.push({ name: 'Radius', value: this.geometryParams.radius, unit: 'm' });
                }
                if (this.geometryParams.height !== undefined) {
                    dimensions.push({ name: 'Height', value: this.geometryParams.height, unit: 'm' });
                }
                break;
        }
        
        return dimensions;
    }

    // Save KML file with proper file type configuration
    async saveKMLFile(contents, suggestedName = 'object.kml') {
        try {
            // Use the File System Access API with KML file type
            const fileHandle = await window.showSaveFilePicker({
                suggestedName,
                types: [{
                    description: 'KML Files',
                    accept: {
                        'application/vnd.google-earth.kml+xml': ['.kml'],
                        'text/xml': ['.kml'],
                    }
                }]
            });

            const writable = await fileHandle.createWritable();
            await writable.write(contents);
            await writable.close();

            console.log('KML file saved successfully!');
            return fileHandle.name;

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('File save was cancelled by user');
                throw new Error('File save cancelled');
            } else {
                console.error('Error saving KML file:', error);
                throw error;
            }
        }
    }

    // Get material information for KML description
    getMaterialInfo() {
        const material = this.material || this.object?.material;
        if (!material) {
            return {
                type: 'Unknown',
                color: '#ffffff',
                opacity: 1.0,
                transparent: false
            };
        }

        // Convert Three.js color to hex string
        const colorHex = material.color ? `#${material.color.getHexString()}` : '#ffffff';
        
        return {
            type: this.common.material || 'basic',
            color: colorHex,
            opacity: material.opacity || 1.0,
            transparent: material.transparent || false
        };
    }

    // Get object scale for KML model
    getObjectScale() {
        // Get the geometry bounds to determine appropriate scaling
        const geometry = this.geometry;
        if (geometry && geometry.boundingBox) {
            geometry.computeBoundingBox();
            const box = geometry.boundingBox;
            const size = Math.max(
                box.max.x - box.min.x,
                box.max.y - box.min.y,
                box.max.z - box.min.z
            );
            
            // Scale to ensure the model is visible in Google Earth (target size ~10-100 meters)
            let scale = 1.0;
            if (size < 1) {
                scale = 10.0; // Scale up very small objects
            } else if (size > 100) {
                scale = 50.0 / size; // Scale down very large objects
            }
            
            return { x: scale, y: scale, z: scale };
        }
        
        // Default scale - use 1.0 for normal sized objects
        return { x: 1.0, y: 1.0, z: 1.0 };
    }

    // Generate COLLADA (.dae) file content
    generateColladaContent(name, geometryType) {
        let geometry, material;
        
        // Handle both procedural geometry and loaded models
        if (this.modelOrGeometry === "model" && this.model) {
            // For loaded models, extract geometry from the first mesh
            let firstMesh = null;
            this.model.traverse((child) => {
                if (child.isMesh && !firstMesh) {
                    firstMesh = child;
                }
            });
            
            if (!firstMesh) {
                throw new Error('No mesh found in the loaded model');
            }
            
            geometry = firstMesh.geometry;
            material = firstMesh.material;
            geometryType = 'model';
        } else {
            // For procedural geometry
            geometry = this.geometry;
            material = this.material || this.object?.material;
            
            if (!geometry) {
                throw new Error('No geometry available for COLLADA export');
            }

            // Check if object is in wireframe or edges mode
            if (this.common.wireframe || this.common.edges) {
                throw new Error('Cannot export wireframe or edges geometry to COLLADA. Please disable wireframe/edges mode and try again.');
            }
        }

        // Get geometry data
        const vertices = this.getVerticesFromGeometry(geometry);
        const normals = this.getNormalsFromGeometry(geometry);
        const indices = this.getIndicesFromGeometry(geometry);
        
        // Get material properties
        const materialInfo = this.getMaterialInfo();
        
        // Generate unique IDs
        const geometryId = `${name}-geometry`;
        const materialId = `${name}-material`;
        const effectId = `${name}-effect`;
        
        // Create COLLADA XML content
        const collada = `<?xml version="1.0" encoding="utf-8"?>
<COLLADA xmlns="http://www.collada.org/2005/11/COLLADASchema" version="1.4.1">
    <asset>
        <contributor>
            <authoring_tool>Sitrec</authoring_tool>
        </contributor>
        <created>${new Date().toISOString()}</created>
        <modified>${new Date().toISOString()}</modified>
        <unit name="meter" meter="1"/>
        <up_axis>Y_UP</up_axis>
    </asset>
    
    <library_effects>
        <effect id="${effectId}">
            <profile_COMMON>
                <technique sid="common">
                    <phong>
                        <emission>
                            <color sid="emission">0.0 0.0 0.0 1.0</color>
                        </emission>
                        <ambient>
                            <color sid="ambient">0.2 0.2 0.2 1.0</color>
                        </ambient>
                        <diffuse>
                            <color sid="diffuse">${this.colorToRGBA(materialInfo.color, materialInfo.opacity)}</color>
                        </diffuse>
                        <specular>
                            <color sid="specular">0.5 0.5 0.5 1.0</color>
                        </specular>
                        <shininess>
                            <float sid="shininess">20.0</float>
                        </shininess>
                        ${materialInfo.transparent && materialInfo.opacity < 1.0 ? `
                        <transparent opaque="A_ONE">
                            <color sid="transparent">1.0 1.0 1.0 1.0</color>
                        </transparent>
                        <transparency>
                            <float sid="transparency">${materialInfo.opacity}</float>
                        </transparency>` : ''}
                    </phong>
                </technique>
            </profile_COMMON>
        </effect>
    </library_effects>
    
    <library_materials>
        <material id="${materialId}" name="${name}-material">
            <instance_effect url="#${effectId}"/>
        </material>
    </library_materials>
    
    <library_geometries>
        <geometry id="${geometryId}" name="${name}-geometry">
            <mesh>
                <source id="${geometryId}-positions">
                    <float_array id="${geometryId}-positions-array" count="${vertices.length}">
                        ${vertices.join(' ')}
                    </float_array>
                    <technique_common>
                        <accessor source="#${geometryId}-positions-array" count="${vertices.length / 3}" stride="3">
                            <param name="X" type="float"/>
                            <param name="Y" type="float"/>
                            <param name="Z" type="float"/>
                        </accessor>
                    </technique_common>
                </source>
                
                <source id="${geometryId}-normals">
                    <float_array id="${geometryId}-normals-array" count="${normals.length}">
                        ${normals.join(' ')}
                    </float_array>
                    <technique_common>
                        <accessor source="#${geometryId}-normals-array" count="${normals.length / 3}" stride="3">
                            <param name="X" type="float"/>
                            <param name="Y" type="float"/>
                            <param name="Z" type="float"/>
                        </accessor>
                    </technique_common>
                </source>
                
                <vertices id="${geometryId}-vertices">
                    <input semantic="POSITION" source="#${geometryId}-positions"/>
                </vertices>
                
                <triangles material="material0" count="${indices.length / 3}">
                    <input semantic="VERTEX" source="#${geometryId}-vertices" offset="0"/>
                    <input semantic="NORMAL" source="#${geometryId}-normals" offset="0"/>
                    <p>${indices.join(' ')}</p>
                </triangles>
            </mesh>
        </geometry>
    </library_geometries>
    
    <library_visual_scenes>
        <visual_scene id="Scene" name="Scene">
            <node id="${name}" name="${name}" type="NODE">
                <instance_geometry url="#${geometryId}">
                    <bind_material>
                        <technique_common>
                            <instance_material symbol="material0" target="#${materialId}"/>
                        </technique_common>
                    </bind_material>
                </instance_geometry>
            </node>
        </visual_scene>
    </library_visual_scenes>
    
    <scene>
        <instance_visual_scene url="#Scene"/>
    </scene>
</COLLADA>`;

        return {
            content: collada,
            vertexCount: vertices.length / 3,
            triangleCount: indices.length / 3,
            materialInfo: materialInfo
        };
    }

    // Extract vertices from Three.js geometry
    getVerticesFromGeometry(geometry) {
        const positions = geometry.attributes.position;
        if (!positions) {
            throw new Error('Geometry has no position attribute');
        }
        
        // Convert vertices and ensure they're properly scaled for Google Earth
        const vertices = Array.from(positions.array);
        const transformedVertices = [];
        
        // Transform vertices to ensure proper orientation for Google Earth
        // Google Earth uses Y-up coordinate system
        for (let i = 0; i < vertices.length; i += 3) {
            const x = vertices[i];
            const y = vertices[i + 1];
            const z = vertices[i + 2];
            
            // Keep the same coordinate system but ensure reasonable scale
            transformedVertices.push(x, y, z);
        }
        
        return transformedVertices;
    }

    // Extract normals from Three.js geometry
    getNormalsFromGeometry(geometry) {
        let normals = geometry.attributes.normal;
        if (!normals) {
            // Compute normals if they don't exist - using optimized version
            fastComputeVertexNormals(geometry);
            normals = geometry.attributes.normal;
        }
        return Array.from(normals.array);
    }

    // Extract indices from Three.js geometry
    getIndicesFromGeometry(geometry) {
        const index = geometry.index;
        if (index) {
            return Array.from(index.array);
        } else {
            // Generate indices for non-indexed geometry
            const vertexCount = geometry.attributes.position.count;
            const indices = [];
            for (let i = 0; i < vertexCount; i++) {
                indices.push(i);
            }
            return indices;
        }
    }

    // Convert hex color to RGBA string for COLLADA
    colorToRGBA(hexColor, opacity = 1.0) {
        // Remove # if present
        const hex = hexColor.replace('#', '');
        
        // Parse RGB values
        const r = parseInt(hex.substring(0, 2), 16) / 255;
        const g = parseInt(hex.substring(2, 4), 16) / 255;
        const b = parseInt(hex.substring(4, 6), 16) / 255;
        
        return `${r.toFixed(6)} ${g.toFixed(6)} ${b.toFixed(6)} ${opacity.toFixed(6)}`;
    }

    // Save KML and COLLADA files as a KMZ archive with proper structure
    async saveAsKMZ(kmlContent, colladaContent, objectName, geometryType, suggestedName) {
        try {
            // Import JSZip dynamically
            const JSZip = (await import('jszip')).default;
            
            const kmz = new JSZip();
            
            // Add doc.kml file to root of KMZ (required name for KMZ format)
            kmz.file('doc.kml', kmlContent);
            
            // Create files/ directory and add COLLADA file
            const colladaFilename = `${objectName}_${geometryType}.dae`;
            kmz.file(`files/${colladaFilename}`, colladaContent);
            
            // Generate KMZ blob (which is just a ZIP with .kmz extension)
            const kmzBlob = await kmz.generateAsync({type: 'blob'});
            
            // Use File System Access API to save KMZ
            const fileHandle = await window.showSaveFilePicker({
                suggestedName,
                types: [{
                    description: 'Google Earth KMZ Files',
                    accept: {
                        'application/vnd.google-earth.kmz': ['.kmz'],
                        'application/zip': ['.kmz'],
                    }
                }]
            });

            const writable = await fileHandle.createWritable();
            await writable.write(kmzBlob);
            await writable.close();

            console.log('KMZ file saved successfully!');
            return fileHandle.name;

        } catch (error) {
            if (error.name === 'AbortError') {
                console.log('KMZ file save was cancelled by user');
                throw new Error('KMZ file save cancelled');
            } else {
                console.error('Error saving KMZ file:', error);
                throw error;
            }
        }
    }

    modSerialize() {
        // Shallow-copy common so we can add modelLengthSI without polluting the live object
        const commonCopy = {...this.common};
        if (this.modelLengthNode) {
            // Store model length in SI (meters) for unit-system-independent serialization
            commonCopy.modelLengthSI = this.modelLengthNode.getValueFrame(0);
        }
        return {
            ...super.modSerialize(),
            color: this.color,
            modelOrGeometry: this.modelOrGeometry,
            model: this.selectModel,
            common: commonCopy,
            geometryParams: this.geometryParams,
            materialParams: this.materialParams,
        }
    }

    modDeserialize(v) {
        super.modDeserialize(v)
        this.color = v.color;
        this.modelOrGeometry = v.modelOrGeometry;
        this.selectModel = resolveModelAlias(v.model);



        // copy the values from v.common, v.geometryParams, v.materialParams
        // to this.common, this.geometryParams, this.materialParams
        // we need to copy the values, not just assign the object
        // because the GUI is referencing the values in this.common, etc
        // and so creating a new object would break the GUI
        for (const key in v.common) {
            this.common[key] = v.common[key];
        }

        this.common.modelLength ??= this.common.longestSide ?? this.common.targetLength ?? this.common.length;
        delete this.common.longestSide;
        delete this.common.targetLength;
        delete this.common.length;
        if (this.modelLengthNode) {
            if (this.common.modelLengthSI !== undefined) {
                // New format: stored in SI meters, convert to current display units
                this.modelLengthNode.setValueWithUnits(this.common.modelLengthSI, "metric", "small");
                delete this.common.modelLengthSI;
            } else {
                // Legacy format: stored in display units, use as-is
                this.modelLengthNode.setValue(this.common.modelLength);
            }
            this.common.modelLength = this.modelLengthNode.value;
        }

        if (this.modelOrGeometry === "geometry") {
            // we do an initial rebuild of geometry to set up the parameters
            // with this.common.geometry
            // otherwise parameters will get reset to defaults
            this.rebuild();
        }

        for (const key in v.geometryParams) {
            this.geometryParams[key] = v.geometryParams[key];
        }

        // First rebuildMaterial creates the correct param structure and UI
        // for the (possibly new) material type. This resets this.materialParams
        // with defaults and builds fresh GUI controllers.
        this.rebuildMaterial();

        // Now copy deserialized material params into the freshly created object.
        // The GUI controllers are bound to this.materialParams with .listen(),
        // so they'll reflect the restored values.
        if (v.materialParams) {
            for (const key in v.materialParams) {
                if (key in this.materialParams) {
                    this.materialParams[key] = v.materialParams[key];
                }
            }
        }

        // Migrate old 'specularcolor' to correct Three.js property names (Feb 2026)
        if (this.materialParams.specularcolor !== undefined) {
            const materialType = this.common.material;
            if (materialType === 'phong') {
                this.materialParams.specular = this.materialParams.specularcolor;
            } else {
                this.materialParams.specularColor = this.materialParams.specularcolor;
            }
            delete this.materialParams.specularcolor;
        }

        // Rebuild material again with the deserialized values.
        // Since the type hasn't changed, params won't be reset.
        this.rebuildMaterial();
        this.rebuild();

        // Apply restored visibility to the group/label, since the base
        // modDeserialize only sets this.visible without invoking show().
        this.show(this.visible);

    }

//   // this is the function that adds the parameters to the GUI
    // it takes the geometryParams and materialParams objects
    // and adds them to the GUI
    // it also sets the default values for the parameters
    // and sets the tooltip for the parameters
    // the geometryParams and materialParams objects are passed in as arrays
    // so they can be used as a template for the GUI
    // the first element is the default value, the second element is the tooltip
    // the third element is the min value, the fourth element is the max value
    // the fifth element is the step value
    // the sixth element is the type of parameter (string, number, boolean, array)
    // the seventh element is the name of the parameter
    addParams(geometryParams, toHere, gui, isCommon=false) {
        const v = this.props;
        for (const key in geometryParams) {
            let params = geometryParams[key][0];
            let tip = geometryParams[key][1];


            // if the geometryParams[key] is an array of four numbers, then
            // set paramps to that array, and set tip to the key
            if (geometryParams[key].length === 4) {
                params = geometryParams[key];
                tip = key;
            }

            if (v[key] === undefined) {
                // if no value is given, then use the first value in the array
                // (the default value)
                // or the value itself if it's not an array
                if (Array.isArray(params) && key !== "color") {
                    v[key] = params[0];
                } else {
                    v[key] = params;
                }
            }
            toHere[key] = v[key];

            let controller;

            const colorNames = ["color", "emissive", "specularColor", "sheenColor", "baseColor"]
            if (colorNames.includes(key)) {
                // assume string values are colors
                // (might need to have an array of names of color keys, like "emissive"
              // add color picker
                // its going to be to controlling toHere[key]
                // which will be this.common.color
                // first we need to ensure it's in the correct format for lil-gui
                // which expect a hex string like "#RRGGBB"

                let passedColor = toHere[key];
                let color3;
                if (Array.isArray(passedColor)) {
                    // the only format three.js can't handle is an array
                    color3 = new Color(passedColor[0], passedColor[1], passedColor[2]);
                } else {
                    // otherwise it's a hex string, or a three.js color
                    color3 = new Color(passedColor);
                }
                toHere[key] = "#" + color3.getHexString();
                controller = gui.addColor(toHere, key).name(key).listen()
                    .onChange((v) => {
                        this.rebuild();
                        setRenderOne(true)
                    }).tooltip(tip);

            } else if (Array.isArray(params)) {

                const elastic = ["radius", "length", "height", "width", "depth", "tube", "innerRadius", "outerRadius", "height", "totalLength", "radiusTop", "radiusBottom",];
                const isElastic = elastic.includes(key);


                // is the firsts value in the array a number?
                if (typeof params[0] === "number") {
                    // and make a gui slider for the parameter
                    controller = gui.add(toHere, key, params[1], params[2], params[3]).name(key).listen()
                        .onChange((v) => {
                            this.rebuild();
                            setRenderOne(true)
                        }).tooltip(tip);
                    if (isElastic) {
                        // elastic means the range will expand 2x when you go of the right end
                        // and reset to the minimum when you go off the left end
                        // Upper limit not too important, so we just set it to 1000x the default
                        controller.elastic(params[2]/100, params[2] * 1000)
                    }

                } else {
                    // assume it's a string, so a drop-down
                    // make a drop-down for the parameter
                    controller = gui.add(toHere, key, params).name(key).listen()
                        .onChange((v) => {
                            if (key === "geometry") {
                                this.modelOrGeometry = "geometry"
                            }
                            this.rebuild();
                            setRenderOne(true)
                        }).tooltip(tip);
                }

            } else {
                // if it's not an array, then it's a boolean
                // so make a checkbox
                controller = gui.add(toHere, key).name(key).listen()
                    .onChange((v) => {
                        this.rebuild();
                        setRenderOne(true);
                        // Note: updateControlVisibility() is already called in rebuild(), so no need to call it again
                    }).tooltip(tip);
            }

            controller.isCommon = isCommon;

        }
    }

    updateControlVisibility() {
        // Define controller visibility rules
        // Each entry: [controllerProperty, showInModelMode, customLogic]
        const controllerVisibilityRules = [
            ['applyMaterial', true, null], // Show in model mode, hide in geometry mode
            ['modelDisplayMode', true, null], // Show in model mode, hide in geometry mode
            ['selectModel', true, null], // Show in model mode, hide in geometry mode
            ['geometry', false, null], // Hide in model mode, show in geometry mode
            ['exportToKML', false, null], // Hide in model mode, show in geometry mode
        ];

        // Apply visibility rules for standard controllers
        controllerVisibilityRules.forEach(([controllerProperty, showInModelMode]) => {

            //  find the controller in this.gui.children
            // then show/hide it depending on the rule
            const controller = this.gui.children.find(c => c.property === controllerProperty);

            const isModelMode = this.modelOrGeometry === "model";

            if (controller) {
                if ((isModelMode && showInModelMode) || (!isModelMode && !showInModelMode)) {
                    controller.show();
                } else {
                    controller.hide();
                }
            } else {
                console.error(`Controller property '${controllerProperty}' not found in this.gui in updateControlVisibility`)
            }
        });

        // Handle material folder with custom logic (depends on both mode and applyMaterial setting)
        if (this.materialFolder) {
            if (this.modelOrGeometry === "model" && !this.common.applyMaterial) {
                this.materialFolder.hide();
            } else {
                this.materialFolder.show();
            }

            // Hide common material controls that don't apply to gradient ShaderMaterial
            const isGradient = this.common.material?.toLowerCase() === "gradient";
            const hideForGradient = ['wireframe', 'edges', 'depthTest', 'opacity', 'transparent'];
            for (const c of this.materialFolder.controllers) {
                if (hideForGradient.includes(c.property)) {
                    if (isGradient) {
                        c.hide();
                    } else {
                        c.show();
                    }
                }
            }
        }
    }




    rebuild() {
        let newType = false;
        if (this.modelOrGeometry !== this.lastModelOrGeometry) {
            this.lastModelOrGeometry = this.modelOrGeometry;
            newType = true;
        }

        this.updateControlVisibility();

        // remove the BB measure, in case we don't rebuild them
        NodeMan.disposeRemove(this.measureX, true);
        this.measureX  = undefined;
        NodeMan.disposeRemove(this.measureY, true);
        this.measureY  = undefined;
        NodeMan.disposeRemove(this.measureZ, true);
        this.measureZ  = undefined;


        const v = this.props;

        const common = this.common;

        this.rebuildMaterial();


        if (this.modelOrGeometry === "model") {
            // Remove geometry parameters from UI when switching to model mode
            if (newType) {
                this.destroyNonCommonUI(this.gui);
            }

            // load the model if differ  ent, this will be async
            // here this.selectModel is the NAME of the model (id or drag and drop filename
            // and this.currentModel points to a model def object (which currently just just a file)
            // so this.currentModel.file is the filename of the last loaded file
            const model = ModelFiles[this.selectModel];

            if (model !== this.currentModel || newType) {

                // if the new model and the old model are BOTH dynamic
                // then we need to remove the old model from the file manager and the GUI
                // Otherwise we'll accumulate models that will get loaded but are not used
                // if the new model has not been loaded yet, then we also need to remove the old model
                // we do that test first, as isUnhosted will assert if the file doesn't exist

                if (this.currentModel
                    && this.currentModel.file !== model.file
                    && FileManager.isUnhosted(this.currentModel.file)
                    && (!FileManager.exists(this.selectModel) || FileManager.isUnhosted(this.selectModel))
                ) {
                    console.log(`Removing unhosted file: ${this.currentModel.file}, replacing with ${model.file}`)
                    FileManager.disposeRemove(this.currentModel.file);
                    // will need to remove from GUI. after we implement adding it ...

                }


                this.currentModel = model;


                //const loader = new GLTFLoader();
                console.log("LOADING NEW model: ", model.file);

                Globals.pendingActions++;
                loadModelAsset(model.file, modelAsset => {
                    // since it's async, we might now be rendering a geometry
                    // If so, then don't add the model to the group
                    if (this.modelOrGeometry === "model") {

                        // destroy the existing object AFTER the new one is loaded
                        // otherwise we might start loading a new object before the last one had finished loading
                        // so the first one will still get added
                        this.destroyObject();
                        this.destroyLights();

                        this.model = modelAsset.scene;
                        this.applyModelFilenameParameters(modelAsset);
                        this.captureModelSourceMaterials();

                        if (Globals.shadowsEnabled) {
                            this.model.traverse((child) => {
                                if (child.isMesh) {
                                    child.castShadow = true;
                                    child.receiveShadow = true;
                                }
                            });
                        }

                        this.extractLightsFromModel(this.model);

                        this.group.add(this.model);
                        
                        // Cache the bounding sphere in local coordinates for efficient camera collision detection
                        this.cachedBoundingSphere = computeGroupBoundingSphere(this.model);
                        console.log("Cached bounding sphere for model:", model.file, "radius:", this.cachedBoundingSphere.radius);

                        // Cache half extents of the local bounding box for gradient mapping
                        const modelBox = computeLocalBoundingBox(this.model);
                        this.cachedModelLength = modelBox.max.z - modelBox.min.z;
                        this.cachedHalfHeight = (modelBox.max.y - modelBox.min.y) / 2;
                        this.cachedHalfLength = (modelBox.max.z - modelBox.min.z) / 2;

                        // Cache the height from center to lowest point for ground clamping
                        this.cachedCenterToLowestPoint = computeCenterToLowestPoint(this.model);
                        console.log("Cached center to lowest point for model:", model.file, "height:", this.cachedCenterToLowestPoint);
                        
                        this.propagateLayerMask()
                        this.recalculate()
                        this.applyMaterialToModel();
                        this.rebuildBoundingBox();
                        console.log("ADDED TO SCENE : ", model.file);
                        setRenderOne(true);

                    }
                    Globals.pendingActions--;
                }, (error) => {
                    console.error("Failed to load model:", model.file, error);
                    Globals.pendingActions--;
                });
            }

            this.applyMaterialToModel();
            this.rebuildBoundingBox();
            return;
        }


        this.destroyObject();
        this.destroyLights();

        // set up inputs based on the geometry type
        // add the defaults if a parameter is missing
        // and add UI controls for the parameters
        const geometryType = common.geometry.toLowerCase();
        const geometryDef = gTypes[geometryType];
        assert(geometryDef !== undefined, "Unknown geometry type: " + geometryType)
        const geometryParams = geometryDef.params;
        // for all the parameters in the geometry type
        // add them to the geometryParams object
        // (either the passed value, or a default)



        // if the geometry or material type has changed, or if we're switching from model to geometry mode
        // then delete all the geometry-specific parameters and re-create them
        if (this.lastGeometry !== common.geometry || newType) {
            this.destroyNonCommonUI(this.gui);

            // and re-create them
            this.geometryParams = {}
            this.addParams(geometryParams, this.geometryParams, this.gui);

            // move the material folder to the end after adding geometry parameters
            this.materialFolder.moveToEnd();

            this.lastGeometry = common.geometry;
        }


        // // map them to the variables in this.geometryParams
        const params = Object.keys(this.geometryParams)
            .map(key => this.geometryParams[key]);

        this.geometry = new geometryDef.g(...params);

        // Apply special geometry-specific rotation adjustments to the geometry itself
        // These are baked-in rotations that are specific to certain geometry types
        const geometryRotateX = ((common.geometry === "capsule" || common.geometry === "tictac") ? 90 : 0);
        if (geometryRotateX) {
            this.geometry.rotateX(geometryRotateX * Math.PI / 180);
        }

        // Note: User-defined rotations (rotateX, rotateY, rotateZ) are now applied 
        // as transforms in preRender() instead of being baked into the geometry

        if (common.wireframe) {
            this.wireframe = new WireframeGeometry(this.geometry);
            this.object = new LineSegments(this.wireframe);
        } else if (common.edges) {
            this.wireframe = new EdgesGeometry(this.geometry);
            this.object = new LineSegments(this.wireframe);
        } else {
            this.object = new Mesh(this.geometry, this.material);
        }

        // const matColor = new Color(common.color)
        // this.object.material.color = matColor;

        this.object.material.depthTest = common.depthTest ?? true;
        this.object.material.opacity = common.opacity ?? 1;
        this.object.material.transparent = common.transparent ?? (v.opacity < 1.0);

        if (Globals.shadowsEnabled) {
            this.object.castShadow = true;
            this.object.receiveShadow = true;
        }
        this.group.add(this.object);
        
        // Cache the bounding sphere in local coordinates for efficient camera collision detection
        // For geometry objects, compute it from the geometry's bounding sphere
        this.geometry.computeBoundingSphere();
        this.cachedBoundingSphere = this.geometry.boundingSphere.clone();

        // Cache the height from center to lowest point for ground clamping
        // For geometry objects, compute it from the geometry's bounding box
        this.geometry.computeBoundingBox();
        const geomBox = this.geometry.boundingBox;
        this.cachedModelLength = geomBox.max.z - geomBox.min.z;
        const geomCenter = new Vector3();
        geomBox.getCenter(geomCenter);
        this.cachedCenterToLowestPoint = geomCenter.y - geomBox.min.y;

        // Cache half extents of the bounding box for gradient mapping
        this.cachedHalfHeight = (geomBox.max.y - geomBox.min.y) / 2;
        this.cachedHalfLength = (geomBox.max.z - geomBox.min.z) / 2;
        
        this.propagateLayerMask()
        this.recalculate()

        this.rebuildBoundingBox();

    }


    lightNamesToIgnore = [
        "Sky_Dome",
        "Light",  // the default light name in the blender cube scene, so often used, but not needed
        "Moon_Light",
        "Lensflare_Source",
        "Sun_light",


    ]

    // model is a THREE.Scene loaded from a GLTF
    // it will have children which are lights
    // we detect them and turn them off
    extractLightsFromModel(model) {
        this.destroyLights();
        
        // First pass: collect all lights that are not ignored
        const validLights = [];
        model.traverse((child) => {
            if (child.isLight) {
                // turn off the light
                child.visible = false;

                // check if the light name is in the list of names to ignore
                if (this.lightNamesToIgnore.includes(child.name)) {
                    // if it is, then just skip it
                    return;
                }
                
                validLights.push(child);
            }
        });
        
        // If we have valid lights, create the Lights folder
        if (validLights.length > 0) {
            this.lightsFolder = this.gui.addFolder("Lights").close();
            
            // Create individual light folders and CNode3DLight instances
            for (const child of validLights) {
                //check if it's a point light
                if (child.isPointLight) {
                    // if it's a point light, we can use it as a CNode3DLight
                    // so we create a CNode3DLight for it
                    // and add it to the group
                    // this will allow us to control the light from the GUI
                    // and also to turn it on/off
                }

                // Create a folder for this specific light
                const lightFolder = this.lightsFolder.addFolder(child.name).close();

                const light = new CNode3DLight({
                    id: this.id + "_" + child.name,
                    light: child,
                    scene: this.group,
                    gui: lightFolder,
                })

                this.lights.push(light);
            }
        }
    }


    rebuildBoundingBox(force = true)
    {

        // if we are displauing a bonding box, then do it
        if (this.displayBoundingBox) {

            // only recalculate the box if forced
            if (force) {


                if (this.modelOrGeometry === "model") {
                    // the model might not be loaded yet
                    // so just skip it if it's not
                    if (this.model !== undefined) {
                        this.boundingBox = computeLocalBoundingBox(this.model);

                        if (this.layers) {
                            this.group.layers.mask = this.layers;
                            propagateLayerMaskObject(this.group);
                        }
                    }

                } else {
                    this.object.geometry.computeBoundingBox();
                    this.boundingBox = this.object.geometry.boundingBox;
                }
            }

            if (!this.boundingBox) {
                return;
            }

            const corners = getBoundingBoxCorners(this.boundingBox)
                .map(corner => corner.applyMatrix4(this.group.matrixWorld));

            // calculate three edges of the bounding box about
            // the corner which is closest to the camera

            const cameraNode = NodeMan.get("mainCamera");
            const camPos = cameraNode.camera.position;
            let closest = 0;
            let closestDist = 1000000;
            for (let i = 0; i < 8; i++) {
                const dist = corners[i].distanceTo(camPos);
                if (dist < closestDist) {
                    closestDist = dist;
                    closest = i;
                }
            }

            // only rebuild it if the closest corner has changed
            // or forced (some external change, like size)
            const needsNewMeasures = !this.measureX || !this.measureY || !this.measureZ || this.lastClosest !== closest;
            if (needsNewMeasures) {

                this.lastClosest = closest;

                // now we have the closest corner, we can calculate the three edges
                const AX = corners[closest];
                const BX = corners[closest ^ 1];
                const AY = corners[closest];
                const BY = corners[closest ^ 2];
                const AZ = corners[closest];
                const BZ = corners[closest ^ 4];

                //
                NodeMan.disposeRemove(this.measureX, true);
                NodeMan.disposeRemove(this.measureY, true);
                NodeMan.disposeRemove(this.measureZ, true);

                // Bounding-box dimensions are editing helpers and should stay
                // out of the recreated/look camera view.
                const boundingBoxLayerMask = LAYER.MASK_HELPERS;

                this.measureX = new CNodeMeasureAB({
                    id: this.id + "_AX",
                    groupNode: "LabelsGroupNode",
                    A: AX,
                    B: BX,
                    color: "#ff8080",
                    text: "X",
                    unitType: "small",
                    layers: boundingBoxLayerMask,
                })
                this.measureY = new CNodeMeasureAB({
                    id: this.id + "_AY",
                    groupNode: "LabelsGroupNode",
                    A: AY,
                    B: BY,
                    color: "#80ff80",
                    text: "X",
                    unitType: "small",
                    layers: boundingBoxLayerMask,
                })
                this.measureZ = new CNodeMeasureAB({
                    id: this.id + "_AZ",
                    groupNode: "LabelsGroupNode",
                    A: AZ,
                    B: BZ,
                    color: "#8080ff",
                    text: "X",
                    unitType: "small",
                    layers: boundingBoxLayerMask,
                })
            }

            const AX = corners[closest];
            const BX = corners[closest ^ 1];
            const AY = corners[closest];
            const BY = corners[closest ^ 2];
            const AZ = corners[closest];
            const BZ = corners[closest ^ 4];

            this.lastClosest = closest;

            this.measureX.in.A.value.copy(AX);
            this.measureX.in.B.value.copy(BX);
            this.measureY.in.A.value.copy(AY);
            this.measureY.in.B.value.copy(BY);
            this.measureZ.in.A.value.copy(AZ);
            this.measureZ.in.B.value.copy(BZ);

            this.measureX.update(par.frame);
            this.measureY.update(par.frame);
            this.measureZ.update(par.frame);
        }
    }

    rebuildMaterial()
    {
        const materialType = this.common.material.toLowerCase();
        const materialDef = materialTypes[materialType];
        assert(materialDef !== undefined, "Unknown material type: " + materialType)

        if (this.lastMaterial !== materialType) {

            this.destroyNonCommonUI(this.materialFolder)

            this.lastMaterial = materialType
            const materialParams = materialDef.params;
            this.materialParams = {}
            this.addParams(materialParams, this.materialParams, this.materialFolder);
        }

        if (this.material)  {
            this.material.dispose();
        }

        const params = {...this.materialParams};
        const isEnvMap = materialType === "envmap";
        const isGradient = materialType === "gradient";

        if (isGradient) {
            this.disposeCubeCamera();
            const palette = this.materialParams.gradientPalette ?? "Ironbow";
            const gradientTexture = createGradientTexture(palette);

            this.material = new ShaderMaterial({
                uniforms: {
                    gradientMap: { value: gradientTexture },
                    gradientCenter: { value: new Vector3() },
                    gradientDir: { value: new Vector3(0, -1, 0) },
                    gradientHalfHeight: { value: 1.0 },
                    gradientScale: { value: this.materialParams.scale ?? 100 },
                    gradientShift: { value: 0.0 },
                    useLeadingEdge: { value: 0.0 },
                    reverseGradient: { value: this.materialParams.reverse ? 1.0 : 0.0 },
                    baseColor: { value: new Color(this.materialParams.baseColor ?? "black") },
                    baseMix: { value: this.materialParams.baseMix ?? 0.0 },
                    ...sharedUniforms,
                },
                vertexShader: gradientVertexShader,
                fragmentShader: gradientFragmentShader,
                fog: false,
            });
        } else if (materialType === "checkerboard") {
            this.disposeCubeCamera();
            const checkerTexture = createCheckerboardTexture(
                this.materialParams.color1 ?? "white",
                this.materialParams.color2 ?? "#808080",
            );
            delete params.color1;
            delete params.color2;
            params.map = checkerTexture;
            this.material = new materialDef.m(params);
        } else if (isEnvMap) {
            delete params.envMapResolution;
            this.setupCubeCamera();
            this.material = new materialDef.m(params);
        } else {
            this.disposeCubeCamera();
            this.material = new materialDef.m(params);
        }

        // Standard materials (basic, lambert, phong, physical, envMap, checkerboard)
        // operate in sRGB space when ColorManagement is disabled.
        // Patch them to linearize output for the linear render target.
        if (!this.material.isShaderMaterial) {
            patchMaterialForLinearOutput(this.material);
        }
    }

    setupCubeCamera() {
        const resolution = this.materialParams.envMapResolution ?? 256;
        if (this._envMapResolution === resolution && this._perViewEnvMaps) return;
        this.disposeCubeCamera();
        this._envMapResolution = resolution;
        this._perViewEnvMaps = new Map();
    }

    getOrCreateEnvMap(renderer) {
        const key = renderer.domElement;
        let entry = this._perViewEnvMaps.get(key);
        if (!entry) {
            const rt = new WebGLCubeRenderTarget(this._envMapResolution, {
                type: HalfFloatType,
            });
            const cam = new CubeCamera(0.1, 100000, rt);
            entry = {renderTarget: rt, cubeCamera: cam};
            this._perViewEnvMaps.set(key, entry);
        }
        return entry;
    }

    disposeCubeCamera() {
        if (this._perViewEnvMaps) {
            for (const entry of this._perViewEnvMaps.values()) {
                entry.renderTarget.dispose();
            }
            this._perViewEnvMaps.clear();
            this._perViewEnvMaps = null;
        }
        this._envMapResolution = null;
    }

    applyMaterialToModel() {
        if (this.model === undefined) {
            return;
        }

        this.model.traverse((child) => {
            if (child.isMesh && !child.userData?.sitrecGaussianSplat) {
                const sourceMaterial = this.getModelSourceMaterial(child);
                const overrideMaterial = this.buildModelOverrideMaterial(sourceMaterial);
                this.setModelMeshMaterial(child, overrideMaterial);
            }
        });

    }

    captureModelSourceMaterials() {
        if (!this.model) {
            return;
        }

        this.model.traverse((child) => {
            if (!child.isMesh || child.userData?.sitrecGaussianSplat) {
                return;
            }

            child.userData ??= {};
            if (child.userData.sitrecSourceMaterial === undefined) {
                child.userData.sitrecSourceMaterial = child.originalMaterial ?? child.material;
            }
            child.originalMaterial = undefined;
        });
    }

    getModelSourceMaterial(child) {
        child.userData ??= {};
        if (child.userData.sitrecSourceMaterial === undefined) {
            child.userData.sitrecSourceMaterial = child.originalMaterial ?? child.material;
            child.originalMaterial = undefined;
        }
        return child.userData.sitrecSourceMaterial;
    }

    buildModelOverrideMaterial(sourceMaterial) {
        const sourceList = Array.isArray(sourceMaterial) ? sourceMaterial : [sourceMaterial];
        const displayMode = this.getModelDisplayMode();

        if (displayMode === "rawTexture") {
            const debugMaterials = sourceList.map((material) => this.createDebugTextureMaterial(material, {
                disableMipmaps: true,
                nearestSampling: true,
            }));
            return Array.isArray(sourceMaterial) ? debugMaterials : debugMaterials[0];
        }

        if (displayMode === "rawTextureMipped") {
            const debugMaterials = sourceList.map((material) => this.createDebugTextureMaterial(material, {
                disableMipmaps: false,
                nearestSampling: false,
            }));
            return Array.isArray(sourceMaterial) ? debugMaterials : debugMaterials[0];
        }

        if (displayMode === "lightingOnly") {
            const lightingMaterials = sourceList.map((material) => this.createLightingOnlyMaterial(material));
            return Array.isArray(sourceMaterial) ? lightingMaterials : lightingMaterials[0];
        }

        if (displayMode === "lambert") {
            const lambertMaterials = sourceList.map((material) => this.createLambertMaterial(material));
            return Array.isArray(sourceMaterial) ? lambertMaterials : lambertMaterials[0];
        }

        if (!this.common.applyMaterial) {
            return sourceMaterial;
        }

        if (this.material?.isShaderMaterial) {
            const sharedMaterials = sourceList.map(() => this.material);
            return Array.isArray(sourceMaterial) ? sharedMaterials : this.material;
        }

        const overrideMaterials = sourceList.map(() => {
            const clone = this.material.clone();
            clone.userData ??= {};
            clone.userData.sitrecOwnedModelOverride = true;
            return clone;
        });
        return Array.isArray(sourceMaterial) ? overrideMaterials : overrideMaterials[0];
    }

    createDebugTextureMaterial(sourceMaterial, options = {}) {
        const disableMipmaps = options.disableMipmaps ?? true;
        const nearestSampling = options.nearestSampling ?? true;
        const sourceDebugMap = sourceMaterial?.map ?? sourceMaterial?.emissiveMap ?? null;
        let debugMap = null;

        if (sourceDebugMap) {
            debugMap = sourceDebugMap.clone();
            debugMap.image = sourceDebugMap.image;
            debugMap.source = sourceDebugMap.source;
            debugMap.colorSpace = sourceDebugMap.colorSpace;
            debugMap.flipY = sourceDebugMap.flipY;
            debugMap.wrapS = sourceDebugMap.wrapS;
            debugMap.wrapT = sourceDebugMap.wrapT;
            debugMap.offset.copy(sourceDebugMap.offset);
            debugMap.repeat.copy(sourceDebugMap.repeat);
            debugMap.center.copy(sourceDebugMap.center);
            debugMap.rotation = sourceDebugMap.rotation;
            debugMap.matrixAutoUpdate = sourceDebugMap.matrixAutoUpdate;
            debugMap.matrix.copy(sourceDebugMap.matrix);

            if (nearestSampling) {
                debugMap.minFilter = NearestFilter;
                debugMap.magFilter = NearestFilter;
            } else {
                debugMap.minFilter = sourceDebugMap.minFilter;
                debugMap.magFilter = sourceDebugMap.magFilter;
            }

            debugMap.generateMipmaps = disableMipmaps ? false : sourceDebugMap.generateMipmaps;
            debugMap.anisotropy = disableMipmaps ? 1 : sourceDebugMap.anisotropy;
            debugMap.needsUpdate = true;
        }

        const debugColor = debugMap
            ? new Color(0xffffff)
            : (sourceMaterial?.color?.clone?.() ?? new Color(0xffffff));

        const material = new MeshBasicMaterial({
            color: debugColor,
            map: debugMap,
            alphaMap: sourceMaterial?.alphaMap ?? null,
            side: sourceMaterial?.side,
            transparent: sourceMaterial?.transparent ?? false,
            opacity: sourceMaterial?.opacity ?? 1,
            alphaTest: sourceMaterial?.alphaTest ?? 0,
            depthTest: sourceMaterial?.depthTest ?? true,
            depthWrite: sourceMaterial?.depthWrite ?? true,
            fog: false,
        });

        material.vertexColors = false;
        material.toneMapped = false;
        material.name = `${sourceMaterial?.name ?? "material"}_sitrecRawTexture`;
        material.userData ??= {};
        material.userData.sitrecOwnedModelOverride = true;
        material.userData.sitrecDebugTextureOnly = true;
        material.userData.sitrecDebugTextureMode = disableMipmaps ? "rawTexture" : "rawTextureMipped";
        material.userData.sitrecOwnedTextures = debugMap ? [debugMap] : [];
        return material;
    }

    createLightingOnlyMaterial(sourceMaterial) {
        const material = new MeshLambertMaterial({
            // Dark neutral albedo avoids clipping to white under high ambient light.
            color: 0x101010,
            side: sourceMaterial?.side,
            transparent: sourceMaterial?.transparent ?? false,
            opacity: sourceMaterial?.opacity ?? 1,
            alphaMap: sourceMaterial?.alphaMap ?? null,
            alphaTest: sourceMaterial?.alphaTest ?? 0,
            depthTest: sourceMaterial?.depthTest ?? true,
            depthWrite: sourceMaterial?.depthWrite ?? true,
            fog: false,
        });

        material.vertexColors = false;
        material.toneMapped = false;
        material.name = `${sourceMaterial?.name ?? "material"}_sitrecLightingOnly`;
        material.userData ??= {};
        material.userData.sitrecOwnedModelOverride = true;
        material.userData.sitrecLightingOnly = true;
        return material;
    }

    createLambertMaterial(sourceMaterial) {
        const material = new MeshLambertMaterial({
            color: sourceMaterial?.color?.clone?.() ?? new Color(0xffffff),
            map: sourceMaterial?.map ?? null,
            emissive: sourceMaterial?.emissive?.clone?.() ?? new Color(0x000000),
            emissiveMap: sourceMaterial?.emissiveMap ?? null,
            emissiveIntensity: sourceMaterial?.emissiveIntensity ?? 1,
            alphaMap: sourceMaterial?.alphaMap ?? null,
            side: sourceMaterial?.side,
            transparent: sourceMaterial?.transparent ?? false,
            opacity: sourceMaterial?.opacity ?? 1,
            alphaTest: sourceMaterial?.alphaTest ?? 0,
            depthTest: sourceMaterial?.depthTest ?? true,
            depthWrite: sourceMaterial?.depthWrite ?? true,
            fog: sourceMaterial?.fog ?? true,
        });

        material.name = `${sourceMaterial?.name ?? "material"}_sitrecLambert`;
        material.userData ??= {};
        material.userData.sitrecOwnedModelOverride = true;
        return material;
    }

    getModelDisplayMode() {
        if (this.common.modelDisplayMode) {
            return this.common.modelDisplayMode;
        }

        return this.common.debugTextureOnly ? "rawTexture" : "normal";
    }

    setModelMeshMaterial(child, nextMaterial) {
        const currentMaterial = child.material;
        if (this.materialsMatch(currentMaterial, nextMaterial)) {
            return;
        }

        this.disposeOwnedOverrideMaterials(currentMaterial);
        child.material = nextMaterial;

        const materialList = Array.isArray(child.material) ? child.material : [child.material];
        for (const material of materialList) {
            if (material) {
                material.needsUpdate = true;
            }
        }
    }

    materialsMatch(a, b) {
        if (a === b) {
            return true;
        }

        if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
            return false;
        }

        return a.every((material, index) => material === b[index]);
    }

    disposeOwnedOverrideMaterials(materialOrList) {
        const materialList = Array.isArray(materialOrList) ? materialOrList : [materialOrList];
        const disposed = new Set();
        const disposedTextures = new Set();

        for (const material of materialList) {
            if (!material || disposed.has(material) || material.userData?.sitrecOwnedModelOverride !== true) {
                continue;
            }
            disposed.add(material);
            const ownedTextures = Array.isArray(material.userData?.sitrecOwnedTextures)
                ? material.userData.sitrecOwnedTextures
                : [];
            for (const texture of ownedTextures) {
                if (!texture || disposedTextures.has(texture)) {
                    continue;
                }
                disposedTextures.add(texture);
                texture.dispose?.();
            }
            material.dispose?.();
        }
    }

    restoreModelSourceMaterials() {
        if (!this.model) {
            return;
        }

        this.model.traverse((child) => {
            if (!child.isMesh || child.userData?.sitrecGaussianSplat) {
                return;
            }

            const sourceMaterial = child.userData?.sitrecSourceMaterial;
            if (sourceMaterial !== undefined) {
                this.setModelMeshMaterial(child, sourceMaterial);
            }
        });
    }


    destroyNonCommonUI(gui) {
        // delete the non-common children of this.gui
        // iterate backwards so we can delete as we go
        for (let i = gui.controllers.length - 1; i >= 0; i--) {
            let c = gui.controllers[i];
            if (!c.isCommon) {
                c.destroy();
                // Explicitly remove the controller from the array if destroy() didn't do it
                if (gui.controllers[i] === c) {
                    gui.controllers.splice(i, 1);
                }
            }
        }
    }

    destroyObject() {
        if (this.object) {
            this.object.geometry.dispose();
            this.object.material.dispose();
            this.group.remove(this.object);
            this.object = undefined;
        }

        // remove any lights from the model
        this.destroyLights();

        if (this.material) {
            this.material.dispose();
        }

        if (this.model) {
            this.group.remove(this.model);
            this.restoreModelSourceMaterials();
            disposeScene(this.model)
            this.model = undefined
        }

    }

    destroyLights() {
        if (this.lights !== undefined) {
            // if we have lights, then dispose them
            for (const light of this.lights) {
                NodeMan.disposeRemove(light, true);
            }
        }
        this.lights = [];
        
        // Clean up the lights folder if it exists
        if (this.lightsFolder) {
            this.lightsFolder.destroy();
            this.lightsFolder = null;
        }
    }

    preRender(view) {
        const common = this.common;
        if (!common) return;

        const target = this.group;
        if (target && (common.rotateX || common.rotateY || common.rotateZ)) {
            this.needsUndo = true;

            this.origPosition = target.position.clone();
            this.origQuaternion = target.quaternion.clone();
            this.origScale = target.scale.clone();

            if (common.rotateY) {
                target.rotateY(common.rotateY * Math.PI / 180);
            }

            if (common.rotateX) {
                target.rotateX(common.rotateX * Math.PI / 180);
            }

            if (common.rotateZ) {
                target.rotateZ(common.rotateZ * Math.PI / 180);
            }

            target.updateMatrix();
            target.updateMatrixWorld(true);
        } else if (target) {
            target.updateMatrixWorld(true);
        }

        if (this.model) {
            if (view.camera) {
                view.camera.updateMatrixWorld(true);
                view.camera.updateProjectionMatrix?.();
            }

            this.model.traverse((child) => {
                const material = child.material;

                if (material?.userData?.sitrecPLYPointCloud) {
                    if (material.uniforms?.viewportHeight) {
                        material.uniforms.viewportHeight.value = view.heightPx ?? 1080;
                    }
                }

                if (child.userData?.sitrecGaussianSplat && material?.userData?.sitrecGaussianSplat) {
                    const h = view.heightPx ?? 1080;
                    const w = view.widthPx ?? 1920;
                    if (material.uniforms?.viewportHeight) {
                        material.uniforms.viewportHeight.value = h;
                    }
                    if (material.uniforms?.viewportWidth) {
                        material.uniforms.viewportWidth.value = w;
                    }

                    const sortState = child.userData.splatSortState;
                    if (sortState && view.camera) {
                        child.updateWorldMatrix(true, false);
                        const renderState = child.userData.gaussianSplatRenderState ??= {
                            worldOrigin: new Vector3(),
                            viewOrigin: new Vector3(),
                            viewLinear: new Matrix3(),
                            objectLinear: new Matrix3(),
                            modelViewLinear: new Matrix3(),
                        };

                        // Feed the shader a camera-relative origin plus the linear
                        // model-view transform so splat projection stays stable even
                        // when the object lives far from world origin.
                        renderState.worldOrigin.setFromMatrixPosition(child.matrixWorld);
                        renderState.viewOrigin.copy(renderState.worldOrigin).applyMatrix4(view.camera.matrixWorldInverse);
                        renderState.viewLinear.setFromMatrix4(view.camera.matrixWorldInverse);
                        renderState.objectLinear.setFromMatrix4(child.matrixWorld);
                        renderState.modelViewLinear.multiplyMatrices(renderState.viewLinear, renderState.objectLinear);

                        if (material.uniforms?.viewOrigin) {
                            material.uniforms.viewOrigin.value.copy(renderState.viewOrigin);
                        }
                        if (material.uniforms?.modelViewLinear) {
                            material.uniforms.modelViewLinear.value.copy(renderState.modelViewLinear);
                        }
                        sortState.sort(view.camera, child.matrixWorld);
                    }
                }
            });
        }

        if (this.displayBoundingBox) {
            this.rebuildBoundingBox(false);
        }

        this.updateEnvMap(view);

        // Update gradient material uniforms with direction and extent data.
        // All modes use world-space positions so the gradient is consistent across
        // model hierarchies with varying internal transforms.
        if (this.material && this.material.isShaderMaterial && this.material.uniforms.gradientHalfHeight) {
            if (this.cachedBoundingSphere) {
                const direction = this.materialParams.gradientDirection ?? "Model Down";

                // Center is always in world space
                const center = this.cachedBoundingSphere.center.clone();
                center.applyMatrix4(this.group.matrixWorld);

                const isLeadingEdge = direction === "Leading Edge";
                const usesMotion = direction === "Motion Forward" || isLeadingEdge;

                let dir;
                if (usesMotion) {
                    dir = this.getMotionForwardVector();
                } else if (direction === "World Down") {
                    // In ECEF, "down" is toward Earth's center: negate the geodetic up vector
                    dir = getLocalUpVector(center).negate();
                } else {
                    // Model Down: extract the object's local -Y axis in world space
                    // from the group's world matrix. This accounts for any internal
                    // model rotations and user-applied rotations.
                    dir = new Vector3(0, -1, 0);
                    dir.transformDirection(this.group.matrixWorld);
                }

                this.material.uniforms.useLeadingEdge.value = isLeadingEdge ? 1.0 : 0.0;

                // Use half-length (Z) for motion-based modes, half-height (Y) for down modes
                const halfExtent = usesMotion
                    ? (this.cachedHalfLength ?? this.cachedBoundingSphere.radius)
                    : (this.cachedHalfHeight ?? this.cachedBoundingSphere.radius);
                const shift = this.materialParams.shift ?? 0;
                if (isLeadingEdge) {
                    // Leading Edge uses dot product space (0-1 unit diameter),
                    // so shift is applied directly in the shader as an offset to d.
                    this.material.uniforms.gradientShift.value = shift / 100;
                } else {
                    // Position-based modes: shift the center along the direction
                    this.material.uniforms.gradientShift.value = 0;
                    if (shift !== 0) {
                        center.addScaledVector(dir, shift / 100 * halfExtent * 2);
                    }
                }

                this.material.uniforms.gradientCenter.value.copy(center);
                this.material.uniforms.gradientDir.value.copy(dir);
                this.material.uniforms.gradientHalfHeight.value = halfExtent;
                this.material.uniforms.gradientScale.value = this.materialParams.scale ?? 100;
            }
        }
    }

    updateEnvMap(view) {
        if (!this._perViewEnvMaps || !view.renderer) return;

        const {renderTarget, cubeCamera} = this.getOrCreateEnvMap(view.renderer);

        this.material.envMap = renderTarget.texture;
        this.applyEnvMapToModel(renderTarget.texture);

        this.group.visible = false;

        cubeCamera.position.setFromMatrixPosition(this.group.matrixWorld);

        for (const child of cubeCamera.children) {
            if (child.isCamera) {
                child.layers.mask = LAYER.MASK_LOOKRENDER;
            }
        }

        const savedBackground = GlobalScene.background;
        if (view.isIR) {
            GlobalScene.background = new Color(0xFFFFFF);
        } else {
            const sunNode = NodeMan.get("theSun", true);
            if (sunNode) {
                GlobalScene.background = sunNode.calculateSkyColor(cubeCamera.position);
            }
        }

        const savedRenderTarget = view.renderer.getRenderTarget();

        cubeCamera.update(view.renderer, GlobalScene);

        view.renderer.setRenderTarget(savedRenderTarget);
        GlobalScene.background = savedBackground;

        this.group.visible = true;
    }

    // Find the source track that drives this object's position via controllers
    getSourceTrack() {
        for (const inputID in this.inputs) {
            const input = this.inputs[inputID];
            if (input.isController && input.in && input.in.sourceTrack) {
                return input.in.sourceTrack;
            }
        }
        return null;
    }

    // Compute the forward direction from the object's motion (velocity vector)
    // Returns a normalized world-space direction vector, or down if unavailable
    getMotionForwardVector() {
        const track = this.getSourceTrack();
        if (track) {
            const f = par.frame;
            const maxF = (track.frames ?? Sit.frames) - 1;
            // Use central difference when possible, forward/backward at edges
            const f0 = Math.max(0, Math.min(f - 1, maxF));
            const f1 = Math.max(0, Math.min(f + 1, maxF));
            if (f0 !== f1) {
                const p0 = track.p(f0);
                const p1 = track.p(f1);
                const dir = p1.sub(p0);
                if (dir.lengthSq() > 0) {
                    return dir.normalize();
                }
            }
        }
        // Fallback: use world down if no track or zero velocity
        return new Vector3(0, -1, 0);
    }

    applyEnvMapToModel(texture) {
        if (!this.model) return;
        this.model.traverse((child) => {
            if (child.isMesh && child.material) {
                child.material.envMap = texture;
                child.material.needsUpdate = true;
            }
        });
    }
    
    postRender(view) {
        // Restore the original transformation state
        if (this.needsUndo && this.group && this.origQuaternion) {
            // Restore the original position, quaternion, and scale
            this.group.position.copy(this.origPosition);
            this.group.quaternion.copy(this.origQuaternion);
            this.group.scale.copy(this.origScale);
            
            // Update matrices after restoring state
            this.group.updateMatrix();
            this.group.updateMatrixWorld();
            this.needsUndo = false;
        }
    }


    dispose() {
        this.cleanUpReflectionAnalysis();
        if (this.reflectionView) {
            this.reflectionView.dispose();
            this.reflectionView = null;
        }
        if (this.label) {
            NodeMan.disposeRemove(this.label, true);
        }
        if (this.modelLengthNode) {
            NodeMan.disposeRemove(this.modelLengthNode, true);
        }
        this.disposeCubeCamera();
        this.gui.destroy();
        this.destroyObject();
        super.dispose();
    }

    applyModelFilenameParameters(modelAsset) {
        const modelLengthFeet = Number(modelAsset?.filenameParameters?.modelLength
            ?? modelAsset?.filenameParameters?.longestSide
            ?? modelAsset?.filenameParameters?.length);
        if (!(modelLengthFeet > 0)) {
            return;
        }

        if (this.modelLengthNode) {
            this.modelLengthNode.setValueWithUnits(modelLengthFeet, "imperial", "small");
            this.common.modelLength = this.modelLengthNode.value;
        }
    }

    getModelLengthScale() {
        const modelLengthMeters = this.modelLengthNode ? this.modelLengthNode.getValueFrame(0) : 0;
        if (modelLengthMeters <= 0) {
            return 1;
        }

        const modelLength = Number(this.cachedModelLength);
        if (!(modelLength > 0)) {
            return 1;
        }

        return modelLengthMeters / modelLength;
    }

    recalculate() {
        super.recalculate();
        const scale = this.in.size.v0 * Globals.objectScale * this.getModelLengthScale();
        this.group.scale.setScalar(scale);

        // update the root track if any input changes (which is what triggers a recalculate)
        // this is using in CustomSupport/preRenderUpdate()
        // to separate objects on the target track from the traverse/target object
        this.rootTrack = findRootTrack(this)


    }

    update(f) {
        super.update(f);

        // if (this.spriteText) {
        //     this.spriteText.position.copy(this._object.position);
        //     this.spriteText.position.y += 0.1;
        // }

       // this.rebuildBoundingBox(false);
    }


}

// Install reflection-analysis prototype methods.
Object.assign(CNode3DObject.prototype, reflectionMethods);
