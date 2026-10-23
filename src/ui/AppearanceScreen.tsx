import { useEffect } from 'react';
import { BackHandler, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import Ionicons from '@expo/vector-icons/Ionicons';
import { appearanceChoices } from '../domain/appearance';
import { en } from '../i18n/en';
import { useAppearance } from './appearanceContext';
import { BackButton, Group, LargeTitle, Notice } from './kit';
import { space, type, useTheme } from './theme';

export function AppearanceScreen({ onClose }: { onClose(): void }) {
  const t = useTheme();
  const { preferences, state } = useAppearance();
  useEffect(() => {
    const back = BackHandler.addEventListener('hardwareBackPress', () => { onClose(); return true; });
    return () => back.remove();
  }, [onClose]);
  const disabled = !state.loaded || state.loading || state.pending !== null;
  return <SafeAreaView edges={['top', 'left', 'right']} style={[styles.root, { backgroundColor: t.ground }]}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <View style={styles.bar}><BackButton label={en.title} onPress={onClose} /></View>
    <ScrollView contentContainerStyle={styles.content}>
      <LargeTitle title={en.appearanceTitle} subtitle={en.appearanceNote} />
      <View accessibilityRole="radiogroup" accessibilityLabel={en.appearanceTitle}>
        <Group footer={en.appearanceLocalNote}>
          {appearanceChoices.map(choice => <Pressable key={choice} accessibilityRole="radio" accessibilityLabel={en.appearanceChoices[choice]}
            accessibilityState={{ selected: state.choice === choice, disabled, busy: state.pending === choice }} disabled={disabled}
            onPress={() => void preferences.choose(choice)}
            style={({ pressed }) => [styles.row, { backgroundColor: pressed ? t.pressed : 'transparent', opacity: disabled ? 0.5 : 1 }]}>
            <Text style={[type.body, { color: t.text, flex: 1 }]}>{en.appearanceChoices[choice]}</Text>
            {state.choice === choice && <Ionicons name="checkmark" size={22} color={t.accent} />}
          </Pressable>)}
        </Group>
      </View>
      {state.pending !== null && <Notice tone="progress" message={en.appearanceSaving} />}
      {state.loading && <Notice tone="progress" message={en.appearanceLoading} />}
      {state.error && <Notice tone="warning" message={state.error === 'load' ? en.appearanceLoadFailed : en.appearanceSaveFailed}
        action={state.error === 'load' ? { label: en.retry, onPress: () => void preferences.load() } : undefined} />}
    </ScrollView>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  root: { flex: 1 },
  bar: { minHeight: 56, paddingHorizontal: space.gutter, justifyContent: 'center' },
  content: { paddingHorizontal: space.gutter, paddingBottom: 48, gap: space.section, width: '100%', maxWidth: 640, alignSelf: 'center' },
  row: { minHeight: space.row, paddingHorizontal: 16, paddingVertical: 14, flexDirection: 'row', alignItems: 'center', gap: 12 },
});
