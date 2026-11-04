import type { CommandStep } from '../game/command-session';
import type { Action, ObjectId, Observation, Result } from '../game/types';
import { parseInstruction } from './text-commands';

export type OfflinePlan = { steps: CommandStep[]; reply?: string; interrupt?: boolean };
type Family = 'box' | 'tool';
type Failure = { action: Action; result: Result };
const BOXES: ObjectId[] = ['red_toolbox', 'blue_toolbox', 'green_toolbox'];
const TOOLS: ObjectId[] = ['wrench', 'screwdriver', 'hammer'];
const label = (id: ObjectId) => ({ pipe_joint: 'pipe', dry_spot: 'shelf', puddle: 'water' }[id as 'pipe_joint' | 'dry_spot' | 'puddle'] ?? id.replaceAll('_', ' '));
const words = (text: string) => text.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const targetOf = (action: Action) => 'target' in action ? action.target.id : undefined;
const sameAction = (a: Action, b: Action) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A deliberately scripted, offline character. Plans are only intentions; dialogue about
 * completed work is produced from real controller results in react(). No hidden state is read.
 */
export class OfflineGrandma {
  private runId?: string;
  private intended?: Action;
  private lastAction?: Action;
  private failure?: Failure;
  private cameraTurnMeansLens = false;
  private recovery?: { intended: Action; prerequisites: Action[] };
  private impediment?: { intended: Action; result: Result };
  private lastChoice?: { family: Family; action: 'open' | 'grab' | 'move_to'; id: ObjectId };
  private tried = new Map<string, Set<ObjectId>>();
  private variants = new Map<string, number>();
  private unknowns = 0;

  reset() {
    this.runId = undefined;
    this.intended = undefined;
    this.lastAction = undefined;
    this.failure = undefined;
    this.cameraTurnMeansLens = false;
    this.recovery = undefined;
    this.impediment = undefined;
    this.lastChoice = undefined;
    this.tried.clear();
    this.variants.clear();
    this.unknowns = 0;
  }

  private scope(observation: Observation) {
    if (this.runId !== observation.runId) { this.reset(); this.runId = observation.runId; }
  }

  private vary(key: string, lines: string[]) {
    const n = this.variants.get(key) ?? 0;
    this.variants.set(key, n + 1);
    if (this.variants.size > 40) this.variants.delete(this.variants.keys().next().value!);
    return lines[n % lines.length];
  }

  private remember(steps: CommandStep[], reply?: string): OfflinePlan {
    this.intended = structuredClone(steps.at(-1)?.action);
    const action = this.intended;
    const id = action && targetOf(action);
    this.lastChoice = id && BOXES.includes(id) && (action?.type === 'open' || action?.type === 'move_to') ? { family: 'box', action: action.type, id }
      : id && TOOLS.includes(id) && action?.type === 'grab' ? { family: 'tool', action: 'grab', id } : undefined;
    this.unknowns = 0;
    return { steps, ...(reply ? { reply } : {}) };
  }

  private visible(observation: Observation, family: Family) {
    const ids = family === 'box' ? BOXES : TOOLS;
    return observation.surroundings.filter(o => o.visible && ids.includes(o.id))
      .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  }

  private attempts(family: Family, action: 'open' | 'grab' | 'move_to') {
    const key = `${family}:${action}`;
    let tried = this.tried.get(key);
    if (!tried) { tried = new Set(); this.tried.set(key, tried); }
    return tried;
  }

  private choose(family: Family, action: 'open' | 'grab' | 'move_to', observation: Observation): ObjectId | undefined {
    const choices = this.visible(observation, family);
    const candidate = choices.find(o => !this.attempts(family, action).has(o.id) && (action !== 'open' || !/\(open\)/i.test(o.name)));
    if (!candidate) return undefined;
    this.lastChoice = { family, action, id: candidate.id };
    return candidate.id;
  }

