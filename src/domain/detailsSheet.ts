/** What the viewer's details sheet does with each drag, release and control, kept apart from React and Animated so
 * their order can be tested.
 *
 * The sheet sits `offset` px below its open position; `height` (the screen) is fully closed. A vertical drag on the
 * media moves it while `dragging`; the sheet's own drag moves it only while `open`. Closing (Back, Done, a release)
 * wins over any drag still in progress: the drag's later moves and its release are ignored, so it can neither pull
 * the closing sheet back into view nor restore it. The sheet unmounts when a close animation finishes and nothing
 * reopened it meanwhile. */
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

export class DetailsSheet {
  phase: SheetPhase = 'closed';
  height: number;
  private readonly effects: SheetEffects;

  constructor(effects: SheetEffects, height: number) { this.effects = effects; this.height = height; }

  /** A vertical drag on the media: its distance (negative is up) while it lasts, null once it ends. */
  stageDrag(dy: number | null): void {
    if (this.phase === 'open') return;
    if (dy === null) { if (this.phase === 'dragging') this.close(); return; }
    if (this.phase !== 'dragging') {
      if (dy >= 0) return; // A drag down closes the viewer on release; nothing follows it.
      this.phase = 'dragging'; this.effects.stop(); this.effects.mount(true);
    }
    this.effects.set(Math.min(this.height, Math.max(0, this.height + dy)));
  }

  /** A released media drag: up opens; down drops a sheet being dragged. Returns false when the viewer should close. */
  release(direction: 'up' | 'down'): boolean {
    if (direction === 'up') { this.open(); return true; }
    if (this.phase === 'dragging') { this.close(); return true; }
    return false;
  }

  open(): void {
    this.phase = 'open'; this.effects.mount(true); this.effects.opened(true); this.effects.animate(0);
  }

  close(): void {
    if (this.phase === 'closed') return;
    this.phase = 'closed'; this.effects.opened(false);
    this.effects.animate(this.height, () => { if (this.phase === 'closed') this.effects.mount(false); });
  }

  /** The sheet's own drag down (dy from where it started). Ignored unless open, so a close in progress wins. */
  sheetDrag(dy: number): void { if (this.phase === 'open') this.effects.set(Math.max(0, dy)); }

  /** The sheet's own drag ended: `leave` closes, otherwise it returns to open. Ignored unless open. */
  sheetRelease(leave: boolean): void {
    if (this.phase !== 'open') return;
    if (leave) this.close(); else this.effects.animate(0);
  }
}
