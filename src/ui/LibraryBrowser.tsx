import { StatusBar } from 'expo-status-bar';
import { useEffect, useMemo, useRef, useState, type MutableRefObject } from 'react';
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ImportStore, LibraryCursor, ChronologicalRow } from '../storage/importStore';
import { thumbnail } from '../platform/originalImporter';
import { pageThumbnails } from '../storage/pageThumbnails';
import { defaultFilters, type LibraryFilters } from '../domain/libraryFilters';
import { librarySections } from '../domain/librarySections';
import { LibraryFilterForm } from './LibraryFilters';
import { dayTitle, memoryDate } from './MemoryViewer';
import { MemoryPager } from './MemoryPager';
import { MemorySequence, keyOf } from '../domain/memoryNavigation';
import { matchesFilters } from '../domain/libraryFilters';
import { FavoriteWrites } from '../domain/favoriteWrites';
import { emptyPageFallback, patchFavorites, returnToGrid } from '../domain/gridReturn';
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
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [filters, setFilters] = useState<LibraryFilters>({ ...defaultFilters });
  const [editingFilters, setEditingFilters] = useState(false);
  const [rows, setRows] = useState<ChronologicalRow[]>([]);
  const [cursor, setCursor] = useState<LibraryCursor | null>(null);
  const [history, setHistory] = useState<(LibraryCursor | null)[]>([]);
  const [previews, setPreviews] = useState<Record<string, string | null>>({});
  const [next, setNext] = useState(false);
  const [sequence, setSequence] = useState<MemorySequence<ChronologicalRow> | null>(null);
  /** Favourite states saved from the viewer since it opened, by memory ID. */
  const favorites = useRef(new Map<string, boolean>());
  const latest = useRef({ sequence, filters });
  latest.current = { sequence, filters };
  /** Favourite writes outlive each viewer (and the viewer itself), so a revisit shows a pending write and a save
   * that finishes later still updates the open sequence or the grid. */
  const writes = useMemo(() => new FavoriteWrites((id, favorite) => store.setFavorite(id, favorite), (id, favorite) => {
    favorites.current.set(id, favorite);
    const { sequence: open, filters: active } = latest.current;
    const loaded = open?.row(id);
    if (open && loaded) { const updated = { ...loaded, favorite: favorite ? 1 : 0 }; open.update(updated, matchesFilters(updated, active)); }
    else if (!open && mounted.current) setRows(previous => {
      const patched = patchFavorites(previous, new Map([[id, favorite]]), active);
      if (previous.length && !patched.length) emptied.current = true; // Recovered by the reload below.
      return patched;
    });
  }), [store]);
  const emptied = useRef(false);
  useEffect(() => { if (emptied.current) { emptied.current = false; setRetry(value => value + 1); } }, [rows]);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true; setLoading(true); setFailed(false); setRows([]); setPreviews({});
    void store.chronologicalPage(cursor, 31, filters).then(page => {
      if (!active) return;
      // A later page can empty (for example after favourites were removed): step back to the page before it.
      const fallback = page.length ? null : emptyPageFallback(cursor, history);
      if (fallback) { setCursor(fallback.cursor); setHistory(fallback.history); return; }
      setRows(page.slice(0, 30)); setNext(page.length > 30);
    })
      .catch(() => { if (active) setFailed(true); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [store, cursor, retry, filters]);
  useEffect(() => {
    let stopped = false;
    if (!sequence) void pageThumbnails(rows, store, thumbnail, () => stopped,
      (id, uri) => setPreviews(previous => ({ ...previous, [id]: uri })));
    return () => { stopped = true; };
  }, [rows, sequence, store]);
  const open = (row: ChronologicalRow) => {
    const index = rows.findIndex(item => item.id === row.id);
    if (index < 0) return;
    const current = filters;
    favorites.current = new Map();
    setSequence(new MemorySequence(rows, index, (anchor, direction, limit) => store.chronologicalAdjacent(anchor, direction, limit, current)));
  };
  /** Back to the grid with the same filters. If the last memory viewed is on this page, the page stays as it was
   * (scroll position included), with favourite changes applied. Otherwise the grid opens at a page starting at that
   * memory, and Previous returns to the page the viewer was opened from. */
  const closeViewer = (last: ChronologicalRow) => {
    setSequence(null);
    const decision = returnToGrid(rows, last.id, favorites.current, filters);
    if (decision.kind === 'keep') { if (favorites.current.size) setRows(decision.rows); return; }
    // The page emptied (every memory on it was unfavourited): read it again; an empty later page steps back.
    if (decision.kind === 'reload') { setRetry(value => value + 1); return; }
    const from = cursor, past = history;
    void store.chronologicalAdjacent(keyOf(last), 'previous', 1, filters).then(before => {
      if (!mounted.current) return;
      const start = before[0] ? keyOf(before[0]) : null;
      setHistory(start ? [...past, from] : []); setCursor(start);
    }).catch(() => { if (mounted.current) setRetry(value => value + 1); });
  };
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
  const chips = en.filterChips(filters.media, filters.favorites, filters.month);

  if (editingFilters) return <LibraryFilterForm current={filters} cancel={() => setEditingFilters(false)}
    apply={value => { setFilters(value); setCursor(null); setHistory([]); setEditingFilters(false); }} />;

  const header = <View style={styles.header}>
    <LargeTitle title={en.libraryTitle} subtitle={en.libraryOrder} />
    {chips.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel={`${en.filterButton}: ${chips.join(', ')}`} onPress={() => setEditingFilters(true)} style={styles.chips}>
      {chips.map(chip => <View key={chip} style={[styles.chip, { backgroundColor: t.accentTint }]}><Text style={[type.caption, { color: t.accent }]}>{chip}</Text></View>)}
    </Pressable>}
  </View>;
  const empty = loading ? <View style={styles.centered}><ActivityIndicator color={t.secondary} accessibilityLabel={en.libraryLoading} /></View>
    : failed ? <View style={styles.pad}><Notice tone="error" message={en.libraryFailed} action={{ label: en.libraryRetry, onPress: () => setRetry(value => value + 1) }} /></View>
    : <View style={styles.centered}>
      <Ionicons name={chips.length ? 'funnel-outline' : 'images-outline'} size={40} color={t.secondary} />
      <Text style={[type.body, styles.emptyText, { color: t.secondary }]}>{chips.length ? en.filterEmpty : en.libraryEmpty}</Text>
    </View>;
  const footer = rows.length > 0 ? <View style={styles.footer}>
    {(history.length > 0 || next) && <View style={styles.pager}>
      <View style={styles.pagerButton}><Button variant="secondary" icon="chevron-back" label={en.libraryPrevious} disabled={!history.length}
        onPress={() => { setCursor(history[history.length - 1]!); setHistory(history.slice(0, -1)); }} /></View>
      <Text style={[type.footnote, { color: t.secondary }]}>{en.libraryPage(history.length + 1)}</Text>
      <View style={styles.pagerButton}><Button variant="secondary" label={en.libraryNext} disabled={!next}
        onPress={() => { setHistory([...history, cursor]); const last = rows[rows.length - 1]!; setCursor({ day: last.sortDay, time: last.sortTime, id: last.id }); }} /></View>
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
    <SectionList key={JSON.stringify(cursor)} sections={loading || failed ? [] : grouped} keyExtractor={(item, index) => item[0]?.id ?? String(index)}
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
