import { describe, expect, it } from 'vitest';
import { createGame } from '../game/controller';
import { createCommandSession } from '../game/command-session';
import type { Action, Result } from '../game/types';
import { OfflineGrandma } from './offline-grandma';

function setup() {
  const { controller, simulation } = createGame(7);
  const commands = createCommandSession(controller);
  const grandma = new OfflineGrandma();
  const actions = new Map<string, Action>();
  const results: Result[] = [];
  const replies: string[] = [];
  controller.subscribe(event => {
    if (event.type === 'action_queued') actions.set(event.actionId, event.action);
    if (event.type === 'action_result') {
      results.push(event.result);
      const action = actions.get(event.result.actionId);
      if (action) replies.push(grandma.react(action, event.result, controller.getObservation()));
    }
  });
  controller.start();
  const say = async (text: string) => {
    const plan = grandma.plan(text, controller.getObservation());
    if (plan.interrupt) commands.interrupt();
    if (plan.steps.length) {
      const turn = commands.beginTurn();
      const pending = commands.submit(turn.token, plan.steps);
      for (let i = 0; i < 1500 && (simulation.readState().active || simulation.readState().queue.length); i++) simulation.advance(0.05);
      await pending;
    }
    return plan;
  };
  return { controller, simulation, commands, grandma, say, results, replies };
}

