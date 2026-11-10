// 再生エンジン: 現行 Unity 版 Run.cs の進行を Web Audio のクロックで再現する。
// Task.Delay の連鎖は使わず、全イベントを AudioContext.currentTime 基準で先行スケジュールする。
// レベルアップ音は convert.ts の事前変換キャッシュから取る（要件定義 §3）。

import { convertLevelUp } from './convert';

export interface ToneSet {
  id: string;
  name: string;
  main: string;
  levelup: string;
}

export const TONE_SETS: ToneSet[] = [
  { id: 'default', name: 'デフォルト', main: 'tones/default/main.wav', levelup: 'tones/default/levelup.wav' },
];

// 現行 Run.cs の pitches 配列（ド〜高いドの再生速度比）
const PITCHES = [1.0, 1.122, 1.26, 1.335, 1.498, 1.682, 1.887, 2.0];

export interface RunParams {
  initialSpeed: number; // km/h
  speedRate: number; // km/h per level
  levelIntervalSec: number; // 秒
}

export interface DisplayState {
  phase: 'idle' | 'countdown' | 'running';
  count: number;
  level: number;
  speed: number;
  shuttles: number;
  elapsedSec: number;
}

type EvKind = 'countBeep' | 'runStart' | 'note' | 'wrap';
interface Ev {
  time: number;
  kind: EvKind;
  rate?: number;
  count?: number;
  // wrap 用: 生成時点で確定した表示値
  shuttlesAfter?: number;
  levelAfter?: number;
  speedAfter?: number;
  leveledUp?: boolean;
}

const HORIZON = 0.25; // 秒: この先まで音を予約する
const TICK_MS = 25;

export class Engine {
  private ctx: AudioContext | null = null;
  private mainBuf: AudioBuffer | null = null;
  private levelBuf: AudioBuffer | null = null;
  private levelBufs = new Map<number, AudioBuffer>();
  private converting = new Set<number>();

  private events: Ev[] = [];
  private evPtr = 0; // 表示反映済みの位置
  private schedPtr = 0; // 音の予約済みの位置
  private timer: number | null = null;
  private wakeLock: WakeLockSentinel | null = null;

  // 生成側の状態（現行コードの Level / Speed / LastTime に対応）
  private params: RunParams = { initialSpeed: 8, speedRate: 0.5, levelIntervalSec: 60 };
  private runStartTime = 0;
  private gLevel = 1;
  private gSpeed = 8;
  private gLastLevelElapsed = 0;
  private gDir: 'up' | 'down' = 'up';
  private gPhaseStart = 0;
  private gShuttles = 0;
  private genDone = false;

  display: DisplayState = { phase: 'idle', count: 0, level: 1, speed: 8, shuttles: 0, elapsedSec: 0 };
  onDisplay: ((d: DisplayState) => void) | null = null;

  private emit(): void {
    this.onDisplay?.({ ...this.display });
  }

  private async loadBuffer(url: string): Promise<AudioBuffer> {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    return this.ctx!.decodeAudioData(buf);
  }

  /** そのレベルの速度（現行の加算ルール: Lv1→2 の遷移だけ速度変化が2倍） */
  private speedAtLevel(level: number): number {
    let s = this.params.initialSpeed;
    for (let l = 1; l < level; l++) {
      s += l <= 1 ? this.params.speedRate * 2 : this.params.speedRate;
    }
    return s;
  }

  /** レベル n 用のレベルアップ音を用意する（先読み変換）。 */
  private ensureLevelBuffer(level: number): void {
    if (level <= 1 || this.levelBufs.has(level) || this.converting.has(level) || !this.ctx) return;
    this.converting.add(level);
    // 現行仕様: レベルアップ音の長さ = 原音 × PitchK、そのレベルの PitchK = 8 / speed。
    // atempo の tempo（速さ倍率）はその逆数 = speed / 8。
    const tempo = this.speedAtLevel(level) / 8;
    convertLevelUp(tempo)
      .then(async (buf) => {
        if (!buf || !this.ctx) return;
        const audio = await this.ctx.decodeAudioData(buf);
        this.levelBufs.set(level, audio);
      })
      .catch(() => undefined)
      .finally(() => this.converting.delete(level));
  }

  private playAt(buffer: AudioBuffer, time: number, rate: number): void {
    if (!this.ctx) return;
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = rate;
    src.connect(this.ctx.destination);
    src.start(time);
  }

