import { DEFAULT_CAMERA_ASPECT, lensYaw, lookAngles, smoothProgress, turnYaw } from './phone';
import { getPerception } from './perception';
import { isActionRequest } from './action-contract';
import { distance, ids, normalize, OBJECTS, radians, TOOLBOXES, TOOLS, TUNING } from './config';
import type { Acceptance, Action, ActionRequest, Band, GameController, GameEvent, ItemId, ObjectId, Observation, ReasonCode, Result, Stage, Target, ToolboxId, ToolId, Vec2 } from './types';

type Queued = { id: string; request: ActionRequest };
type Active = Queued & {
  target?: ObjectId; elapsed: number; duration: number; from: Vec2; to?: Vec2;
  fromYaw: number; toYaw: number; turnDuration: number; moveDuration?: number;
  fromPhoneYaw: number; toPhoneYaw: number; fromPhonePitch: number; toPhonePitch: number;
};
export type WorldState = {
  runId: string; seed: number; stage: Stage; elapsed: number; water: number; leakRate: number;
  grandma: { position: Vec2; yaw: number; posture: 'standing' | 'bent'; held: ItemId[] };
  phone: { mode: 'selfie' | 'rear'; placement: 'hand' | 'dry_spot'; yaw: number; pitch: number; fixedYaw: number; aspect: number };
  items: Record<ItemId, { position: Vec2; height: number; location: 'toolbox' | 'world' | 'held' | 'used' }>;
  /** Which tool each toolbox hides; shuffled per seed so the player has to look. */
  toolboxes: Record<ToolboxId, { open: boolean; tool: ToolId }>;
  towelRemaining: number; bucketRemaining: number; towelUsed: boolean; bucketUsed: boolean;
  active: Active | null; queue: Queued[];
};
type Failure = { code: ReasonCode; message: string; candidates?: ObjectId[] };
let runCounter = 0;
// A page reload must not accidentally reuse a run ID still held by a voice service.
const instanceId = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
const itemIds: ItemId[] = [...TOOLS, 'towels', 'bucket'];
const isToolbox = (id: ObjectId): id is ToolboxId => (TOOLBOXES as ObjectId[]).includes(id);
const clone = <T,>(value: T): T => structuredClone(value);
const failure = (code: ReasonCode, message: string): Failure => ({ code, message });
export class Simulation implements GameController {
  private state!: WorldState;
  private randomState = 1;
  private serial = 0;
  private remainder = 0;
  private listeners = new Set<(event: GameEvent) => void>();
  private events: GameEvent[] = [];
  private delivering = false;

  constructor(seed = 7) { this.initialize(seed); }

  private initialize(seed: number) {
    const cameraAspect = this.state?.phone.aspect ?? DEFAULT_CAMERA_ASPECT;
    this.randomState = seed >>> 0;
    this.remainder = 0;
    // Deal the three tools into the three toolboxes (seeded Fisher-Yates).
    const dealt = [...TOOLS];
    for (let i = dealt.length - 1; i > 0; i--) { const j = Math.floor(this.random() * (i + 1)); [dealt[i], dealt[j]] = [dealt[j], dealt[i]]; }
    const toolboxes = Object.fromEntries(TOOLBOXES.map((box, i) => [box, { open: false, tool: dealt[i] }])) as WorldState['toolboxes'];
    const boxOf = (tool: ToolId) => TOOLBOXES.find(box => toolboxes[box].tool === tool)!;
    this.state = {
      runId: `run-${instanceId}-${++runCounter}`, seed, stage: 'ready', elapsed: 0, water: 0, leakRate: TUNING.initialLeakPerSecond,
      grandma: { position: { x: 0, z: 0.9 }, yaw: 0, posture: 'standing', held: [] },
      // The incoming call opens on Grandma's face; changing to the room lens is part of play.
      phone: { mode: 'selfie', placement: 'hand', yaw: 0, pitch: 0, fixedYaw: 0, aspect: cameraAspect },
      items: Object.fromEntries(itemIds.map(id => {
        const tool = (TOOLS as ItemId[]).includes(id);
        const home = tool ? OBJECTS[boxOf(id as ToolId)].position : OBJECTS[id].position;
        return [id, { position: { ...home }, height: OBJECTS[id].height, location: tool ? 'toolbox' : 'world' }];
      })) as WorldState['items'],
      toolboxes, towelRemaining: 0, bucketRemaining: 0, towelUsed: false, bucketUsed: false, active: null, queue: [],
    };
  }

