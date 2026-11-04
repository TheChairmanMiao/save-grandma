import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createGame } from './controller';
import { distance, OBJECTS, normalize } from './config';
import { getPerception } from './perception';
import { getEyePose, getPhonePose } from './phone';
import type { Action } from './types';

function setup() {
  const { controller, simulation } = createGame(7); controller.start();
  const send = (action: Action) => controller.submitAction({ runId: controller.getObservation().runId, action });
  const run = (...actions: Action[]) => {
    actions.forEach(send);
    for (let i = 0; i < 1200 && (simulation.readState().active || simulation.readState().queue.length); i++) simulation.advance(0.05);
  };
  return { controller, simulation, send, run };
}
const ids = (objects: { id: string }[]) => objects.map(object => object.id);

function projectedPipe(world: ReturnType<ReturnType<typeof createGame>['simulation']['readState']>) {
  const pose = getPhonePose(world);
  const camera = new PerspectiveCamera(pose.verticalFov, pose.aspect, 0.035, 30);
  camera.position.set(...pose.position); camera.lookAt(...pose.target); camera.updateMatrixWorld();
  const pipe = OBJECTS.pipe_joint;
  return new Vector3(pipe.position.x, pipe.height, pipe.position.z).project(camera);
}

describe('Grandma sight and the actual phone frame', () => {
  it('distinguishes what Grandma sees from the selfie image, then shares the rear view', () => {
    const t = setup(); const initial = t.controller.getObservation();
    expect(ids(initial.surroundings)).toContain('pipe_joint');
    expect(initial.cameraView.grandmaVisible).toBe(true);
    expect(ids(initial.cameraView.surroundings)).not.toContain('pipe_joint');
    t.run({ type: 'switch_camera', mode: 'rear' });
    const rear = t.controller.getObservation();
    expect(rear.surroundings).toEqual(initial.surroundings);
    expect(rear.cameraView.grandmaVisible).toBe(false);
    expect(ids(rear.cameraView.surroundings)).toContain('pipe_joint');
    const projection = projectedPipe(t.simulation.readState());
    expect(Math.abs(projection.x)).toBeLessThan(1); expect(Math.abs(projection.y)).toBeLessThan(1);
  });

  it('uses pitch and the rendered perspective instead of reporting an offscreen pipe', () => {
    const t = setup(); t.run({ type: 'switch_camera', mode: 'rear' }, { type: 'look', direction: 'up', degrees: 65 });
    const projection = projectedPipe(t.simulation.readState());
    expect(Math.abs(projection.y)).toBeGreaterThan(1);
    expect(ids(t.controller.getObservation().cameraView.surroundings)).not.toContain('pipe_joint');
    expect(ids(t.controller.getObservation().surroundings)).not.toContain('pipe_joint');
  });

  it('updates camera framing for the actual viewport without changing Grandma’s sight or game state', () => {
    const t = setup(); t.run({ type: 'switch_camera', mode: 'rear' });
    const before = t.controller.getObservation();
    expect(ids(before.cameraView.surroundings)).toContain('pipe_joint');
    t.controller.setCameraAspect(0.25);
    const narrow = t.controller.getObservation();
    expect(ids(narrow.cameraView.surroundings)).not.toContain('pipe_joint');
    expect(narrow.surroundings).toEqual(before.surroundings);
    expect(narrow.elapsedSeconds).toBe(before.elapsedSeconds);
    expect(narrow.grandma).toEqual(before.grandma);
    expect(Math.abs(projectedPipe(t.simulation.readState()).x)).toBeGreaterThan(1);
    for (const invalid of [0, -1, Infinity, NaN]) t.controller.setCameraAspect(invalid);
    expect(t.simulation.readState().phone.aspect).toBe(0.25);
    t.controller.reset(); expect(t.simulation.readState().phone.aspect).toBe(0.25);
  });

  it('does not let nearby objects behind Grandma bypass her field of view', () => {
    const t = setup(); const world = t.simulation.readState();
    world.grandma.position = { x: 1.31, z: 2.4 }; world.grandma.yaw = -90;
    expect(distance(world.grandma.position, OBJECTS.blue_toolbox.position)).toBeLessThan(0.6);
    expect(ids(getPerception(world).surroundings)).not.toContain('blue_toolbox');
  });

  it('keeps her head within its natural range while the phone can aim behind her', () => {
    const t = setup(); t.run({ type: 'switch_camera', mode: 'rear' }, { type: 'look', direction: 'backward' });
    const world = t.simulation.readState(), eyes = getEyePose(world), camera = getPhonePose(world);
    expect(Math.abs(normalize(eyes.yaw - world.grandma.yaw))).toBe(65);
    expect(Math.abs(normalize(camera.yaw - world.grandma.yaw))).toBe(180);
    expect(ids(t.controller.getObservation().surroundings)).toContain('pipe_joint');
    expect(ids(t.controller.getObservation().cameraView.surroundings)).not.toContain('pipe_joint');
    t.run({ type: 'look', direction: 'up', degrees: 65 });
    expect(getEyePose(t.simulation.readState()).pitch).toBe(45);
    expect(t.simulation.readState().phone.pitch).toBe(65);
    t.run({ type: 'bend' });
    expect(getEyePose(t.simulation.readState()).pitch).toBe(20);
  });

  it('hides an item behind the solid toilet tank and reveals it from a clear side view', () => {
    const t = setup(); const world = t.simulation.readState();
    world.phone.mode = 'rear';
    world.items.bucket.position = { x: 2.2, z: 5.3 };
    world.grandma.position = { x: 2.2, z: 3.6 }; world.grandma.yaw = 0;
    expect(ids(getPerception(world).surroundings)).not.toContain('bucket');
    expect(ids(getPerception(world).cameraView.surroundings)).not.toContain('bucket');
    world.grandma.position = { x: -0.5, z: 4 };
    world.grandma.yaw = Math.atan2(2.7, 1.3) * 180 / Math.PI;
    expect(ids(getPerception(world).surroundings)).toContain('bucket');
    expect(ids(getPerception(world).cameraView.surroundings)).toContain('bucket');
  });

  it('keeps unopened contents private in both sight lists and excludes held/consumed objects', () => {
    const t = setup();
    for (const mode of ['selfie', 'rear'] as const) {
      t.run({ type: 'switch_camera', mode });
      const observation = t.controller.getObservation();
      for (const list of [observation.surroundings, observation.cameraView.surroundings]) expect(ids(list)).not.toEqual(expect.arrayContaining(['wrench']));
      expect(JSON.stringify(observation)).not.toMatch(/wrench|hammer|screwdriver/);
    }
    t.run({ type: 'move_to', target: { id: 'blue_toolbox' } }, { type: 'open', target: { id: 'red_toolbox' } }, { type: 'open', target: { id: 'blue_toolbox' } }, { type: 'open', target: { id: 'green_toolbox' } }, { type: 'grab', target: { id: 'wrench' } });
    expect(t.controller.getObservation().grandma.heldItems).toContain('wrench');
    expect(ids(t.controller.getObservation().surroundings)).not.toContain('wrench');
    expect(ids(t.controller.getObservation().cameraView.surroundings)).not.toContain('wrench');
  });

  it('keeps a shelf camera fixed while Grandma walks, turns and looks elsewhere', () => {
    const t = setup(); t.run({ type: 'move_to', target: { id: 'dry_spot' } }, { type: 'place_phone', target: { id: 'dry_spot' } });
    const fixed = getPhonePose(t.simulation.readState());
    t.run({ type: 'move_to', target: { id: 'pipe_joint' } }, { type: 'turn', direction: 'right', degrees: 90 }, { type: 'look', direction: 'up', degrees: 50 });
    expect(getPhonePose(t.simulation.readState())).toEqual(fixed);
  });
});

