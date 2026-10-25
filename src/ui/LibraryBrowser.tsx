import { StatusBar } from 'expo-status-bar';
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type MutableRefObject } from 'react';
import { ActivityIndicator, AppState, Image, Pressable, FlatList, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ImportStore, ChronologicalRow } from '../storage/importStore';
import { memoryThumbnail } from '../platform/originalImporter';
import { pageThumbnails } from '../storage/pageThumbnails';
import { LibraryFilterForm } from './LibraryFilters';
import { dayTitle, memoryDate } from './MemoryViewer';
import { MemoryPager } from './MemoryPager';
import { MemorySequence } from '../domain/memoryNavigation';
import { FavoriteWrites } from '../domain/favoriteWrites';
import { favoriteSavedHandler } from '../domain/libraryGrid';
import { ThumbnailWindow } from '../domain/thumbnailWindow';
import { GRID_COLUMNS, GRID_GAP } from '../domain/gridLayout';
import { MonthScrollbar } from './MonthScrollbar';
import { utcDay, watchUTCDate } from '../domain/onThisDay';
import { Notice } from './kit';
import { space, type, useTheme } from './theme';
import { en } from '../i18n/en';

import { LibraryTimeline } from '../domain/libraryTimeline';
import { timelineLayout, TimelinePosition, clampFraction, restoredTimelineOffset, type TimelineCell } from '../domain/timelineLayout';

const COLUMNS = GRID_COLUMNS, GAP = GRID_GAP;

