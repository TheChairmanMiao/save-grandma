export type Vec2 = { x: number; z: number };
export type ToolboxId = 'red_toolbox' | 'blue_toolbox' | 'green_toolbox';
export type ToolId = 'wrench' | 'screwdriver' | 'hammer';
export type ObjectId = 'pipe_joint' | ToolboxId | ToolId | 'towels' | 'bucket' | 'dry_spot' | 'puddle';
export type ItemId = ToolId | 'towels' | 'bucket';
export type Direction = 'forward' | 'backward' | 'left' | 'right';
export type Frame = 'grandma' | 'camera';
export type Stage = 'ready' | 'running' | 'paused' | 'won' | 'lost';
export type Band = 'low' | 'medium' | 'high';
export type Target = { id?: ObjectId; description?: string; candidates?: ObjectId[]; qualifiers?: { color?: string } };
export type Action =
  | { type: 'look'; direction: Direction | 'up' | 'down'; degrees?: number; frame?: Frame }
  | { type: 'turn'; direction: 'left' | 'right'; degrees?: number; frame?: Frame }
  | { type: 'move'; direction: Direction; meters: number; frame?: Frame }
  | { type: 'move_to'; target: Target }
  | { type: 'switch_camera'; mode: 'selfie' | 'rear' }
  | { type: 'place_phone'; target: Target }
  | { type: 'retrieve_phone' }
  | { type: 'bend' | 'stand' }
  | { type: 'grab'; target: Target }
  | { type: 'place'; target: Target; item: ItemId }
  | { type: 'rotate'; target: Target; direction?: 'clockwise' | 'counterclockwise' }
  | { type: 'open'; target: Target }
  | { type: 'wait'; seconds: number };
export type ActionRequest = { runId: string; action: Action; unresolved?: string[] };
export type ReasonCode = 'OK' | 'INVALID_REQUEST' | 'STALE_RUN' | 'NOT_RUNNING' | 'QUEUE_FULL' | 'CLARIFICATION_NEEDED' | 'OUT_OF_REACH' | 'WRONG_POSTURE' | 'HANDS_FULL' | 'MISSING_TOOL' | 'NOT_FOUND' | 'PHONE_NOT_HELD' | 'INVALID_TARGET' | 'BLOCKED' | 'ALREADY_DONE' | 'CANCELLED' | 'LEAK_WORSENED' | 'TERMINAL';
export type Result = { actionId: string; runId: string; status: 'completed' | 'failed' | 'clarification_needed' | 'cancelled'; code: ReasonCode; message: string; targetId?: ObjectId; candidates?: ObjectId[] };
export type Acceptance = { accepted: boolean; actionId: string; runId: string; code: ReasonCode; message: string };
export type PerceivedObject = { id: ObjectId; name: string; color: string; distance: number; reachable: boolean; visible: boolean };
export type Observation = {
  runId: string; stage: Stage; elapsedSeconds: number;
  grandma: { position: Vec2; facingDegrees: number; posture: 'standing' | 'bent'; heldItems: ItemId[] };
  phone: { mode: 'selfie' | 'rear'; placement: 'hand' | 'dry_spot' };
  /** Objects Grandma can see with her eyes, independent of the selected phone lens. */
  surroundings: PerceivedObject[];
  /** What actually falls inside the phone lens; a selfie need not show the room. */
  cameraView: { surroundings: PerceivedObject[]; grandmaVisible: boolean; facingDegrees: number; pitchDegrees: number };
  waterBand: Band; stressBand: Band; leak: 'flowing' | 'stopped';
  currentAction: { actionId: string; type: Action['type']; progress: number } | null;
  queuedActions: number;
};
export type GameEvent =
  | { type: 'state_changed'; runId: string; observation: Observation }
  | { type: 'action_queued'; runId: string; actionId: string; action: Action }
  | { type: 'action_progress'; runId: string; actionId: string; action: Action['type']; progress: number }
  | { type: 'action_result'; runId: string; result: Result }
  | { type: 'misunderstanding'; runId: string; actionId: string; selectedTarget: ObjectId; alternatives: ObjectId[]; stressBand: Band }
  | { type: 'terminal'; runId: string; outcome: 'won' | 'lost'; message: string };
export interface GameController {
  getObservation(): Observation;
  submitAction(request: ActionRequest): Acceptance;
  cancelActions(): void;
  subscribe(listener: (event: GameEvent) => void): () => void;
  /** The renderer reports its actual viewport ratio; this changes framing, never game rules. */
  setCameraAspect(aspect: number): void;
  start(): void; pause(): void; resume(): void; reset(options?: { seed?: number }): void;
}
