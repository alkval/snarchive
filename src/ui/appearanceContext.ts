import { createContext, useContext } from 'react';
import type { AppearancePreferences, AppearanceState } from '../domain/appearance';
export const AppearanceContext = createContext<{ preferences: AppearancePreferences; state: AppearanceState } | null>(null);
export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error('appearance-provider-missing');
  return context;
}
