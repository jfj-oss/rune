// The queue logic lives in @liner/shared (shared/src/queue.ts): the same module serves every zone and the browser mock.
export {
  PREV_RESTART_THRESHOLD_MS,
  clear,
  createQueue,
  currentItem,
  enqueue,
  indexOfQueueId,
  jump,
  move,
  next,
  play,
  prev,
  remove,
  setRepeat,
  setShuffle,
  shuffled,
  upcoming,
} from '@liner/shared';
export type { NextResult, PrevResult, QueueState, RepeatMode, UpcomingEntry } from '@liner/shared';
