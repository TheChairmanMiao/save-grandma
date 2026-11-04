import { tool } from '@openai/agents/realtime';
import { z } from 'zod';
import { gameController as game, type Action, type GameEvent, type ItemId, type Observation, type Result, type Target } from '../game';

const RESULT_TIMEOUT_MS = 30_000;

/** What Grandma knows right now, in plain words. No IDs, so the model can't sidestep ambiguity. */
export function describe(o: Observation) {
  return {
    sees: o.surroundings.map(s => `${s.name} (${s.color}, ${s.distance} m${s.reachable ? ', within reach' : ''})`),
    holding: o.grandma.heldItems.length ? o.grandma.heldItems : 'nothing but the phone',
    posture: o.grandma.posture,
    phone: o.phone.placement === 'hand' ? `in her hand, ${o.phone.mode === 'selfie' ? 'front' : 'back'} camera on` : `on the dry shelf, ${o.phone.mode === 'selfie' ? 'front' : 'back'} camera on`,
    water: o.waterBand, leak: o.leak, stress: o.stressBand,
  };
}

// The game only understands its own alias vocabulary, so pass the caller's noun through as-is.
const target = (thing: string, color?: string | null): Target => ({
  description: thing.trim().toLowerCase().replace(/^(the|a|an|that|this|those|these)\s+/, ''),
  ...(color ? { qualifiers: { color: color.toLowerCase() } } : {}),
});

/** Run actions in order; stop at the first that does not complete and report that result. */
async function runSequence(actions: Action[]): Promise<string> {
  let last = '';
  for (const action of actions) {
    last = await runAction(action);
    const { status } = JSON.parse(last) as { status: string };
    if (status !== 'completed') return last;
  }
  return last;
}

/** Submit one action and resolve once the game reports its result. */
function runAction(action: Action): Promise<string> {
  const before = game.getObservation();
  if (before.stage !== 'running') return Promise.resolve(JSON.stringify({ status: 'not_running', note: `The call is ${before.stage}.` }));
  const runId = before.runId;
  return new Promise(resolve => {
    let actionId: string | undefined;
    let misheard: string | undefined;
    const results = new Map<string, Result>();
    const finish = (payload: object) => { unsubscribe(); clearTimeout(timer); resolve(JSON.stringify({ ...payload, now: describe(game.getObservation()) })); };
    const check = () => {
      const result = actionId && results.get(actionId);
      if (!result) return;
      finish({ status: result.status, code: result.code, detail: result.message, ...(misheard ? { misheard } : {}) });
    };
    // Subscribe before submitting: the game emits events synchronously.
    const unsubscribe = game.subscribe((event: GameEvent) => {
      if (event.runId !== runId) return;
      if (event.type === 'action_result') { results.set(event.result.actionId, event.result); check(); }
      if (event.type === 'misunderstanding' && (!actionId || event.actionId === actionId)) misheard = `Grandma got flustered and went for the ${event.selectedTarget.replace('_', ' ')} instead.`;
    });
    const timer = setTimeout(() => finish({ status: 'still_going', detail: 'Grandma is still busy with this.' }), RESULT_TIMEOUT_MS);
    const accepted = game.submitAction({ runId, action });
    if (!accepted.accepted) { finish({ status: 'rejected', code: accepted.code, detail: accepted.message }); return; }
    actionId = accepted.actionId;
    check();
  });
}

const thing = z.string().describe('The object exactly as the caller named it, as a short noun, e.g. "pipe", "toolbox", "box", "tool", "wrench", "hammer", "screwdriver", "towels", "bucket", "shelf", "water". Do not substitute a more specific object than the caller said.');
const color = z.string().nullable().describe('A color the caller mentioned for the object, or null.');
const item = z.enum(['wrench', 'screwdriver', 'hammer', 'towels', 'bucket']);

