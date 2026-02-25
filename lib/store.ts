import { create } from "zustand";
import type { WikiEditEvent } from "./types";

const MAX_QUEUE = 200;
const MAX_HISTORY = 500;

type AudioState = {
  amplitude: number;
  lowFreq: number;
  highFreq: number;
};

type Store = {
  queue: WikiEditEvent[];
  history: WikiEditEvent[];
  totalCount: number;
  audio: AudioState;
  overlayVisible: boolean;
  connected: boolean;
  introFinished: boolean;
  aboutVisible: boolean;

  enqueue: (event: WikiEditEvent) => void;
  dequeue: () => WikiEditEvent | undefined;
  setAudio: (audio: Partial<AudioState>) => void;
  toggleOverlay: () => void;
  setConnected: (v: boolean) => void;
  setIntroFinished: (v: boolean) => void;
  toggleAbout: () => void;
  setAboutVisible: (v: boolean) => void;
};

export const useStore = create<Store>((set, get) => ({
  queue: [],
  history: [],
  totalCount: 0,
  audio: { amplitude: 0, lowFreq: 0, highFreq: 0 },
  overlayVisible: true,
  connected: false,
  introFinished: false,
  aboutVisible: false,

  enqueue: (event) =>
    set((s) => ({
      queue:
        s.queue.length >= MAX_QUEUE
          ? [...s.queue.slice(1), event]
          : [...s.queue, event],
      history:
        s.history.length >= MAX_HISTORY
          ? [...s.history.slice(1), event]
          : [...s.history, event],
      totalCount: s.totalCount + 1,
    })),

  dequeue: () => {
    const { queue } = get();
    if (queue.length === 0) return undefined;
    const [first, ...rest] = queue;
    set({ queue: rest });
    return first;
  },

  setAudio: (audio) =>
    set((s) => ({ audio: { ...s.audio, ...audio } })),

  toggleOverlay: () => set((s) => ({ overlayVisible: !s.overlayVisible })),

  setConnected: (v) => set({ connected: v }),

  setIntroFinished: (v) => set({ introFinished: v }),

  toggleAbout: () => set((s) => ({ aboutVisible: !s.aboutVisible })),

  setAboutVisible: (v) => set({ aboutVisible: v }),
}));
