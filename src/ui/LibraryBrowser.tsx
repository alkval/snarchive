import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useReducer, useRef, useState, type MutableRefObject } from 'react';
import { ActivityIndicator, AppState, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ImportStore, ChronologicalRow } from '../storage/importStore';
import { thumbnail } from '../platform/originalImporter';
import { pageThumbnails } from '../storage/pageThumbnails';
import { librarySections } from '../domain/librarySections';
import { LibraryFilterForm } from './LibraryFilters';
import { dayTitle, memoryDate } from './MemoryViewer';
import { MemoryPager } from './MemoryPager';
import { MemorySequence } from '../domain/memoryNavigation';
import { FavoriteWrites } from '../domain/favoriteWrites';
import { LibraryGrid, favoriteSavedHandler } from '../domain/libraryGrid';
import { utcDay, watchUTCDate } from '../domain/onThisDay';
import { BackButton, Button, FadeImage, LargeTitle, Notice } from './kit';
import { space, type, useTheme } from './theme';
import { en } from '../i18n/en';

const COLUMNS = 3, GAP = 2;
type Section = { key: string; title: string; count: number; data: ChronologicalRow[][] };

function sections(rows: ChronologicalRow[]): Section[] {
  return librarySections(rows).map(section => ({
    key: section.key, count: section.rows.length,
    title: section.group === 'conflict' ? en.sectionConflict : section.group === 'unknown' ? en.sectionUnknown : dayTitle(section.group),
    data: Array.from({ length: Math.ceil(section.rows.length / COLUMNS) }, (_, index) => section.rows.slice(index * COLUMNS, index * COLUMNS + COLUMNS)),
  }));
}

