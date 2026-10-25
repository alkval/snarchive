import { StatusBar } from 'expo-status-bar';
import { memo, useCallback, useEffect, useMemo, useReducer, useRef, useState, type MutableRefObject } from 'react';
import { ActivityIndicator, AppState, Image, Pressable, SectionList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ImportStore, ChronologicalRow, LibraryMonth } from '../storage/importStore';
import { memoryThumbnail } from '../platform/originalImporter';
import { pageThumbnails } from '../storage/pageThumbnails';
import { librarySections } from '../domain/librarySections';
import { LibraryFilterForm } from './LibraryFilters';
import { dayTitle, memoryDate } from './MemoryViewer';
import { MemoryPager } from './MemoryPager';
import { MemorySequence } from '../domain/memoryNavigation';
import { FavoriteWrites } from '../domain/favoriteWrites';
import { LibraryGrid, favoriteSavedHandler } from '../domain/libraryGrid';
import { ThumbnailWindow, visibleThumbnailRows } from '../domain/thumbnailWindow';
import { gridLayout, GRID_COLUMNS, GRID_GAP } from '../domain/gridLayout';
import { MonthScrollbar } from './MonthScrollbar';
import { utcDay, watchUTCDate } from '../domain/onThisDay';
import { Button, Notice } from './kit';
import { space, type, useTheme } from './theme';
import { en } from '../i18n/en';

const COLUMNS = GRID_COLUMNS, GAP = GRID_GAP;
type Section = { key: string; title: string; count: number; data: ChronologicalRow[][] };

function sections(rows: ChronologicalRow[]): Section[] {
  return librarySections(rows).map(section => ({
    key: section.key, count: section.rows.length,
    title: section.group === 'conflict' ? en.sectionConflict : section.group === 'unknown' ? en.sectionUnknown : dayTitle(section.group),
    data: Array.from({ length: Math.ceil(section.rows.length / COLUMNS) }, (_, index) => section.rows.slice(index * COLUMNS, index * COLUMNS + COLUMNS)),
  }));
}

