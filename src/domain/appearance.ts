export type AppearanceChoice = 'system' | 'light' | 'dark';
export const appearanceChoices: readonly AppearanceChoice[] = ['system', 'light', 'dark'];
export function isAppearanceChoice(value: unknown): value is AppearanceChoice {
  return value === 'system' || value === 'light' || value === 'dark';
}
export function darkAppearance(choice: AppearanceChoice, system: 'light' | 'dark' | null | undefined): boolean {
  return choice === 'dark' || (choice === 'system' && system === 'dark');
}
export interface AppearanceRepository {
  load(): Promise<AppearanceChoice>;
  save(choice: AppearanceChoice): Promise<void>;
}
export interface AppearanceState {
  readonly choice: AppearanceChoice;
  readonly initialized: boolean;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly pending: AppearanceChoice | null;
  readonly error: 'load' | 'save' | null;
}

/** Owned by the app, not the settings screen. Apply a choice only after its write succeeds. */
export class AppearancePreferences {
  private readonly repository: AppearanceRepository;
  private state: AppearanceState = { choice: 'system', initialized: false, loaded: false, loading: false, pending: null, error: null };
  private listeners = new Set<(state: AppearanceState) => void>();
  constructor(repository: AppearanceRepository) { this.repository = repository; }
  snapshot(): AppearanceState { return this.state; }
  subscribe(listener: (state: AppearanceState) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  private publish(update: Partial<AppearanceState>): void {
    this.state = { ...this.state, ...update };
    this.listeners.forEach(listener => listener(this.state));
  }
  async load(): Promise<boolean> {
    if (this.state.loaded) return true;
    if (this.state.loading || this.state.pending !== null) return false;
    this.publish({ loading: true, error: null });
    try {
      const choice = await this.repository.load();
      if (!isAppearanceChoice(choice)) throw new Error('invalid-appearance');
      this.publish({ choice, initialized: true, loaded: true, loading: false });
      return true;
    } catch {
      this.publish({ initialized: true, loading: false, error: 'load' });
      return false;
    }
  }
  async choose(choice: AppearanceChoice): Promise<boolean> {
    if (!isAppearanceChoice(choice) || !this.state.loaded || this.state.loading || this.state.pending !== null) return false;
    if (choice === this.state.choice) { this.publish({ error: null }); return true; }
    this.publish({ pending: choice, error: null });
    try {
      await this.repository.save(choice);
      this.publish({ choice, pending: null });
      return true;
    } catch {
      this.publish({ pending: null, error: 'save' });
      return false;
    }
  }
}
