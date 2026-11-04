import { distance, ids, OBJECTS, radians, TUNING } from './config';
import type { WorldState } from './controller';
import { getCharacterPose, getEyePose, getPhonePose, type Point3 } from './phone';
import type { ItemId, ObjectId, Observation, PerceivedObject } from './types';

type View = { position: Point3; yaw: number; pitch: number; verticalFov: number; aspect: number };
type Solid = { min: Point3; max: Point3 };

// Actual opaque fixture volumes, not the inflated walking/collision footprints. These
// deliberately cover the large furniture only; cosmetic meshes do not change perception.
const FIXTURES: Solid[] = [
  { min: [1.6, 0.625, 1.65], max: [2.3, 0.745, 3.15] }, // work-table top and apron
  { min: [-1.8, 0.87, 4.76], max: [0, 1.13, 5.4] }, // wall-hung sink counter
  { min: [1.94, 0, 4.35], max: [2.46, 0.6, 5.01] }, // toilet bowl/pedestal
  { min: [1.95, 0.41, 5.0], max: [2.45, 1.08, 5.24] }, // toilet tank
  { min: [-3, 0, 0.08], max: [-2.28, 0.6, 2.42] }, // bathtub side
];

function crossesSolid(from: Point3, to: Point3, solid: Solid) {
  let entry = 0, exit = 1;
  for (let axis = 0; axis < 3; axis++) {
    const delta = to[axis] - from[axis];
    if (Math.abs(delta) < 1e-8) {
      if (from[axis] < solid.min[axis] || from[axis] > solid.max[axis]) return false;
      continue;
    }
    const a = (solid.min[axis] - from[axis]) / delta;
    const b = (solid.max[axis] - from[axis]) / delta;
    entry = Math.max(entry, Math.min(a, b)); exit = Math.min(exit, Math.max(a, b));
    if (entry > exit) return false;
  }
  return exit > 0.001 && entry < 0.999;
}

function inFrame(point: Point3, view: View) {
  const yaw = radians(view.yaw), pitch = radians(view.pitch);
  const dx = point[0] - view.position[0], dy = point[1] - view.position[1], dz = point[2] - view.position[2];
  const forward = dx * Math.sin(yaw) * Math.cos(pitch) + dy * Math.sin(pitch) + dz * Math.cos(yaw) * Math.cos(pitch);
  if (forward < 0.035 || forward > 30) return false;
  const horizontal = dx * Math.cos(yaw) - dz * Math.sin(yaw);
  const vertical = -dx * Math.sin(yaw) * Math.sin(pitch) + dy * Math.cos(pitch) - dz * Math.cos(yaw) * Math.sin(pitch);
  const halfHeight = forward * Math.tan(radians(view.verticalFov / 2));
  return Math.abs(horizontal) <= halfHeight * view.aspect && Math.abs(vertical) <= halfHeight;
}

function visible(points: Point3[], view: View, solids = FIXTURES) {
  return points.some(point => inFrame(point, view) && !solids.some(solid => crossesSolid(view.position, point, solid)));
}

function samples(world: WorldState, id: ObjectId): Point3[] {
  const item = world.items[id as ItemId];
  const position = item?.position ?? OBJECTS[id].position;
  const y = item?.height ?? OBJECTS[id].height;
  const radius = id.endsWith('_toolbox') ? 0.21 : id === 'dry_spot' ? 0.28 : id === 'puddle' ? 0.32 : id === 'bucket' ? 0.19 : id === 'pipe_joint' ? 0.1 : 0.13;
  const height = id === 'bucket' ? 0.18 : id === 'puddle' ? 0.015 : 0.06;
  // A partly visible object counts; use small interaction bounds, rather than an omniscient
  // radius around Grandma or the entire object's possibly distant decorative geometry.
  return [[position.x, y, position.z], [position.x - radius, y, position.z], [position.x + radius, y, position.z],
    [position.x, y + height, position.z], [position.x, Math.max(0, y - height), position.z],
    [position.x, y, position.z - radius], [position.x, y, position.z + radius]];
}

/** Perception is computed from the same continuous physical pose as the rendered camera. */
export function getPerception(world: WorldState): Pick<Observation, 'surroundings' | 'cameraView'> {
  const { grandma } = world;
  const pose = getCharacterPose(world), camera = getPhonePose(world), eyes = getEyePose(world);
  const body: Solid = {
    min: [grandma.position.x - 0.28, 0, grandma.position.z - 0.24],
    max: [grandma.position.x + 0.28, 1.65 - pose.bend * 0.45, grandma.position.z + 0.24],
  };
  const cameraSolids = [...FIXTURES, body];
  const available = ids.filter(id => !world.items[id as ItemId] || world.items[id as ItemId].location === 'world');
  const describe = (id: ObjectId): PerceivedObject => {
    const object = OBJECTS[id], item = world.items[id as ItemId];
    const d = distance(grandma.position, item?.position ?? object.position);
    const name = id.endsWith('_toolbox') ? `${object.name} (${world.toolboxes[id as keyof typeof world.toolboxes].open ? 'open' : 'closed'})` : object.name;
    return { id, name, color: object.color, distance: Math.round(d * 10) / 10, reachable: d <= TUNING.reach, visible: true };
  };
  return {
    surroundings: available.filter(id => visible(samples(world, id), eyes)).map(describe),
    cameraView: {
      surroundings: available.filter(id => visible(samples(world, id), camera, cameraSolids)).map(describe),
      grandmaVisible: visible([eyes.position], camera),
      facingDegrees: camera.yaw, pitchDegrees: camera.pitch,
    },
  };
}
