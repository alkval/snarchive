/** Photo zoom, pan and swipe navigation as plain state, so the rules can be tested without a device.
 *
 * Coordinates are relative to the stage centre. The photo and its overlay are drawn as one layer that fills the stage
 * with "contain"; a single transform (translate, then scale about the stage centre) moves both, so they can never
 * drift apart. Screen point q of content point u: q = t + s·u. */
export type Size = { width: number; height: number };
export type Point = { x: number; y: number };
export type Transform = { scale: number; x: number; y: number };
export type Touch = { id: string | number; x: number; y: number };
export type Navigation = 'next' | 'previous';

export const IDENTITY: Transform = Object.freeze({ scale: 1, x: 0, y: 0 });
export const MIN_SCALE = 1, MAX_SCALE = 4, DOUBLE_TAP_SCALE = 2.5;
/** Below this the photo counts as not zoomed: swipes navigate and the transform snaps back to fit. */
export const ZOOM_EPSILON = 0.02;
/** A swipe navigates when it moves far enough (the smaller of `distance` px and `fraction` of the stage width), or
 * is flicked (`flickVelocity` px/ms over at least `flickDistance` px), and is mostly horizontal (`dominance`). */
export const SWIPE = { distance: 80, fraction: 0.18, flickDistance: 24, flickVelocity: 0.6, dominance: 1.5 };
/** A tap moves less than `slop` px and lasts under `maxDuration` ms; two within `doubleInterval` ms and
 * `doubleSlop` px are a double tap. Movement beyond `slop` decides between swipe, pan and nothing. */
export const TAP = { slop: 10, maxDuration: 250, doubleInterval: 300, doubleSlop: 32 };

const finitePositive = (size: Size) => Number.isFinite(size.width) && Number.isFinite(size.height) && size.width > 0 && size.height > 0;

/** The size a photo is drawn at with "contain" (letterboxed) in the stage; zero for invalid sizes. */
export function containedSize(content: Size, stage: Size): Size {
  if (!finitePositive(content) || !finitePositive(stage)) return { width: 0, height: 0 };
  const fit = Math.min(stage.width / content.width, stage.height / content.height);
  return { width: content.width * fit, height: content.height * fit };
}

/** Scale within [MIN_SCALE, MAX_SCALE]; translation such that the scaled photo never leaves a gap on a side where it
 * is larger than the stage, and stays centred on an axis where it is smaller. Near 1 it snaps to the exact fit. */
export function clampTransform(transform: Transform, drawn: Size, stage: Size): Transform {
  const scale = Number.isFinite(transform.scale) ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, transform.scale)) : MIN_SCALE;
  if (scale < MIN_SCALE + ZOOM_EPSILON) return IDENTITY;
  const limitX = Math.max(0, (drawn.width * scale - stage.width) / 2), limitY = Math.max(0, (drawn.height * scale - stage.height) / 2);
  const clamp = (value: number, limit: number) => Number.isFinite(value) ? Math.min(limit, Math.max(-limit, value)) : 0;
  return { scale, x: clamp(transform.x, limitX), y: clamp(transform.y, limitY) };
}

/** Zooms to `scale` keeping the content under `focal` (stage-centre coordinates) in place, then clamps. */
export function zoomAbout(transform: Transform, scale: number, focal: Point, drawn: Size, stage: Size): Transform {
  const bounded = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
  const ratio = bounded / transform.scale;
  return clampTransform({ scale: bounded, x: focal.x - ratio * (focal.x - transform.x), y: focal.y - ratio * (focal.y - transform.y) }, drawn, stage);
}

export const isZoomed = (transform: Transform) => transform.scale >= MIN_SCALE + ZOOM_EPSILON;

/** Whether a released horizontal drag navigates, and where. dx < 0 (moving left) shows the next memory. */
export function swipeDecision(dx: number, dy: number, velocityX: number, stageWidth: number): Navigation | null {
  if (!(Math.abs(dx) > SWIPE.dominance * Math.abs(dy))) return null;
  const far = Math.abs(dx) >= Math.min(SWIPE.distance, SWIPE.fraction * stageWidth);
  const flick = Math.abs(dx) >= SWIPE.flickDistance && Math.abs(velocityX) >= SWIPE.flickVelocity && Math.sign(velocityX) === Math.sign(dx);
  if (!far && !flick) return null;
  return dx < 0 ? 'next' : 'previous';
}

/** Button controls share the gesture transform. Directions describe movement of the photo on screen. */
export const PHOTO_ADJUSTMENTS = ['zoom-in', 'zoom-out', 'left', 'right', 'up', 'down', 'reset'] as const;
export type PhotoAdjustment = typeof PHOTO_ADJUSTMENTS[number];
export type PhotoControlState = { ready: boolean; percent: number; enabled: Record<PhotoAdjustment, boolean> };
export const PHOTO_ZOOM_STEP = 0.5, PHOTO_MOVE_FRACTION = 0.25;