  // ---- イベント生成（現行の Up / Down / Wrap の構造に対応） ----
  private genPhase(): void {
    const I = 8 / this.gSpeed; // Tonelength 秒 = 8000ms / Speed
    const start = this.gPhaseStart;
    for (let k = 0; k < 8; k++) {
      const rate = this.gDir === 'up' ? PITCHES[k] : PITCHES[7 - k];
      this.events.push({ time: start + I * (k + 1), kind: 'note', rate });
    }
    const wrapTime = start + I * 9;
    // Wrap: シャトル+1、レベル判定
    this.gShuttles += 1;
    const elapsed = wrapTime - this.runStartTime;
    let leveledUp = false;
    if (elapsed - this.gLastLevelElapsed > this.params.levelIntervalSec) {
      this.gLastLevelElapsed = elapsed;
      this.gSpeed += this.gLevel <= 1 ? this.params.speedRate * 2 : this.params.speedRate;
      this.gLevel += 1;
      leveledUp = true;
      this.ensureLevelBuffer(this.gLevel);
      this.ensureLevelBuffer(this.gLevel + 1);
      this.ensureLevelBuffer(this.gLevel + 2);
    }
    this.events.push({
      time: wrapTime,
      kind: 'wrap',
      shuttlesAfter: this.gShuttles,
      levelAfter: this.gLevel,
      speedAfter: this.gSpeed,
      leveledUp,
    });
    this.gDir = this.gDir === 'up' ? 'down' : 'up';
    this.gPhaseStart = wrapTime;
  }

  private schedule(): void {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // 必要なら次のフェイズを生成
    while (!this.genDone) {
      const last = this.events[this.events.length - 1];
      if (last && last.time > now + HORIZON) break;
      if (this.gPhaseStart > now + HORIZON) break;
      this.genPhase();
    }
    // 音の予約
    while (this.schedPtr < this.events.length) {
      const ev = this.events[this.schedPtr];
      if (ev.time > now + HORIZON) break;
      this.scheduleEventAudio(ev);
      this.schedPtr++;
    }
    // 表示の反映
    let changed = false;
    while (this.evPtr < this.events.length) {
      const ev = this.events[this.evPtr];
      if (ev.time > now) break;
      this.applyDisplay(ev);
      this.evPtr++;
      changed = true;
    }
    if (this.display.phase === 'running') {
      this.display.elapsedSec = Math.max(0, now - this.runStartTime);
      changed = true;
    }
    if (changed) this.emit();
  }

  private scheduleEventAudio(ev: Ev): void {
    if (!this.mainBuf) return;
    switch (ev.kind) {
      case 'countBeep':
        this.playAt(this.mainBuf, ev.time, 1.0);
        break;
      case 'runStart':
        if (this.levelBuf) this.playAt(this.levelBuf, ev.time, 1.0);
        break;
      case 'note':
        this.playAt(this.mainBuf, ev.time, ev.rate ?? 1.0);
        break;
      case 'wrap': {
        this.playAt(this.mainBuf, ev.time, 1.0);
        this.playAt(this.mainBuf, ev.time, 0.5);
        if (ev.leveledUp && ev.levelAfter) {
          const buf = this.levelBufs.get(ev.levelAfter) ?? this.levelBuf;
          if (buf) this.playAt(buf, ev.time, 1.0);
        }
        break;
      }
    }
  }

  private applyDisplay(ev: Ev): void {
    switch (ev.kind) {
      case 'countBeep':
        this.display.phase = 'countdown';
        this.display.count = ev.count ?? 0;
        break;
      case 'runStart':
        this.display.phase = 'running';
        this.display.count = 0;
        break;
      case 'wrap':
        this.display.shuttles = ev.shuttlesAfter ?? this.display.shuttles;
        this.display.level = ev.levelAfter ?? this.display.level;
        this.display.speed = ev.speedAfter ?? this.display.speed;
        break;
      default:
        break;
    }
  }

