import { Modal, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { PhotoAdjustment, PhotoControlState } from '../domain/viewerGestures';
import { en } from '../i18n/en';
import { Button } from './kit';
import { space, type, useReducedMotion, useTheme } from './theme';

/** A modal over the unchanged stage: opening/closing it never changes the photo's layout or zoom. */
export function PhotoControls({ visible, state, adjust, close }: {
  visible: boolean; state: PhotoControlState; adjust(action: PhotoAdjustment): void; close(): void;
}) {
  const t = useTheme(), reduced = useReducedMotion();
  const { fontScale } = useWindowDimensions();
  const button = (action: PhotoAdjustment, label: string) => <View style={[styles.cell, fontScale >= 1.5 && styles.unflex]}>
    <Button variant="secondary" label={label} disabled={!state.enabled[action]} onPress={() => adjust(action)} />
  </View>;
  const move = (direction: 'left' | 'right' | 'up' | 'down') => <Pressable key={direction}
    accessibilityRole="button" accessibilityLabel={en.viewerPhotoMoves[direction]} accessibilityState={{ disabled: !state.enabled[direction] }}
    disabled={!state.enabled[direction]} onPress={() => adjust(direction)}
    style={({ pressed }) => [styles.move, fontScale >= 1.5 && styles.unflex, { backgroundColor: pressed ? t.pressed : t.raised, opacity: state.enabled[direction] ? 1 : 0.4 }]}>
    <Ionicons name={direction === 'left' ? 'arrow-back' : direction === 'right' ? 'arrow-forward' : direction === 'up' ? 'arrow-up' : 'arrow-down'} size={22} color={t.text} />
    <Text style={[type.footnote, { color: t.text }]}>{en.viewerPhotoDirections[direction]}</Text>
  </Pressable>;
  return <Modal visible={visible} transparent animationType={reduced ? 'none' : 'fade'} onRequestClose={close}>
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.backdrop}>
      <View accessibilityViewIsModal style={[styles.sheet, { backgroundColor: t.ground }]}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          <View style={styles.heading}>
            <Text accessibilityRole="header" style={[type.title, { color: t.text }]}>{en.viewerPhotoControls}</Text>
            <Text accessibilityLiveRegion="polite" style={[type.headline, { color: t.text }]}>{en.viewerZoomPercent(state.percent)}</Text>
          </View>
          <Text style={[type.footnote, { color: t.secondary }]}>{en.viewerPhotoControlsNote}</Text>
          <View style={[styles.row, fontScale >= 1.5 && styles.stacked]}>
            {button('zoom-out', en.viewerZoomOut)}{button('zoom-in', en.viewerZoomIn)}
          </View>
          <View style={styles.movement}>
            <Text accessibilityRole="header" style={[type.footnote, { color: t.secondary }]}>{en.viewerMovePhoto}</Text>
            <View style={[styles.row, fontScale >= 1.5 && styles.stacked]}>{(['left', 'right', 'up', 'down'] as const).map(move)}</View>
          </View>
          <Button variant="secondary" label={en.viewerResetZoom} disabled={!state.enabled.reset} onPress={() => adjust('reset')} />
        </ScrollView>
        <Button label={en.viewerPhotoControlsDone} onPress={close} />
      </View>
    </SafeAreaView>
  </Modal>;
}
const styles = StyleSheet.create({
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.25)' },
  sheet: { maxHeight: '90%', width: '100%', maxWidth: 560, alignSelf: 'center', padding: space.gutter, borderRadius: 24, gap: 16 },
  scroll: { flexShrink: 1 },
  content: { gap: 12, paddingBottom: 4 },
  heading: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  movement: { gap: 6 },
  move: { flex: 1, minHeight: 64, borderRadius: 16, alignItems: 'center', justifyContent: 'center', padding: 8, gap: 4 },
  row: { flexDirection: 'row', gap: 12 },
  stacked: { flexDirection: 'column' },
  cell: { flex: 1 },
  unflex: { flex: 0 },
});
