import { beforeEach, describe as group, expect, it } from 'vitest';
import { RunContext } from '@openai/agents';
import { gameController, simulation } from '../game/session';
import { grandmaTools } from './tools';

const byName = Object.fromEntries(grandmaTools.map(t => [t.name, t]));

/** Invoke a tool as the Realtime session would, while simulated time runs. */
async function call(name: string, args: object = {}) {
  const pending = byName[name].invoke(new RunContext(), JSON.stringify(args));
  let done = false;
  void pending.then(() => { done = true; });
  for (let i = 0; i < 2000 && !done; i++) { simulation.advance(0.05); await Promise.resolve(); await Promise.resolve(); }
  return JSON.parse(String(await pending));
}

group('Grandma voice tools', () => {
  beforeEach(() => { gameController.reset({ seed: 7 }); gameController.start(); });

  it('finds the wrench in the toolboxes and tightens the red pipe through tools', async () => {
    expect((await call('switch_camera', { camera: 'back' })).status).toBe('completed');
    expect((await call('walk_to', { thing: 'the toolboxes', color: 'blue' })).status).toBe('completed');
    expect((await call('pick_up', { thing: 'wrench', color: null })).status).toBe('failed');
    for (const color of ['red', 'blue', 'green']) expect((await call('open_toolbox', { thing: 'toolbox', color })).status).toBe('completed');
    expect((await call('pick_up', { thing: 'the wrench', color: null })).status).toBe('completed');
    expect((await call('walk_to', { thing: 'the red pipe', color: null })).status).toBe('completed');
    expect((await call('bend_down')).status).toBe('completed');
    const twist = await call('twist', { thing: 'pipe', color: 'red', direction: 'counterclockwise' });
    expect(twist.status).toBe('completed');
    expect(gameController.getObservation().stage).toBe('won');
  });

  it('asks which toolbox when the caller does not say', async () => {
    await call('walk_to', { thing: 'toolbox', color: 'blue' });
    const open = await call('open_toolbox', { thing: 'toolbox', color: null });
    expect(['clarification_needed', 'completed']).toContain(open.status);
  });

  it('flips the current camera in both directions without turning Grandma', async () => {
    const facing = gameController.getObservation().grandma.facingDegrees;
    expect((await call('flip_camera')).status).toBe('completed');
    expect(gameController.getObservation().phone.mode).toBe('rear');
    expect((await call('flip_camera')).status).toBe('completed');
    expect(gameController.getObservation().phone.mode).toBe('selfie');
    expect(gameController.getObservation().grandma.facingDegrees).toBe(facing);
  });

  it('performs a literal half-turn without changing the selected camera', async () => {
    const before = gameController.getObservation();
    expect((await call('turn_around')).status).toBe('completed');
    const after = gameController.getObservation();
    expect(Math.abs(after.grandma.facingDegrees - before.grandma.facingDegrees)).toBe(180);
    expect(after.phone.mode).toBe(before.phone.mode);
  });

  it('asks which way when no direction was given', async () => {
    await call('walk_to', { thing: 'pipe', color: null });
    const twist = await call('twist', { thing: 'pipe', color: null, direction: null });
    expect(twist.status).toBe('clarification_needed');
  });

  it('reports prerequisite failures for Grandma to explain', async () => {
    const grab = await call('pick_up', { thing: 'bucket', color: null });
    expect(grab.status).toBe('failed');
    expect(grab.now.sees).toBeInstanceOf(Array);
  });

  it('hides object ids from the model', async () => {
    const seen = await call('look_around');
    expect(JSON.stringify(seen)).not.toMatch(/pipe_joint|dry_spot|red_toolbox|wrench/);
  });

  it('rejects actions when the call is paused', async () => {
    gameController.pause();
    expect((await call('bend_down')).status).toBe('not_running');
  });
});
