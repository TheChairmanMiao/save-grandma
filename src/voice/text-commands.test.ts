import { describe, expect, it } from 'vitest';
import { parseInstruction, EXAMPLES, type ParseContext } from './text-commands';
import { createGame } from '../game/controller';
import { createCommandSession } from '../game/command-session';

const actions = (line: string, context?: ParseContext) => { const r = parseInstruction(line, context); if (!r.ok) throw new Error(r.hint); return r.steps.map(s => s.action); };

describe('typed instruction fallback', () => {
  it('understands every example phrase', () => {
    for (const example of EXAMPLES) expect(parseInstruction(example).ok, example).toBe(true);
  });
  it('maps phrasings to structured actions', () => {
    expect(actions('switch to the rear camera')).toEqual([{ type: 'switch_camera', mode: 'rear' }]);
    expect(actions('show me your face')).toEqual([{ type: 'switch_camera', mode: 'selfie' }]);
    expect(actions('go to the toolboxes')).toEqual([{ type: 'move_to', target: { id: 'blue_toolbox' } }]);
    expect(actions('open the red toolbox')).toEqual([{ type: 'open', target: { id: 'red_toolbox' } }]);
    expect(actions('open the toolbox')).toEqual([{ type: 'open', target: { candidates: ['red_toolbox', 'blue_toolbox', 'green_toolbox'] } }]);
    expect(actions('turn the pipe clockwise')).toEqual([{ type: 'move_to', target: { id: 'pipe_joint' } }, { type: 'bend' }, { type: 'rotate', target: { id: 'pipe_joint' }, direction: 'clockwise' }]);
    expect(actions('turn the pipe')).toEqual([{ type: 'move_to', target: { id: 'pipe_joint' } }, { type: 'bend' }, { type: 'rotate', target: { id: 'pipe_joint' }, direction: undefined }]);
    expect(actions('loosen the joint')).toEqual([{ type: 'move_to', target: { id: 'pipe_joint' } }, { type: 'bend' }, { type: 'rotate', target: { id: 'pipe_joint' }, direction: 'counterclockwise' }]);
    expect(actions('tighten the joint')).toEqual([{ type: 'move_to', target: { id: 'pipe_joint' } }, { type: 'bend' }, { type: 'rotate', target: { id: 'pipe_joint' }, direction: 'counterclockwise' }]);
    expect(actions('tighten the pipe clockwise')).toEqual([{ type: 'move_to', target: { id: 'pipe_joint' } }, { type: 'bend' }, { type: 'rotate', target: { id: 'pipe_joint' }, direction: 'clockwise' }]);
    expect(actions('pick up the wrench')).toEqual([{ type: 'grab', target: { id: 'wrench' } }]);
    expect(actions('put the phone on the shelf')).toEqual([{ type: 'place_phone', target: { id: 'dry_spot' } }]);
    expect(actions('grab the phone')).toEqual([{ type: 'retrieve_phone' }]);
    expect(actions('put the towels on the puddle')).toEqual([{ type: 'place', item: 'towels', target: { id: 'puddle' } }]);
    expect(actions('grab the hammer')).toEqual([{ type: 'grab', target: { id: 'hammer' } }]);
    expect(actions('walk forward 2 meters')).toEqual([{ type: 'move', direction: 'forward', meters: 2 }]);
    expect(actions('look up')).toEqual([{ type: 'look', direction: 'up' }]);
    expect(actions('turn around')).toEqual([{ type: 'turn', direction: 'left', degrees: 180 }]);
    expect(actions('wait 5 seconds')).toEqual([{ type: 'wait', seconds: 5 }]);
  });
  it('splits compound instructions and rejects unknown clauses', () => {
    expect(actions('grab the wrench, then go to the pipe and bend down').map(a => a.type)).toEqual(['grab', 'move_to', 'bend']);
    const bad = parseInstruction('go to the pipe, then fix everything');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.phrase).toBe('fix everything');
  });
  it('recognizes explicit camera aliases and scopes negation to the requested view', () => {
    for (const phrase of ['turn off selfie mode', 'turn selfie mode off', 'stop showing your face', "I don't want selfie mode", 'I don’t want selfie mode', 'show me the room', 'use the back camera', 'switch the camera to the rear', 'rear-facing camera']) {
      expect(actions(phrase), phrase).toEqual([{ type: 'switch_camera', mode: 'rear' }]);
    }
    for (const phrase of ['front-facing camera', 'show me yourself', 'switch the camera to the front', 'not the rear camera', "don't turn off selfie mode"]) {
      expect(actions(phrase), phrase).toEqual([{ type: 'switch_camera', mode: 'selfie' }]);
    }
    expect(actions('not the front camera use the rear camera')).toEqual([{ type: 'switch_camera', mode: 'rear' }]);
    expect(parseInstruction("don't turn the camera around").ok).toBe(false);
  });
  it.each([
    ['turn off selfie mode', 'selfie', 'rear'],
    ['stop showing your face', 'selfie', 'rear'],
    ["I don't want selfie mode", 'selfie', 'rear'],
    ['turn the camera around', 'selfie', 'rear'],
    ['turn the camera around', 'rear', 'selfie'],
    ['switch to the front camera', 'rear', 'selfie'],
    ['switch to the rear camera', 'selfie', 'rear'],
  ] as const)('executes “%s” from %s as %s without turning Grandma', async (instruction, initialCamera, expectedCamera) => {
    const { controller, simulation } = createGame(7);
    const session = createCommandSession(controller);
    controller.start();
    controller.submitAction({ runId: controller.getObservation().runId, action: { type: 'switch_camera', mode: initialCamera } });
    simulation.advance(1);
    simulation.advance(220); // Clear lens instructions remain exact even under high stress.
    const before = controller.getObservation();
    const turn = session.beginTurn();
    const parsed = parseInstruction(instruction, { cameraMode: before.phone.mode });
    expect(parsed.ok).toBe(true);
    const pending = session.submit(turn.token, parsed.ok ? parsed.steps : []);
    simulation.advance(2);
    expect((await pending).status).toBe('completed');
    const after = controller.getObservation();
    expect(after.phone.mode).toBe(expectedCamera);
    expect(after.grandma.facingDegrees).toBe(before.grandma.facingDegrees);
    expect(after.grandma.position).toEqual(before.grandma.position);
    session.dispose();
  });
  it('tracks explicit changes and toggles within one compound instruction', async () => {
    const { controller, simulation } = createGame(7);
    const session = createCommandSession(controller);
    controller.start();
    const turn = session.beginTurn();
    const parsed = parseInstruction('use the rear camera, turn the camera around, flip the camera', { cameraMode: 'selfie' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.hint);
    expect(parsed.steps.map(step => step.action)).toEqual([
      { type: 'switch_camera', mode: 'rear' },
      { type: 'switch_camera', mode: 'selfie' },
      { type: 'switch_camera', mode: 'rear' },
    ]);
    const pending = session.submit(turn.token, parsed.steps);
    simulation.advance(3);
    expect((await pending).status).toBe('completed');
    expect(controller.getObservation().phone.mode).toBe('rear');
    session.dispose();
  });
  it('keeps “turn around” as body rotation without changing the lens', async () => {
    const { controller, simulation } = createGame(7);
    const session = createCommandSession(controller);
    controller.start();
    const before = controller.getObservation();
    const turn = session.beginTurn();
    const parsed = parseInstruction('turn around', { cameraMode: before.phone.mode });
    expect(parsed.ok).toBe(true);
    const pending = session.submit(turn.token, parsed.ok ? parsed.steps : []);
    simulation.advance(2);
    expect((await pending).status).toBe('completed');
    expect(controller.getObservation().phone.mode).toBe(before.phone.mode);
    expect(Math.abs(controller.getObservation().grandma.facingDegrees - before.grandma.facingDegrees)).toBe(180);
    session.dispose();
  });
  it.each(['turn the pipe counterclockwise', 'tighten the pipe'])('wins the wrench solution with “%s” through the command session', async instruction => {
    const { controller, simulation } = createGame(7);
    const session = createCommandSession(controller);
    controller.start();
    const turn = session.beginTurn();
    const parsed = parseInstruction(`switch to the rear camera, go to the toolboxes, open the red toolbox, open the blue toolbox, open the green toolbox, pick up the wrench, walk to the pipe, bend down, ${instruction}`);
    expect(parsed.ok).toBe(true);
    const pending = session.submit(turn.token, parsed.ok ? parsed.steps : []);
    simulation.advance(40);
    const outcome = await pending;
    expect(outcome.status).toBe('completed');
    expect(controller.getObservation().stage).toBe('won');
    expect(simulation.readState().leakRate).toBe(0);
    session.dispose();
  });
  it.each(['turn the pipe clockwise', 'tighten the pipe clockwise'])('worsens the leak with the explicit instruction “%s”', async instruction => {
    const { controller, simulation } = createGame(7);
    const session = createCommandSession(controller);
    controller.start();
    const initialLeakRate = simulation.readState().leakRate;
    const turn = session.beginTurn();
    const parsed = parseInstruction(`go to the toolboxes, open the red toolbox, open the blue toolbox, open the green toolbox, pick up the wrench, walk to the pipe, bend down, ${instruction}`);
    expect(parsed.ok).toBe(true);
    const pending = session.submit(turn.token, parsed.ok ? parsed.steps : []);
    simulation.advance(40);
    const outcome = await pending;
    expect(outcome.status).toBe('stopped');
    expect(outcome.code).toBe('LEAK_WORSENED');
    expect(controller.getObservation().stage).toBe('running');
    expect(simulation.readState().leakRate).toBeGreaterThan(initialLeakRate);
    session.dispose();
  });
});