export function adjustPhoto(transform: Transform, action: PhotoAdjustment, drawn: Size, stage: Size): Transform {
  const current = clampTransform(transform, drawn, stage);
  if (action === 'reset') return IDENTITY;
  if (action === 'zoom-in' || action === 'zoom-out')
    return zoomAbout(current, current.scale + (action === 'zoom-in' ? PHOTO_ZOOM_STEP : -PHOTO_ZOOM_STEP), { x: 0, y: 0 }, drawn, stage);
  const dx = action === 'left' ? -stage.width * PHOTO_MOVE_FRACTION : action === 'right' ? stage.width * PHOTO_MOVE_FRACTION : 0;
  const dy = action === 'up' ? -stage.height * PHOTO_MOVE_FRACTION : action === 'down' ? stage.height * PHOTO_MOVE_FRACTION : 0;
  return clampTransform({ ...current, x: current.x + dx, y: current.y + dy }, drawn, stage);
}
const sameTransform = (a: Transform, b: Transform) => a.scale === b.scale && a.x === b.x && a.y === b.y;
export function photoControlState(zoomable: boolean, transform: Transform, drawn: Size, stage: Size): PhotoControlState {
  const ready = zoomable && finitePositive(drawn) && finitePositive(stage);
  const enabled = Object.fromEntries(PHOTO_ADJUSTMENTS.map(action => [action, ready && !sameTransform(transform, adjustPhoto(transform, action, drawn, stage))])) as Record<PhotoAdjustment, boolean>;
  return { ready, percent: Math.round(transform.scale * 100), enabled };
}
export const EMPTY_PHOTO_CONTROLS: PhotoControlState = photoControlState(false, IDENTITY, { width: 0, height: 0 }, { width: 0, height: 0 });
export function samePhotoControls(a: PhotoControlState | null, b: PhotoControlState): boolean {
  return !!a && a.ready === b.ready && a.percent === b.percent && PHOTO_ADJUSTMENTS.every(action => a.enabled[action] === b.enabled[action]);
}

type Mode = 'idle' | 'pending' | 'swipe' | 'vertical' | 'pan' | 'pinch' | 'ignored';
export type GestureEnd = { navigate: Navigation | null; tapped: boolean };

/** One gesture at a time over the stage. While zoomed, one finger pans and never navigates; two fingers always
 * pinch. A gesture that involved two fingers never navigates, even after one is lifted. Swipes navigate only at fit. */
export class StageGestures {
  transform: Transform = IDENTITY;
  /** Horizontal offset shown while an unzoomed swipe is in progress; 0 otherwise. */
  swipeOffset = 0;
  verticalSwipe: 'up' | 'down' | null = null;
  private stage: Size = { width: 0, height: 0 };
  private drawn: Size = { width: 0, height: 0 };
  private content: Size = { width: 0, height: 0 };
  private mode: Mode = 'idle';
  private multi = false;
  private count = 0;
  private start = { x: 0, y: 0, time: 0 };
  private base: Transform = IDENTITY;
  private pinch = { distance: 1, focal: { x: 0, y: 0 } };
  private last = { x: 0, y: 0 };
  private lastTap: { x: number; y: number; time: number } | null = null;
  private zoomable: boolean;

  constructor(zoomable: boolean) { this.zoomable = zoomable; }

  /** A stage can become zoomable once its photo has loaded (or stop being so); either way it starts again at fit. */
  setZoomable(zoomable: boolean): void { if (zoomable !== this.zoomable) { this.zoomable = zoomable; this.reset(); } }

  get active(): boolean { return this.mode !== 'idle'; }
  get pinching(): boolean { return this.mode === 'pinch'; }
  get controls(): PhotoControlState { return photoControlState(this.zoomable, this.transform, this.drawn, this.stage); }
  /** An external control ends any in-flight gesture and pending double tap. Its later move/release cannot navigate. */
  adjust(action: PhotoAdjustment): void {
    if (!this.controls.ready) return;
    this.cancel();
    this.transform = adjustPhoto(this.transform, action, this.drawn, this.stage);
  }


  /** A new stage width (rotation, a window change) or a new photo resets to fit: the old position means nothing there.
   * A height-only change, such as a note appearing below the stage, keeps the zoom within the new bounds. */
  layout(stage: Size, content: Size | null): void {
    const sameContent = (content?.width ?? 0) === this.content.width && (content?.height ?? 0) === this.content.height;
    const sameWidth = stage.width === this.stage.width;
    this.stage = stage; this.content = { width: content?.width ?? 0, height: content?.height ?? 0 };
    this.drawn = content ? containedSize(content, stage) : { width: 0, height: 0 };
    if (!sameContent || !sameWidth) this.reset();
    else this.transform = clampTransform(this.transform, this.drawn, this.stage);
  }
  reset(): void { this.verticalSwipe = null; this.transform = IDENTITY; this.swipeOffset = 0; this.mode = 'idle'; this.multi = false; this.count = 0; this.lastTap = null; }

