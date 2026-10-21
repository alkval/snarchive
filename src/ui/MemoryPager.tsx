import { useEffect, useReducer, useRef, useState } from 'react';
import type { ChronologicalRow, ImportStore } from '../storage/importStore';
import type { Direction, MemorySequence } from '../domain/memoryNavigation';
import type { FavoriteWrites } from '../domain/favoriteWrites';
import { MemoryViewer } from './MemoryViewer';

/** Shows the open memory of a sequence and moves through it. Each memory gets a fresh viewer (keyed by ID). Favourite
 * writes belong to the library browser, which updates the sequence's rows when they are saved. */
export function MemoryPager({ sequence, store, writes, onClose }: {
  sequence: MemorySequence<ChronologicalRow>; store: ImportStore; writes: FavoriteWrites; onClose: (last: ChronologicalRow) => void;
}) {
  const [, render] = useReducer((value: number) => value + 1, 0);
  const [failed, setFailed] = useState<Direction | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => sequence.subscribe(render), [sequence]);
  useEffect(() => writes.subscribe(render), [writes]);
  useEffect(() => { sequence.prepare(); }, [sequence]);
  const go = (direction: Direction) => {
    setFailed(null);
    void sequence.move(direction).then(result => { if (mounted.current && result === 'error') setFailed(direction); });
  };
  const row = sequence.current;
  return <MemoryViewer key={row.id} row={row} store={store} onBack={() => onClose(sequence.current)}
    navigation={{ previous: sequence.state('previous'), next: sequence.state('next'), go, failed }}
    favorite={{ pending: writes.isPending(row.id), failed: writes.hasFailed(row.id), toggle: () => void writes.toggle(row.id, row.favorite === 1) }} />;
}
