import type { Action, Direction, ItemId, ObjectId } from '../game/types';
import type { CommandStep } from '../game/command-session';

/**
 * PLACEHOLDER for Yao's voice agent.
 *
 * Turns a typed line such as "grab the wrench, go to the pipe, bend down, tighten the pipe"
 * into the same structured steps the voice adapter will produce. It is a small keyword matcher,
 * not a language model, so it only understands the phrasings listed in `EXAMPLES`.
 * The game itself never parses language; this module exists so the loop is playable before
 * speech, interpretation and Fish Audio are connected.
 */
export type ParseOutcome = { ok: true; steps: CommandStep[] } | { ok: false; phrase: string; hint: string };

export const EXAMPLES = [
  'switch to the rear camera',
  'go to the toolboxes',
  'open the red toolbox',
  'pick up the wrench',
  'walk to the pipe',
  'bend down',
  'tighten the pipe',
  'put the phone on the shelf',
  'put the towels on the puddle',
  'look left',
  'walk forward 1 meter',
  'wait 5 seconds',
];

const OBJECT_WORDS: [RegExp, ObjectId][] = [
  [/\bred (tool ?box|box)\b/, 'red_toolbox'],
  [/\bblue (tool ?box|box)\b/, 'blue_toolbox'],
  [/\bgreen (tool ?box|box)\b/, 'green_toolbox'],
  [/\b(tool ?box(es)?|boxes|table)\b/, 'blue_toolbox'],
  [/\b(pipe joint|joint|pipe|leak|valve)\b/, 'pipe_joint'],
  [/\b(wrench|spanner)\b/, 'wrench'],
  [/\bscrewdriver\b/, 'screwdriver'],
  [/\bhammer\b/, 'hammer'],
  [/\btowels?\b/, 'towels'],
  [/\bbucket\b/, 'bucket'],
  [/\b(shelf|dry spot|dry place|counter)\b/, 'dry_spot'],
  [/\b(puddle|water|floor|leak spot)\b/, 'puddle'],
];
const ITEMS: ItemId[] = ['wrench', 'screwdriver', 'hammer', 'towels', 'bucket'];

const findObject = (text: string, exclude?: ObjectId): ObjectId | undefined => {
  for (const [pattern, id] of OBJECT_WORDS) if (id !== exclude && pattern.test(text)) return id;
  return undefined;
};
const number = (text: string, fallback: number) => { const m = text.match(/(\d+(?:\.\d+)?)/); return m ? Number(m[1]) : fallback; };
const direction = (text: string): Direction | undefined =>
  /\b(forward|forwards|ahead|straight)\b/.test(text) ? 'forward' : /\b(back|backward|backwards)\b/.test(text) ? 'backward' : /\bleft\b/.test(text) ? 'left' : /\bright\b/.test(text) ? 'right' : undefined;
const target = (id: ObjectId) => ({ id });

