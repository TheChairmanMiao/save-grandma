import { OBJECTS, normalize, radians, TUNING } from '../game/config';
import type { WorldState } from '../game/controller';
import { getCharacterPose, getEyePose, getPhonePose } from '../game/phone';
import type { ItemId, ObjectId, ToolboxId } from '../game/types';

export type Point3 = [number, number, number];
export type AnimationName = 'Idle_Standing' | 'Idle_Bent' | 'Walk' | 'Look' | 'Turn' | 'Bend_Down' | 'Stand_Up' | 'Pick_Up' | 'Put_Down' | 'Phone_Place' | 'Phone_Retrieve' | 'Phone_Check' | 'Open_Toolbox' | 'Tighten_Joint' | 'Relief' | 'Flooded';
export type SceneFrame = {
  runId: string;
  stage: WorldState['stage'];
  time: number;
  character: {
    position: Point3; yaw: number; bend: number;
    look: { yaw: number; pitch: number };
    motion: { phase: number; weight: number; reducedMotion: boolean };
    hands: { left: ItemId | 'phone' | null; right: ItemId | null };
    animation: { name: AnimationName; progress: number; duration: number; loop: boolean; playing: boolean; actionId: string | null; targetId: ObjectId | null };
  };
  phone: { position: Point3; target: Point3; yaw: number; pitch: number; verticalFov: number; aspect: number; mode: 'selfie' | 'rear'; placement: 'hand' | 'dry_spot' };
  anchors: Record<ObjectId, Point3>;
  effects: { waterHeight: number; waterRatio: number; leakRatio: number; openToolboxes: ToolboxId[]; bucketUsed: boolean; towelsUsed: boolean; bucketFill: number; towelSaturation: number };
};

/** Jeff's render contract. Pure and testable: visuals never mutate gameplay. */
export function getSceneFrame(world: WorldState): SceneFrame {
  const { grandma: g, phone, active } = world;
  const action = active?.request.action;
  const progress = active ? active.elapsed / active.duration : 0;
  const { yaw: bodyYaw, bend } = getCharacterPose(world);
  const eyes = getEyePose(world);
  const phonePose = getPhonePose(world);
  let name: AnimationName = g.posture === 'bent' ? 'Idle_Bent' : 'Idle_Standing';
  if (world.stage === 'won') name = 'Relief';
  else if (world.stage === 'lost') name = 'Flooded';
  else if (action) {
    switch (action.type) {
      case 'move': case 'move_to': name = active && active.elapsed < active.turnDuration ? 'Turn' : 'Walk'; break;
      case 'look': name = 'Look'; break;
      case 'turn': name = 'Turn'; break;
      case 'bend': name = 'Bend_Down'; break;
      case 'stand': name = 'Stand_Up'; break;
      case 'grab': name = 'Pick_Up'; break;
      case 'place': name = 'Put_Down'; break;
      case 'place_phone': name = 'Phone_Place'; break;
      case 'retrieve_phone': name = 'Phone_Retrieve'; break;
      case 'switch_camera': name = 'Phone_Check'; break;
      case 'rotate': name = 'Tighten_Joint'; break;
      case 'open': name = 'Open_Toolbox'; break;
    }
  }
  const ratio = world.water / TUNING.floodThreshold;
  return {
    runId: world.runId,
    stage: world.stage,
    time: world.elapsed,
    character: {
      position: [g.position.x, 0, g.position.z], yaw: bodyYaw, bend,
      look: { yaw: normalize(eyes.yaw - bodyYaw), pitch: eyes.pitch },
      motion: { phase: 0, weight: 0, reducedMotion: false },
      hands: { left: phone.placement === 'hand' ? 'phone' : g.held[1] ?? null, right: g.held[0] ?? null },
      animation: { name, progress, duration: active?.duration ?? 0, loop: name === 'Walk' || name.startsWith('Idle_'), playing: world.stage === 'running', actionId: active?.id ?? null, targetId: active?.target ?? null },
    },
    phone: phonePose,
    anchors: Object.fromEntries(Object.values(OBJECTS).map(o => {
      const item = world.items[o.id as ItemId];
      return [o.id, item ? [item.position.x, item.height, item.position.z] : [o.position.x, o.height, o.position.z]];
    })) as Record<ObjectId, Point3>,
    effects: { waterHeight: 0.015 + ratio * 0.3, waterRatio: ratio, leakRatio: world.leakRate / TUNING.initialLeakPerSecond, openToolboxes: (Object.keys(world.toolboxes) as ToolboxId[]).filter(box => world.toolboxes[box].open), bucketUsed: world.bucketUsed, towelsUsed: world.towelUsed, bucketFill: world.bucketUsed ? 1 - world.bucketRemaining / TUNING.bucketCapacity : 0, towelSaturation: world.towelUsed ? 1 - world.towelRemaining / TUNING.towelCapacity : 0 },
  };
}

