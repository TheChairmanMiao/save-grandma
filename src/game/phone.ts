import { normalize, OBJECTS, radians } from './config';
import type { WorldState } from './controller';
import type { Action } from './types';

export type Point3 = [number, number, number];
export const PHONE_VERTICAL_FOV = 88;
export const DEFAULT_CAMERA_ASPECT = 9 / 16;
export const smoothProgress = (progress: number) => { const p = Math.max(0, Math.min(1, progress)); return p * p * (3 - 2 * p); };

/** Simulation yaw/aim are already continuous; consumers must not interpolate them again. */
export function getCharacterPose(world: WorldState) {
  const { grandma, phone, active } = world;
  const action = active?.request.action;
  const progress = active ? smoothProgress(active.elapsed / active.duration) : 0;
  const initialBend = grandma.posture === 'bent' ? 1 : 0;
  const bend = action?.type === 'bend' ? initialBend + (1 - initialBend) * progress : action?.type === 'stand' ? initialBend * (1 - progress) : initialBend;
  return { yaw: grandma.yaw, bend, lookYaw: phone.yaw, pitch: phone.pitch };
}

/** A natural neck range limits Grandma's eyes even when she aims the phone behind her. */
export function getEyePose(world: WorldState) {
  const { grandma } = world;
  const pose = getCharacterPose(world);
  const position: Point3 = [
    grandma.position.x + Math.sin(radians(pose.yaw)) * pose.bend * 0.16,
    1.48 - pose.bend * 0.5,
    grandma.position.z + Math.cos(radians(pose.yaw)) * pose.bend * 0.16,
  ];
  return {
    position, yaw: pose.yaw + Math.max(-65, Math.min(65, pose.lookYaw)),
    pitch: Math.max(-45, Math.min(45, pose.pitch)) - pose.bend * 25,
    verticalFov: 110, aspect: Math.tan(radians(70)) / Math.tan(radians(55)),
  };
}

/** One physical phone pose, shared by rendering, camera-relative actions, and perception. */
export function getPhonePose(world: WorldState) {
  const { grandma, phone } = world;
  const pose = getCharacterPose(world);
  const yaw = normalize((phone.placement === 'hand' ? pose.yaw + pose.lookYaw : phone.fixedYaw) + (phone.mode === 'selfie' ? 180 : 0));
  const position: Point3 = phone.placement === 'hand'
    ? [grandma.position.x + Math.sin(radians(pose.yaw)) * (0.55 + pose.bend * 0.15), 1.3 - pose.bend * 0.55, grandma.position.z + Math.cos(radians(pose.yaw)) * (0.55 + pose.bend * 0.15)]
    : [OBJECTS.dry_spot.position.x, 1.32, OBJECTS.dry_spot.position.z];
  const rearPitch = phone.placement === 'hand' ? pose.pitch - 22 - pose.bend * 20 : -Math.atan(0.18) * 180 / Math.PI;
  const pitch = phone.mode === 'selfie' ? -rearPitch : rearPitch;
  const lensPitch = radians(pitch);
  const target: Point3 = [position[0] + Math.sin(radians(yaw)) * Math.cos(lensPitch), position[1] + Math.sin(lensPitch), position[2] + Math.cos(radians(yaw)) * Math.cos(lensPitch)];
  return { position, target, yaw, pitch, verticalFov: PHONE_VERTICAL_FOV, aspect: phone.aspect, mode: phone.mode, placement: phone.placement };
}

/** Authoritative heading shared by movement and rendering. */
export function lensYaw(world: WorldState) {
  return getPhonePose(world).yaw;
}
export function turnYaw(world: WorldState, action: Extract<Action, { type: 'turn' }>) {
  const base = action.frame === 'camera' ? lensYaw(world) : world.grandma.yaw;
  return normalize(base + (action.direction === 'left' ? 1 : -1) * (action.degrees ?? 90));
}
export function lookAngles(world: WorldState, action: Extract<Action, { type: 'look' }>) {
  const { grandma, phone } = world;
  const degrees = action.degrees ?? 35;
  if (action.direction === 'up' || action.direction === 'down') {
    const lensSign = action.frame === 'camera' && phone.mode === 'selfie' ? -1 : 1;
    return { yaw: phone.yaw, pitch: Math.max(-65, Math.min(65, phone.pitch + lensSign * (action.direction === 'up' ? degrees : -degrees))) };
  }
  const base = action.frame === 'camera' ? lensYaw(world) : grandma.yaw;
  const offset = { forward: 0, backward: 180, left: degrees, right: -degrees }[action.direction];
  return {
    yaw: normalize(base + offset - grandma.yaw - (action.frame === 'camera' && phone.mode === 'selfie' ? 180 : 0)),
    pitch: action.direction === 'forward' ? 0 : phone.pitch,
  };
}
