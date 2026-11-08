import { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('../store/ui', () => ({ useUi: { getState: () => ({ toast }) } }));
vi.mock('../api', () => ({ api: {} }));
const { likedKey, optimisticLiked } = await import('./useLiked');

let qc: QueryClient;
beforeEach(() => {
  toast.mockClear();
  qc = new QueryClient();
});

const wait = (ms = 5) => new Promise((r) => setTimeout(r, ms));

describe('optimisticLiked', () => {
  it('shows the heart flipped before the server answers, then keeps the server’s answer', async () => {
    qc.setQueryData(likedKey('sp:t1'), false);
    let release!: () => void;
    const pending = new Promise<void>((r) => { release = r; });

    const done = optimisticLiked(qc, 'sp:t1', true, () => pending);
    await wait();
    expect(qc.getQueryData(likedKey('sp:t1'))).toBe(true);

    release();
    expect(await done).toBe(true);
    expect(qc.getQueryData(likedKey('sp:t1'))).toBe(true);
    expect(toast).not.toHaveBeenCalled();
  });

  it('rolls the heart back and says so when the request fails', async () => {
    qc.setQueryData(likedKey('sp:t1'), false);
    const ok = await optimisticLiked(qc, 'sp:t1', true, () => Promise.reject(new Error('502')), 'Could not update Liked Songs');
    expect(ok).toBe(false);
    expect(qc.getQueryData(likedKey('sp:t1'))).toBe(false);
    expect(toast).toHaveBeenCalledWith('Could not update Liked Songs — changes undone');
  });

  it('rolls a failed unlike back to liked', async () => {
    qc.setQueryData(likedKey('sp:t1'), true);
    const ok = await optimisticLiked(qc, 'sp:t1', false, () => Promise.reject(new Error('429')));
    expect(ok).toBe(false);
    expect(qc.getQueryData(likedKey('sp:t1'))).toBe(true);
  });

  it('prefers the server’s explanation in the toast', async () => {
    const err = Object.assign(new Error('429'), { serverMessage: 'Spotify is busy (rate limit) — try again in a few minutes' });
    await optimisticLiked(qc, 'sp:t1', true, () => Promise.reject(err), 'Could not update Liked Songs');
    expect(toast).toHaveBeenCalledWith('Spotify is busy (rate limit) — try again in a few minutes — changes undone');
  });

  it('invalidates the Liked Songs page and playlist list on success', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await optimisticLiked(qc, 'sp:t1', true, () => Promise.resolve());
    expect(spy).toHaveBeenCalledWith({ queryKey: likedKey('sp:t1') });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['playlist', 'pl:sp:liked'] });
    expect(spy).toHaveBeenCalledWith({ queryKey: ['playlists'] });
  });

  it('does not invalidate anything on failure', async () => {
    const spy = vi.spyOn(qc, 'invalidateQueries');
    await optimisticLiked(qc, 'sp:t1', true, () => Promise.reject(new Error('no')));
    expect(spy).not.toHaveBeenCalled();
  });
});