/** Parses one clause. Returns undefined when nothing matched. */
function parseClause(raw: string): Action | undefined {
  const text = raw.toLowerCase().replace(/[^a-z0-9. ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  const object = findObject(text);

  if (/\b(rear|back) camera\b/.test(text) || /\bflip\b.*\b(room|around)\b/.test(text) || /\bshow me the (room|bathroom|pipe|leak)\b/.test(text)) return { type: 'switch_camera', mode: 'rear' };
  if (/\b(front|selfie) camera\b|\bselfie\b|\bshow me (your face|yourself)\b/.test(text)) return { type: 'switch_camera', mode: 'selfie' };

  if (/\bphone\b/.test(text)) {
    if (/\b(pick|grab|take|get|retrieve)\b/.test(text)) return { type: 'retrieve_phone' };
    if (/\b(put|place|set|leave|rest)\b/.test(text)) return { type: 'place_phone', target: target('dry_spot') };
  }

  if (/\b(bend|crouch|kneel|squat|get down|lean down)\b/.test(text)) return { type: 'bend' };
  if (/\b(stand|straighten|get up)\b/.test(text)) return { type: 'stand' };

  if (/\bwait\b|\bhold on\b|\bstay there\b/.test(text)) return { type: 'wait', seconds: number(text, 3) };

  if (/\b(open|unlatch|check|look in|look inside|search)\b/.test(text) && object && object.endsWith('_toolbox')) {
    // "the toolbox" without a color: let the game ask which one (or mishear under stress).
    if (!/\b(red|blue|green)\b/.test(text)) return { type: 'open', target: { candidates: ['red_toolbox', 'blue_toolbox', 'green_toolbox'] } };
    return { type: 'open', target: target(object) };
  }

  if (/\b(turn|rotate|twist|tighten|loosen|close|shut|crank|fix)\b/.test(text) && object === 'pipe_joint') {
    // The red pipe seals counterclockwise. Honor an explicit direction before an intended repair.
    const dir = /\b(counter ?clockwise|anticlockwise|anti clockwise|the other way)\b/.test(text) ? 'counterclockwise'
      : /\b(clockwise|righty)\b/.test(text) ? 'clockwise'
      : /\b(tighten|close|shut|loosen|open)\b/.test(text) ? 'counterclockwise' : undefined;
    return { type: 'rotate', target: target(object), direction: dir };
  }
  if (/\b(turn|rotate|twist)\b/.test(text) && /\b(it|that)\b/.test(text) && !object) {
    const dir = /\b(counter ?clockwise|anticlockwise|the other way)\b/.test(text) ? 'counterclockwise' : /\bclockwise\b/.test(text) ? 'clockwise' : undefined;
    return { type: 'rotate', target: target('pipe_joint'), direction: dir };
  }

  if (/\b(put|place|set|drop|lay)\b/.test(text) && object) {
    const item = ITEMS.find(id => id === object);
    const spot = findObject(text, item);
    if (item && spot && (spot === 'dry_spot' || spot === 'puddle')) return { type: 'place', item, target: target(spot) };
  }

  if (/\b(pick up|grab|take|get|fetch|hold)\b/.test(text) && object) return { type: 'grab', target: target(object) };

  if (/\b(go|walk|head|move|step|come|get)\b/.test(text)) {
    const dir = direction(text);
    if (object && !/\b(forward|backward|left|right)\b.*\bmeter/.test(text)) return { type: 'move_to', target: target(object) };
    if (dir) return { type: 'move', direction: dir, meters: Math.min(5, Math.max(0.1, number(text, 1))) };
  }

  if (/\b(look|point|aim|show)\b/.test(text)) {
    if (/\b(up|ceiling)\b/.test(text)) return { type: 'look', direction: 'up' };
    if (/\b(down|floor|feet)\b/.test(text)) return { type: 'look', direction: 'down' };
    const dir = direction(text);
    if (dir) return { type: 'look', direction: dir, degrees: /\d/.test(text) ? number(text, 35) : undefined };
  }
  if (/\b(turn|face|spin)\b/.test(text)) {
    if (/\baround\b/.test(text)) return { type: 'turn', direction: 'left', degrees: 180 };
    const dir = direction(text);
    if (dir === 'left' || dir === 'right') return { type: 'turn', direction: dir, degrees: /\d/.test(text) ? number(text, 90) : undefined };
  }
  return undefined;
}

/** Splits a typed line into clauses on commas, "then", "and", semicolons and periods. */
export function parseInstruction(line: string): ParseOutcome {
  const clauses = line.split(/\s*(?:,|;|\.|\bthen\b|\band then\b|\bafter that\b|\band\b)\s*/i).map(c => c.trim()).filter(Boolean);
  if (!clauses.length) return { ok: false, phrase: line, hint: 'Type an instruction for Grandma, or "help" for examples.' };
  const steps: CommandStep[] = [];
  for (const clause of clauses) {
    const action = parseClause(clause);
    if (!action) return { ok: false, phrase: clause, hint: `I don’t know how to do “${clause}”. Try something like “${EXAMPLES[Math.floor(Math.random() * EXAMPLES.length)]}”.` };
    // Turning the pipe implies walking over and bending down; the game still checks every prerequisite.
    if (action.type === 'rotate' && !steps.some(s => s.action.type === 'move_to' || s.action.type === 'bend')) steps.push({ action: { type: 'move_to', target: action.target } }, { action: { type: 'bend' } });
    steps.push({ action });
  }
  return { ok: true, steps };
}
