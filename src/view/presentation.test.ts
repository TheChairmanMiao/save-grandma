import { describe, expect, it } from 'vitest';
import { createGame } from '../game/controller';
import { getSceneFrame, stepSceneMotion, type SceneMotion } from './presentation';
import { FIND_WRENCH, PRESETS } from '../game/presets';
import { lensYaw } from '../game/phone';
import type { Action } from '../game/types';
import { normalize } from '../game/config';

function setup() {
  const { controller, simulation } = createGame(); controller.start();
  const send = (action: Action) => controller.submitAction({ runId: controller.getObservation().runId, action });
  return { controller, simulation, send, frame: () => getSceneFrame(simulation.readState()) };
}

describe('Jeff’s presentation contract and phone camera', () => {
  it('front and rear lenses share a position and point in opposite directions', () => {
    const t = setup(); const selfie = t.frame().phone;
    t.send({ type: 'switch_camera', mode: 'rear' }); t.simulation.advance(1); const rear = t.frame().phone;
    expect(selfie.position).toEqual(rear.position);
    for (let i = 0; i < 3; i++) expect(selfie.target[i] - selfie.position[i]).toBeCloseTo(-(rear.target[i] - rear.position[i]));
  });
  it('bending lowers the phone continuously and shares the character’s progress', () => {
    const t = setup(); const before = t.frame().phone.position[1];
    t.send({ type: 'bend' }); t.simulation.advance(0.5); const middle = t.frame();
    expect(middle.character.bend).toBeCloseTo(0.5); expect(middle.character.animation.name).toBe('Bend_Down');
    t.simulation.advance(0.5); const after = t.frame().phone.position[1];
    expect(middle.phone.position[1]).toBeCloseTo((before + after) / 2);
  });
  it('repeating bend does not make an already bent Grandma pop upright', () => {
    const t = setup(); t.send({ type: 'bend' }); t.simulation.advance(1); t.send({ type: 'bend' }); t.simulation.advance(0.1);
    expect(t.frame().character.bend).toBe(1);
  });
  it('camera-relative look up raises the image aim with either lens', () => {
    for (const mode of ['selfie', 'rear'] as const) {
      const t = setup(); t.send({ type: 'switch_camera', mode }); t.simulation.advance(1);
      const before = t.frame().phone;
      t.send({ type: 'look', direction: 'up', degrees: 20, frame: 'camera' }); t.simulation.advance(1);
      const after = t.frame().phone;
      expect(after.target[1] - after.position[1]).toBeGreaterThan(before.target[1] - before.position[1]);
    }
  });
  it('aims the visible head with Grandma’s actual look while the body stays facing its original direction', () => {
    const t = setup(); let motion = stepSceneMotion(null, t.frame(), 0);
    t.send({ type: 'look', direction: 'left', degrees: 35 }); t.simulation.advance(0.25);
    const middle = t.frame();
    expect(middle.character.look.yaw).toBeGreaterThan(0); expect(middle.character.look.yaw).toBeLessThan(35);
    expect(middle.character.yaw).toBe(0);
    motion = stepSceneMotion(motion, middle, 1 / 60);
    expect(motion.character.look.yaw).toBeGreaterThan(0); expect(motion.character.look.yaw).toBeLessThan(middle.character.look.yaw);
    expect(Math.abs(normalize(motion.phone.yaw - motion.character.look.yaw))).toBeCloseTo(180);
  });
  it('switching a placed phone’s lens requires physically reaching it', () => {
    const t = setup();
    t.send({ type: 'move_to', target: { id: 'dry_spot' } }); t.send({ type: 'place_phone', target: { id: 'dry_spot' } });
    t.send({ type: 'move_to', target: { id: 'pipe_joint' } }); t.simulation.advance(20);
    t.send({ type: 'switch_camera', mode: 'rear' }); t.simulation.advance(1);
    expect(t.frame().phone.mode).toBe('selfie');
  });
  it('interpolates turning and ends with the same heading used for camera-frame actions', () => {
    const t = setup(); t.send({ type: 'turn', direction: 'left', degrees: 90 }); t.simulation.advance(0.35);
    expect(t.frame().character.yaw).toBeCloseTo(45);
    t.simulation.advance(0.35); expect(t.frame().character.yaw).toBeCloseTo(90);
    expect(t.frame().phone.yaw).toBeCloseTo(lensYaw(t.simulation.readState()));
  });
  it('recenters a previously aimed phone gradually during a body turn', () => {
    const t = setup(); t.send({ type: 'look', direction: 'left', degrees: 35 }); t.simulation.advance(1);
    const initialYaw = t.frame().phone.yaw;
    t.send({ type: 'turn', direction: 'left', degrees: 90 }); t.simulation.advance(0.35);
    const middleYaw = t.frame().phone.yaw;
    t.simulation.advance(0.35);
    expect(middleYaw).toBeCloseTo((initialYaw + t.frame().phone.yaw) / 2);
  });
  it('a placed phone ignores Grandma’s subsequent motion, posture and looking', () => {
    const t = setup();
    t.send({ type: 'move_to', target: { id: 'dry_spot' } }); t.send({ type: 'place_phone', target: { id: 'dry_spot' } }); t.simulation.advance(10);
    const fixed = t.frame().phone;
    t.send({ type: 'move_to', target: { id: 'pipe_joint' } }); t.send({ type: 'bend' }); t.send({ type: 'look', direction: 'down' }); t.simulation.advance(10);
    expect(t.frame().phone).toEqual(fixed);
  });
  it('exposes stable anchors and inventory hand slots independently of model choice', () => {
    const t = setup(); for (const action of FIND_WRENCH) t.send(action); t.simulation.advance(12);
    expect(t.frame().character.hands).toEqual({ left: 'phone', right: 'wrench' });
    expect(t.frame().effects.openToolboxes).toEqual(['red_toolbox', 'blue_toolbox', 'green_toolbox']);
    expect(t.frame().anchors.pipe_joint).toEqual([-1.3, 0.45, 4.6]);
    const snapshot = t.simulation.readState(); getSceneFrame(snapshot); expect(t.simulation.readState()).toEqual(snapshot);
  });
  it('freezes animation time in pause and switches to a terminal cue on success', () => {
    const t = setup(); for (const action of PRESETS.wrench.actions) t.send(action); t.simulation.advance(0.3);
    t.controller.pause(); const paused = t.frame(); t.simulation.advance(20);
    expect(t.frame()).toEqual(paused); expect(paused.character.animation.playing).toBe(false);
    t.controller.resume(); t.simulation.advance(40); expect(t.frame().character.animation.name).toBe('Relief');
  });

  it('fills the gaps between simulation ticks with continuous movement in the actual travel direction', () => {
    const t = setup();
    let motion = stepSceneMotion(null, t.frame(), 0);
    const start = motion.character.position[2];
    t.send({ type: 'move', direction: 'forward', meters: 1 }); t.simulation.advance(0.2);
    const target = t.frame();
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      motion = stepSceneMotion(motion, target, 1 / 60);
      samples.push(motion.phone.position[2]);
      expect(motion.character.position[2]).toBeGreaterThan(start);
      expect(motion.character.position[2]).toBeLessThan(target.character.position[2]);
      expect(motion.character.yaw).toBeCloseTo(0);
    }
    expect(samples[1]).toBeGreaterThan(samples[0]);
    expect(samples[2]).toBeGreaterThan(samples[1]);
    expect(motion.gait.weight).toBeGreaterThan(0);
    expect(Math.abs(motion.phone.roll)).toBeLessThanOrEqual(0.35);
  });

  it('orbits the held phone with Grandma during a turn instead of snapping the lens toward a target', () => {
    const t = setup(); let motion = stepSceneMotion(null, t.frame(), 0);
    t.send({ type: 'turn', direction: 'left', degrees: 90 }); t.simulation.advance(0.35);
    const target = t.frame();
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      motion = stepSceneMotion(motion, target, 1 / 60);
      const offset = [motion.phone.position[0] - motion.character.position[0], motion.phone.position[2] - motion.character.position[2]];
      expect(Math.atan2(offset[0], offset[1]) * 180 / Math.PI).toBeCloseTo(motion.character.yaw);
      expect(normalize(motion.phone.yaw - motion.character.yaw)).toBeCloseTo(-180);
      samples.push(motion.character.yaw);
    }
    expect(samples[0]).toBeGreaterThan(0);
    expect(samples[4]).toBeGreaterThan(samples[0]);
    expect(samples[4]).toBeLessThan(target.character.yaw);
    expect(motion.gait.weight).toBe(0);
  });

  it('shows an in-place turn before a destination walk and starts footfalls only after travel begins', () => {
    const t = setup(); let motion = stepSceneMotion(null, t.frame(), 0);
    const start = t.frame().character.position;
    t.send({ type: 'move_to', target: { id: 'pipe_joint' } }); t.simulation.advance(0.05);
    expect(t.frame().character.animation.name).toBe('Turn');
    motion = stepSceneMotion(motion, t.frame(), 1 / 60);
    expect(motion.character.position).toEqual(start); expect(motion.gait.weight).toBe(0);
    t.simulation.advance(0.5);
    expect(t.frame().character.animation.name).toBe('Walk');
    motion = stepSceneMotion(motion, t.frame(), 1 / 60);
    expect(motion.character.position).not.toEqual(start); expect(motion.gait.weight).toBeGreaterThan(0);
  });

  it('keeps opposite lenses on the same moving phone, including gait and vertical aiming', () => {
    const t = setup(); const start = t.frame();
    const rearView = () => {
      const state = t.simulation.readState();
      return getSceneFrame({ ...state, phone: { ...state.phone, mode: 'rear' } });
    };
    const rearStart = rearView();
    t.send({ type: 'move', direction: 'left', meters: 0.5 }); t.simulation.advance(0.3);
    const selfie = t.frame(); const rear = rearView();
    let frontMotion = stepSceneMotion(null, start, 0); let rearMotion = stepSceneMotion(null, rearStart, 0);
    for (let i = 0; i < 8; i++) {
      frontMotion = stepSceneMotion(frontMotion, selfie, 1 / 60);
      rearMotion = stepSceneMotion(rearMotion, rear, 1 / 60);
    }
    expect(frontMotion.phone.position).toEqual(rearMotion.phone.position);
    for (let i = 0; i < 3; i++) expect(frontMotion.phone.target[i] - frontMotion.phone.position[i]).toBeCloseTo(-(rearMotion.phone.target[i] - rearMotion.phone.position[i]));
  });

  it('never applies body following or footstep sway to a phone left on the shelf', () => {
    const t = setup();
    t.send({ type: 'move_to', target: { id: 'dry_spot' } }); t.send({ type: 'place_phone', target: { id: 'dry_spot' } }); t.simulation.advance(10);
    let motion = stepSceneMotion(null, t.frame(), 0); const fixed = structuredClone(motion.phone);
    t.send({ type: 'move_to', target: { id: 'pipe_joint' } });
    for (let i = 0; i < 120; i++) {
      t.simulation.advance(1 / 60); motion = stepSceneMotion(motion, t.frame(), 1 / 60);
      expect(motion.phone).toEqual(fixed);
    }
  });

  it('freezes the displayed pose on pause and removes extra gait and easing for reduced motion', () => {
    const t = setup(); let motion = stepSceneMotion(null, t.frame(), 0);
    t.send({ type: 'move', direction: 'forward', meters: 1 }); t.simulation.advance(0.4);
    motion = stepSceneMotion(motion, t.frame(), 1 / 60);
    t.controller.pause(); const paused = structuredClone(motion);
    motion = stepSceneMotion(motion, t.frame(), 0.1);
    expect(motion).toEqual(paused);
    const reduced = stepSceneMotion(motion, t.frame(), 1 / 60, true);
    expect(reduced.phone.position).toEqual(t.frame().phone.position);
    expect(reduced.phone.target).toEqual(t.frame().phone.target);
    expect(reduced.character.position).toEqual(t.frame().character.position);
    expect(reduced.gait.weight).toBe(0); expect(reduced.phone.roll).toBe(0);
  });

  it('keeps the greeting character alive before the game clock starts, then freezes cosmetic time on pause', () => {
    const { controller, simulation } = createGame();
    const ready = getSceneFrame(simulation.readState());
    const initial = stepSceneMotion(null, ready, 0);
    const greeting = stepSceneMotion(initial, ready, 0.05);
    expect(greeting.time).toBeGreaterThan(initial.time);
    expect(greeting.character.position).toEqual(initial.character.position);
    expect(greeting.phone.position).toEqual(initial.phone.position);
    expect(simulation.readState().elapsed).toBe(0);
    controller.start(); controller.pause();
    expect(stepSceneMotion(greeting, getSceneFrame(simulation.readState()), 0.1)).toEqual(greeting);
  });

  it('has the same easing at 60 and 120Hz and resets immediately for a new call', () => {
    const t = setup(); const start = t.frame();
    t.send({ type: 'move', direction: 'forward', meters: 1 }); t.simulation.advance(0.4); const target = t.frame();
    const run = (rate: number) => {
      let motion: SceneMotion = stepSceneMotion(null, start, 0);
      for (let i = 0; i < rate / 2; i++) motion = stepSceneMotion(motion, target, 1 / rate);
      return motion;
    };
    const a = run(60); const b = run(120);
    expect(a.character.position[2]).toBeCloseTo(b.character.position[2], 10);
    expect(a.character.yaw).toBeCloseTo(b.character.yaw, 10);
    t.controller.reset();
    const reset = stepSceneMotion(a, t.frame(), 1 / 60);
    expect(reset.character.position).toEqual(t.frame().character.position);
    expect(reset.phone.position).toEqual(t.frame().phone.position);
    expect(reset.gait.weight).toBe(0);
  });
});
