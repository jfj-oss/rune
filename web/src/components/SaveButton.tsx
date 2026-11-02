import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Heart } from 'lucide-react';
import { api } from '../api';
import { useUi } from '../store/ui';

/** Save / Saved toggle for a Spotify album (adds it to / removes it from the user's Spotify library). */
export function SaveButton({ albumId }: { albumId: string }) {
  const qc = useQueryClient();
  const toast = useUi((s) => s.toast);
  const saved = useQuery({ queryKey: ['saved', albumId], queryFn: () => api.albumSaved(albumId), staleTime: 30_000 });
  const m = useMutation({
    mutationFn: (on: boolean) => api.setAlbumSaved(albumId, on),
    onMutate: async (on) => {
      await qc.cancelQueries({ queryKey: ['saved', albumId] });
      const prev = qc.getQueryData<boolean>(['saved', albumId]);
      qc.setQueryData(['saved', albumId], on);
      return { prev };
    },
    onError: (_e, _on, ctx) => {
      qc.setQueryData(['saved', albumId], ctx?.prev ?? false);
      toast('Could not update your Spotify library');
    },
    onSuccess: (_d, on) => toast(on ? 'Saved to your Spotify library' : 'Removed from your Spotify library'),
    onSettled: () => {
      // the Albums / Spotify list and Home rows depend on what is saved
      void qc.invalidateQueries({ queryKey: ['albums'] });
      void qc.invalidateQueries({ queryKey: ['saved', albumId] });
    },
  });
  const on = saved.data === true;
  return (
    <button
      className={`btn${on ? ' btn--saved' : ''}`}
      aria-pressed={on}
      disabled={saved.isLoading || m.isPending}
      onClick={() => m.mutate(!on)}
      title={on ? 'Remove from your Spotify library' : 'Save to your Spotify library'}
    >
      {on ? <Check size={17} /> : <Heart size={17} />} {on ? 'Saved' : 'Save'}
    </button>
  );
}
