/**
 * Shared shader patches:
 *   - fog: exponential fog tinted toward the sun, plus low-lying mist below the roof line so
 *     the courtyard and the keep's stone base drown in haze (installed once, globally)
 *   - snowify: world-up surfaces gather noisy snow (roofs, ridge, lantern caps, shoulders)
 *   - rimLit: warm fresnel rim from the low sun behind the fighters, the painterly edge light
 */
import * as THREE from "three";

/**
 * The moon (the name is kept from the dusk version: everything that faces "the sun" now faces
 * it): huge and low behind the general, a little left of the keep.
 */
export const SUN_DIR = new THREE.Vector3(-0.3, 0.145, -1).normalize();
/** Key light: the moon, raised so the shadows rake long across the snow toward the camera. */
export const LIGHT_DIR = new THREE.Vector3(-0.36, 0.52, -1).normalize();
/** Angular radius of the moon disc (radians): a poster moon, ~16x the real one. */
export const MOON_R = 0.072;
/** Where the blizzard blows (xz, unit): toward -x / +z, as the gameplay wind. */
export const WIND_XZ = new THREE.Vector2(-0.9, 0.44).normalize();

const v3 = (v: THREE.Vector3) => `vec3(${v.x.toFixed(4)}, ${v.y.toFixed(4)}, ${v.z.toFixed(4)})`;

export function installFog(): void {
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  C.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying float vFogDepth;
  varying vec3 vFogDir;
#endif`;
  C.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  vFogDepth = - mvPosition.z;
  // World-space camera→vertex from the view-space position (rotation part is orthonormal, so
  // v * M is the inverse rotation). Sprites / points have no 'transformed'; every shader has mvPosition.
  vFogDir = (vec4(mvPosition.xyz, 0.0) * viewMatrix).xyz;
#endif`;
  C.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  varying float vFogDepth;
  varying vec3 vFogDir;
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif`;
  C.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp( - fogDensity * fogDensity * vFogDepth * vFogDepth );
  #else
    float fogFactor = smoothstep( fogNear, fogFar, vFogDepth );
  #endif
  vec3 fogD = normalize(vFogDir);
  float fogH = vFogDir.y + cameraPosition.y;
  // Height mist: the courtyard below the roof line drowns in haze (thicker the lower it goes).
  // Height mist: below the roof line the castle sinks into the cloud sea.
  float mist = (1.0 - exp(-length(vFogDir) * 0.03)) * (1.0 - smoothstep(-22.0, -1.0, fogH));
  fogFactor = max(fogFactor, mist * 0.97);
  float fogSun = pow(max(dot(fogD, ${v3(SUN_DIR)}), 0.0), 4.0);
  // Moon glow in the falling snow: a cold silver band toward it, a brighter core round it.
  vec3 fogC = mix(fogColor, vec3(0.085, 0.105, 0.15), fogSun * 0.8) + vec3(0.1, 0.12, 0.16) * pow(fogSun, 8.0);
  fogC = mix(fogC, vec3(0.06, 0.075, 0.11), mist * (1.0 - smoothstep(-6.0, -1.0, fogH)));
  gl_FragColor.rgb = mix(gl_FragColor.rgb, fogC, fogFactor);
#endif`;
  installSkinRim();
}

/** Tuned edge light on the skinned fighters (see TASKS.md "Lighting pass"). */
export const SKIN_RIM = { sun: 1.25, sky: 0.3, sunPow: 2.4 };

/**
 * Sekiro-style separation for every skinned body, done in the light loop (the character code is
 * untouched): grazing edges that face the shadowed sun (directional light 0, three sorts shadowed
 * lights first) take its orange light, strongest when the sun is behind the fighter; edges facing
 * away take the cold sky. Adds to direct diffuse, so fog, AO and the grade treat it like light.
 */
function installSkinRim(): void {
  const C = THREE.ShaderChunk as unknown as Record<string, string>;
  if (C.lights_fragment_end.includes("SKIN_RIM")) return;
  C.lights_fragment_end += /* glsl */ `
#if ( defined( USE_SKINNING ) || defined( CHAR_RIM ) ) && NUM_DIR_LIGHTS > 0
  { // SKIN_RIM
    float rimF = 1.0 - saturate(dot(geometryNormal, geometryViewDir));
    vec3 rimL = directionalLights[0].direction;
    float rimBack = saturate(dot(-geometryViewDir, rimL) * 0.5 + 0.5);
    float rimSide = smoothstep(-0.25, 0.55, dot(geometryNormal, rimL));
    vec3 rimTint = mix(material.diffuseColor, vec3(0.75), 0.8);
    reflectedLight.directDiffuse += directionalLights[0].color * rimTint * pow(rimF, ${SKIN_RIM.sunPow.toFixed(1)})
      * rimSide * (0.3 + 0.7 * rimBack) * ${SKIN_RIM.sun.toFixed(3)};
    reflectedLight.directDiffuse += vec3(0.35, 0.45, 0.8) * rimTint * pow(rimF, 2.5) * (1.0 - rimSide)
      * saturate(geometryNormal.y * 0.5 + 0.6) * ${SKIN_RIM.sky.toFixed(3)};
  }
#endif`;
}