  begin(touches: readonly Touch[], time: number): void {
    this.verticalSwipe = null;
    this.multi = touches.length > 1; this.swipeOffset = 0; this.count = touches.length;
    if (touches.length > 1) { this.startPinch(touches); return; }
    const touch = touches[0];
    if (!touch) return;
    this.mode = 'pending'; this.start = { x: touch.x, y: touch.y, time }; this.last = { x: touch.x, y: touch.y };
    this.base = this.transform;
  }

  /** A finger landed or lifted during the gesture, with or without movement (the responder's start and end events).
   * Once two fingers have taken part, the gesture can no longer navigate, until it ends. Lifting one finger
   * continues the same gesture (a pan if zoomed); it never restarts it. */
  touchesChanged(touches: readonly Touch[], _time: number): void {
    if (this.mode === 'idle' || touches.length === this.count) return;
    const previous = this.count;
    this.count = touches.length;
    if (touches.length > 1) {
      this.multi = true; this.swipeOffset = 0;
      if (this.mode !== 'pinch') this.startPinch(touches);
      return;
    }
    const touch = touches[0];
    if (!touch || previous < 2) return; // All fingers lifted: the release follows.
    this.mode = this.zoomable && isZoomed(this.transform) ? 'pan' : 'ignored';
    this.start = { ...this.start, x: touch.x, y: touch.y }; this.last = { x: touch.x, y: touch.y }; this.base = this.transform;
  }

  move(touches: readonly Touch[], time: number): void {
    if (this.mode === 'idle') return;
    this.touchesChanged(touches, time);
    if (touches.length > 1) { if (this.mode === 'pinch') this.updatePinch(touches); return; }
    const touch = touches[0];
    if (!touch) return;
    this.last = { x: touch.x, y: touch.y };
    const dx = touch.x - this.start.x, dy = touch.y - this.start.y;
    if (this.mode === 'pending') {
      if (Math.hypot(dx, dy) < TAP.slop) return;
      if (this.zoomable && isZoomed(this.transform)) this.mode = 'pan';
      else if (!this.multi && Math.abs(dx) > SWIPE.dominance * Math.abs(dy)) this.mode = 'swipe';
      else if (!this.multi && Math.abs(dy) > SWIPE.dominance * Math.abs(dx)) this.mode = 'vertical';
      else this.mode = 'ignored';
    }
    if (this.mode === 'pan') this.transform = clampTransform({ scale: this.base.scale, x: this.base.x + dx, y: this.base.y + dy }, this.drawn, this.stage);
    else if (this.mode === 'swipe') this.swipeOffset = dx;
  }

  /** The gesture ended normally. velocityX in px/ms (positive to the right). */
  end(time: number, velocityX: number): GestureEnd {
    const mode = this.mode, dx = this.last.x - this.start.x, dy = this.last.y - this.start.y;
    this.mode = 'idle'; this.swipeOffset = 0;
    this.count = 0;
    this.verticalSwipe = mode === 'vertical' && !this.multi && Math.abs(dy) >= 72 ? (dy < 0 ? 'up' : 'down') : null;
    if (mode === 'swipe' && !this.multi) return { navigate: swipeDecision(dx, dy, velocityX, this.stage.width), tapped: false };
    if (mode === 'pending' && !this.multi && time - this.start.time <= TAP.maxDuration) {
      const tap = { x: this.start.x, y: this.start.y, time };
      const previous = this.lastTap;
      if (this.zoomable && previous && time - previous.time <= TAP.doubleInterval && Math.hypot(tap.x - previous.x, tap.y - previous.y) <= TAP.doubleSlop) {
        this.lastTap = null;
        this.transform = isZoomed(this.transform) ? IDENTITY : zoomAbout(this.transform, DOUBLE_TAP_SCALE, tap, this.drawn, this.stage);
      } else this.lastTap = tap;
      return { navigate: null, tapped: true };
    }
    this.transform = clampTransform(this.transform, this.drawn, this.stage);
    return { navigate: null, tapped: false };
  }

  /** The system took the gesture away (another responder, a dialog, the app backgrounding): never navigate, keep any
   * zoom already applied, within bounds. */
  cancel(): void {
    this.verticalSwipe = null;
    this.mode = 'idle'; this.swipeOffset = 0; this.lastTap = null; this.count = 0;
    this.transform = clampTransform(this.transform, this.drawn, this.stage);
  }

  private startPinch(touches: readonly Touch[]): void {
    if (!this.zoomable) { this.mode = 'ignored'; return; }
    const [a, b] = touches as [Touch, Touch];
    this.mode = 'pinch'; this.base = this.transform; this.swipeOffset = 0;
    this.pinch = { distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), focal: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
  }
  private updatePinch(touches: readonly Touch[]): void {
    const [a, b] = touches as [Touch, Touch];
    const distance = Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), focal = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.base.scale * distance / this.pinch.distance));
    // The content point that was under the starting midpoint follows the current midpoint (pinch and two-finger pan).
    const u = { x: (this.pinch.focal.x - this.base.x) / this.base.scale, y: (this.pinch.focal.y - this.base.y) / this.base.scale };
    this.transform = clampTransform({ scale, x: focal.x - scale * u.x, y: focal.y - scale * u.y }, this.drawn, this.stage);
  }
}
