import './style.css';
import { Engine, TONE_SETS, type DisplayState } from './engine';
import { ensureConverter, setLevelUpSource, onConverterStatus } from './convert';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const homePanel = $('homePanel');
const runPanel = $('runPanel');
const countOverlay = $('countOverlay');
const countNum = $('countNum');
const levelVal = $('levelVal');
const speedVal = $('speedVal');
const timeVal = $('timeVal');
const noteVal = $('noteVal');
const engineStatus = $('engineStatus');

const initialSpeed = $<HTMLInputElement>('initialSpeed');
const speedRate = $<HTMLInputElement>('speedRate');
const levelInterval = $<HTMLInputElement>('levelInterval');

function bindSlider(input: HTMLInputElement, out: HTMLElement, format: (v: number) => string): void {
  const update = () => {
    out.textContent = format(parseFloat(input.value));
  };
  input.addEventListener('input', update);
  update();
}
bindSlider(initialSpeed, $('initialSpeedVal'), (v) => v.toFixed(1));
bindSlider(speedRate, $('speedRateVal'), (v) => v.toFixed(2));
bindSlider(levelInterval, $('levelIntervalVal'), (v) => v.toFixed(0));

const toneSelect = $<HTMLSelectElement>('toneSelect');
for (const t of TONE_SETS) {
  const opt = document.createElement('option');
  opt.value = t.id;
  opt.textContent = t.name;
  toneSelect.appendChild(opt);
}

// モード選択: 詳細モードの時だけ、体重とスライダー（カスタム設定）を出す
const modeSelect = $<HTMLSelectElement>('modeSelect');
const detailInputs = $('detailInputs');
const weightKg = $<HTMLInputElement>('weightKg');
function isDetail(): boolean {
  return modeSelect.value === 'detail';
}
function applyMode(): void {
  detailInputs.hidden = !isDetail();
}
modeSelect.addEventListener('change', applyMode);
applyMode();

// 普通モードのパラメータ（Léger 標準表: 初期 8.0 / 変化 0.5 / 1分ごと。
// Lv1→2 だけ2倍になる規則と合わせると公式の速度推移になる）
const NORMAL_PARAMS = { initialSpeed: 8.0, speedRate: 0.5, levelIntervalSec: 60 };
let sessionWeightKg = 60;

// 変換エンジンの状態表示
onConverterStatus((s) => {
  engineStatus.textContent =
    s === 'ready'
      ? '変換エンジン: 準備完了（ffmpeg / atempo）'
      : s === 'loading'
        ? '変換エンジン: 読み込み中…'
        : s === 'error'
          ? '変換エンジン: 利用できません（効果音は原音で再生します）'
          : '変換エンジン: 準備中';
});

// 起動時に変換エンジンと変換元音源を用意しておく
const defaultTone = TONE_SETS[0];
setLevelUpSource(defaultTone.levelup).catch(() => undefined);
ensureConverter();

const engine = new Engine();

function fmtTime(sec: number): string {
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(ss)}`;
}

const shuttleTimeVal = $('shuttleTimeVal');
const paceVal = $('paceVal');
const distanceVal = $('distanceVal');
const calorieVal = $('calorieVal');
const nextLevelVal = $('nextLevelVal');
const avgSpeedVal = $('avgSpeedVal');
const bigCount = $('bigCount');
const trackMarker = $('trackMarker');
const remainVal = $('remainVal');
let lastDisplay: DisplayState | null = null;

const NOTE_NAMES = ['ド', 'レ', 'ミ', 'ファ', 'ソ', 'ラ', 'シ', 'ド'];

// カウンターは「無限」が前提: 20桁でも収まるよう、桁数で文字を自動で縮める
let lastCountText = '';
function renderCount(n: number): void {
  const text = n.toLocaleString('en-US');
  if (text === lastCountText) return;
  lastCountText = text;
  bigCount.textContent = text;
  const digits = String(n).length;
  const size = Math.min(92, Math.max(15, Math.floor(600 / Math.max(digits, 1))));
  bigCount.style.fontSize = `${size}px`;
}

// フレーム単位のリアルタイム描画
let rafId = 0;
function renderRT(): void {
  rafId = requestAnimationFrame(renderRT);
  const d = lastDisplay;
  if (!d || d.phase !== 'running') return;
  const info = engine.liveInfo();
  if (!info) return;

  renderCount(info.completed);

  // 20m トラック上のマーカー（往復で向きが反転する）
  const pos = info.shuttleIndex % 2 === 1 ? info.shuttleProgress : 1 - info.shuttleProgress;
  trackMarker.style.left = `${(pos * 100).toFixed(2)}%`;
  remainVal.textContent = info.shuttleRemaining.toFixed(2);

  timeVal.textContent = info.elapsed.toFixed(2);
  noteVal.textContent = NOTE_NAMES[info.noteIndex] ?? 'ド';
  shuttleTimeVal.textContent = info.shuttleDuration.toFixed(2);
  nextLevelVal.textContent = info.nextLevelInSec !== null ? info.nextLevelInSec.toFixed(2) : '--';
  distanceVal.textContent = info.distanceM.toFixed(1);
  calorieVal.textContent = (1.05 * sessionWeightKg * (info.distanceM / 1000)).toFixed(2);
  avgSpeedVal.textContent = info.elapsed > 1 ? ((info.distanceM / info.elapsed) * 3.6).toFixed(1) : d.speed.toFixed(1);
}

engine.onDisplay = (d: DisplayState) => {
  lastDisplay = d;
  if (d.phase === 'idle') {
    homePanel.hidden = false;
    runPanel.hidden = true;
    cancelAnimationFrame(rafId);
    return;
  }
  homePanel.hidden = true;
  runPanel.hidden = false;
  countOverlay.hidden = d.phase !== 'countdown';
  countNum.textContent = String(d.count);
  levelVal.textContent = String(d.level);
  speedVal.textContent = d.speed.toFixed(1);
  const speed = Math.max(d.speed, 0.1);
  const paceSec = 3600 / speed;
  paceVal.textContent = `${Math.floor(paceSec / 60)}:${String(Math.floor(paceSec % 60)).padStart(2, '0')}`;
};

$('startBtn').addEventListener('click', async () => {
  const tone = TONE_SETS.find((t) => t.id === toneSelect.value) ?? defaultTone;
  await setLevelUpSource(tone.levelup).catch(() => undefined);
  sessionWeightKg = Math.min(200, Math.max(20, parseFloat(weightKg.value) || 60));
  lastCountText = '';
  bigCount.textContent = '0';
  bigCount.style.fontSize = '92px';
  trackMarker.style.left = '0%';
  timeVal.textContent = '0.00';
  noteVal.textContent = 'ド';
  const params = !isDetail()
    ? { ...NORMAL_PARAMS }
    : {
        initialSpeed: parseFloat(initialSpeed.value),
        speedRate: parseFloat(speedRate.value),
        levelIntervalSec: parseFloat(levelInterval.value),
      };
  runPanel.classList.toggle('detail', isDetail());
  await engine.start(params, tone);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(renderRT);
});

$('stopBtn').addEventListener('click', () => engine.stop());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
