/**
 * Between the rooftop and the mountains (the compound, turrets and pines are in arena.glb): the
 * cloud sea the castle rises out of, with the town far below (CloudSea), and the moon disc mesh
 * that drives the light-shaft pass.
 */
import * as THREE from "three";
import { CloudSea } from "./CloudSea";
import { MOON_R, SUN_DIR } from "./materials";

const MOON_DIST = 1100;

export class Surround {
  readonly group = new THREE.Group();
  /** The moon, for the god-ray pass (name kept: it was the sun at dusk). */
  readonly sunMesh: THREE.Mesh;
  readonly clouds = new CloudSea();
  private readonly moonMat: THREE.MeshBasicMaterial;

  constructor() {
    this.group.add(this.clouds.group);
    // Same size as the sky's disc. Dim on purpose: the rays should be a faint moonbeam through
    // the falling snow, not a sunburst (the pass clamps its samples at 1.0).
    this.moonMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.55, 0.62, 0.75), fog: false, transparent: true, depthWrite: false });
    this.sunMesh = new THREE.Mesh(new THREE.SphereGeometry(MOON_DIST * Math.tan(MOON_R), 24, 16), this.moonMat);
    this.sunMesh.position.copy(SUN_DIR).multiplyScalar(MOON_DIST);
    this.sunMesh.frustumCulled = false;
    this.group.add(this.sunMesh);
  }

  set blood(v: number) {
    this.clouds.blood = v;
    this.moonMat.color.setRGB(0.55 + v * 0.3, 0.62 * (1 - v * 0.85), 0.75 * (1 - v * 0.88));
  }

  update(t: number): void {
    this.clouds.update(t);
  }
}