const NOISE_GLSL = /* glsl */ `
float snH(vec3 p) { return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453); }
float snNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(snH(i), snH(i + vec3(1,0,0)), f.x), mix(snH(i + vec3(0,1,0)), snH(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(snH(i + vec3(0,0,1)), snH(i + vec3(1,0,1)), f.x), mix(snH(i + vec3(0,1,1)), snH(i + vec3(1,1,1)), f.x), f.y), f.z);
}`;

export interface SnowOpts {
  /** 0..1 how much snow sticks. */
  amount?: number;
  /** noise frequency (1/m). */
  scale?: number;
  /** snow albedo (linear). */
  color?: THREE.Color;
  /** Noise weight on coverage: higher = patchier (bare tile between drifts). */
  patch?: number;
  /** Fade fine detail to a flat averaged albedo with distance [near, far] m (kills moiré). */
  far?: [number, number];
  /**
   * Wind-sculpted drifts: large dunes and sastrugi combed along the wind bury the tiles outright
   * (their ribs smooth out under the snow normal), scoured patches leave them bare.
   */
  drift?: number;
  /** Moonlit ice-crystal glitter (view-dependent, in snow only). */
  glitter?: number;
}

export function snowify<T extends THREE.MeshStandardMaterial>(mat: T, opts: SnowOpts = {}): T {
  const amount = opts.amount ?? 0.8;
  const scale = opts.scale ?? 1.3;
  const col = opts.color ?? new THREE.Color(0.78, 0.82, 0.9);
  const patch = opts.patch ?? 0.9;
  const far = opts.far;
  const drift = opts.drift ?? 0;
  const glitter = opts.glitter ?? 0;
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.vertexShader = sh.vertexShader
      .replace("#include <common>", "#include <common>\nvarying vec3 vSnowW;\nvarying vec3 vSnowN;")
      .replace(
        "#include <project_vertex>",
        `#include <project_vertex>
        vec4 snWp = vec4(transformed, 1.0);
        vec3 snN = objectNormal;
        #ifdef USE_INSTANCING
          snWp = instanceMatrix * snWp;
          snN = mat3(instanceMatrix) * snN;
        #endif
        vSnowW = (modelMatrix * snWp).xyz;
        vSnowN = normalize(mat3(modelMatrix) * snN);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", `#include <common>\nvarying vec3 vSnowW;\nvarying vec3 vSnowN;\nfloat snowAmt = 0.0;\nfloat snowDeep = 0.0;\nfloat snowRipple = 0.5;\n${NOISE_GLSL}`)
      .replace(
        "#include <color_fragment>",
        `#include <color_fragment>
        {
          float n = snNoise(vSnowW * ${scale.toFixed(3)}) * 0.6 + snNoise(vSnowW * ${(scale * 4.1).toFixed(3)}) * 0.4;
          float up = vSnowN.y;
          snowAmt = smoothstep(0.35, 0.8, up + (n - 0.5) * ${patch.toFixed(3)}) * ${amount.toFixed(3)};
          ${
            drift > 0
              ? `{
            // Along / across the wind: dunes stretched downwind, sastrugi ribs across it.
            vec2 wd = vec2(${WIND_XZ.x.toFixed(4)}, ${WIND_XZ.y.toFixed(4)});
            vec2 q = vec2(dot(vSnowW.xz, wd), dot(vSnowW.xz, vec2(-wd.y, wd.x)));
            float dune = snNoise(vec3(q.x * 0.07, 0.0, q.y * 0.21)) * 0.65 + snNoise(vec3(q.x * 0.16 + 4.0, 1.0, q.y * 0.5)) * 0.35;
            float rib = snNoise(vec3(q.x * 0.9, 2.0, q.y * 5.5));
            // Snow piles up against the ridge and the far eaves (lee of the wind), the middle is scoured.
            float lee = smoothstep(-5.0, -12.5, vSnowW.z) * 0.35 + smoothstep(6.0, 11.5, abs(vSnowW.x)) * 0.25;
            snowDeep = smoothstep(0.4, 0.56, dune + lee + (rib - 0.5) * 0.22) * ${drift.toFixed(3)} * smoothstep(0.2, 0.7, up);
            snowAmt = max(snowAmt, snowDeep);
            snowRipple = rib;
          }`
              : ""
          }
          ${drift > 0 ? "diffuseColor.rgb *= 0.6; // scoured tiles: wet black ibushi clay" : ""}
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${col.r.toFixed(3)}, ${col.g.toFixed(3)}, ${col.b.toFixed(3)}) * (0.92 + snowRipple * 0.12), snowAmt);
          ${
            far
              ? `float snFar = smoothstep(${far[0].toFixed(1)}, ${far[1].toFixed(1)}, distance(vSnowW, cameraPosition));
          diffuseColor.rgb = mix(diffuseColor.rgb, vec3(${(col.r * 0.82).toFixed(3)}, ${(col.g * 0.82).toFixed(3)}, ${(col.b * 0.82).toFixed(3)}), snFar * 0.8);
          snowAmt = mix(snowAmt, 0.6, snFar);`
              : ""
          }
        }`,
      )
      .replace(
        "#include <normal_fragment_maps>",
        `#include <normal_fragment_maps>
        ${
          drift > 0
            ? `{
          // Buried tiles: the drift's own smooth surface (with its wind ripples) replaces their ribs.
          vec3 upV = normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz);
          vec3 ripV = normalize((viewMatrix * vec4(${(-WIND_XZ.x).toFixed(4)}, 0.0, ${(-WIND_XZ.y).toFixed(4)}, 0.0)).xyz);
          vec3 dn = normalize(upV + ripV * (snowRipple - 0.5) * 0.25);
          normal = normalize(mix(normal, dn, snowDeep * 0.92));
        }`
            : ""
        }`,
      )
      .replace(
        "#include <emissivemap_fragment>",
        `#include <emissivemap_fragment>
        ${
          glitter > 0
            ? `{
          // Ice glitter: sparse facets that flash as the view moves across them, only in snow.
          vec3 gp = floor(vSnowW * 55.0);
          float gh = snH(gp);
          vec3 vd = normalize(cameraPosition - vSnowW);
          float tw = snH(gp + floor(vd * 9.0 + gh * 3.0));
          float sparkle = step(0.988, gh) * step(0.55, tw) * snowAmt;
          float toward = pow(max(dot(-vd, ${v3(SUN_DIR)}), 0.0), 2.0);
          totalEmissiveRadiance += vec3(0.75, 0.85, 1.1) * sparkle * (0.6 + toward * 2.4) * ${glitter.toFixed(2)}
            * (1.0 - smoothstep(6.0, 22.0, length(cameraPosition - vSnowW)));
        }`
            : ""
        }`,
      )
      .replace(
        "#include <roughnessmap_fragment>",
        "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.88, snowAmt);",
      );
  };
  mat.customProgramCacheKey = () => `snow-${amount}-${scale}-${patch}-${far ?? ""}-${drift}-${glitter}`;
  return mat;
}

