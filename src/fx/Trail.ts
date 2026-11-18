/**
 * Sword trail: a ribbon between the hilt and tip over the last few frames, fading with age.
 * Only emitted while a swing is active so it reads as the arc of the cut.
 */
import * as THREE from "three";

const N = 18;

export class Trail {
  readonly mesh: THREE.Mesh;
  private readonly pos: Float32Array;
  private readonly alpha: Float32Array;
  private readonly hilt: THREE.Vector3[] = [];
  private readonly tip: THREE.Vector3[] = [];
  private readonly age: number[] = [];
  private readonly geo: THREE.BufferGeometry;
  private readonly mat: THREE.ShaderMaterial;
  emitting = false;
  life = 0.16;

  constructor(color: THREE.ColorRepresentation, intensity = 1.6) {
    this.pos = new Float32Array(N * 2 * 3);
    this.alpha = new Float32Array(N * 2);
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute("aA", new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    geo.setIndex(idx);
    this.geo = geo;
    const c = new THREE.Color(color).multiplyScalar(intensity);
    this.mat = new THREE.ShaderMaterial({
      uniforms: { uC: { value: c } },
      vertexShader: /* glsl */ `
        attribute float aA; varying float vA; varying float vEdge;
        void main() { vA = aA; vEdge = float(gl_VertexID % 2);
          gl_Position = projectionMatrix * viewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */ `
        uniform vec3 uC; varying float vA; varying float vEdge;
        // Bright along the cutting edge, gone toward the hilt: an arc of light, not a flat sheet.
        void main() { float a = vA * vA * vA * vEdge * vEdge * 1.15;
          gl_FragColor = vec4(uC * a, 1.0); }`,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
  }

  update(dt: number, hilt: THREE.Vector3, tip: THREE.Vector3): void {
    for (let i = 0; i < this.age.length; i++) this.age[i] += dt;
    while (this.age.length && this.age[this.age.length - 1] > this.life) {
      this.age.pop();
      this.hilt.pop();
      this.tip.pop();
    }
    // A frozen blade (hitstop, contact hold) adds nothing: repeats would collapse the arc.
    const still = this.tip.length > 0 && this.tip[0].distanceToSquared(tip) < 1e-5;
    if (this.emitting && !still) {
      const h = this.hilt.length >= N ? this.hilt.pop()! : new THREE.Vector3();
      const t = this.tip.length >= N ? this.tip.pop()! : new THREE.Vector3();
      if (this.age.length >= N) this.age.pop();
      // Blade inner third to tip: the trail hugs the cutting edge.
      h.copy(hilt).lerp(tip, 0.3);
      t.copy(tip);
      this.hilt.unshift(h);
      this.tip.unshift(t);
      this.age.unshift(0);
    }
    const n = this.age.length;
    for (let i = 0; i < N; i++) {
      const j = Math.min(i, n - 1);
      const h = n ? this.hilt[j] : hilt;
      const t = n ? this.tip[j] : tip;
      this.pos.set([h.x, h.y, h.z], i * 6);
      this.pos.set([t.x, t.y, t.z], i * 6 + 3);
      const a = i < n ? Math.max(0, 1 - this.age[i] / this.life) * (1 - i / N) : 0;
      this.alpha[i * 2] = a;
      this.alpha[i * 2 + 1] = a;
    }
    this.geo.attributes.position.needsUpdate = true;
    (this.geo.attributes.aA as THREE.BufferAttribute).needsUpdate = true;
    this.mesh.visible = n > 1;
  }

  clear(): void {
    this.age.length = 0;
    this.hilt.length = 0;
    this.tip.length = 0;
  }
}