  private recover(steps: CommandStep[], observation: Observation): { steps: CommandStep[]; reply?: string } {
    const action = steps.at(-1)?.action;
    const failed = this.failure;
    if (action && this.impediment && sameAction(action, this.impediment.intended)) {
      const detail = this.impediment.result.code === 'BLOCKED' ? 'I tried getting closer, but the path is blocked.' : `Getting closer didn’t work. ${this.impediment.result.message}`;
      return { steps: [], reply: this.vary('recovery-blocked', [`${detail} Which way should I step?`, `Same obstacle, sweetheart. Give me a short step around it first.`, `${detail} I need another way over there.`]) };
    }
    if (!action || !failed || !sameAction(action, failed.action)) return { steps };
    if (failed.result.code === 'BLOCKED') return { steps: [], reply: this.vary('blocked', ['I already tried that path. Which way should I step around it?', 'Still blocked, sweetheart. Give me a shorter step or another direction.']) };
    const prefix: CommandStep[] = [];
    if (failed.result.code === 'OUT_OF_REACH') {
      const id = failed.result.targetId ?? targetOf(action) ?? (action.type === 'switch_camera' || action.type === 'retrieve_phone' ? 'dry_spot' : undefined);
      if (!id) return { steps };
      if (observation.grandma.posture === 'bent') prefix.push({ action: { type: 'stand' } });
      prefix.push({ action: { type: 'move_to', target: { id } } });
      this.recovery = { intended: structuredClone(action), prerequisites: prefix.map(step => structuredClone(step.action)) };
      return { steps: [...prefix, { action }], reply: 'All right, let me get closer first. These arms only go so far.' };
    }
    if (failed.result.code === 'WRONG_POSTURE') {
      if (/bend/i.test(failed.result.message)) prefix.push({ action: { type: 'bend' } });
      else if (/stand/i.test(failed.result.message)) prefix.push({ action: { type: 'stand' } });
      if (prefix.length) {
        this.recovery = { intended: structuredClone(action), prerequisites: prefix.map(step => structuredClone(step.action)) };
        return { steps: [...prefix, { action }], reply: /bend/i.test(failed.result.message) ? 'Let me bend down first. Easy on the knees, sweetheart.' : 'Let me stand up first. Then I can do that.' };
      }
    }
    return { steps };
  }

  private question(observation: Observation) {
    const boxes = this.visible(observation, 'box').filter(o => !/\(open\)/i.test(o.name));
    const tools = this.visible(observation, 'tool');
    if (this.failure?.result.code === 'HANDS_FULL') return 'My hands are full. Should I put something on the shelf?';
    if (this.failure?.result.code === 'WRONG_POSTURE') return /bend/i.test(this.failure.result.message) ? 'Should I bend down first, sweetheart?' : 'Should I stand up first, sweetheart?';
    if (this.failure?.result.code === 'OUT_OF_REACH') return 'Should I move closer to that first?';
    if (observation.phone.mode === 'selfie') return 'Do you mean the camera, or should I turn myself?';
    if (tools.length) return `Which tool do you mean — ${tools.slice(0, 3).map(o => label(o.id)).join(', ')}?`;
    if (boxes.length) return `Which box, sweetheart — ${boxes.map(o => o.color).join(', ')}?`;
    return 'Should I move the phone, or move myself?';
  }

  private clarify(observation: Observation): OfflinePlan {
    this.unknowns++;
    const question = this.question(observation);
    const reply = this.unknowns === 1 ? 'Sweetheart, what exactly do you want me to do?' : this.unknowns === 2 ? question
      : this.vary('unknown', [`I’m getting flustered. ${question}`, `One thing at a time, dear. ${question}`, `I’m listening, sweetheart. ${question}`]);
    return { steps: [], reply };
  }

