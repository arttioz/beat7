export type Difficulty = 'easy' | 'medium' | 'hard';

export interface Note {
  /** time in ms from audio start */
  t: number;
  /** lane 0..keys-1 */
  lane: number;
  /** long-note length in ms, 0 = tap */
  len: number;
}

export type KeyCount = 4 | 5 | 7;

export interface Chart {
  version: 1;
  title: string;
  bpm: number;
  /** first-beat offset in ms */
  offsetMs: number;
  /** number of lanes/keys: 4, 5 or 7 */
  keys: KeyCount;
  difficulty: Difficulty;
  audioHash: string;
  durationMs: number;
  notes: Note[];
}

export type Band = 'bass' | 'mid' | 'high';

export interface Onset {
  tMs: number;
  band: Band;
  /** ratio of flux to local average — bigger = more prominent */
  strength: number;
  /** how long the sound keeps ringing after the onset (long vocals/solo notes) */
  sustainMs: number;
}

export interface Section {
  startMs: number;
  endMs: number;
  /** 0-1 average loudness */
  energy: number;
  /** onsets per second in this section */
  onsetDensity: number;
}

export interface Analysis {
  bpm: number;
  beatOffsetMs: number;
  durationMs: number;
  onsets: Onset[];
  sections: Section[];
}

export type Judgment = 'cool' | 'good' | 'bad' | 'miss';

export type PlayMode = 'chill' | 'audition';

export interface PlayStats {
  cool: number;
  good: number;
  bad: number;
  miss: number;
  maxCombo: number;
  totalJudgments: number;
  score: number;
  accuracy: number;
  grade: string;
  /** audition mode: got 4 ❌ and was dropped out */
  droppedOut: boolean;
  /** audition mode: golden buzzer was triggered */
  goldenTime: boolean;
}
