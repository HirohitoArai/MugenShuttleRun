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

const HORIZON = 1.5; // 秒: この先まで音を予約する（配信などで画面が裏に回っても途切れないよう長め）
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

  // 生成側の状態（未来のイベント列を作る。現行コードの Level / Speed / LastTime に対応）
  private params: RunParams = { initialSpeed: 8, speedRate: 0.5, levelIntervalSec: 60 };
  private runStartTime = 0;
  private gLevel = 1;
  private gSpeed = 8;
  private gLastLevelElapsed = 0;
  private gDir: 'up' | 'down' = 'up';
  private gPhaseStart = 0;
  private gShuttles = 0;
  private genDone = false;

  // 実行側の状態（現在時刻の表示を定数時間で求めるために、適用済みイベントから増分管理する）
  private livePhaseStart = 0; // 現在のフェイズ（シャトル）が始まった時刻
  private liveNoteCount = 0; // 現在のフェイズで鳴った note の数
  private liveDir: 'up' | 'down' = 'up'; // 現在のフェイズの向き
  private liveLevelElapsed = 0; // 最後にレベルアップした時点の経過秒
  // 生成済みの次のレベルアップ（折り返し番号と時刻）。生成側が正確に知っているので、
  // 手元にある間は割り算で推定せずこれを使う
  private upcomingLevelUps: Array<{ shuttlesAfter: number; time: number }> = [];

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

  /**
   * そのレベルの速度。加算ルール（Lv1→2 だけ速度変化が2倍、以降は等差）を閉じた式にした:
   * level >= 2 では 初期速度 + 速度変化 × level になる。
   */
  private speedAtLevel(level: number): number {
    if (level <= 1) return this.params.initialSpeed;
    return this.params.initialSpeed + this.params.speedRate * level;
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
        // 長時間運転用: 古いレベルの変換済み音は捨てる（際限なく溜めない）
        for (const k of this.levelBufs.keys()) {
          if (k < level - 6) this.levelBufs.delete(k);
        }
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
    const I = 8 / Math.max(this.gSpeed, 0.1); // Tonelength 秒 = 8000ms / Speed
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
    if (leveledUp) this.upcomingLevelUps.push({ shuttlesAfter: this.gShuttles, time: wrapTime });
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
    // 適用済みイベントの破棄（長時間運転で配列が際限なく伸びないように）。
    // 現在の表示は実行側の状態（live*）で保持しているので、過去分は丸ごと捨てられる。
    if (this.evPtr > 512) {
      this.events.splice(0, this.evPtr);
      this.schedPtr -= this.evPtr;
      this.evPtr = 0;
    }
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

  /** イベントを1つ表示へ反映し、実行側の状態（live*）も同じ場所で進める */
  private applyDisplay(ev: Ev): void {
    switch (ev.kind) {
      case 'countBeep':
        this.display.phase = 'countdown';
        this.display.count = ev.count ?? 0;
        break;
      case 'runStart':
        this.display.phase = 'running';
        this.display.count = 0;
        this.livePhaseStart = ev.time;
        this.liveNoteCount = 0;
        this.liveDir = 'up';
        this.liveLevelElapsed = 0;
        break;
      case 'note':
        this.liveNoteCount++;
        break;
      case 'wrap':
        this.display.shuttles = ev.shuttlesAfter ?? this.display.shuttles;
        this.display.level = ev.levelAfter ?? this.display.level;
        this.display.speed = ev.speedAfter ?? this.display.speed;
        this.livePhaseStart = ev.time;
        this.liveNoteCount = 0;
        // フェイズの向きは完了数と交互（偶数番目のフェイズが上行）
        this.liveDir = this.display.shuttles % 2 === 0 ? 'up' : 'down';
        if (ev.leveledUp) {
          this.liveLevelElapsed = ev.time - this.runStartTime;
          // 通過したレベルアップをキューから外す
          while (this.upcomingLevelUps.length > 0 && this.upcomingLevelUps[0].shuttlesAfter <= this.display.shuttles) {
            this.upcomingLevelUps.shift();
          }
        }
        break;
    }
  }

  // ---- リアルタイム表示用 ----

  /**
   * 現在時刻時点のライブ状態を返す。イベント列は走査せず、実行側の状態（live*）と
   * 現在の速度だけから定数時間で求める。未開始なら null。
   * 前提: 速度はレベルアップの折り返しでしか変わらないので、現在のフェイズと
   * 次のレベルアップまでの折り返し位置は割り算で正確に決まる。
   */
  live(): {
    elapsed: number;
    completed: number;
    shuttleIndex: number;
    shuttleProgress: number;
    shuttleDuration: number;
    shuttleRemaining: number;
    distanceM: number;
    nextLevelInSec: number;
    noteIndex: number;
  } | null {
    if (!this.ctx || this.display.phase === 'idle') return null;
    const now = this.ctx.currentTime;
    const elapsed = Math.max(0, now - this.runStartTime);

    // 現在のフェイズ（シャトル）内での位置
    const duration = 72 / Math.max(this.display.speed, 0.1); // 9合図 × (8 / 速度)
    const phaseStart = this.display.phase === 'running' ? this.livePhaseStart : this.runStartTime;
    const phaseElapsed = Math.min(Math.max(now - phaseStart, 0), duration);
    const progress = phaseElapsed / duration;
    const completed = this.display.shuttles;

    // 次のレベルアップまでの秒数。生成済みなら生成側の正確な時刻を使い、
    // まだ生成されていない先の話なら、折り返し本数を割り算で数える
    // （境界条件が割り算の誤差で1本ずれることがあるが、近づけば生成側の値に切り替わる）。
    let nextLevelInSec: number;
    const upcoming = this.upcomingLevelUps[0];
    if (upcoming) {
      nextLevelInSec = Math.max(upcoming.time - now, 0);
    } else {
      const threshold = this.liveLevelElapsed + this.params.levelIntervalSec;
      const wrapsToLevelUp = Math.max(1, Math.floor((threshold - elapsed + phaseElapsed) / duration) + 1);
      nextLevelInSec = Math.max(phaseStart + wrapsToLevelUp * duration - now, 0);
    }

    // 現在の音: フェイズ内で鳴った note の順番と向きから決まる
    const step = Math.max(this.liveNoteCount - 1, 0);
    const noteIndex = this.liveDir === 'up' ? step : 7 - step;

    return {
      elapsed,
      completed,
      shuttleIndex: completed + 1,
      shuttleProgress: progress,
      shuttleDuration: duration,
      shuttleRemaining: duration - phaseElapsed,
      distanceM: completed * 20 + progress * 20,
      nextLevelInSec,
      noteIndex,
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
    this.upcomingLevelUps = [];
    this.wakeLock?.release().catch(() => undefined);
    this.wakeLock = null;
  }

  stop(): void {
    this.stopInternal();
    this.display = { phase: 'idle', count: 0, level: 1, speed: this.params.initialSpeed, shuttles: 0, elapsedSec: 0 };
    this.emit();
  }
}