  plan(text: string, observation: Observation): OfflinePlan {
    this.scope(observation);
    const clean = words(text);
    const parsed = parseInstruction(text, { cameraMode: observation.phone.mode });
    const cameraRequest = parsed.ok && parsed.steps.some(step => step.action.type === 'switch_camera');
    if (!cameraRequest && /\b(dont|do not|never) (?:you )?(stop|cancel|hang up)\b/.test(clean)) return { steps: [], interrupt: false, reply: 'All right, sweetheart. I’m listening.' };
    if (!cameraRequest && ((!/\bstop (?:the )?(?:leak|water|flood|pipe)\b/.test(clean) && /\b(stop|cancel|never mind|hold on|hang up)\b/.test(clean)) || /^wait(?: please)?$/.test(clean))) {
      this.failure = undefined;
      this.intended = undefined;
      return { steps: [], interrupt: true, reply: this.vary('stop', ['All right. I’m stopping, sweetheart.', 'Okay, okay. I’ll stop and listen.', 'Stopping. Tell me one thing at a time.']) };
    }
    let steps: CommandStep[] | undefined;
    let reply: string | undefined;
    const previous = this.intended ?? this.lastAction;

    // A correction distinguishes the camera from Grandma's body, without repeating the turn.
    if (/\bcamera\b/.test(clean) && /\b(not you|not yourself|not your body|i meant the camera|camera not)\b/.test(clean) && (previous?.type === 'turn' || this.lastAction?.type === 'turn')) {
      // "No" rejects the prior body turn here; "not you" does not negate a later named lens.
      const request = clean.replace(/^(?:no|nope)\s+/, '').replace(/\bnot (?:your body|yourself|you)\b/g, '');
      const correction = parseInstruction(request, { cameraMode: observation.phone.mode });
      const explicit = correction.ok ? correction.steps.map(step => step.action).filter((action): action is Extract<Action, { type: 'switch_camera' }> => action.type === 'switch_camera').at(-1)?.mode : undefined;
      steps = [{ action: { type: 'switch_camera', mode: explicit ?? (observation.phone.mode === 'selfie' ? 'rear' : 'selfie') } }];
      this.cameraTurnMeansLens = true;
      reply = 'The camera, not me. All right, dear.';
    }
    if (!steps && this.cameraTurnMeansLens && /^(?:please )?(?:turn|spin) around(?: again)?(?: please)?$/.test(clean)) {
      steps = [{ action: { type: 'switch_camera', mode: observation.phone.mode === 'selfie' ? 'rear' : 'selfie' } }];
      reply = 'The phone this time. I’m catching on, sweetheart.';
    }
    const color = clean.match(/^(?:no |nope |sorry |i meant |the )*(red|blue|green)(?: one| box| toolbox)?(?: please)?$/)?.[1];
    if (!steps && color && previous && (previous.type === 'open' || previous.type === 'move_to') && (targetOf(previous)?.endsWith('_toolbox') || ('target' in previous && previous.target.candidates?.some(id => BOXES.includes(id))))) {
      const id = `${color}_toolbox` as ObjectId;
      steps = [{ action: { type: previous.type, target: { id } } }];
      reply = `The ${color} one. You could’ve led with that, sweetheart.`;
    }
    const directionOnly = /^(?:no |nope |the |i meant )*(counter ?clockwise|anticlockwise|clockwise|left|right|other way)(?: please)?$/.exec(clean)?.[1];
    if (!steps && directionOnly && previous?.type === 'rotate') {
      const direction = /counter|anti|left/.test(directionOnly) ? 'counterclockwise' : /clockwise|right/.test(directionOnly) ? 'clockwise'
        : previous.direction ? previous.direction === 'clockwise' ? 'counterclockwise' : 'clockwise' : undefined;
      if (direction) { steps = [{ action: { ...previous, direction } }]; reply = 'That direction. All right, let me try.'; }
    }
    const namedTool = clean.match(/^(?:no |nope |i meant |the )*(wrench|spanner|screwdriver|hammer)(?: one)?(?: please)?$/)?.[1];
    if (!steps && namedTool && previous?.type === 'grab') {
      steps = [{ action: { type: 'grab', target: { id: namedTool === 'spanner' ? 'wrench' : namedTool as ObjectId } } }];
      reply = `The ${namedTool}. All right, sweetheart.`;
    }
    if (!steps && /^(?:try again|again|do it|do that|just do it|please try again)$/.test(clean) && previous) steps = [{ action: structuredClone(previous) }];

    const other = /^(?:no |nope )?(?:not that one|the other one|wrong one|another one|try another one)$/.test(clean);
    const vagueTool = /\b(pick up|grab|take|get|fetch|hold) (?:the |that |a )?tool\b/.test(clean) && !/\b(wrench|spanner|screwdriver|hammer)\b/.test(clean);
    if (!steps && ((other && this.lastChoice) || vagueTool)) {
      const family = vagueTool ? 'tool' : this.lastChoice!.family;
      const action = vagueTool ? 'grab' : this.lastChoice!.action;
      if (other && this.lastChoice) this.attempts(family, action).add(this.lastChoice.id);
      const id = this.choose(family, action, observation);
      if (!id) return { steps: [], reply: family === 'tool' && !this.visible(observation, 'tool').length ? 'I don’t see a tool yet. Which toolbox should I open?' : 'I’ve tried the ones I can see. Tell me which one you mean.' };
      steps = [{ action: { type: action, target: { id } } }];
      reply = `You mean the ${label(id)}? Let me try that.`;
    }

    if (!steps) {
      if (parsed.ok) steps = parsed.steps;
      else if (/\b(come on|frustrat|stupid|listen to me|not listening|for gods sake|annoying)\b/.test(clean)) return { steps: [], reply: this.vary('frustration', ['I’m trying, sweetheart. One clear thing at a time.', 'I’m flustered too. Tell me exactly which thing you mean.', 'Easy, dear. We’ll manage. What should I do next?']) };
      else return this.clarify(observation);
    }

    // Vague targets become plausible, visible choices. The real game still checks every action.
    let exhausted = false;
    steps = steps.map(step => {
      const action = step.action;
      if ((action.type !== 'open' && action.type !== 'move_to') || /\b(red|blue|green)\b/.test(clean) || !/\b(tool ?box(?:es)?|boxes|box)\b/.test(clean)) return step;
      // The plural means the shared table, whose existing parser anchor is the middle box.
      if (action.type === 'move_to' && /\b(tool ?boxes|boxes|table)\b/.test(clean)) return step;
      if (this.failure && sameAction(action, this.failure.action)) return step;
      if (this.failure?.action.type === action.type && ['OUT_OF_REACH', 'WRONG_POSTURE'].includes(this.failure.result.code) && targetOf(this.failure.action)?.endsWith('_toolbox')) return { action: structuredClone(this.failure.action) };
      const id = this.choose('box', action.type, observation);
      if (!id) { exhausted = true; return step; }
      reply ??= `You mean the ${label(id)}? Let me try that.`;
      return { ...step, action: { ...action, target: { id } } };
    });
    if (exhausted) return { steps: [], reply: 'I’ve tried the boxes I can see. Name a color, sweetheart.' };
    const final = steps.at(-1)?.action;
    if (final && this.failure && targetOf(final) === undefined && 'target' in final && final.target.candidates && this.intended && this.failure.action.type === final.type && !/\b(red|blue|green)\b/.test(clean)) {
      steps = steps.map((step, i) => i === steps!.length - 1 ? { action: structuredClone(this.failure!.action) } : step);
    }
    if (this.recovery && final && !sameAction(final, this.recovery.intended)) this.recovery = undefined;
    const recovered = this.recover(steps, observation);
    return recovered.steps.length ? this.remember(recovered.steps, recovered.reply ?? reply) : { steps: [], reply: recovered.reply ?? reply };
  }