export function LibraryBrowser({ store, onClose, backHandler, onAdd, onSettings, refreshToken = 0, onLibraryChanged, onNotice }: {
  store: ImportStore; onClose(): void; backHandler: MutableRefObject<(() => boolean) | null>;
  onAdd?(): void; onSettings?(): void; refreshToken?: number; onLibraryChanged?(): void; onNotice?(message: string): void;
}) {
  const t = useTheme();
  const screen = useWindowDimensions();
  const [listWidth, setListWidth] = useState(screen.width);
  const [listHeaderHeight, setListHeaderHeight] = useState(0);
  const [editingFilters, setEditingFilters] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [monthRevision, monthsChanged] = useReducer((value: number) => value + 1, 0);
  const [timeline, setTimeline] = useState<{ key: string; months: LibraryMonth[] }>({ key: '', months: [] });
  const [visibleMonth, setVisibleMonth] = useState<{ key: string; month: string } | null>(null);
  const [feedEpoch, setFeedEpoch] = useState(0);
  const jumpRequest = useRef(0);
  const [, thumbnailChanged] = useReducer((value: number) => value + 1, 0);
  const thumbnails = useMemo(() => new ThumbnailWindow<ChronologicalRow>(async row => {
    let uri: string | null = null;
    await pageThumbnails([row], store, memoryThumbnail, () => false, (_id, value) => { uri = value; });
    return uri;
  }), [store]);
  useEffect(() => thumbnails.subscribe(thumbnailChanged), [thumbnails]);
  useEffect(() => { thumbnails.reset(); }, [thumbnails, refreshToken]);
  const [sequence, setSequence] = useState<MemorySequence<ChronologicalRow> | null>(null);
  /** Page, filters, history and every completed favourite save (see LibraryGrid). */
  const grid = useMemo(() => new LibraryGrid<ChronologicalRow>(
    (cursor, filters) => store.chronologicalPage(cursor, 31, filters)), [store]);
  const [gridVersion, render] = useReducer((value: number) => value + 1, 0);
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
  const writes = useMemo(() => {
    const saved = favoriteSavedHandler(grid, () => latest.current);
    return new FavoriteWrites((id, favorite) => store.setFavorite(id, favorite), (id, favorite) => {
      saved(id, favorite); if (grid.filters.favorites) monthsChanged();
    });
  }, [store, grid]);
  const feed = useMemo(() => grid.feedRows, [grid, gridVersion]), filters = grid.filters;
  const filterKey = JSON.stringify(filters);
  useEffect(() => {
    let active = true;
    void store.chronologicalMonths(filters).then(months => { if (active) setTimeline({ key: filterKey, months }); },
      () => { if (active) setTimeline({ key: filterKey, months: [] }); });
    return () => { active = false; };
  }, [store, filterKey, refreshToken, monthRevision]);
  // A refresh (an import closed, a restore) reads the library again from its first page. Until that read lands, keep the
  // rows already shown rather than blanking the grid to a spinner and back; they cannot be opened meanwhile.
  const held = useRef({ key: '', rows: [] as ChronologicalRow[] });
  const holding = grid.loading && !feed.length && held.current.key === filterKey && held.current.rows.length > 0;
  if (!holding) held.current = { key: filterKey, rows: feed };
  const rows = holding ? held.current.rows : feed;
  const rowsRef = useRef(rows); rowsRef.current = rows;
  const thumbnailRef = useRef(thumbnails); thumbnailRef.current = thumbnails;
  const visibleIds = useRef<readonly string[]>([]);
  const visibleScope = useRef(filterKey);
  if (visibleScope.current !== filterKey) { visibleScope.current = filterKey; visibleIds.current = []; }
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10, minimumViewTime: 80 }).current;
  const viewability = useRef(({ viewableItems }: { viewableItems: { item: unknown }[] }) => {
    if (latest.current) return;
    const visible = viewableItems.flatMap(token => Array.isArray(token.item) ? token.item as ChronologicalRow[] : []);
    const ids = visible.map(row => row.id);
    const window = visibleThumbnailRows(rowsRef.current, ids);
    if (!window) return;
    // Visibility is an observation, not React state. Updating state here feeds list layout back into another
    // render and another visibility update. Once these thumbnails are cached, this callback causes no renders.
    visibleIds.current = ids;
    if (visible[0]) {
      const key = visibleScope.current, month = visible[0].sortDay.slice(0, 7);
      setVisibleMonth(previous => previous?.key === key && previous.month === month ? previous : { key, month });
    }
    thumbnailRef.current.setRows(window);
  }).current;
  const previousRevision = useRef(refreshToken);
  useEffect(() => { if (previousRevision.current !== refreshToken) { previousRevision.current = refreshToken; void grid.refresh(); } }, [refreshToken, grid]);
  useEffect(() => {
    thumbnails.setRows(sequence ? [] : visibleThumbnailRows(rows, visibleIds.current) ?? rows.slice(0, 30));
    return () => { thumbnails.setRows([]); };
  }, [rows, sequence, thumbnails]);
  const open = (row: ChronologicalRow) => {
    if (holding || grid.refreshDay(utcDay())) return;
    const index = rows.findIndex(item => item.id === row.id);
    if (index < 0) return;
    const current = filters;
    const next = new MemorySequence(rows, index, (anchor, direction, limit) => store.chronologicalAdjacent(anchor, direction, limit, current));
    latest.current = next;
    setSequence(next);
  };
  const openRef = useRef(open); openRef.current = open;
  const openTile = useCallback((row: ChronologicalRow) => openRef.current(row), []);
  const failThumbnail = useCallback((id: string, uri: string) => thumbnails.failed(id, uri), [thumbnails]);
  const jump = async (month: string) => {
    const request = ++jumpRequest.current;
    if (await grid.jumpToMonth(month) && jumpRequest.current === request) {
      visibleIds.current = []; setVisibleMonth({ key: filterKey, month }); setFeedEpoch(value => value + 1);
    }
  };
  const newest = async () => {
    const request = ++jumpRequest.current;
    await grid.refresh();
    if (jumpRequest.current === request) { visibleIds.current = []; setFeedEpoch(value => value + 1); }
  };
  /** Keep the grid's earlier rows and original scroll position; append towards the last viewed memory in bounded
   * batches. Never jump to a middle-only feed: it has no Previous button to recover omitted rows. */
  const closeViewer = (last: ChronologicalRow) => {
    latest.current = null; setSequence(null);
    const refreshed = grid.refreshDay(utcDay());
    if (!refreshed) void grid.extendFeedTo(last);
  };
  // System Back steps out of the viewer or filters before it leaves the library.
  useEffect(() => {
    backHandler.current = () => {
      if (deleting) return true;
      if (sequence) { if (sequence.current) closeViewer(sequence.current); else setSequence(null); return true; }
      if (editingFilters) { setEditingFilters(false); return true; }
      return false;
    };
    return () => { backHandler.current = null; };
  });
  const grouped = useMemo(() => sections(rows), [rows]);
  const chips = en.filterChips(filters.media, filters.favorites, filters.month, filters.onThisDay);
  const hasHeader = chips.length > 0 || grid.jumped;
  const layout = useMemo(() => gridLayout(grouped.map(section => section.data.length), listWidth, screen.fontScale,
    hasHeader ? listHeaderHeight : 0), [grouped, listWidth, screen.fontScale, hasHeader, listHeaderHeight]);

  const header = hasHeader ? <View style={styles.header} onLayout={event => setListHeaderHeight(event.nativeEvent.layout.height)}>
    {chips.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel={`${en.filterButton}: ${chips.join(', ')}`} onPress={() => setEditingFilters(true)} style={styles.chips}>
      {chips.map(chip => <View key={chip} style={[styles.chip, { backgroundColor: t.accentTint }]}><Text style={[type.caption, { color: t.accent }]}>{chip}</Text></View>)}
    </Pressable>}
    {grid.jumped && <Button label="Back to newest" variant="plain" onPress={() => void newest()} />}
  </View> : null;
  const empty = grid.loading ? <View style={styles.centered}><ActivityIndicator color={t.secondary} accessibilityLabel={en.libraryLoading} /></View>
    : grid.failed ? <View style={styles.pad}><Notice tone="error" message={en.libraryFailed} action={{ label: en.libraryRetry, onPress: () => void grid.retry() }} /></View>
    : <View style={styles.centered}>
      <Ionicons name={chips.length ? 'funnel-outline' : 'images-outline'} size={40} color={t.secondary} />
      <Text style={[type.body, styles.emptyText, { color: t.secondary }]}>{filters.onThisDay ? en.onThisDayEmpty : chips.length ? en.filterEmpty : en.libraryEmpty}</Text>
    </View>;
  const footer = <View style={styles.footer}>
    <View style={styles.loadingSlot}>
      {grid.loading && rows.length > 0 && <ActivityIndicator color={t.accent} accessibilityLabel="Loading more memories" />}
    </View>
    {grid.failed && rows.length > 0 && <Button label="Try loading more again" variant="plain" onPress={() => void grid.retry()} />}
    {!grid.loading && !rows.length && grid.hasNext && <Button label="Load more" onPress={() => void grid.nextPage()} />}
  </View>;
  // Keep the grid mounted and laid out for scroll retention, but exclude it from drawing, input and accessibility under
  // the viewer or filters. Remounting it would lose the scroll position and redraw every thumbnail.
  const covered = !!sequence || editingFilters;
  return <View style={styles.root}>
    <View collapsable={false} style={[styles.root, covered && styles.hiddenGrid]} pointerEvents={covered ? 'none' : 'auto'}
      importantForAccessibility={covered ? 'no-hide-descendants' : 'auto'} accessibilityElementsHidden={covered}>
    <SafeAreaView edges={['top', 'left', 'right']} style={[styles.root, { backgroundColor: t.ground }]}>
    <StatusBar style={t.dark ? 'light' : 'dark'} />
    <View style={styles.topBar}>
      <Text accessibilityRole="header" style={[type.title, { color: t.text, flex: 1 }]}>Snarchive</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Add memories" onPress={onAdd} style={[styles.addButton, { backgroundColor: t.accent }]}>
        <Ionicons name="add" size={22} color="#FFFFFF" /><Text style={[type.headline, { color: '#FFFFFF' }]}>Add</Text>
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel={en.filterButton} onPress={() => setEditingFilters(true)} hitSlop={4} style={styles.iconButton}>
        <Ionicons name={chips.length ? 'options' : 'options-outline'} size={23} color={t.text} />
      </Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={onSettings} hitSlop={4} style={styles.iconButton}>
        <Ionicons name="settings-outline" size={23} color={t.text} />
      </Pressable>
    </View>
    <View style={[styles.root, { flexDirection: 'row' }]}>
    <SectionList style={styles.root} key={`${filterKey}:${feedEpoch}`} sections={grouped} keyExtractor={(item, index) => item[0]?.id ?? String(index)}
      ListHeaderComponent={header ?? undefined} ListEmptyComponent={empty} ListFooterComponent={footer} stickySectionHeadersEnabled
      onEndReachedThreshold={0.5} onEndReached={() => { if (!grid.loading && !grid.failed && grid.hasNext) void grid.nextPage(); }}
      onViewableItemsChanged={viewability} viewabilityConfig={viewabilityConfig} initialNumToRender={12} windowSize={7}
      removeClippedSubviews={false}
      onLayout={event => setListWidth(event.nativeEvent.layout.width)}
      getItemLayout={(_data, index) => layout.cells[index]!}
      renderSectionHeader={({ section }) => <View style={[styles.sectionHeader, { backgroundColor: t.ground, height: layout.heading }]} accessibilityRole="header">
        <Text numberOfLines={1} style={[type.headline, { color: t.text, flex: 1 }]}>{section.title}</Text>
        <Text style={[type.footnote, { color: t.secondary, fontVariant: ['tabular-nums'] }]}>{section.count}</Text>
      </View>}
      renderItem={({ item }) => <View style={[styles.tileRow, { height: layout.tile }]}>
        {item.map(row => <LibraryTile key={row.id} row={row} uri={thumbnails.get(row.id)} disabled={holding}
          onOpen={openTile} onFailed={failThumbnail} />)}
        {Array.from({ length: COLUMNS - item.length }, (_, index) => <View key={index} style={styles.spacer} />)}
      </View>} />
    {timeline.key === filterKey && timeline.months.length > 1 && <MonthScrollbar key={filterKey} months={timeline.months} month={visibleMonth?.key === filterKey ? visibleMonth.month : null} select={month => void jump(month)} />}
    </View>
  </SafeAreaView>
    </View>
    {editingFilters && <View style={StyleSheet.absoluteFill}>
      <LibraryFilterForm current={filters} cancel={() => setEditingFilters(false)} apply={value => { void grid.setFilters(value); setEditingFilters(false); }} />
    </View>}
    {sequence && <View style={StyleSheet.absoluteFill}>
      <MemoryPager sequence={sequence} store={store} writes={writes} onClose={closeViewer} onBusy={setDeleting}
        onDeleted={(id, cleanupFailed) => { grid.memoryDeleted(id); monthsChanged(); onLibraryChanged?.(); onNotice?.(cleanupFailed ? 'Deleted. Some unused files could not be cleared; you can retry from Settings.' : 'Deleted'); }} />
    </View>}
  </View>;
}

