import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput } from 'react-native';
import { defaultFilters, validFilters, type LibraryFilters } from '../domain/libraryFilters';
import { en } from '../i18n/en';
export function LibraryFilterForm({ current, apply, cancel }: { current: LibraryFilters; apply: (filters: LibraryFilters) => void; cancel: () => void }) {
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState(false);
  function button(label: string, onPress: () => void, selected?: boolean) {
    return <Pressable key={label} accessibilityRole="button" accessibilityState={{ selected }} onPress={onPress} style={[styles.button, selected && styles.selected]}><Text style={styles.text}>{label}</Text></Pressable>;
  }
  return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
    <Text accessibilityRole="header" style={styles.text}>{en.filtersTitle}</Text>
    {(['all', 'photos', 'videos'] as const).map(media => button(en.filterMedia[media], () => setDraft({ ...draft, media }), draft.media === media))}
    {button(draft.favorites ? en.favoritesOnlyOn : en.favoritesOnlyOff, () => setDraft({ ...draft, favorites: !draft.favorites }), draft.favorites)}
    <Text style={styles.text}>{en.filterMonth}</Text>
    <TextInput accessibilityLabel={en.filterMonth} value={draft.month} onChangeText={month => { setDraft({ ...draft, month }); setError(false); }} placeholder="YYYY-MM" placeholderTextColor="#b9c2bc" autoCorrect={false} autoCapitalize="none" maxLength={7} style={[styles.button, styles.text]} />
    <Text style={styles.text}>{en.filterMonthNote}</Text>
    {error && <Text accessibilityLiveRegion="polite" style={styles.text}>{en.filterInvalid}</Text>}
    {button(en.filterApply, () => { if (validFilters(draft)) apply(draft); else setError(true); })}
    {button(en.filterClear, () => apply({ ...defaultFilters }))}
    {button(en.filterCancel, cancel)}
  </ScrollView>;
}
const styles = StyleSheet.create({ content: { gap: 12, paddingBottom: 20 }, button: { padding: 14, minHeight: 48, borderWidth: 1, borderColor: '#b9c2bc', borderRadius: 8 }, selected: { backgroundColor: '#244f37' }, text: { color: '#f3f4ef', fontSize: 16 } });
