import { useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { ViewerMediaCache } from '../domain/viewerMediaCache';
import { loadViewerMedia, type ViewerMedia } from '../platform/viewerMedia';
import { deleteMemory } from '../platform/storageCleanup';
import type { ChronologicalRow, ImportStore } from '../storage/importStore';
import type { Direction, MemorySequence } from '../domain/memoryNavigation';
import type { FavoriteWrites } from '../domain/favoriteWrites';
import { MemoryViewer } from './MemoryViewer';

/** Shows the open memory of a sequence and moves through it. Each memory gets a fresh viewer (keyed by ID). Favourite
 * writes belong to the library browser, which updates the sequence's rows when they are saved. */
export function MemoryPager({ sequence, store, writes, onClose, onDeleted, onBusy }: {
  sequence: MemorySequence<ChronologicalRow>; store: ImportStore; writes: FavoriteWrites; onClose: (last: ChronologicalRow) => void;
  onDeleted(id: string, cleanupFailed: boolean): void; onBusy(value: boolean): void;
}) {
  const [, render] = useReducer((value: number) => value + 1, 0);
  const [failed, setFailed] = useState<Direction | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => sequence.subscribe(render), [sequence]);
  useEffect(() => writes.subscribe(render), [writes]);
  useEffect(() => { sequence.prepare(); }, [sequence]);
  const cache = useMemo(() => new ViewerMediaCache<ViewerMedia>(id => {
    const item = sequence.row(id); if (!item) throw new Error('memory-unavailable');
    return loadViewerMedia(store, item);
  }), [sequence, store]);
  useEffect(() => cache.subscribe(render), [cache]);
  const current = sequence.current, previous = sequence.peek('previous'), next = sequence.peek('next');
  useEffect(() => { for (const item of [current, previous, next]) if (item) void cache.load(item.id).catch(() => {}); }, [cache, current?.id, previous?.id, next?.id]);
  const go = async (direction: Direction) => {
    setFailed(null);
    const result = await sequence.move(direction); if (mounted.current && result === 'error') setFailed(direction); return result === 'moved';
  };
  const row = sequence.current;
  if (!row) return null;
  const preview = (item?: ChronologicalRow) => item ? <MediaPreview media={cache.peek(item.id)} /> : null;
  return <MemoryViewer key={row.id} row={row} store={store} onBack={() => onClose(sequence.current)}
    navigation={{ previous: sequence.state('previous'), next: sequence.state('next'), go, failed }}
    initialMedia={cache.peek(row.id)} loadMedia={() => cache.load(row.id)}
    previousPreview={preview(previous)} nextPreview={preview(next)} onBusy={onBusy}
    onDelete={async () => {
      const result = await deleteMemory(row.id);
      onDeleted(row.id, result.cleanupFailed);
      const remaining = await sequence.remove(row.id);
      if (!remaining && mounted.current) onClose(row);
      return result;
    }}
    favorite={{ pending: writes.isPending(row.id), failed: writes.hasFailed(row.id), toggle: () => void writes.toggle(row.id, row.favorite === 1) }} />;
}

function MediaPreview({ media }: { media?: ViewerMedia }) {
  const uri = media?.base?.uri ?? media?.poster;
  return uri ? <View style={StyleSheet.absoluteFill}>
    <Image accessible={false} source={{ uri }} resizeMode="contain" style={StyleSheet.absoluteFill} />
    {media?.overlay && <Image accessible={false} source={{ uri: media.overlay.uri }} resizeMode="contain" style={StyleSheet.absoluteFill} />}
  </View> : null;
}