/** A thumbnail result must not re-send every visible Image's props to Android. No fades in the scrolling grid. */
const LibraryTile = memo(function LibraryTile({ row, uri, disabled, onOpen, onFailed }: {
  row: ChronologicalRow; uri: string | null | undefined; disabled: boolean;
  onOpen(row: ChronologicalRow): void; onFailed(id: string, uri: string): void;
}) {
  const t = useTheme();
  const date = memoryDate(row);
  const source = useMemo(() => uri ? { uri } : undefined, [uri]);
  return <Pressable disabled={disabled} accessibilityRole="button"
    accessibilityLabel={en.libraryTile(date.title, row.videos > 0, row.favorite === 1)}
    onPress={() => onOpen(row)} style={({ pressed }) => [styles.tile, { backgroundColor: t.raised, opacity: pressed ? 0.7 : 1 }]}>
    {source ? <Image accessible={false} source={source} resizeMode="cover" fadeDuration={0} style={StyleSheet.absoluteFill}
      onError={() => { if (uri) onFailed(row.id, uri); }} />
      : uri === null ? <View style={styles.missing}><Ionicons name="image-outline" size={24} color={t.secondary} accessibilityLabel={en.thumbnailMissing} /></View> : null}
    <View style={styles.badges} pointerEvents="none">
      {row.videos > 0 ? <Ionicons name="videocam" size={15} color="#FFFFFF" style={styles.badge} /> : <View />}
      {row.favorite === 1 && <Ionicons name="heart" size={15} color="#FFFFFF" style={styles.badge} />}
    </View>
  </Pressable>;
});

const styles = StyleSheet.create({
  root: { flex: 1 },
  hiddenGrid: { opacity: 0 },
  topBar: { minHeight: 52, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: space.gutter - 4 },
  addButton: { flexDirection: 'row', gap: 4, alignItems: 'center', paddingHorizontal: 14, minHeight: 42, borderRadius: 22 },
  iconButton: { width: 44, height: 48, alignItems: 'center', justifyContent: 'center' },
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
  loadingSlot: { height: 24, alignItems: 'center', justifyContent: 'center' },
  pager: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  pagerButton: { flex: 1 },
});
