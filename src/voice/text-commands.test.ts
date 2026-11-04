import { describe, expect, it } from 'vitest';
import { parseInstruction, EXAMPLES } from './text-commands';
import { createGame } from '../game/controller';
import { createCommandSession } from '../game/command-session';

const actions = (line: string) => { const r = parseInstruction(line); if (!r.ok) throw new Error(r.hint); return r.steps.map(s => s.action); };

describe('typed instruction placeholder', () => {
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