export const grandmaTools = [
  tool({
    name: 'look_around', description: 'Check what Grandma can currently see, hold, and how bad the water is. Free and instant.',
    parameters: z.object({}),
    execute: async () => JSON.stringify(describe(game.getObservation())),
  }),
  tool({
    name: 'walk_to', description: 'Walk over to an object the caller names.',
    parameters: z.object({ thing, color }),
    execute: async ({ thing, color }) => runAction({ type: 'move_to', target: target(thing, color) }),
  }),
  tool({
    name: 'step', description: 'Take steps in a direction relative to Grandma\'s body.',
    parameters: z.object({ direction: z.enum(['forward', 'backward', 'left', 'right']), meters: z.number().min(0.1).max(5).describe('Roughly one step is 0.5 m.') }),
    execute: async ({ direction, meters }) => runAction({ type: 'move', direction, meters }),
  }),
  tool({
    name: 'turn_body', description: 'Turn Grandma\'s whole body left or right. Requests about the camera, selfie mode, or showing the room use switch_camera instead.',
    parameters: z.object({ direction: z.enum(['left', 'right']), degrees: z.number().min(1).max(180).nullable().describe('null for a quarter turn.') }),
    execute: async ({ direction, degrees }) => runAction({ type: 'turn', direction, ...(degrees ? { degrees } : {}) }),
  }),
  tool({
    name: 'turn_around', description: 'Turn Grandma’s whole body around by a half-turn. Use when the caller says turn around or turn yourself around without naming a camera. Left versus right does not matter for a half-turn; this tool chooses left, so do not ask the caller for a direction.',
    parameters: z.object({}),
    execute: async () => runAction({ type: 'turn', direction: 'left', degrees: 180 }),
  }),
  tool({
    name: 'look', description: 'Point Grandma\'s head (and the handheld phone) in a direction.',
    parameters: z.object({ direction: z.enum(['forward', 'backward', 'left', 'right', 'up', 'down']) }),
    execute: async ({ direction }) => runAction({ type: 'look', direction }),
  }),
  tool({ name: 'bend_down', description: 'Bend down to reach low things.', parameters: z.object({}), execute: async () => runAction({ type: 'bend' }) }),
  tool({ name: 'stand_up', description: 'Stand back up straight.', parameters: z.object({}), execute: async () => runAction({ type: 'stand' }) }),
  tool({
    name: 'pick_up', description: 'Pick up an object the caller names.',
    parameters: z.object({ thing, color }),
    execute: async ({ thing, color }) => runAction({ type: 'grab', target: target(thing, color) }),
  }),
  tool({
    name: 'put_down', description: 'Put a held item on the dry shelf, or onto the water on the floor.',
    parameters: z.object({ item, where: z.enum(['shelf', 'water']) }),
    execute: async ({ item, where }) => runAction({ type: 'place', item: item as ItemId, target: { id: where === 'shelf' ? 'dry_spot' : 'puddle' } }),
  }),
  tool({
    name: 'open_toolbox', description: 'Open a toolbox the caller names (there are red, blue and green ones on the table) to see which tool is inside.',
    parameters: z.object({ thing, color }),
    execute: async ({ thing, color }) => runAction({ type: 'open', target: target(thing, color) }),
  }),
  tool({
    name: 'twist', description: 'Turn the pipe or fitting the caller names, using the wrench. Only pass a direction the caller actually said.',
    parameters: z.object({ thing, color, direction: z.enum(['clockwise', 'counterclockwise']).nullable().describe('null if the caller did not say which way. For this red pipe, "tighten"/"close"/"seal" means counterclockwise. An explicit "clockwise"/"right"/"righty-tighty" means clockwise and takes precedence over a repair verb. "Counterclockwise"/"left"/"loosen"/"open" means counterclockwise.') }),
    execute: async ({ thing, color, direction }) => {
      // Turning the pipe implies getting to it: walk over and bend down first, then turn. The game still
      // checks reach, posture and the wrench at each step, and any failure is reported as-is.
      const pipe = target(thing, color);
      const now = game.getObservation();
      const inReach = now.surroundings.some(o => o.id === 'pipe_joint' && o.reachable);
      const bent = now.grandma.posture === 'bent';
      const steps: Action[] = [];
      if (!inReach) { if (bent) steps.push({ type: 'stand' }); steps.push({ type: 'move_to', target: pipe }, { type: 'bend' }); }
      else if (!bent) steps.push({ type: 'bend' });
      steps.push({ type: 'rotate', target: pipe, ...(direction ? { direction } : {}) });
      return runSequence(steps);
    },
  }),
  tool({ name: 'put_phone_on_shelf', description: 'Set the phone down on the dry shelf to free both hands.', parameters: z.object({}), execute: async () => runAction({ type: 'place_phone', target: { id: 'dry_spot' } }) }),
  tool({ name: 'pick_up_phone', description: 'Pick the phone back up from the shelf.', parameters: z.object({}), execute: async () => runAction({ type: 'retrieve_phone' }) }),
  tool({
    name: 'switch_camera', description: 'Switch the phone lens without turning Grandma. Front/selfie shows her face; back/rear shows the room. Turn off selfie mode or stop showing your face means back. Turn the camera around means the opposite of the current lens; inspect look_around if needed.',
    parameters: z.object({ camera: z.enum(['front', 'back']) }),
    execute: async ({ camera }) => runAction({ type: 'switch_camera', mode: camera === 'front' ? 'selfie' : 'rear' }),
  }),
  tool({
    name: 'flip_camera', description: 'Turn the phone camera around: flip to the opposite lens without turning Grandma’s body. Use for flip the camera, turn the camera around, or the other camera when no fixed front/back lens was requested. This always reads the current lens before choosing the opposite.',
    parameters: z.object({}),
    execute: async () => runAction({ type: 'switch_camera', mode: game.getObservation().phone.mode === 'selfie' ? 'rear' : 'selfie' }),
  }),
  tool({
    name: 'wait', description: 'Wait without doing anything. The water keeps rising.',
    parameters: z.object({ seconds: z.number().min(1).max(20) }),
    execute: async ({ seconds }) => runAction({ type: 'wait', seconds }),
  }),
  tool({
    name: 'stop', description: 'Stop whatever Grandma is doing right now, when the caller says stop or wait.',
    parameters: z.object({}),
    execute: async () => { game.cancelActions(); return JSON.stringify({ status: 'stopped', now: describe(game.getObservation()) }); },
  }),
];