  private random() {
    this.randomState = (this.randomState + 0x6D2B79F5) >>> 0;
    let t = this.randomState;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }

  private emit(event: GameEvent) { this.events.push(event); }
  // Deliver only after a mutation completes. Listener-triggered actions are safe.
  private flush() {
    if (this.delivering) return;
    this.delivering = true;
    try {
      while (this.events.length) {
        const event = this.events.shift()!;
        for (const listener of [...this.listeners]) {
          try { listener(clone(event)); } catch (error) { console.error('Game subscriber failed', error); }
        }
      }
    } finally { this.delivering = false; }
  }
  private changed() { this.emit({ type: 'state_changed', runId: this.state.runId, observation: this.getObservation() }); }
  private band(): Band {
    const ratio = this.state.water / TUNING.floodThreshold;
    return ratio >= TUNING.stressHigh ? 'high' : ratio >= TUNING.stressMedium ? 'medium' : 'low';
  }
  private position(id: ObjectId) { return itemIds.includes(id as ItemId) ? this.state.items[id as ItemId].position : OBJECTS[id].position; }
  private height(id: ObjectId) { return itemIds.includes(id as ItemId) ? this.state.items[id as ItemId].height : OBJECTS[id].height; }
  private available(id: ObjectId) { return !itemIds.includes(id as ItemId) || this.state.items[id as ItemId].location === 'world'; }

  getObservation(): Observation {
    const s = this.state;
    const perception = getPerception(s);
    return clone({
      runId: s.runId, stage: s.stage, elapsedSeconds: s.elapsed,
      grandma: { position: s.grandma.position, facingDegrees: s.grandma.yaw, posture: s.grandma.posture, heldItems: s.grandma.held },
      phone: { mode: s.phone.mode, placement: s.phone.placement }, ...perception,
      waterBand: this.band(), stressBand: this.band(), leak: s.leakRate > 0 ? 'flowing' : 'stopped',
      currentAction: s.active ? { actionId: s.active.id, type: s.active.request.action.type, progress: s.active.elapsed / s.active.duration } : null,
      queuedActions: s.queue.length,
    });
  }