  // ---- リアルタイム表示用（動画形式の表示に倣い、フレーム単位で読む） ----
  now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /**
   * 現在時刻時点のライブ状態を返す。イベント列（生成済み）から正確に求める。
   * 戻り値が null の間は未開始。countdown 中は elapsed 等が 0 側に張り付く。
   */
  liveInfo(): {
    elapsed: number;
    completed: number;
    shuttleIndex: number;
    shuttleProgress: number;
    shuttleDuration: number;
    shuttleRemaining: number;
    distanceM: number;
    nextLevelInSec: number | null;
    noteIndex: number;
    noteDir: 'up' | 'down';
  } | null {
    if (!this.ctx || this.display.phase === 'idle') return null;
    const now = this.ctx.currentTime;
    const elapsed = Math.max(0, now - this.runStartTime);

    // 現在のフェイズ（シャトル）の開始と終了をイベント列から探す
    let phaseStart = this.runStartTime;
    let completed = 0;
    let phaseEnd: number | null = null;
    for (const ev of this.events) {
      if (ev.kind !== 'wrap') continue;
      if (ev.time <= now) {
        phaseStart = ev.time;
        completed = ev.shuttlesAfter ?? completed;
      } else {
        phaseEnd = ev.time;
        break;
      }
    }
    if (phaseEnd === null) {
      // 次の wrap が未生成なら、必要分だけ先行生成する
      for (let i = 0; i < 600 && phaseEnd === null; i++) {
        this.genPhase();
        const last = this.events[this.events.length - 1];
        if (last && last.time > now) phaseEnd = last.time;
      }
    }
    if (phaseEnd === null) return null;
    const duration = Math.max(phaseEnd - phaseStart, 0.001);
    const remaining = Math.max(phaseEnd - now, 0);
    const progress = Math.min(Math.max((now - phaseStart) / duration, 0), 1);
    const distanceM = completed * 20 + progress * 20;

    // 現在の音: フェイズは up/down が交互。フェイズ内の note の順番から音名を決める
    const noteDir: 'up' | 'down' = completed % 2 === 0 ? 'up' : 'down';
    let noteOrder = 0;
    for (const ev of this.events) {
      if (ev.time > now) break;
      if (ev.kind === 'note' && ev.time > phaseStart) noteOrder++;
    }
    const step = Math.max(noteOrder - 1, 0);
    const noteIndex = noteDir === 'up' ? step : 7 - step;

    // 次のレベルアップ（leveledUp な wrap）を探す
    let nextLevelInSec: number | null = null;
    {
      let found: number | null = null;
      for (const ev of this.events) {
        if (ev.kind !== 'wrap' || ev.time <= now) continue;
        if (ev.leveledUp) {
          found = ev.time;
          break;
        }
      }
      if (found === null) {
        // 未生成の先にレベルアップがあるはずなので、少し先まで生成して再探索する
        for (let i = 0; i < 600 && found === null; i++) {
          const before = this.events.length;
          this.genPhase();
          for (let j = before; j < this.events.length; j++) {
            const ev = this.events[j];
            if (ev.kind !== 'wrap' || ev.time <= now) continue;
            if (ev.leveledUp) {
              found = ev.time;
              break;
            }
          }
        }
      }
      if (found !== null) nextLevelInSec = Math.max(found - now, 0);
    }

    return {
      elapsed,
      completed,
      shuttleIndex: completed + 1,
      shuttleProgress: progress,
      shuttleDuration: duration,
      shuttleRemaining: remaining,
      distanceM,
      nextLevelInSec,
      noteIndex,
      noteDir,
    };
  }

  async start(params: RunParams, tone: ToneSet): Promise<void> {
    this.stopInternal();
    this.params = params;
    this.ctx = new AudioContext();
    await this.ctx.resume();
    this.mainBuf = await this.loadBuffer(tone.main);
    this.levelBuf = await this.loadBuffer(tone.levelup);
    this.levelBufs.clear();

    try {
      this.wakeLock = await navigator.wakeLock?.request('screen');
    } catch {
      this.wakeLock = null;
    }

    // 先読み変換（レベル2〜6）
    for (let l = 2; l <= 6; l++) this.ensureLevelBuffer(l);

    const t0 = this.ctx.currentTime + 0.15;
    // カウントダウン: 現行は1秒待ってから 5..1 を1秒ごとに鳴らし、その1秒後に開始
    for (let i = 0; i < 5; i++) {
      this.events.push({ time: t0 + 1 + i, kind: 'countBeep', count: 5 - i });
    }
    this.runStartTime = t0 + 6;
    this.events.push({ time: this.runStartTime, kind: 'runStart' });

    this.gLevel = 1;
    this.gSpeed = params.initialSpeed;
    this.gLastLevelElapsed = 0;
    this.gDir = 'up';
    this.gPhaseStart = this.runStartTime;
    this.gShuttles = 0;
    this.genDone = false;
    this.evPtr = 0;
    this.schedPtr = 0;

    this.display = {
      phase: 'countdown',
      count: 5,
      level: 1,
      speed: params.initialSpeed,
      shuttles: 0,
      elapsedSec: 0,
    };
    this.emit();

    this.timer = window.setInterval(() => this.schedule(), TICK_MS);
    this.schedule();
  }

  private stopInternal(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.ctx) {
      this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.events = [];
    this.evPtr = 0;
    this.schedPtr = 0;
    this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }

  stop(): void {
    this.stopInternal();
    this.display = { phase: 'idle', count: 0, level: 1, speed: this.params.initialSpeed, shuttles: 0, elapsedSec: 0 };
    this.emit();
  }
}
