import {DataTexture, Vector2, Vector3, Vector4} from "three";

const blank = new DataTexture(new Uint8Array(4), 1, 1);
blank.needsUpdate = true;
export const cityLightsUniforms = {
    cityMode: {value: 0}, cityGain: {value: 1}, cityDark: {value: .22},
    cityMask: {value: blank}, cityRect: {value: new Vector4(0, 0, 1, 1)},
    cityOrigin: {value: new Vector3()}, cityEast: {value: new Vector3()},
    cityNorth: {value: new Vector3()}, cityUp: {value: new Vector3()},
    citySquash: {value: 1}, cityWindows: {value: .35}, cityMaskSize: {value: 4096},
};
let enabled = false;
export function setCityLightsDefault(value) { enabled = !!value; }
export function cityLightsDefault() { return enabled; }
export function clearCityLightsUniforms() {
    cityLightsUniforms.cityMode.value = 0;
    cityLightsUniforms.cityMask.value = blank;
}

const declarations = `
uniform float cityMode, cityGain, cityDark, citySquash,cityWindows,cityMaskSize;
uniform sampler2D cityMask;
uniform vec4 cityRect;
uniform vec2 cityTexel;
uniform vec3 cityEast, cityNorth, cityUp;
varying vec3 vCityLocal;
float cityHash(vec2 p) {return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float cityLum(vec3 c) {return dot(c,vec3(.299,.587,.114));}
// Integrated periodic rectangles: retain energy as windows become subpixel.
float cityPulse(float x, float width) {
    float fw = max(fwidth(x), .001);
    float edge = abs(fract(x)-.5);
    float resolved = 1.-smoothstep(width*.5-fw*.5,width*.5+fw*.5,edge);
    return mix(resolved,width,smoothstep(.35,1.5,fw));
}
`;
const emission = `
if (cityMode > .5) {
    vec3 up = normalize(vec3(vWorldPositionDN.xy,vWorldPositionDN.z*citySquash));
    vec3 wn = inverseTransformDirection(normal,viewMatrix);
    float upright = abs(dot(wn,up));
    float wall = 1.-smoothstep(.16,.40,upright);
    vec2 uvDx=dFdx(vDNUv),uvDy=dFdy(vDNUv);
    float uvArea=abs(uvDx.x*uvDy.y-uvDx.y*uvDy.x);
    // Extruded tile skirts have collapsed UVs and otherwise look like walls.
    float skirt=1.-step(1e-6*length(uvDx)*length(uvDy)+1e-20,uvArea);
    wall *= 1.-skirt;
    float top = smoothstep(.75,.94,upright);
    vec3 albedo = diffuseColor.rgb;
    float lum = cityLum(albedo);
    float green = smoothstep(.005,.055,albedo.g-max(albedo.r,albedo.b)*1.04);
    float neutral = (1.-green)*smoothstep(.035,.17,lum);
    float lat = atan(up.z,length(up.xy));
    float lon = atan(vWorldPositionDN.y,vWorldPositionDN.x);
    vec2 merc = vec2(lon*.159154943+.5,.5-log(tan(.785398163+lat*.5))*.159154943);
    vec2 maskUV = vec2(fract(merc.x-cityRect.x)*cityRect.z,(merc.y-cityRect.y)*cityRect.w);
    vec4 mask = vec4(0.);
    if(cityMode>2.5) mask=texture2D(cityMask,clamp(maskUV,0.,1.));
    vec2 coverage=smoothstep(vec2(0.),vec2(.045),maskUV)*(1.-smoothstep(vec2(.955),vec2(1.),maskUV));
    mask *= coverage.x*coverage.y;
    // Aligned window rows in metres, projected along the facade tangent.
    vec2 xy = vCityLocal.xy;
    vec2 hn = normalize(vec2(dot(wn,cityEast),dot(wn,cityNorth)) + vec2(.00001));
    // Two stable dominant-axis projections avoid a grid that swims with face normals.
    float along = abs(hn.x)>abs(hn.y) ? xy.y : xy.x;
    vec2 win = vec2(along/3.2,vCityLocal.z/3.6);
    float style=0.;
    if(cityMode>2.5){
        // Metadata uses nearest base-level texels; light/coverage channels use
        // filtered mipmaps. Averaging headings would rotate windows at distance.
        vec2 mu=(floor(clamp(maskUV,0.,.999999)*cityMaskSize)+.5)/cityMaskSize;
        float code=floor(textureLod(cityMask,mu,0.).r*255.+.5);
        float angle=floor(code/8.)*.049087385; // 32 headings over 90 degrees
        style=mod(code,8.);
        vec2 axis=vec2(cos(angle),sin(angle)),perp=vec2(-axis.y,axis.x);
        float side=abs(dot(hn,axis))>abs(dot(hn,perp))?dot(xy,perp):dot(xy,axis);
        win=vec2(side/(2.8+mod(style,3.)*.35)+style*.371,vCityLocal.z/(3.1+mod(style,4.)*.2)+style*.137);
    }
    float occupied = step(1.-cityWindows,cityHash(floor(win)+style*13.));
    occupied = mix(occupied,cityWindows,smoothstep(.4,1.5,max(fwidth(win.x),fwidth(win.y))));
    float windows = cityPulse(win.x,.42)*cityPulse(win.y,.45)*occupied;
    float textureMask = 0.;
    #ifdef USE_MAP
    if(cityMode<1.5) {
      vec2 du = vec2(cityTexel.x,0.), dv = vec2(0.,cityTexel.y);
      float left = cityLum(texture2D(map,vMapUv-du).rgb);
      float right = cityLum(texture2D(map,vMapUv+du).rgb);
      float above = cityLum(texture2D(map,vMapUv-dv).rgb);
      float below = cityLum(texture2D(map,vMapUv+dv).rgb);
      vec2 grad = vec2(right-left,below-above);
      vec2 g1 = vec2(cityLum(texture2D(map,vMapUv+dv+du).rgb)-cityLum(texture2D(map,vMapUv+dv-du).rgb),
                    cityLum(texture2D(map,vMapUv+2.*dv).rgb)-cityLum(texture2D(map,vMapUv).rgb));
      vec2 g2 = vec2(cityLum(texture2D(map,vMapUv+2.*du).rgb)-cityLum(texture2D(map,vMapUv).rgb),
                    cityLum(texture2D(map,vMapUv+du+dv).rgb)-cityLum(texture2D(map,vMapUv+du-dv).rgb));
      float coherence = max(abs(dot(normalize(grad+.00001),normalize(g1+.00001))),
                            abs(dot(normalize(grad+.00001),normalize(g2+.00001))));
      textureMask = smoothstep(.06,.24,length(grad))*smoothstep(.88,.995,coherence)*neutral;
    }
    #endif
    vec3 warm = vec3(1.,.53,.19);
    vec3 cool = vec3(.65,.8,1.);
    vec3 lightColor = mix(warm,cool,step(.73,cityHash(floor(xy/15.))));
    vec3 lights = vec3(0.);
    if (cityMode < 1.5) lights = lightColor*textureMask*.9;
    else if (cityMode < 2.5) lights = lightColor*wall*neutral*windows*2.8;
    else {
      // R=packed building heading/style, G/B=warm/cool lamps, A=footprints.
      float facade = mask.a*wall*windows*2.7;
      float distant=smoothstep(2000.,8000.,length(vViewPosition));
      float roof = mask.a*top*.026*distant*cityWindows;
      vec3 roadLight=vec3(1.,.61,.26)*mask.g+vec3(.78,.85,1.)*mask.b;
      lights = roadLight*3.5*top*(1.-green*.9) + lightColor*(facade+roof);
      if (cityMode > 3.5) lights += lightColor*wall*neutral*windows*.4;
    }
    float night = 1.-smoothstep(-.08,.04,dot(up,normalize(sunDirection)));
    gl_FragColor.rgb = mix(gl_FragColor.rgb,gl_FragColor.rgb*cityDark + lights*cityGain,night);
}
`;

export function applyCityLightsShader(shader, material) {
    if (material.defines?.SITREC_CITY_LIGHTS === undefined) return;
    Object.assign(shader.uniforms, cityLightsUniforms);
    shader.uniforms.cityTexel = {value: new Vector2(1 / (material.map?.image?.width || 256), 1 / (material.map?.image?.height || 256))};
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
uniform vec3 cityOrigin,cityEast,cityNorth,cityUp;
varying vec3 vCityLocal;`);
    shader.vertexShader = shader.vertexShader.replace('vLocalPositionDN = sitrecLocalPositionDN.xyz;', `vLocalPositionDN = sitrecLocalPositionDN.xyz;
vec3 cityDelta = vWorldPositionDN-cityOrigin;
vCityLocal=vec3(dot(cityDelta,cityEast),dot(cityDelta,cityNorth),dot(cityDelta,cityUp));`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\n' + declarations);
    // Surface lights precede water reflections, so darkening the ground does
    // not also darken the reflected sky. Keep the material and its fade hooks.
    shader.fragmentShader = shader.fragmentShader.replace('#ifdef SITREC_TILE_WATER\n// Water, added LAST', emission + '\n#ifdef SITREC_TILE_WATER\n// Water, added LAST');
}
