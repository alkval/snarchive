/** What the viewer's details sheet does with each drag, release and control, kept apart from React and Animated so
 * their order can be tested.
 *
 * The sheet sits `offset` px below its open position; `height` (the screen) is fully closed. A vertical drag on the
 * media moves it while `dragging`; the sheet's own drag moves it only while `open`. Closing (Back, Done, a release)
 * wins over any drag still in progress, on the sheet or on the media: that drag's later moves and its release are
 * ignored, so it can neither pull the closing sheet back into view, restore it nor reopen it. A new gesture (after
 * the media drag ended) may still interrupt a close. The sheet unmounts when a close animation finishes and nothing
 * reopened it meanwhile; a screen-height change (rotation) retargets a close in progress, so it never stops short. */
export type SheetPhase = 'closed' | 'dragging' | 'open';
export type SheetEffects = {
  /** Shows the sheet at `offset` at once. */
  set(offset: number): void;
  /** Animates to `offset`; `done` runs only if the animation finished (was not stopped or replaced). */
  animate(offset: number, done?: () => void): void;
  stop(): void;
  mount(mounted: boolean): void;
  /** The sheet is open (status bar, screen-reader focus) or is closing / being dragged. */
  opened(open: boolean): void;
};

/** Consume the release before cancelling the photo stage: cancel reports stageDrag(null), which clears the flag
 * that keeps an earlier Back/Done from being undone by this gesture. Videos may have no stage to cancel. */
export function releaseDetailsGesture(sheet: DetailsSheet, direction: 'up' | 'down', cancelStage: () => void): boolean {
  const handled = sheet.release(direction);
  if (direction === 'up') cancelStage();
  return handled;
}

export class DetailsSheet {
  phase: SheetPhase = 'closed';
  height: number;
  private readonly effects: SheetEffects;
  /** A media drag is in progress (between its first reported distance and its end). */
  private mediaDrag = false;
  /** That media drag was cancelled by a close: ignore it until it ends. */
  private ignoreMediaDrag = false;
  private closing = false;
  private lastDrag = 0;

  constructor(effects: SheetEffects, height: number) { this.effects = effects; this.height = height; }

  /** A vertical drag on the media: its distance (negative is up) while it lasts, null once it ends. */
  stageDrag(dy: number | null): void {
    if (dy === null) { this.mediaDrag = false; if (this.ignoreMediaDrag) { this.ignoreMediaDrag = false; return; } }
    else { this.mediaDrag = true; if (this.ignoreMediaDrag) return; }
    if (this.phase === 'open') return;
    if (dy === null) { if (this.phase === 'dragging') this.close(); return; }
    if (this.phase !== 'dragging') {
      if (dy >= 0) return; // A drag down closes the viewer on release; nothing follows it.
      this.phase = 'dragging'; this.closing = false; this.effects.stop(); this.effects.mount(true);
    }
    this.lastDrag = dy;
    this.effects.set(this.dragOffset());
  }

  /** A released media drag: up opens; down drops a sheet being dragged. Returns false when the viewer should close. */
  release(direction: 'up' | 'down'): boolean {
    if (this.ignoreMediaDrag) return true; // The close already handled this gesture.
    this.mediaDrag = false; // Released: a close from here on cancels nothing.
    if (direction === 'up') { this.open(); return true; }
    if (this.phase === 'dragging') { this.close(); return true; }
    return false;
  }

  open(): void {
    this.phase = 'open'; this.closing = false; this.effects.mount(true); this.effects.opened(true); this.effects.animate(0);
  }

  close(): void {
    if (this.phase === 'closed') return;
    if (this.mediaDrag) this.ignoreMediaDrag = true;
    this.phase = 'closed'; this.closing = true; this.effects.opened(false);
    this.slideAway();
  }

  /** The screen height changed: a closing sheet now slides to the new bottom, a dragged one keeps its distance. */
  resize(height: number): void {
    if (height === this.height) return;
    this.height = height;
    if (this.closing) this.slideAway();
    else if (this.phase === 'dragging') this.effects.set(this.dragOffset());
  }

  private dragOffset(): number { return Math.min(this.height, Math.max(0, this.height + this.lastDrag)); }
  private slideAway(): void {
    this.effects.animate(this.height, () => { if (this.phase === 'closed') { this.closing = false; this.effects.mount(false); } });
  }

  /** The sheet's own drag down (dy from where it started). Ignored unless open, so a close in progress wins. */
  sheetDrag(dy: number): void { if (this.phase === 'open') this.effects.set(Math.max(0, dy)); }

  /** The sheet's own drag ended: `leave` closes, otherwise it returns to open. Ignored unless open. */
  sheetRelease(leave: boolean): void {
    if (this.phase !== 'open') return;
    if (leave) this.close(); else this.effects.animate(0);
  }
}