export function LibraryBrowser({ store, onClose, backHandler, onAdd, onSettings, refreshToken = 0, onLibraryChanged, onNotice }: {
  store: ImportStore; onClose(): void; backHandler: MutableRefObject<(() => boolean) | null>;
  onAdd?(): void; onSettings?(): void; refreshToken?: number; onLibraryChanged?(): void; onNotice?(message: string): void;
}) {
  const t = useTheme(), screen = useWindowDimensions();
  const [listWidth, setListWidth] = useState(screen.width - 32), [viewport, setViewport] = useState(0);
  const [editingFilters, setEditingFilters] = useState(false), [deleting, setDeleting] = useState(false);
  const [, render] = useReducer(n => n + 1, 0), [, thumbnailChanged] = useReducer(n => n + 1, 0);
  const [sequence, setSequence] = useState<MemorySequence<ChronologicalRow> | null>(null);
  const latest = useRef(sequence), list = useRef<FlatList<TimelineCell>>(null), scrollY = useRef(0);
  const position = useMemo(() => new TimelinePosition(), []);
  const grid = useMemo(() => new LibraryTimeline<ChronologicalRow>(filters => store.chronologicalIndex(filters), ids => store.chronologicalRows(ids)), [store]);
  useEffect(() => { const stop = grid.subscribe(render); void grid.load(); return () => { stop(); grid.dispose(); }; }, [grid]);
  const thumbnails = useMemo(() => new ThumbnailWindow<ChronologicalRow>(async row => {
    let uri: string | null = null;
    await pageThumbnails([row], store, memoryThumbnail, () => false, (_id, value) => { uri = value; });
    return uri;
  }), [store]);
  useEffect(() => thumbnails.subscribe(thumbnailChanged), [thumbnails]);
  useEffect(() => { thumbnails.reset(); }, [thumbnails, refreshToken]);
  useEffect(() => {
    const clock = watchUTCDate(day => { if (!latest.current) void grid.refreshDay(day); });
    const subscription = AppState.addEventListener('change', state => { if (state === 'active') clock.refresh(); });
    return () => { clock.stop(); subscription.remove(); };
  }, [grid]);
  const writes = useMemo(() => new FavoriteWrites((id, favorite) => store.setFavorite(id, favorite),
    favoriteSavedHandler<ChronologicalRow>(grid, () => latest.current)), [store, grid]);
  const filters = grid.filters, filterKey = JSON.stringify(filters);
  const layout = useMemo(() => timelineLayout(grid.entries, listWidth, screen.fontScale), [grid.entries, listWidth, screen.fontScale]);
  const maxScroll = Math.max(0, layout.total - viewport);
  const anchor = useRef<{ id: string; within: number; at: number } | null>(null);
  const shownFilter = useRef(filterKey);
  // Retain the visible memory across a favourite/deletion refresh or rotation. New filter scopes start at the top.
  useLayoutEffect(() => {
    const previous = anchor.current;
    const newScope = shownFilter.current !== filterKey; shownFilter.current = filterKey;
    if (newScope) anchor.current = null;
    if (!layout.cells.length) anchor.current = null;
    const offset = restoredTimelineOffset(layout, previous, viewport, scrollY.current, newScope);
    scrollY.current = offset;
    list.current?.scrollToOffset({ offset, animated: false });
    position.set(maxScroll ? offset / maxScroll : 0, layout.cellAt(offset)?.group ?? '');
  }, [layout, viewport, filterKey, maxScroll, position]);
  const observe = (y: number) => {
    const offset = Math.max(0, Math.min(maxScroll, y)); scrollY.current = offset;
    const cell = layout.cellAt(offset);
    const at = cell ? cell.index : -1;
    const row = cell?.entries.length ? cell : layout.cells[at + 1];
    if (row?.entries[0]) anchor.current = { id: row.entries[0].id, within: offset - row.offset, at: Math.max(0, at) };
    position.set(maxScroll ? offset / maxScroll : 0, cell?.group ?? '');
  };
  const seek = (fraction: number) => {
    const offset = clampFraction(fraction) * maxScroll;
    list.current?.scrollToOffset({ offset, animated: false }); observe(offset);
    const cell = layout.cellAt(offset), at = cell ? cell.index : -1;
    grid.show((cell?.entries.length ? cell : layout.cells[at + 1])?.entries.map(entry => entry.id) ?? []);
    if (!latest.current) thumbnails.setRows(grid.visibleRows);
  };
  const marks = useMemo(() => {
    const seen = new Set<string>();
    return layout.cells.flatMap(cell => {
      const month = /^\d{4}-\d{2}/.test(cell.group) ? cell.group.slice(0, 7) : '';
      if (seen.has(month)) return []; seen.add(month);
      return [{ month, fraction: maxScroll ? Math.min(1, cell.offset / maxScroll) : 0 }];
    });
  }, [layout, maxScroll]);
  const viewRef = useRef({ grid, thumbnails }); viewRef.current = { grid, thumbnails };
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10, minimumViewTime: 50 }).current;
  const viewability = useRef(({ viewableItems }: { viewableItems: { item: TimelineCell }[] }) => {
    if (latest.current) return;
    const { grid, thumbnails } = viewRef.current;
    grid.show(viewableItems.flatMap(token => token.item.entries.map(entry => entry.id)));
    thumbnails.setRows(grid.visibleRows);
  }).current;
  useEffect(() => { thumbnails.setRows(sequence ? [] : grid.visibleRows); });
  useEffect(() => () => { thumbnails.setRows([]); }, [thumbnails]);
  const previousRevision = useRef(refreshToken);
  useEffect(() => { if (previousRevision.current !== refreshToken) { previousRevision.current = refreshToken; void grid.refresh(); } }, [refreshToken, grid]);
  const open = (row: ChronologicalRow) => {
    if (grid.loading || grid.failed || grid.refreshDay(utcDay())) return;
    // Sparse display caches need not be adjacent. Start from the selected row and fetch strict neighbours.
    const current = { ...filters };
    const next = new MemorySequence([row], 0, (key, direction, limit) => store.chronologicalAdjacent(key, direction, limit, current));
    latest.current = next; setSequence(next);
  };
  const openRef = useRef(open); openRef.current = open;
  const openTile = useCallback((row: ChronologicalRow) => openRef.current(row), []);
  const failThumbnail = useCallback((id: string, uri: string) => thumbnails.failed(id, uri), [thumbnails]);
  const closeViewer = () => { latest.current = null; setSequence(null); void grid.refreshDay(utcDay()); };
  useEffect(() => {
    backHandler.current = () => {
      if (deleting) return true;
      if (sequence) { closeViewer(); return true; }
      if (editingFilters) { setEditingFilters(false); return true; }
      return false;
    };
    return () => { backHandler.current = null; };
  });
  const chips = en.filterChips(filters.media, filters.favorites, filters.month, filters.onThisDay);
  const empty = grid.loading ? <View style={styles.centered}><ActivityIndicator color={t.secondary} accessibilityLabel={en.libraryLoading} /></View>
    : grid.failed ? <View style={styles.pad}><Notice tone="error" message={en.libraryFailed} action={{ label: en.libraryRetry, onPress: () => void grid.load() }} /></View>
    : <View style={styles.centered}><Text style={[type.body, styles.emptyText, { color: t.secondary }]}>{filters.onThisDay ? en.onThisDayEmpty : chips.length ? en.filterEmpty : en.libraryEmpty}</Text></View>;
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
        <Pressable accessibilityRole="button" accessibilityLabel={en.filterButton} onPress={() => setEditingFilters(true)} style={styles.iconButton}>
          <Ionicons name={chips.length ? 'options' : 'options-outline'} size={23} color={t.text} />
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Settings" onPress={onSettings} style={styles.iconButton}>
          <Ionicons name="settings-outline" size={23} color={t.text} />
        </Pressable>
      </View>
      {chips.length > 0 && <Pressable accessibilityRole="button" accessibilityLabel={`${en.filterButton}: ${chips.join(', ')}`} onPress={() => setEditingFilters(true)} style={styles.chips}>
        {chips.map(chip => <View key={chip} style={[styles.chip, { backgroundColor: t.accentTint }]}><Text style={[type.caption, { color: t.accent }]}>{chip}</Text></View>)}
      </Pressable>}
      {grid.entries.length > 0 && (grid.failed || grid.rowsFailed) && <Notice tone="error" message={en.libraryFailed}
        action={{ label: en.libraryRetry, onPress: () => grid.failed ? void grid.load() : grid.retryRows() }} />}
      <View style={[styles.root, { flexDirection: 'row' }]}>
        <FlatList ref={list} style={styles.root} key={filterKey} data={layout.cells} stickyHeaderIndices={layout.headers} extraData={grid.visibleRows}
          keyExtractor={cell => cell.key} ListEmptyComponent={empty} ListFooterComponent={grid.entries.length ? <View style={{ height: 48 }} /> : undefined}
          initialNumToRender={12} windowSize={7} removeClippedSubviews={false} showsVerticalScrollIndicator={false}
          onLayout={event => { setListWidth(event.nativeEvent.layout.width); setViewport(event.nativeEvent.layout.height); }}
          getItemLayout={(_data, index) => ({ index, offset: layout.cells[index]!.offset, length: layout.cells[index]!.length })}
          onScroll={event => observe(event.nativeEvent.contentOffset.y)} scrollEventThrottle={16}
          onViewableItemsChanged={viewability} viewabilityConfig={viewabilityConfig}
          renderItem={({ item }) => item.entries.length ? <View style={[styles.tileRow, { height: layout.tile }]}>
            {item.entries.map(entry => { const row = grid.row(entry.id); return row ? <LibraryTile key={entry.id} row={row} uri={thumbnails.get(row.id)} disabled={grid.loading || grid.failed}
              onOpen={openTile} onFailed={failThumbnail} /> : <View key={entry.id} style={[styles.tile, { backgroundColor: t.raised }]} />; })}
            {Array.from({ length: COLUMNS - item.entries.length }, (_, index) => <View key={index} style={styles.spacer} />)}
          </View> : <View style={[styles.sectionHeader, { backgroundColor: t.ground, height: item.length }]} accessibilityRole="header">
            <Text numberOfLines={1} style={[type.headline, { color: t.text, flex: 1 }]}>{item.group === 'conflict' ? en.sectionConflict : item.group === 'unknown' ? en.sectionUnknown : dayTitle(item.group)}</Text>
            <Text style={[type.footnote, { color: t.secondary }]}>{item.count}</Text>
          </View>} />
        {maxScroll > 0 ? <MonthScrollbar position={position} marks={marks} seek={seek} /> : <View style={{ width: 32 }} />}
      </View>
    </SafeAreaView>
    </View>
    {editingFilters && <View style={StyleSheet.absoluteFill}><LibraryFilterForm current={filters} cancel={() => setEditingFilters(false)} apply={value => { void grid.setFilters(value); setEditingFilters(false); }} /></View>}
    {sequence && <View style={StyleSheet.absoluteFill}><MemoryPager sequence={sequence} store={store} writes={writes} onClose={closeViewer} onBusy={setDeleting}
      onDeleted={(id, cleanupFailed) => { grid.memoryDeleted(id); onLibraryChanged?.(); onNotice?.(cleanupFailed ? 'Deleted. Some unused files could not be cleared; you can retry from Settings.' : 'Deleted'); }} /></View>}
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