export type SceneMotion = {
  runId: string;
  time: number;
  character: Pick<SceneFrame['character'], 'position' | 'yaw' | 'bend' | 'look'>;
  phone: SceneFrame['phone'] & { roll: number };
  hand: { offset: Point3; yaw: number; pitch: number };
  gait: { phase: number; weight: number };
};

const mix = (from: number, to: number, amount: number) => from + (to - from) * amount;
const mixAngle = (from: number, to: number, amount: number) => normalize(from + normalize(to - from) * amount);
const mixPoint = (from: Point3, to: Point3, amount: number): Point3 => from.map((v, i) => mix(v, to[i], amount)) as Point3;
const rotateOffset = ([x, y, z]: Point3, yaw: number): Point3 => {
  const angle = radians(yaw);
  return [x * Math.cos(angle) + z * Math.sin(angle), y, z * Math.cos(angle) - x * Math.sin(angle)];
};

/** One physical hand pose follows the body; screen motion never substitutes for walking. */
export function stepSceneMotion(previous: SceneMotion | null, frame: SceneFrame, deltaSeconds: number, reducedMotion = false): SceneMotion {
  const sourceOffset = rotateOffset(frame.phone.position.map((v, i) => v - frame.character.position[i]) as Point3, -frame.character.yaw);
  const hand = { offset: sourceOffset, yaw: normalize(frame.phone.yaw - frame.character.yaw), pitch: frame.phone.pitch };
  if (!previous || previous.runId !== frame.runId || reducedMotion) {
    return {
      runId: frame.runId,
      time: frame.time,
      character: { position: [...frame.character.position], yaw: frame.character.yaw, bend: frame.character.bend, look: { ...frame.character.look } },
      phone: { ...frame.phone, position: [...frame.phone.position], target: [...frame.phone.target], roll: 0 },
      hand,
      gait: { phase: 0, weight: 0 },
    };
  }
  // Pause freezes the exact displayed pose, including a footstep already in progress.
  if (!frame.character.animation.playing && frame.stage !== 'ready') return previous;
  // Exponential damping gives the same response at different display refresh rates.
  const dt = Math.max(0, Math.min(deltaSeconds, 0.1));
  const amount = 1 - Math.exp(-18 * dt);
  const character = {
    position: mixPoint(previous.character.position, frame.character.position, amount),
    yaw: mixAngle(previous.character.yaw, frame.character.yaw, amount),
    bend: mix(previous.character.bend, frame.character.bend, amount),
    look: {
      yaw: mixAngle(previous.character.look.yaw, frame.character.look.yaw, amount),
      pitch: mix(previous.character.look.pitch, frame.character.look.pitch, amount),
    },
  };
  const travelled = Math.hypot(character.position[0] - previous.character.position[0], character.position[2] - previous.character.position[2]);
  const gait = {
    phase: previous.gait.phase + travelled / 0.9 * Math.PI * 2,
    weight: mix(previous.gait.weight, dt > 0 && travelled / dt > 0.04 ? 1 : 0, 1 - Math.exp(-10 * dt)),
  };
  const switched = frame.phone.mode !== previous.phone.mode || frame.phone.placement !== previous.phone.placement;
  const smoothedHand = switched ? hand : {
    offset: mixPoint(previous.hand.offset, hand.offset, amount),
    yaw: mixAngle(previous.hand.yaw, hand.yaw, amount),
    pitch: mix(previous.hand.pitch, hand.pitch, amount),
  };
  if (frame.phone.placement === 'dry_spot') {
    return { runId: frame.runId, time: previous.time + dt, character, phone: { ...frame.phone, roll: 0 }, hand, gait };
  }
  const bodyOffset = rotateOffset(smoothedHand.offset, character.yaw);
  const side = Math.sin(gait.phase) * gait.weight;
  const step = Math.sin(gait.phase * 2) * gait.weight;
  const sway = rotateOffset([side * 0.009, step * 0.012, 0], character.yaw);
  const position = character.position.map((v, i) => v + bodyOffset[i] + sway[i]) as Point3;
  const yaw = normalize(character.yaw + smoothedHand.yaw + side * 0.3);
  const lensSign = frame.phone.mode === 'selfie' ? -1 : 1;
  const pitch = smoothedHand.pitch + step * 0.35 * lensSign;
  const horizontal = Math.cos(radians(pitch));
  const target: Point3 = [position[0] + Math.sin(radians(yaw)) * horizontal, position[1] + Math.sin(radians(pitch)), position[2] + Math.cos(radians(yaw)) * horizontal];
  return {
    runId: frame.runId, time: previous.time + dt, character, hand: smoothedHand, gait,
    phone: { ...frame.phone, position, target, yaw, pitch, roll: side * 0.35 * lensSign },
  };
}