export function LibraryBrowser({ store, onClose, backHandler }: { store: ImportStore; onClose: () => void; backHandler: MutableRefObject<(() => boolean) | null> }) {
  const t = useTheme();
  const [editingFilters, setEditingFilters] = useState(false);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [sequence, setSequence] = useState<MemorySequence<ChronologicalRow> | null>(null);
  /** Page, filters, history and every completed favourite save (see LibraryGrid). */
  const grid = useMemo(() => new LibraryGrid<ChronologicalRow>(
    (cursor, filters) => store.chronologicalPage(cursor, 31, filters),
    (key, filters) => store.chronologicalAdjacent(key, 'previous', 1, filters)), [store]);
  const [, render] = useReducer((value: number) => value + 1, 0);
  useEffect(() => { const stop = grid.subscribe(render); void grid.load(); return stop; }, [grid]);
  // Updated at the event boundary, so midnight/foreground callbacks need not wait for a React render.
  const latest = useRef(sequence);
  // Keep a viewer's date scope fixed. Refresh the grid at UTC midnight or on foreground when no viewer is open.
  useEffect(() => {
    const clock = watchUTCDate(day => { if (!latest.current) void grid.refreshDay(day); });
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') clock.refresh(); });
    return () => { clock.stop(); subscription.remove(); };
  }, [grid]);
  /** Favourite writes outlive each viewer (and the viewer itself), so a revisit shows a pending write. A completed
   * save always reaches the grid, whichever viewer started it and whenever it finishes; the open sequence, if it has
   * that memory loaded, is updated too. */
  const writes = useMemo(() => new FavoriteWrites((id, favorite) => store.setFavorite(id, favorite),
    favoriteSavedHandler(grid, () => latest.current)), [store, grid]);
  const rows = grid.rows, page = grid.pageRows, filters = grid.filters, history = grid.history;
  useEffect(() => { setPreviews({}); }, [page]);
  useEffect(() => {
    let stopped = false;
    if (!sequence) void pageThumbnails(page, store, thumbnail, () => stopped,
      (id, uri) => setPreviews(previous => ({ ...previous, [id]: uri })));
    return () => { stopped = true; };
  }, [page, sequence, store]);
  const open = (row: ChronologicalRow) => {
    if (grid.refreshDay(utcDay())) return;
    const index = rows.findIndex(item => item.id === row.id);
    if (index < 0) return;
    const current = filters;
    const next = new MemorySequence(rows, index, (anchor, direction, limit) => store.chronologicalAdjacent(anchor, direction, limit, current));
    latest.current = next;
    setSequence(next);
  };
  /** Back to the grid with the same filters: the same page (scroll position included) if the last memory viewed is
   * on it, otherwise a page starting at that memory, from which Previous returns here. */
  const closeViewer = (last: ChronologicalRow) => { latest.current = null; setSequence(null); void (grid.refreshDay(utcDay()) ?? grid.closedViewer(last)); };
  // System Back steps out of the viewer or filters before it leaves the library.
  useEffect(() => {
    backHandler.current = () => {
      if (sequence) { closeViewer(sequence.current); return true; }
      if (editingFilters) { setEditingFilters(false); return true; }
      return false;
    };
    return () => { backHandler.current = null; };
  });
  const grouped = useMemo(() => sections(rows), [rows]);
  const chips = en.filterChips(filters.media, filters.favorites, filters.month, filters.onThisDay);

  if (editingFilters) return <LibraryFilterForm current={filters} cancel={() => setEditingFilters(false)}
    apply={value => { void grid.setFilters(value); setEditingFilters(false); }} />;

  const header = <View style={styles.header}>
    <LargeTitle title={filters.onThisDay ? en.onThisDay : en.libraryTitle} subtitle={filters.onThisDay ? en.onThisDayScope(filters.onThisDay) : en.libraryOrder} />
    {filters.onThisDay
      ? <Button variant="plain" label={en.onThisDayAllDates} onPress={() => void grid.setFilters({ ...filters, onThisDay: '', month: '' })} />
      : <Button variant="secondary" icon="calendar-outline" label={en.onThisDay} onPress={() => void grid.setFilters({ ...filters, month: '', onThisDay: utcDay() })} />}
    {chips.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel={`${en.filterButton}: ${chips.join(', ')}`} onPress={() => setEditingFilters(true)} style={styles.chips}>
      {chips.map(chip => <View key={chip} style={[styles.chip, { backgroundColor: t.accentTint }]}><Text style={[type.caption, { color: t.accent }]}>{chip}</Text></View>)}
    </Pressable>}
  </View>;
  const empty = grid.loading ? <View style={styles.centered}><ActivityIndicator color={t.secondary} accessibilityLabel={en.libraryLoading} /></View>
    : grid.failed ? <View style={styles.pad}><Notice tone="error" message={en.libraryFailed} action={{ label: en.libraryRetry, onPress: () => void grid.retry() }} /></View>
    : <View style={styles.centered}>
      <Ionicons name={chips.length ? 'funnel-outline' : 'images-outline'} size={40} color={t.secondary} />
      <Text style={[type.body, styles.emptyText, { color: t.secondary }]}>{filters.onThisDay ? en.onThisDayEmpty : chips.length ? en.filterEmpty : en.libraryEmpty}</Text>
    </View>;
  // Pagination stays reachable even if every row on this page was hidden by saves.
  const footer = rows.length > 0 || history.length > 0 || grid.hasNext ? <View style={styles.footer}>
    {(history.length > 0 || grid.hasNext) && <View style={styles.pager}>
      <View style={styles.pagerButton}><Button variant="secondary" icon="chevron-back" label={en.libraryPrevious} disabled={!history.length}
        onPress={() => void grid.previousPage()} /></View>
      <Text style={[type.footnote, { color: t.secondary }]}>{en.libraryPage(history.length + 1)}</Text>
      <View style={styles.pagerButton}><Button variant="secondary" label={en.libraryNext} disabled={!grid.hasNext}
        onPress={() => void grid.nextPage()} /></View>
    </View>}
    <Text style={[type.footnote, { color: t.secondary, textAlign: 'center' }]}>{en.libraryPreviewNote}</Text>
  </View> : undefined;

  // The grid stays mounted under the viewer (hidden from assistive technology) so its scroll position survives.
  return <View style={styles.root}><SafeAreaView edges={['top', 'left', 'right']} style={[styles.root, { backgroundColor: t.ground }]}
    importantForAccessibility={sequence ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={!!sequence}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <View style={styles.topBar}>
      <BackButton label={en.libraryClose} onPress={onClose} />
      <Pressable accessibilityRole="button" accessibilityLabel={en.filterButton} onPress={() => setEditingFilters(true)} hitSlop={8}
        style={({ pressed }) => [styles.filterButton, { opacity: pressed ? 0.5 : 1 }]}>
        <Ionicons name={chips.length ? 'options' : 'options-outline'} size={22} color={t.accent} />
        <Text style={[type.body, { color: t.accent }]}>{en.filterButton}</Text>
      </Pressable>
    </View>
    <SectionList key={JSON.stringify(grid.cursor)} sections={grid.loading || grid.failed ? [] : grouped} keyExtractor={(item, index) => item[0]?.id ?? String(index)}
      ListHeaderComponent={header} ListEmptyComponent={empty} ListFooterComponent={footer} stickySectionHeadersEnabled
      renderSectionHeader={({ section }) => <View style={[styles.sectionHeader, { backgroundColor: t.ground }]} accessibilityRole="header">
        <Text style={[type.headline, { color: t.text }]}>{section.title}</Text>
        <Text style={[type.footnote, { color: t.secondary, fontVariant: ['tabular-nums'] }]}>{section.count}</Text>
      </View>}
      renderItem={({ item }) => <View style={styles.tileRow}>
        {item.map(row => {
          const date = memoryDate(row);
          const uri = previews[row.id];
          return <Pressable key={row.id} accessibilityRole="button" accessibilityLabel={en.libraryTile(date.title, row.videos > 0, row.favorite === 1)}
            onPress={() => open(row)} style={({ pressed }) => [styles.tile, { backgroundColor: t.raised, opacity: pressed ? 0.7 : 1 }]}>
            {uri ? <FadeImage accessible={false} source={{ uri }} resizeMode="cover" style={StyleSheet.absoluteFill}
              onError={() => setPreviews(previous => ({ ...previous, [row.id]: null }))} />
              : uri === null ? <View style={styles.missing}><Ionicons name="image-outline" size={24} color={t.secondary} accessibilityLabel={en.thumbnailMissing} /></View> : null}
            <View style={styles.badges} pointerEvents="none">
              {row.videos > 0 ? <Ionicons name="videocam" size={15} color="#FFFFFF" style={styles.badge} /> : <View />}
              {row.favorite === 1 && <Ionicons name="heart" size={15} color="#FFFFFF" style={styles.badge} />}
            </View>
          </Pressable>;
        })}
        {Array.from({ length: COLUMNS - item.length }, (_, index) => <View key={index} style={styles.spacer} />)}
      </View>} />
  </SafeAreaView>
    {sequence && <View style={StyleSheet.absoluteFill}>
      <MemoryPager sequence={sequence} store={store} writes={writes} onClose={closeViewer} />
    </View>}
  </View>;
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  topBar: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.gutter - 4 },
  filterButton: { flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 48, paddingLeft: 8 },
  header: { paddingHorizontal: space.gutter, paddingBottom: 12, gap: 12 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderRadius: 999, paddingHorizontal: 12, paddingVertical: 6 },
  sectionHeader: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', paddingHorizontal: space.gutter, paddingTop: 16, paddingBottom: 8 },
  tileRow: { flexDirection: 'row', gap: GAP, marginBottom: GAP },
  // Tiles share the row exactly; a short last row keeps their size with spacers.
  tile: { flex: 1, aspectRatio: 1 },
  spacer: { flex: 1 },
  missing: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
  badges: { position: 'absolute', left: 6, right: 6, bottom: 5, flexDirection: 'row', justifyContent: 'space-between' },
  badge: { textShadowColor: 'rgba(0,0,0,0.6)', textShadowRadius: 4, textShadowOffset: { width: 0, height: 1 } },
  centered: { alignItems: 'center', justifyContent: 'center', paddingVertical: 96, gap: 12, paddingHorizontal: space.gutter },
  emptyText: { textAlign: 'center' },
  pad: { paddingHorizontal: space.gutter },
  footer: { paddingHorizontal: space.gutter, paddingTop: 24, paddingBottom: 48, gap: 16 },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  pagerButton: { flex: 1 },
});
