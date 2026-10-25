import { useEffect, useRef, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from './theme';

// Media is always drawn on black, in both appearances; the scrims only keep the bars readable over bright photos.
const TOP_SCRIM = 'linear-gradient(to bottom, rgba(0,0,0,0.55), rgba(0,0,0,0))';
const BOTTOM_SCRIM = 'linear-gradient(to top, rgba(0,0,0,0.6), rgba(0,0,0,0))';

/** The viewer's top and bottom bars, drawn over the fullscreen media so a photo or video sits in the same place whatever
 * its controls are, and whether they are shown. Hidden bars fade out, take no touches and are hidden from assistive
 * technology. Empty space in the bars passes touches through to the media. */
export function ViewerChrome({ visible, top, bottom }: { visible: boolean; top: ReactNode; bottom: ReactNode }) {
  const insets = useSafeAreaInsets(), reduced = useReducedMotion();
  const shown = useRef(new Animated.Value(visible ? 1 : 0)).current;
  useEffect(() => {
    Animated.timing(shown, { toValue: visible ? 1 : 0, duration: reduced ? 0 : 160, easing: Easing.bezier(0.23, 1, 0.32, 1), useNativeDriver: true }).start();
  }, [visible, reduced, shown]);
  const hidden = { pointerEvents: visible ? 'box-none' : 'none', importantForAccessibility: visible ? 'auto' : 'no-hide-descendants', accessibilityElementsHidden: !visible } as const;
  const sides = { paddingLeft: insets.left + 12, paddingRight: insets.right + 12 };
  return <>
    <Animated.View {...hidden} style={[styles.top, sides, { paddingTop: insets.top, opacity: shown }]}>{top}</Animated.View>
    <Animated.View {...hidden} style={[styles.bottom, sides, { paddingBottom: insets.bottom + 8, opacity: shown }]}>{bottom}</Animated.View>
  </>;
}

const styles = StyleSheet.create({
  top: { position: 'absolute', top: 0, left: 0, right: 0, paddingBottom: 16, backgroundImage: TOP_SCRIM },
  bottom: { position: 'absolute', bottom: 0, left: 0, right: 0, paddingTop: 24, gap: 10, backgroundImage: BOTTOM_SCRIM },
});