describe('physical facing while moving', () => {
  it('turns smoothly toward a named destination before starting to walk', () => {
    const t = setup(); t.run({ type: 'turn', direction: 'right', degrees: 90 });
    const before = t.simulation.readState().grandma;
    t.send({ type: 'move_to', target: { id: 'blue_toolbox' } }); t.simulation.advance(0.1);
    const middle = t.simulation.readState();
    expect(middle.grandma.position).toEqual(before.position);
    expect(middle.grandma.yaw).toBeGreaterThan(before.yaw);
    expect(middle.grandma.yaw).toBeLessThan(0);
    const expected = Math.atan2(OBJECTS.blue_toolbox.position.x - before.position.x, OBJECTS.blue_toolbox.position.z - before.position.z) * 180 / Math.PI;
    t.simulation.advance(10);
    expect(t.simulation.readState().grandma.yaw).toBeCloseTo(expected);
    expect(distance(t.simulation.readState().grandma.position, OBJECTS.blue_toolbox.position)).toBeLessThan(1.3);
  });

  it('retains explicit backward and side-step direction without rotating the body', () => {
    for (const direction of ['backward', 'left', 'right'] as const) {
      const t = setup(); t.run({ type: 'move', direction, meters: 0.2 });
      expect(t.simulation.readState().grandma.yaw).toBe(0);
      const position = t.simulation.readState().grandma.position;
      if (direction === 'backward') expect(position.z).toBeCloseTo(0.7);
      else expect(position.x).toBeCloseTo(direction === 'left' ? 0.2 : -0.2);
    }
  });

  it('preserves the current partial body and phone pose when interrupted or paused', () => {
    const t = setup();
    t.send({ type: 'turn', direction: 'left', degrees: 90 }); t.simulation.advance(0.2);
    const partial = getPhonePose(t.simulation.readState());
    const facing = t.controller.getObservation().grandma.facingDegrees;
    expect(facing).toBeGreaterThan(0); expect(facing).toBeLessThan(90);
    t.controller.pause(); t.simulation.advance(2); expect(getPhonePose(t.simulation.readState())).toEqual(partial);
    t.controller.resume(); t.controller.cancelActions(); expect(getPhonePose(t.simulation.readState())).toEqual(partial);
    t.send({ type: 'look', direction: 'left', degrees: 60 }); t.simulation.advance(0.2);
    const aimed = getPhonePose(t.simulation.readState()); t.controller.cancelActions();
    expect(getPhonePose(t.simulation.readState())).toEqual(aimed);
    expect(normalize(t.controller.getObservation().grandma.facingDegrees - facing)).toBeCloseTo(0);
  });
});
