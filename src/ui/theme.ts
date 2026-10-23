import { useContext, useEffect, useState } from 'react';
import { AccessibilityInfo, useColorScheme, type TextStyle } from 'react-native';

import { darkAppearance } from '../domain/appearance';
import { AppearanceContext } from './appearanceContext';

// One accent, used for links, selection and icons only. Primary actions are near-black (white in dark).
// Every text tier holds 4.5:1 on the surface it sits on.
const light = {
  dark: false,
  ground: '#F2F2F7', surface: '#FFFFFF', raised: '#E9E9EE', pressed: '#E3E3E8', separator: '#DCDCE1',
  text: '#111114', secondary: '#5C5C66',
  accent: '#0062CC', accentTint: '#E6F0FB',
  primary: '#111114', onPrimary: '#FFFFFF',
  positive: '#1F7A47', positiveTint: '#E3F5EA',
  warning: '#8A5300', warningTint: '#FFF3DC',
  negative: '#C4242A', negativeTint: '#FDECEC',
  media: '#000000', onMedia: '#FFFFFF', onMediaSecondary: '#C7C7CC', mediaControl: 'rgba(44,44,46,0.72)',
};
const dark: typeof light = {
  dark: true,
  ground: '#000000', surface: '#1C1C1E', raised: '#2C2C2E', pressed: '#3A3A3C', separator: '#38383A',
  text: '#FFFFFF', secondary: '#AEAEB2',
  accent: '#4DA3FF', accentTint: '#0F2236',
  primary: '#FFFFFF', onPrimary: '#000000',
  positive: '#3FC07A', positiveTint: '#13261A',
  warning: '#F0B44C', warningTint: '#2A2110',
  negative: '#FF6B6B', negativeTint: '#2C1517',
  media: '#000000', onMedia: '#FFFFFF', onMediaSecondary: '#C7C7CC', mediaControl: 'rgba(44,44,46,0.72)',
};
export type Palette = typeof light;

/** Size-specific tracking: tighter as type grows, none on body. Sizes follow the system font scale. */
export const type = {
  largeTitle: { fontSize: 32, lineHeight: 38, fontWeight: '700', letterSpacing: -0.6 },
  title: { fontSize: 22, lineHeight: 28, fontWeight: '700', letterSpacing: -0.3 },
  headline: { fontSize: 17, lineHeight: 22, fontWeight: '600', letterSpacing: -0.2 },
  body: { fontSize: 16, lineHeight: 22 },
  footnote: { fontSize: 13, lineHeight: 18 },
  caption: { fontSize: 12, lineHeight: 16, fontWeight: '500' },
  figure: { fontSize: 40, lineHeight: 44, fontWeight: '700', letterSpacing: -1, fontVariant: ['tabular-nums'] },
} satisfies Record<string, TextStyle>;

export const space = { gutter: 20, section: 28, row: 52, radius: 16 };

export function useTheme(): Palette {
  const appearance = useContext(AppearanceContext);
  const system = useColorScheme();
  return darkAppearance(appearance?.state.choice ?? 'system', system) ? dark : light;
}

// One system listener shared by every animated component.
let reducedMotion = false;
const listeners = new Set<(value: boolean) => void>();
let watching = false;
function watchReducedMotion() {
  if (watching) return;
  watching = true;
  const publish = (value: boolean) => { reducedMotion = value; listeners.forEach(listener => listener(value)); };
  void AccessibilityInfo.isReduceMotionEnabled().then(publish, () => {});
  AccessibilityInfo.addEventListener('reduceMotionChanged', publish);
}

/** Reduced motion keeps opacity changes and drops movement and scale. */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(reducedMotion);
  useEffect(() => {
    watchReducedMotion();
    listeners.add(setReduced); setReduced(reducedMotion);
    return () => { listeners.delete(setReduced); };
  }, []);
  return reduced;
}
