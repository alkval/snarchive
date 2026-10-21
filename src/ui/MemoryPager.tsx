import { useEffect, useReducer, useRef, useState } from 'react';
import type { ChronologicalRow, ImportStore } from '../storage/importStore';
import { matchesFilters, type LibraryFilters } from '../domain/libraryFilters';
import type { Direction, MemorySequence } from '../domain/memoryNavigation';
import { MemoryViewer } from './MemoryViewer';

/** Shows the open memory of a sequence and moves through it. Each memory gets a fresh viewer (keyed by ID). */
export function MemoryPager({ sequence, store, filters, onClose, onFavorite }: {
  sequence: MemorySequence<ChronologicalRow>; store: ImportStore; filters: LibraryFilters; onClose: (last: ChronologicalRow) => void; onFavorite: (id: string, favorite: boolean) => void;
}) {
  const [, render] = useReducer((value: number) => value + 1, 0);
  const [failed, setFailed] = useState<Direction | null>(null);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => sequence.subscribe(render), [sequence]);
  useEffect(() => { sequence.prepare(); }, [sequence]);
  const go = (direction: Direction) => {
    setFailed(null);
    void sequence.move(direction).then(result => { if (mounted.current && result === 'error') setFailed(direction); });
  };
  const row = sequence.current;
  return <MemoryViewer key={row.id} row={row} store={store} onBack={() => onClose(sequence.current)}
    navigation={{ previous: sequence.state('previous'), next: sequence.state('next'), go, failed }}
    onFavoriteSaved={favorite => {
      onFavorite(row.id, favorite);
      const updated = { ...row, favorite: favorite ? 1 : 0 };
      sequence.update(updated, matchesFilters(updated, filters));
    }} />;
}