  /** Rendering/developer diagnostics only. Never send this to a conversational model. */
  readState(): WorldState { return clone(this.state); }
  subscribe(listener: (event: GameEvent) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  setCameraAspect(aspect: number) {
    if (!Number.isFinite(aspect) || aspect <= 0 || aspect > 10 || Math.abs(aspect - this.state.phone.aspect) < 1e-5) return;
    this.state.phone.aspect = aspect; this.changed(); this.flush();
  }
  start() { if (this.state.stage === 'ready') { this.state.stage = 'running'; this.changed(); this.flush(); } }
  pause() { if (this.state.stage === 'running') { this.state.stage = 'paused'; this.changed(); this.flush(); } }
  resume() { if (this.state.stage === 'paused') { this.state.stage = 'running'; this.changed(); this.flush(); } }
  reset(options?: { seed?: number }) {
    this.cancelInternal();
    this.initialize(Number.isFinite(options?.seed) ? options!.seed! : this.state.seed);
    this.changed(); this.flush();
  }

  submitAction(request: ActionRequest): Acceptance {
    const actionId = `${this.state.runId}:action-${++this.serial}`;
    let error: Failure | undefined;
    if (!isActionRequest(request)) error = failure('INVALID_REQUEST', 'Use one supported structured action with valid fields; broad goals need a specific next action.');
    else if (request.runId !== this.state.runId) error = failure('STALE_RUN', 'This request belongs to an earlier run. Read the current observation before submitting.');
    else if (this.state.stage !== 'running') error = failure('NOT_RUNNING', 'Start or resume the current session before sending actions.');
    else if (this.state.queue.length >= TUNING.queueLimit) error = failure('QUEUE_FULL', 'Wait for queued actions to complete or cancel them.');
    if (!error) {
      this.state.queue.push({ id: actionId, request: clone(request) });
      this.emit({ type: 'action_queued', runId: this.state.runId, actionId, action: clone(request.action) });
      this.changed();
    }
    const result = { accepted: !error, actionId, runId: this.state.runId, code: error?.code ?? 'OK', message: error?.message ?? 'Queued; prerequisites will be checked when the action starts.' };
    this.flush();
    return result;
  }

  private result(q: Queued, code: ReasonCode, message: string, targetId?: ObjectId, candidates?: ObjectId[]) {
    const status: Result['status'] = code === 'CLARIFICATION_NEEDED' ? 'clarification_needed' : code === 'CANCELLED' ? 'cancelled' : code === 'OK' || code === 'LEAK_WORSENED' ? 'completed' : 'failed';
    this.emit({ type: 'action_result', runId: q.request.runId, result: { actionId: q.id, runId: q.request.runId, status, code, message, targetId, candidates } });
  }
  private cancelInternal() {
    const interrupted = [ ...(this.state.active ? [this.state.active] : []), ...this.state.queue ];
    this.state.active = null; this.state.queue = [];
    for (const q of interrupted) this.result(q, 'CANCELLED', 'Stopped at the current safe point. Finished actions and distance already walked are preserved.');
  }
  cancelActions() { this.cancelInternal(); this.changed(); this.flush(); }

  private resolve(q: Queued, target: Target): { id: ObjectId } | Failure {
    if (target.id) {
      if (target.qualifiers?.color && OBJECTS[target.id].color !== target.qualifiers.color.toLowerCase()) return failure('CLARIFICATION_NEEDED', 'The target identifier and color disagree. Which should I use?');
      return { id: target.id };
    }
    const perceived = this.getObservation().surroundings.map(o => o.id);
    let candidates = target.candidates ? [...new Set(target.candidates)] : ids.filter(id => {
      const label = target.description?.trim().toLowerCase();
      return label && (OBJECTS[id].aliases.includes(label) || OBJECTS[id].name.toLowerCase() === label);
    });
    // A tool that is still shut in a toolbox is not "unknown"; say where to look.
    const hidden = candidates.filter(id => (TOOLS as ObjectId[]).includes(id) && this.state.items[id as ItemId].location === 'toolbox');
    // Grandma knows her own bathroom: walking to a named thing does not require it to be in view right now.
    candidates = candidates.filter(id => (q.request.action.type === 'move_to' || perceived.includes(id)) && this.available(id));
    if (!candidates.length && hidden.length) return failure('NOT_FOUND', `I don’t see a ${OBJECTS[hidden[0]].name.toLowerCase()} anywhere. Maybe it’s in one of the toolboxes?`);
    const action = q.request.action;
    if (action.type === 'rotate') candidates = candidates.filter(id => id === 'pipe_joint');
    if (action.type === 'open') candidates = candidates.filter(isToolbox);
    if (action.type === 'grab') candidates = candidates.filter(id => OBJECTS[id].portable);
    if (target.qualifiers?.color) candidates = candidates.filter(id => OBJECTS[id].color === target.qualifiers!.color!.toLowerCase());
    if (!candidates.length) return failure('CLARIFICATION_NEEDED', 'I cannot identify that target here. Specify a visible object or its identifier.');
    if (candidates.length === 1) return { id: candidates[0] };
    candidates.sort((a, b) => distance(this.state.grandma.position, this.position(a)) - distance(this.state.grandma.position, this.position(b)));
    if (this.random() < TUNING.mistakes[this.band()]) {
      const selectedTarget = candidates[1 + Math.floor(this.random() * (candidates.length - 1))];
      this.emit({ type: 'misunderstanding', runId: this.state.runId, actionId: q.id, selectedTarget, alternatives: candidates, stressBand: this.band() });
      return { id: selectedTarget };
    }
    return { ...failure('CLARIFICATION_NEEDED', 'There is more than one plausible target. Specify the object or color.'), candidates };
  }

  private blocked(p: Vec2) {
    const r = TUNING.room;
    return p.x < r.minX || p.x > r.maxX || p.z < r.minZ || p.z > r.maxZ || TUNING.obstacles.some(o => p.x > o.minX && p.x < o.maxX && p.z > o.minZ && p.z < o.maxZ);
  }
  private pathClear(from: Vec2, to: Vec2) {
    const steps = Math.ceil(distance(from, to) / 0.08);
    for (let i = 1; i <= steps; i++) if (this.blocked({ x: from.x + (to.x - from.x) * i / steps, z: from.z + (to.z - from.z) * i / steps })) return false;
    return true;
  }
  private check(a: Action, target?: ObjectId): Failure | undefined {
    const s = this.state;
    const g = s.grandma;
    if (a.type === 'move' || a.type === 'move_to') {
      if (g.posture !== 'standing') return failure('WRONG_POSTURE', 'Stand up before walking.');
      if (target && !this.available(target)) return failure('INVALID_TARGET', 'That object is already held or has been used.');
    }
    if (target && !['move_to', 'look'].includes(a.type)) {
      if (distance(g.position, this.position(target)) > TUNING.reach) return failure('OUT_OF_REACH', `Move closer to ${OBJECTS[target].name.toLowerCase()} first.`);
      if (this.height(target) < 0.6 && g.posture !== 'bent') return failure('WRONG_POSTURE', 'Bend down to reach this low object.');
      if (this.height(target) >= 0.6 && g.posture !== 'standing') return failure('WRONG_POSTURE', 'Stand up to reach this object.');
    }
    const freeHands = 2 - g.held.length - (s.phone.placement === 'hand' ? 1 : 0);
    switch (a.type) {
      case 'switch_camera':
        if (s.phone.placement === 'dry_spot') {
          if (distance(g.position, OBJECTS.dry_spot.position) > TUNING.reach) return failure('OUT_OF_REACH', 'Move closer to the phone shelf to switch cameras.');
          if (g.posture !== 'standing') return failure('WRONG_POSTURE', 'Stand up to reach the phone controls.');
        }
        break;
      case 'look':
        if (a.frame === 'camera' && s.phone.placement !== 'hand') return failure('PHONE_NOT_HELD', 'Retrieve the phone to aim its camera.');
        break;
      case 'place_phone':
        if (target !== 'dry_spot') return failure('INVALID_TARGET', 'Use the dry phone shelf.');
        if (s.phone.placement !== 'hand') return failure('ALREADY_DONE', 'The phone is already on the shelf.');
        break;
      case 'retrieve_phone':
        if (s.phone.placement === 'hand') return failure('ALREADY_DONE', 'The phone is already in my hand.');
        if (distance(g.position, OBJECTS.dry_spot.position) > TUNING.reach) return failure('OUT_OF_REACH', 'Move closer to the phone shelf first.');
        if (g.posture !== 'standing') return failure('WRONG_POSTURE', 'Stand up to retrieve the phone.');
        if (freeHands < 1) return failure('HANDS_FULL', 'Put down an item to make room for the phone.');
        break;
      case 'grab':
        if (!target || !OBJECTS[target].portable) return failure('INVALID_TARGET', 'That object cannot be picked up.');
        if (s.items[target as ItemId].location === 'toolbox') return failure('NOT_FOUND', `I don’t see a ${OBJECTS[target].name.toLowerCase()} anywhere. Maybe it’s in one of the toolboxes?`);
        if (!this.available(target)) return failure('ALREADY_DONE', 'That object has already been picked up or used.');
        if (freeHands < 1) return failure('HANDS_FULL', 'Put down a held item or place the phone on its shelf first.');
        break;
      case 'place':
        if (!g.held.includes(a.item)) return failure('MISSING_TOOL', `Pick up the ${a.item} first.`);
        if (target !== 'dry_spot' && target !== 'puddle') return failure('INVALID_TARGET', 'Place items on the dry shelf or at the puddle.');
        if ((a.item === 'bucket' && s.bucketUsed) || (a.item === 'towels' && s.towelUsed)) return failure('ALREADY_DONE', 'This mitigation is already used.');
        break;
      case 'rotate': {
        if (target !== 'pipe_joint') return failure('INVALID_TARGET', 'Only the leaking pipe can be turned.');
        if (!g.held.includes('wrench')) {
          const wrong = g.held.find(item => (TOOLS as ItemId[]).includes(item));
          return failure('MISSING_TOOL', wrong ? `A ${wrong} won’t grip the pipe. I need the wrench.` : 'I need the wrench to turn the pipe.');
        }
        break;
      }
      case 'open':
        if (!target || !isToolbox(target)) return failure('INVALID_TARGET', 'Only the toolboxes can be opened.');
        if (s.toolboxes[target].open) return failure('ALREADY_DONE', `The ${OBJECTS[target].name.toLowerCase()} is already open.`);
        if (freeHands < 1) return failure('HANDS_FULL', 'Free a hand to lift the lid.');
        break;
    }
  }

  private begin(q: Queued) {
    const a = q.request.action;
    let target: ObjectId | undefined;
    let error: Failure | undefined;
    if (q.request.unresolved?.some(detail => detail !== 'target')) error = failure('CLARIFICATION_NEEDED', `Clarify: ${q.request.unresolved.filter(x => x !== 'target').join(', ')}.`);
    else if (a.type === 'rotate' && !a.direction) error = failure('CLARIFICATION_NEEDED', 'Which direction: clockwise or counterclockwise?');
    else if ('target' in a) {
      const resolved = this.resolve(q, a.target);
      if ('id' in resolved) target = resolved.id; else error = resolved;
    } else if (q.request.unresolved?.length) error = failure('CLARIFICATION_NEEDED', 'Specify the unresolved target.');
    if (!error) error = this.check(a, target);
    let duration: number = TUNING.durations[a.type];
    const from = { ...this.state.grandma.position };
    const fromYaw = this.state.grandma.yaw;
    const fromPhoneYaw = this.state.phone.yaw, fromPhonePitch = this.state.phone.pitch;
    let toYaw = fromYaw, toPhoneYaw = fromPhoneYaw, toPhonePitch = fromPhonePitch, turnDuration = 0;
    let moveDuration: number | undefined;
    let to: Vec2 | undefined;
    if (!error && (a.type === 'move' || a.type === 'move_to')) {
      if (a.type === 'move_to' && target) {
        const p = this.position(target);
        const d = distance(from, p);
        const fraction = d ? Math.max(0, d - TUNING.approachDistance) / d : 0;
        to = { x: from.x + (p.x - from.x) * fraction, z: from.z + (p.z - from.z) * fraction };
      } else if (a.type === 'move') {
        const yaw = (a.frame === 'camera' ? lensYaw(this.state) : this.state.grandma.yaw) + { forward: 0, backward: 180, left: 90, right: -90 }[a.direction];
        to = { x: from.x + Math.sin(radians(yaw)) * a.meters, z: from.z + Math.cos(radians(yaw)) * a.meters };
      }
      if (to) {
        if (!this.pathClear(from, to)) error = failure('BLOCKED', 'That path meets a wall or the toilet. Choose a shorter step or another direction.');
        moveDuration = Math.max(0.2, distance(from, to) / TUNING.moveSpeed);
        if (a.type === 'move_to') {
          // Face the destination before walking; explicit directional steps remain sidesteps/backsteps.
          const p = target ? this.position(target) : to;
          const heading = Math.atan2(p.x - from.x, p.z - from.z) * 180 / Math.PI;
          if (distance(from, p) > 0.01) toYaw = fromYaw + normalize(heading - fromYaw);
          turnDuration = Math.abs(toYaw - fromYaw) / 180 * TUNING.durations.turn;
          toPhoneYaw = 0; toPhonePitch = 0;
        }
        duration = turnDuration + moveDuration;
      }
    }
    if (a.type === 'turn') {
      const delta = normalize(turnYaw(this.state, a) - fromYaw);
      toYaw = fromYaw + (Math.abs(delta) === 180 ? (a.direction === 'left' ? 180 : -180) : delta);
      toPhoneYaw = 0;
    } else if (a.type === 'look') {
      const look = lookAngles(this.state, a); toPhoneYaw = fromPhoneYaw + normalize(look.yaw - fromPhoneYaw); toPhonePitch = look.pitch;
    }
    if (a.type === 'wait') duration = a.seconds;
    if (error) { this.result(q, error.code, error.message, target, error.candidates); return; }
    this.state.active = { ...q, target, elapsed: 0, duration, from, to, fromYaw, toYaw, turnDuration, moveDuration, fromPhoneYaw, toPhoneYaw, fromPhonePitch, toPhonePitch };
    this.emit({ type: 'action_progress', runId: this.state.runId, actionId: q.id, action: a.type, progress: 0 });
  }

  private consume(item: ItemId) { this.state.grandma.held = this.state.grandma.held.filter(id => id !== item); this.state.items[item].location = 'used'; }
  private finish(active: Active) {
    const s = this.state;
    const a = active.request.action;
    let code: ReasonCode = 'OK';
    let message = `${a.type.replaceAll('_', ' ')} completed.`;
    let win = false;
    switch (a.type) {
      case 'look': s.phone.yaw = normalize(active.toPhoneYaw); s.phone.pitch = active.toPhonePitch; break;
      case 'turn': s.grandma.yaw = normalize(active.toYaw); s.phone.yaw = 0; break;
      case 'switch_camera': s.phone.mode = a.mode; break;
      case 'place_phone':
        s.phone.placement = 'dry_spot';
        s.phone.fixedYaw = Math.atan2(OBJECTS.pipe_joint.position.x - OBJECTS.dry_spot.position.x, OBJECTS.pipe_joint.position.z - OBJECTS.dry_spot.position.z) * 180 / Math.PI;
        break;
      case 'retrieve_phone': s.phone.placement = 'hand'; s.phone.yaw = 0; s.phone.pitch = 0; break;
      case 'bend': s.grandma.posture = 'bent'; break;
      case 'stand': s.grandma.posture = 'standing'; break;
      case 'grab': {
        const item = active.target as ItemId; s.grandma.held.push(item); s.items[item].location = 'held'; break;
      }
      case 'place':
        s.grandma.held = s.grandma.held.filter(id => id !== a.item);
        s.items[a.item] = { position: { ...this.position(active.target!) }, height: this.height(active.target!), location: 'world' };
        if (active.target === 'puddle' && a.item === 'towels') { this.consume('towels'); s.towelUsed = true; s.towelRemaining = TUNING.towelCapacity; message = 'Towels are soaking up water. They will saturate.'; }
        if (active.target === 'puddle' && a.item === 'bucket') { this.consume('bucket'); s.bucketUsed = true; s.bucketRemaining = TUNING.bucketCapacity; message = 'The bucket is catching water. It will fill up.'; }
        break;
      case 'rotate':
        // Lefty to fix: the red pipe seals when turned counterclockwise; clockwise forces it open and worsens the leak.
        if (a.direction === 'counterclockwise') { s.leakRate = 0; win = true; message = 'The red pipe is sealed. The water has stopped.'; }
        else { s.leakRate = Math.min(TUNING.initialLeakPerSecond * TUNING.maxLeakMultiplier, s.leakRate * TUNING.wrongRotationMultiplier); code = 'LEAK_WORSENED'; message = 'That forced the pipe the wrong way. Water is flowing faster; turn it counterclockwise to seal it.'; }
        break;
      case 'open': {
        const box = active.target as ToolboxId;
        const tool = s.toolboxes[box].tool;
        s.toolboxes[box].open = true;
        s.items[tool].location = 'world';
        message = `The ${OBJECTS[box].name.toLowerCase()} is open. There’s a ${tool} inside.`;
        break;
      }
    }
    this.result(active, code, message, active.target);
    if (win) this.terminal('won', message);
  }
  private terminal(outcome: 'won' | 'lost', message: string) {
    this.state.stage = outcome;
    // The action completing a win was already removed. Flooding interrupts active work.
    this.cancelInternal();
    this.emit({ type: 'terminal', runId: this.state.runId, outcome, message });
  }

  /** Engine clock only; not part of the teammate-facing controller. Seconds of simulation time. */
  advance(seconds: number) {
    if (!Number.isFinite(seconds) || seconds <= 0 || this.state.stage !== 'running') return;
    this.remainder += seconds;
    const runId = this.state.runId;
    while (this.remainder >= TUNING.tickSeconds - 1e-9 && this.state.stage === 'running' && this.state.runId === runId) {
      const dt = TUNING.tickSeconds;
      this.remainder = Math.max(0, this.remainder - dt);
      const s = this.state;
      if (!s.active && s.queue.length) {
        this.begin(s.queue.shift()!);
        this.flush();
        if (this.state !== s || s.stage !== 'running') break;
      }
      if (this.state !== s || s.stage !== 'running') break;
      s.elapsed += dt;
      let inflow = s.leakRate * dt;
      const caught = Math.min(s.bucketRemaining, inflow); s.bucketRemaining -= caught; inflow -= caught;
      s.water += inflow;
      const absorbed = Math.min(s.towelRemaining, s.water); s.towelRemaining -= absorbed; s.water -= absorbed;
      if (s.water >= TUNING.floodThreshold - 1e-8) { s.water = TUNING.floodThreshold; this.terminal('lost', 'The bathroom has flooded. Reset to try again.'); break; }
      if (s.active) {
        const active = s.active; active.elapsed = Math.min(active.duration, active.elapsed + dt);
        const progress = active.elapsed / active.duration;
        const moving = active.to && active.moveDuration !== undefined;
        const facingProgress = moving ? active.turnDuration ? smoothProgress(active.elapsed / active.turnDuration) : 1 : smoothProgress(progress);
        const aimDuration = moving ? Math.max(active.turnDuration, Math.min(0.35, active.moveDuration!)) : active.duration;
        const aimProgress = smoothProgress(active.elapsed / aimDuration);
        s.grandma.yaw = normalize(active.fromYaw + (active.toYaw - active.fromYaw) * facingProgress);
        s.phone.yaw = normalize(active.fromPhoneYaw + (active.toPhoneYaw - active.fromPhoneYaw) * aimProgress);
        s.phone.pitch = active.fromPhonePitch + (active.toPhonePitch - active.fromPhonePitch) * aimProgress;
        if (active.to) {
          const travel = Math.max(0, Math.min(1, (active.elapsed - active.turnDuration) / active.moveDuration!));
          s.grandma.position = { x: active.from.x + (active.to.x - active.from.x) * travel, z: active.from.z + (active.to.z - active.from.z) * travel };
        }
        if (active.elapsed >= active.duration - 1e-9) { s.active = null; this.finish(active); }
      }
      // Let interruptions and result-driven sequences react before the next tick.
      this.flush();
    }
    if (this.state.runId !== runId || this.state.stage !== 'running') this.remainder = 0;
    const active = this.state.active;
    if (active) this.emit({ type: 'action_progress', runId: this.state.runId, actionId: active.id, action: active.request.action.type, progress: active.elapsed / active.duration });
    this.changed(); this.flush();
  }
}

/** A restricted facade prevents accidental state leaks into the voice integration. */
export function createGame(seed = 7) {
  const simulation = new Simulation(seed);
  const controller: GameController = Object.freeze({
    getObservation: () => simulation.getObservation(), submitAction: (request: ActionRequest) => simulation.submitAction(request),
    setCameraAspect: (aspect: number) => simulation.setCameraAspect(aspect),
    cancelActions: () => simulation.cancelActions(), subscribe: (listener: (event: GameEvent) => void) => simulation.subscribe(listener),
    start: () => simulation.start(), pause: () => simulation.pause(), resume: () => simulation.resume(), reset: (options?: { seed?: number }) => simulation.reset(options),
  });
  return { controller, simulation };
}
