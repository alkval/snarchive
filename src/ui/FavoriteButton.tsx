import { favoriteButtonState } from '../domain/favoriteWrites';
import { MediaButton } from './kit';

/** Shows the saved favourite state passed in; the write itself belongs to FavoriteWrites, so it is not lost when this
 * button unmounts (moving to another memory) and a revisit shows the pending or saved state. */
export function FavoriteButton({ favorite, pending, onToggle }: { favorite: boolean; pending: boolean; onToggle: () => void }) {
  const state = favoriteButtonState(favorite, pending);
  return <MediaButton icon={state.icon} disabled={state.disabled} label={state.label} onPress={onToggle} />;
}