/** Shared uniforms for the rim light (sun direction in view space, updated each frame). */
export const RIM = {
  uSunView: { value: new THREE.Vector3(0, 0, -1) },
  // Moonlight edge (silver-blue) and the cold sky on the far side.
  uRimColor: { value: new THREE.Color(1.15, 1.35, 1.75) },
  uRimCold: { value: new THREE.Color(0.06, 0.09, 0.2) },
};

export function rimLit<T extends THREE.MeshStandardMaterial>(mat: T, strength = 1): T {
  const prev = mat.onBeforeCompile;
  mat.onBeforeCompile = (sh, r) => {
    prev?.call(mat, sh, r);
    sh.uniforms.uSunView = RIM.uSunView;
    sh.uniforms.uRimColor = RIM.uRimColor;
    sh.uniforms.uRimCold = RIM.uRimCold;
    sh.fragmentShader = sh.fragmentShader
      .replace("#include <common>", "#include <common>\nuniform vec3 uSunView;\nuniform vec3 uRimColor;\nuniform vec3 uRimCold;")
      .replace(
        "#include <opaque_fragment>",
        `{
          vec3 rv = normalize(vViewPosition);
          float fres = pow(1.0 - saturate(dot(normal, rv)), 2.6);
          float toSun = saturate(dot(normal, uSunView) * 0.6 + 0.4);
          outgoingLight += uRimColor * fres * pow(toSun, 2.2) * ${strength.toFixed(2)} * 0.55;
          outgoingLight += uRimCold * fres * (1.0 - toSun) * 0.6;
        }
        #include <opaque_fragment>`,
      );
  };
  const key = mat.customProgramCacheKey?.bind(mat);
  mat.customProgramCacheKey = () => `rim-${strength}-${key ? key() : ""}`;
  return mat;
}

/** Small canvas texture helper. */
export function canvasTexture(
  w: number,
  h: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
  srgb = true,
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d")!;
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