  react(action: Action, result: Result, observation: Observation): string {
    this.scope(observation);
    if (result.runId !== observation.runId) return 'Let’s stay with this call, sweetheart.';
    this.lastAction = structuredClone(action);
    if (this.recovery?.prerequisites.some(prerequisite => sameAction(prerequisite, action)) && result.status !== 'completed' && result.status !== 'cancelled') {
      this.impediment = { intended: structuredClone(this.recovery.intended), result: structuredClone(result) };
      this.recovery = undefined;
    }
    if (this.recovery && sameAction(this.recovery.intended, action)) this.recovery = undefined;
    if (result.status === 'completed' && ['move', 'move_to', 'bend', 'stand'].includes(action.type)) this.impediment = undefined;
    this.failure = result.status === 'failed' || result.status === 'clarification_needed' ? { action: structuredClone(action), result: structuredClone(result) } : undefined;
    const id = result.targetId ?? targetOf(action);
    if (id && (result.status === 'completed' || result.code === 'ALREADY_DONE')) {
      if (BOXES.includes(id) && (action.type === 'open' || action.type === 'move_to')) this.attempts('box', action.type).add(id);
      if (TOOLS.includes(id) && action.type === 'grab') this.attempts('tool', 'grab').add(id);
    }
    if (result.code === 'CANCELLED') return this.vary('cancelled', ['All right, I’ve stopped.', 'Stopped. I’m listening, dear.']);
    if (result.code === 'LEAK_WORSENED') return this.vary('worse', ['Oh! More water! That made it worse — turn it counterclockwise!', 'It’s coming faster, sweetheart! Counterclockwise, the other way!']);
    if (result.status !== 'completed') {
      const key = `${result.code}:${action.type}`;
      if (result.code === 'CLARIFICATION_NEEDED' && action.type === 'rotate' && !action.direction) return this.vary(key, ['Clockwise or counterclockwise, sweetheart?', 'Which way, dear? Clockwise or counterclockwise?', 'I need a direction. Which way should I turn it?']);
      if (result.code === 'OUT_OF_REACH') return this.vary(key, [`I can’t reach that. ${result.message}`, `My arms aren’t that long, dear. ${result.message}`, `I’m trying! ${result.message}`]);
      if (result.code === 'WRONG_POSTURE') return this.vary(key, [`Oof, not like this. ${result.message}`, `These knees, sweetheart. ${result.message}`, `One thing first, dear. ${result.message}`]);
      if (result.code === 'HANDS_FULL') return this.vary(key, [`Both hands are busy, dear. ${result.message}`, `I’m not an octopus, sweetheart. ${result.message}`]);
      if (result.code === 'MISSING_TOOL' || result.code === 'NOT_FOUND') return this.vary(key, [`Wait, sweetheart. ${result.message}`, `I’m looking, dear. ${result.message}`, `That’s the trouble. ${result.message}`]);
      if (result.code === 'BLOCKED') return `Something’s in my way. ${result.message}`;
      return this.vary(key, [result.message, `Hold on, sweetheart. ${result.message}`, `One problem, dear. ${result.message}`]);
    }
    const key = `done:${action.type}`;
    switch (action.type) {
      case 'switch_camera': return observation.phone.mode === 'rear' ? this.vary(key, ['There. You’re seeing the room now.', 'Room camera’s on. Can you see the mess?']) : this.vary(key, ['There’s my face. Can you see me, sweetheart?', 'Back to my face. Still me, dear.']);
      case 'open': return `${result.message} ${this.vary(key, ['Is that the one you wanted, sweetheart?', 'One lid at a time, dear.', 'Now what, sweetheart? The water’s still busy.'])}`;
      case 'grab': return this.vary(key, [`Got the ${id ? label(id) : 'thing you asked for'}. Now what, sweetheart?`, `The ${id ? label(id) : 'thing you asked for'} is in my hand. This one?`, `I’ve got the ${id ? label(id) : 'thing you asked for'}. Don’t rush me, dear.`]);
      case 'move_to': return this.vary(key, [`I’m by the ${id ? label(id) : 'thing you named'}. What now?`, `All right, I’ve moved closer to the ${id ? label(id) : 'thing you named'}.`, `Here I am, by the ${id ? label(id) : 'thing you named'}. Still with me?`]);
      case 'move': return this.vary(key, ['I’ve moved. Now where, sweetheart?', 'All right, a few steps. What next?', 'I’m over a little. Is that better?']);
      case 'turn': return this.vary(key, [`I turned myself ${action.direction}. Is that what you meant?`, `I’ve turned ${action.direction}. Me, not the camera, dear.`]);
      case 'look': return this.vary(key, [`I’m looking ${action.direction}. What am I looking for?`, `There, I’ve aimed ${action.direction}. Can you see it?`]);
      case 'bend': return this.vary(key, ['Oof. I’m bent down. My knees want a thank-you.', 'I’m down here, sweetheart. These knees are complaining.']);
      case 'stand': return this.vary(key, ['All right, I’m standing. My knees filed a complaint.', 'Back on my feet, dear. What next?']);
      case 'rotate': return observation.leak === 'stopped' ? 'It stopped! Oh, sweetheart, the water stopped!' : result.message;
      case 'place': return /soaking|catching/i.test(result.message) ? result.message : `I put the ${action.item} down. What next, dear?`;
      case 'place_phone': return 'Phone’s on the shelf. Can you still see, sweetheart?';
      case 'retrieve_phone': return 'Phone’s back in my hand. Still with me, dear?';
      case 'wait': return this.vary(key, ['I waited. The water isn’t waiting with me.', 'Still here, sweetheart. What now?']);
    }
  }
}
