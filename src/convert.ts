// 変換層: レベルアップ音を「ピッチを保ったまま長さだけ変える」変換にする。
// 方式は本人の試聴決定により ffmpeg の atempo（ffmpeg.wasm 公式 core を使用）。
// 変換は再生中には行わず、開始前＋先読みで済ませてキャッシュする（要件定義 §3-1）。

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
// core は CDN ではなく自前ホストする（@ffmpeg/core を依存に入れ、?url で実ファイルを同梱）。
// 過去に CDN + ?url の worker 取り込みで load() が無言で固まる不具合があったため、
// worker は @ffmpeg/ffmpeg 内部のバンドル済み worker に任せ、core/wasm だけを渡す。
import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

let ffmpeg: FFmpeg | null = null;
let loadPromise: Promise<boolean> | null = null;
let sourceBytes: Uint8Array | null = null;

export type ConverterStatus = 'idle' | 'loading' | 'ready' | 'error';
let status: ConverterStatus = 'idle';
const statusListeners = new Set<(s: ConverterStatus) => void>();

export function onConverterStatus(fn: (s: ConverterStatus) => void): void {
  statusListeners.add(fn);
  fn(status);
}

function setStatus(s: ConverterStatus): void {
  status = s;
  statusListeners.forEach((fn) => fn(s));
}

export function converterStatus(): ConverterStatus {
  return status;
}

/** ffmpeg.wasm の読み込み（冪等）。失敗したら false を返し、呼び出し側は原音フォールバックする。 */
export function ensureConverter(): Promise<boolean> {
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        setStatus('loading');
        ffmpeg = new FFmpeg();
        await ffmpeg.load({ coreURL, wasmURL });
        setStatus('ready');
        return true;
      } catch (e) {
        console.warn('ffmpeg.wasm load failed', e);
        ffmpeg = null;
        setStatus('error');
        return false;
      }
    })();
  }
  return loadPromise;
}

/** 変換元のレベルアップ音バイト列を登録する（アプリ起動時に1回）。 */
export async function setLevelUpSource(url: string): Promise<void> {
  const data = await fetchFile(url);
  sourceBytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
}

/**
 * atempo の1段は [0.5, 2.0] に収める。範囲外は多段チェインに分解する。
 * 例: tempo 4.0 → [2.0, 2.0]、tempo 0.25 → [0.5, 0.5]
 */
export function atempoChain(tempo: number): number[] {
  const stages: number[] = [];
  let t = tempo;
  while (t > 2.0) {
    stages.push(2.0);
    t /= 2.0;
  }
  while (t < 0.5) {
    stages.push(0.5);
    t /= 0.5;
  }
  stages.push(Math.round(t * 1000) / 1000);
  return stages;
}

const cache = new Map<number, Promise<ArrayBuffer | null>>();
let queue: Promise<unknown> = Promise.resolve();

/**
 * tempo 倍速（ピッチ保持）の WAV を返す。tempo=1 なら null（= 原音を使う合図）。
 * 変換は直列キューで実行し、同じ tempo の変換は1回だけ行う。
 */
export function convertLevelUp(tempo: number): Promise<ArrayBuffer | null> {
  if (Math.abs(tempo - 1) < 0.001) return Promise.resolve(null);
  const key = Math.round(tempo * 1000);
  const existing = cache.get(key);
  if (existing) return existing;

  const job = queue.then(async (): Promise<ArrayBuffer | null> => {
    const ok = await ensureConverter();
    if (!ok || !ffmpeg || !sourceBytes) return null;
    try {
      const filter = atempoChain(tempo)
        .map((v) => `atempo=${v}`)
        .join(',');
      await ffmpeg.writeFile('in.wav', sourceBytes);
      const code = await ffmpeg.exec(['-i', 'in.wav', '-af', filter, 'out.wav']);
      if (code !== 0) return null;
      const out = await ffmpeg.readFile('out.wav');
      if (typeof out === 'string') return null;
      const buf = new ArrayBuffer(out.byteLength);
      new Uint8Array(buf).set(out);
      return buf;
    } catch (e) {
      console.warn('atempo conversion failed', e);
      return null;
    }
  });
  queue = job.catch(() => undefined);
  cache.set(key, job);
  // 長時間運転用: 変換キャッシュは直近分だけ残す（際限なく溜めない）
  while (cache.size > 24) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return job;
}
