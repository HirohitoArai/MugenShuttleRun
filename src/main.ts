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
const shuttleVal = $('shuttleVal');
const timeVal = $('timeVal');
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
const nextLevelShuttlesVal = $('nextLevelShuttlesVal');
const metsVal = $('metsVal');
const vo2Val = $('vo2Val');
const bcDim = $('bcDim');
const bcMain = $('bcMain');
const ageYears = $<HTMLInputElement>('ageYears');
let sessionAge = 20;
let lastDisplay: DisplayState | null = null;

// シェブロン（現在のシャトルの残りを示す8個の三角形）
const chevronsEl = $('chevrons');
const chevSpans: HTMLSpanElement[] = [];
for (let i = 0; i < 8; i++) {
  const s = document.createElement('span');
  s.className = 'chev';
  chevronsEl.appendChild(s);
  chevSpans.push(s);
}
let lastChevKey = '';

function fmtClock(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec * 100) % 100);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(m)}:${p(s)}.${p(cs)}`;
}

// フレーム単位のリアルタイム描画（動画形式の表示に倣う）
let rafId = 0;
function renderRT(): void {
  rafId = requestAnimationFrame(renderRT);
  const d = lastDisplay;
  if (!d || d.phase !== 'running') return;
  const info = engine.liveInfo();
  if (!info) return;

  // 巨大カウンター（完了シャトル数、先行ゼロは薄く）
  const n = info.completed;
  const main = String(n);
  bcDim.textContent = n < 10 ? '00' : n < 100 ? '0' : '';
  bcMain.textContent = main;

  // シェブロン: 残り時間の整数部分だけ点灯。往復で寄る側が交互になる
  const filled = Math.min(8, Math.floor(info.shuttleRemaining + 0.001));
  const anchorRight = info.shuttleIndex % 2 === 1;
  const key = `${filled}:${anchorRight ? 'R' : 'L'}`;
  if (key !== lastChevKey) {
    lastChevKey = key;
    chevSpans.forEach((s, i) => {
      const on = anchorRight ? i >= 8 - filled : i < filled;
      s.classList.toggle('on', on);
    });
  }

  timeVal.textContent = fmtClock(info.elapsed);
  shuttleTimeVal.textContent = info.shuttleRemaining.toFixed(2);
  nextLevelVal.textContent = info.nextLevelInSec !== null ? info.nextLevelInSec.toFixed(2) : '--';
  nextLevelShuttlesVal.textContent = info.nextLevelShuttles !== null ? String(info.nextLevelShuttles) : '--';
  distanceVal.textContent = info.distanceM.toFixed(1);
  calorieVal.textContent = (1.05 * sessionWeightKg * (info.distanceM / 1000)).toFixed(2);
  const speed = Math.max(d.speed, 0.1);
  // METs: ACSM ランニング式 VO2 = 0.2 × 速度(m/分) + 3.5、METs = VO2 / 3.5
  metsVal.textContent = ((0.2 * ((speed * 1000) / 60) + 3.5) / 3.5).toFixed(2);
  // 最大酸素摂取量: Léger の推定式（S=現在の速度 km/h、A=年齢）
  const vo2 = 31.025 + 3.238 * speed - 3.248 * sessionAge + 0.1536 * speed * sessionAge;
  vo2Val.textContent = Math.max(vo2, 0).toFixed(2);
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
  shuttleVal.textContent = String(d.shuttles);
  const speed = Math.max(d.speed, 0.1);
  const paceSec = 3600 / speed;
  paceVal.textContent = `${Math.floor(paceSec / 60)}:${String(Math.floor(paceSec % 60)).padStart(2, '0')}`;
};

$('startBtn').addEventListener('click', async () => {
  const tone = TONE_SETS.find((t) => t.id === toneSelect.value) ?? defaultTone;
  await setLevelUpSource(tone.levelup).catch(() => undefined);
  sessionWeightKg = Math.min(200, Math.max(20, parseFloat(weightKg.value) || 60));
  sessionAge = Math.min(99, Math.max(5, parseFloat(ageYears.value) || 20));
  lastChevKey = '';
  bcDim.textContent = '00';
  bcMain.textContent = '0';
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
