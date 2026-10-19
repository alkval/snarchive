import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { defaultFilters, validFilters, type LibraryFilters } from '../domain/libraryFilters';
import { en } from '../i18n/en';
import { Button, Group, Notice, Segmented } from './kit';
import { space, type, useTheme } from './theme';

export function LibraryFilterForm({ current, apply, cancel }: { current: LibraryFilters; apply: (filters: LibraryFilters) => void; cancel: () => void }) {
  const t = useTheme();
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState(false);
  const submit = () => { if (validFilters(draft)) apply(draft); else setError(true); };
  return <SafeAreaView edges={['top', 'left', 'right']} style={[styles.root, { backgroundColor: t.ground }]}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <View style={styles.topBar}>
      <Pressable accessibilityRole="button" onPress={cancel} hitSlop={8} style={({ pressed }) => [styles.barButton, { opacity: pressed ? 0.5 : 1 }]}>
        <Text style={[type.body, { color: t.accent }]}>{en.filterCancel}</Text>
      </Pressable>
      <Text accessibilityRole="header" style={[type.headline, { color: t.text }]}>{en.filtersTitle}</Text>
      <Pressable accessibilityRole="button" onPress={submit} hitSlop={8} style={({ pressed }) => [styles.barButton, styles.barRight, { opacity: pressed ? 0.5 : 1 }]}>
        <Text style={[type.headline, { color: t.accent }]}>{en.filterApply}</Text>
      </Pressable>
    </View>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
      <View style={styles.block}>
        <Text accessibilityRole="header" style={[type.headline, styles.label, { color: t.text }]}>{en.filterMediaHeader}</Text>
        <Segmented label={en.filterMediaHeader} value={draft.media} onChange={media => setDraft({ ...draft, media })}
          options={(['all', 'photos', 'videos'] as const).map(value => ({ value, label: en.filterMedia[value] }))} />
      </View>
      <Group>
        <Pressable accessibilityRole="switch" accessibilityState={{ checked: draft.favorites }} accessibilityLabel={en.favoritesOnly}
          onPress={() => setDraft({ ...draft, favorites: !draft.favorites })} style={({ pressed }) => [styles.switchRow, { backgroundColor: pressed ? t.pressed : 'transparent' }]}>
          <Text style={[type.body, { color: t.text, flex: 1 }]}>{en.favoritesOnly}</Text>
          <Switch accessible={false} value={draft.favorites} onValueChange={favorites => setDraft({ ...draft, favorites })}
            trackColor={{ true: t.accent, false: t.raised }} thumbColor="#FFFFFF" />
        </Pressable>
      </Group>
      <Group header={en.filterMonth} footer={en.filterMonthNote}>
        <TextInput accessibilityLabel={en.filterMonth} value={draft.month} onChangeText={month => { setDraft({ ...draft, month }); setError(false); }}
          placeholder={en.filterMonthPlaceholder} placeholderTextColor={t.secondary} autoCorrect={false} autoCapitalize="none" maxLength={7}
          keyboardType="numbers-and-punctuation" returnKeyType="done" onSubmitEditing={submit} selectionColor={t.accent}
          style={[type.body, styles.input, { color: t.text }]} />
      </Group>
      {error && <Notice tone="warning" message={en.filterInvalid} />}
      <Button variant="plain" label={en.filterClear} onPress={() => apply({ ...defaultFilters })} />
    </ScrollView>
  </SafeAreaView>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { minHeight: 56, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.gutter },
  barButton: { minHeight: 48, minWidth: 72, justifyContent: 'center' },
  barRight: { alignItems: 'flex-end' },
  content: { paddingHorizontal: space.gutter, paddingTop: 12, paddingBottom: 48, gap: space.section },
  block: { gap: 8 },
  label: { marginHorizontal: 4 },
  switchRow: { minHeight: space.row, paddingHorizontal: 16, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 12 },
  input: { minHeight: space.row, paddingHorizontal: 16, paddingVertical: 12 },
});