describe('offline Grandma learns from real actions and corrections', () => {
  it('actually opens a plausible vague box, accepts a color correction, and moves on from tried boxes', async () => {
    const t = setup();
    await t.say('go to the toolboxes');
    const vague = await t.say('open the toolbox');
    const first = t.results.at(-1)!;
    expect(first.status).toBe('completed');
    expect(first.targetId).toMatch(/_toolbox$/);
    expect(vague.reply).toContain('Let me try');
    expect(vague.reply).not.toMatch(/is open|inside|got it/i);
    const color = first.targetId === 'green_toolbox' ? 'blue' : 'green';
    const correction = await t.say(`No, the ${color} one`);
    expect(correction.steps.at(-1)?.action).toEqual({ type: 'open', target: { id: `${color}_toolbox` } });
    expect(t.results.at(-1)?.targetId).toBe(`${color}_toolbox`);
    if (t.results.at(-1)?.code === 'OUT_OF_REACH') {
      const closer = await t.say(`the ${color} one`);
      expect(closer.steps.map(step => step.action.type)).toEqual(['move_to', 'open']);
    }
    expect(t.simulation.readState().toolboxes[`${color}_toolbox` as 'green_toolbox'].open).toBe(true);
    await t.say('open the toolbox');
    expect(t.results.at(-1)?.status).toBe('completed');
    expect(t.results.at(-1)?.targetId).not.toBe(first.targetId);
    expect(t.results.at(-1)?.targetId).not.toBe(`${color}_toolbox`);
    const exhausted = await t.say('open the toolbox');
    expect(exhausted.steps).toEqual([]);
    expect(exhausted.reply).toMatch(/Name a color/);
    t.commands.dispose();
  });

  it('recovers from reach, then posture failures without secretly collecting anything', async () => {
    const t = setup();
    await t.say('pick up the bucket');
    expect(t.results.at(-1)?.code).toBe('OUT_OF_REACH');
    const original = { ...t.controller.getObservation().grandma.position };
    const closer = await t.say('pick up the bucket');
    expect(closer.steps.map(step => step.action.type)).toEqual(['move_to', 'grab']);
    expect(t.controller.getObservation().grandma.position).not.toEqual(original);
    expect(t.results.at(-1)?.code).toBe('WRONG_POSTURE');
    const bent = await t.say('try again');
    expect(bent.steps.map(step => step.action.type)).toEqual(['bend', 'grab']);
    expect(t.results.at(-1)?.status).toBe('completed');
    expect(t.controller.getObservation().grandma.heldItems).toEqual(['bucket']);
    expect(t.controller.getObservation().grandma.posture).toBe('bent');
    expect(t.simulation.readState().leakRate).toBeGreaterThan(0);
    t.commands.dispose();
  });

  it('stands before retrying a walk that failed while bent', async () => {
    const t = setup();
    await t.say('bend down');
    await t.say('go to the red toolbox');
    expect(t.results.at(-1)?.code).toBe('WRONG_POSTURE');
    const retry = await t.say('go to the red toolbox');
    expect(retry.steps.map(step => step.action.type)).toEqual(['stand', 'move_to']);
    expect(t.results.at(-1)?.status).toBe('completed');
    expect(t.controller.getObservation().grandma.posture).toBe('standing');
    t.commands.dispose();
  });

  it('corrects a body turn to a lens switch and respects an explicit front-camera correction', async () => {
    const t = setup();
    await t.say('turn around');
    const facing = t.controller.getObservation().grandma.facingDegrees;
    const correction = await t.say('No, the camera, not you');
    expect(correction.steps).toEqual([{ action: { type: 'switch_camera', mode: 'rear' } }]);
    expect(t.controller.getObservation().phone.mode).toBe('rear');
    expect(t.controller.getObservation().grandma.facingDegrees).toBe(facing);
    expect(t.replies.at(-1)).toMatch(/room/);
    await t.say('front camera');
    expect(t.controller.getObservation().phone.mode).toBe('selfie');
    expect(t.replies.at(-1)).toMatch(/face/);
    t.commands.dispose();
  });

  it('honors an explicit face request inside a correction even when selfie is already selected', async () => {
    const t = setup();
    await t.say('turn around');
    const before = t.controller.getObservation().grandma.facingDegrees;
    const correction = await t.say('No, the camera, not you. I want to see your face again.');
    expect(correction.steps).toEqual([{ action: { type: 'switch_camera', mode: 'selfie' } }]);
    expect(t.controller.getObservation().phone.mode).toBe('selfie');
    expect(t.controller.getObservation().grandma.facingDegrees).toBe(before);
    expect(t.replies.at(-1)).toMatch(/face/);
    t.commands.dispose();
  });

  it('learns a camera correction for later bare turn-around requests while explicit body turns still work', async () => {
    const t = setup();
    await t.say('turn around');
    await t.say('No, the camera, not you');
    const before = t.controller.getObservation();
    const learned = await t.say('turn around');
    expect(learned.steps).toEqual([{ action: { type: 'switch_camera', mode: 'selfie' } }]);
    expect(t.controller.getObservation().grandma.facingDegrees).toBe(before.grandma.facingDegrees);
    const explicit = await t.say('turn your whole body around');
    expect(explicit.steps.at(-1)?.action.type).toBe('turn');
    expect(t.controller.getObservation().grandma.facingDegrees).not.toBe(before.grandma.facingDegrees);
    expect(t.controller.getObservation().phone.mode).toBe('selfie');
    t.grandma.reset();
    expect(t.grandma.plan('turn around', t.controller.getObservation()).steps.at(-1)?.action.type).toBe('turn');
    t.commands.dispose();
  });

  it('remembers a failed movement prerequisite instead of alternating reach and blocked failures forever', async () => {
    const t = setup();
    await t.say('go to the red toolbox');
    await t.say('open the green toolbox');
    expect(t.results.at(-1)?.code).toBe('OUT_OF_REACH');
    await t.say('open the green toolbox');
    expect(t.results.at(-1)?.code).toBe('BLOCKED');
    const count = t.results.length;
    const question = await t.say('open the green toolbox');
    const repeated = await t.say('open the green toolbox');
    expect(question.steps).toEqual([]);
    expect(repeated.steps).toEqual([]);
    expect(t.results).toHaveLength(count);
    expect(question.reply).toMatch(/tried getting closer.*blocked/i);
    expect(question.reply).not.toBe(repeated.reply);
    await t.say('go to the toolboxes');
    await t.say('open the green toolbox');
    expect(t.results.at(-1)?.status).toBe('completed');
    expect(t.simulation.readState().toolboxes.green_toolbox.open).toBe(true);
    t.commands.dispose();
  });

  it.each(['stop showing your face', 'turn off selfie mode', "I don't want selfie mode"])('treats “%s” as a real camera change, rather than a stop or a body turn', async instruction => {
    const t = setup();
    const before = t.controller.getObservation().grandma;
    const plan = await t.say(instruction);
    expect(plan.interrupt).not.toBe(true);
    expect(plan.steps).toEqual([{ action: { type: 'switch_camera', mode: 'rear' } }]);
    expect(t.controller.getObservation().phone.mode).toBe('rear');
    expect(t.controller.getObservation().grandma.facingDegrees).toBe(before.facingDegrees);
    expect(t.controller.getObservation().grandma.position).toEqual(before.position);
    expect(t.replies.at(-1)).toMatch(/room/);
    t.commands.dispose();
  });

  it('keeps a camera-negation request accurate when followed by another clear instruction', async () => {
    const t = setup();
    const plan = await t.say('stop showing your face, then go to the toolboxes');
    expect(plan.interrupt).not.toBe(true);
    expect(t.controller.getObservation().phone.mode).toBe('rear');
    expect(t.results.every(result => result.status === 'completed')).toBe(true);
    t.commands.dispose();
  });

  it('completes a direction clarification using the previously requested pipe action', async () => {
    const t = setup();
    await t.say('go to the toolboxes, open the red toolbox, open the blue toolbox, open the green toolbox, pick up the wrench');
    await t.say('turn the pipe');
    expect(t.results.at(-1)?.code).toBe('CLARIFICATION_NEEDED');
    expect(t.replies.at(-1)).toMatch(/clockwise or counterclockwise/i);
    const correction = await t.say('counterclockwise');
    expect(correction.steps.at(-1)?.action).toMatchObject({ type: 'rotate', direction: 'counterclockwise' });
    expect(t.controller.getObservation().stage).toBe('won');
    expect(t.replies.at(-1)).toMatch(/water stopped/);
    t.commands.dispose();
  });

  it('does not discover hidden tools and reports the actual contents of opened boxes', async () => {
    const t = setup();
    const vague = await t.say('grab the tool');
    expect(vague.steps).toEqual([]);
    expect(vague.reply).toMatch(/don’t see a tool/);
    expect(vague.reply).not.toMatch(/wrench|hammer|screwdriver/);
    await t.say('go to the red toolbox');
    await t.say('open the red toolbox');
    expect(t.replies.at(-1)).toContain(t.results.at(-1)?.message);
    const actualTool = t.simulation.readState().toolboxes.red_toolbox.tool;
    expect(t.replies.at(-1)).toContain(actualTool);
    await t.say('grab the tool');
    expect(t.controller.getObservation().grandma.heldItems).toEqual([actualTool]);
    expect(t.replies.at(-1)).toContain(actualTool);
    t.commands.dispose();
  });

  it('varies repeated unknowns, asks scene-specific questions, and does not invent actions', async () => {
    const t = setup();
    await t.say('rear camera');
    const plans = [];
    for (let i = 0; i < 5; i++) plans.push(await t.say('make it all better somehow'));
    expect(plans.every(plan => plan.steps.length === 0)).toBe(true);
    expect(new Set(plans.map(plan => plan.reply)).size).toBe(5);
    expect(plans[1].reply).toMatch(/box.*red|box.*blue|box.*green/);
    expect(plans.map(plan => plan.reply).join(' ')).not.toMatch(/wrench|hammer|screwdriver|completed/);
    t.commands.dispose();
  });

  it('keeps useful failure information while varying reactions to actual repeated failures', async () => {
    const t = setup();
    await t.say('pick up the wrench');
    const first = t.replies.at(-1);
    await t.say('pick up the wrench');
    const second = t.replies.at(-1);
    expect(first).not.toBe(second);
    expect(first).toContain(t.results.at(-2)?.message);
    expect(second).toContain(t.results.at(-1)?.message);
    expect(t.controller.getObservation().grandma.heldItems).toEqual([]);
    t.commands.dispose();
  });

  it('stops on request, handles frustration kindly, and does not mistake stopping water for stopping actions', () => {
    const t = setup();
    const stop = t.grandma.plan('Stop, you are not listening', t.controller.getObservation());
    expect(stop.interrupt).toBe(true);
    expect(stop.steps).toEqual([]);
    const frustration = t.grandma.plan('Come on, listen to me', t.controller.getObservation());
    expect(frustration.steps).toEqual([]);
    expect(frustration.reply).toMatch(/sweetheart|dear/);
    expect(t.grandma.plan('stop the water', t.controller.getObservation()).interrupt).not.toBe(true);
    t.commands.dispose();
  });

  it('does not interrupt an active action when the caller says not to stop', async () => {
    const t = setup();
    const turn = t.commands.beginTurn();
    const waiting = t.commands.submit(turn.token, [{ action: { type: 'wait', seconds: 5 } }]);
    t.simulation.advance(1);
    expect(t.controller.getObservation().currentAction?.type).toBe('wait');
    const plan = await t.say("don't stop");
    expect(plan.interrupt).toBe(false);
    expect(plan.steps).toEqual([]);
    expect(t.controller.getObservation().currentAction?.type).toBe('wait');
    t.simulation.advance(4.1);
    expect((await waiting).status).toBe('completed');
    t.commands.dispose();
  });

  it('clears assumptions on explicit reset and a new simulation run', async () => {
    const t = setup();
    await t.say('go to the red toolbox');
    await t.say('open the toolbox');
    t.grandma.reset();
    expect(t.grandma.plan('the green one', t.controller.getObservation()).steps).toEqual([]);
    await t.say('open the blue toolbox');
    t.controller.reset();
    t.controller.start();
    expect(t.grandma.plan('the green one', t.controller.getObservation()).steps).toEqual([]);
    expect(t.grandma.plan('counterclockwise', t.controller.getObservation()).steps).toEqual([]);
    t.commands.dispose();
  });
});
