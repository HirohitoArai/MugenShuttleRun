import './style.css';
import { Engine, TONE_SETS, type DisplayState } from './engine';
import { ensureConverter, setLevelUpSource, onConverterStatus, type ConverterStatus } from './convert';
import { fmtDuration, fmtDurationFull, fmtDistance, fmtCalories, setFormatLang } from './format';
import { STR, type Lang } from './i18n';

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

// 表示言語（日本語 / English）。フッターの小さなボタンで切り替え、選択は保存する
let lang: Lang = localStorage.getItem('mugen-lang') === 'en' ? 'en' : 'ja';

// 変換エンジンの状態表示（言語切替で再描画できるよう状態を保持する）
let convStatus: ConverterStatus = 'idle';
function renderConvStatus(): void {
  engineStatus.textContent = STR[lang].engine[convStatus];
}
onConverterStatus((s) => {
  convStatus = s;
  renderConvStatus();
});

// 起動時に変換エンジンと変換元音源を用意しておく
const defaultTone = TONE_SETS[0];
setLevelUpSource(defaultTone.levelup).catch(() => undefined);
ensureConverter();

const engine = new Engine();

const shuttleTimeVal = $('shuttleTimeVal');
const paceVal = $('paceVal');
const distanceVal = $('distanceVal');
const calorieVal = $('calorieVal');
const nextLevelVal = $('nextLevelVal');
const nextLevelShuttlesVal = $('nextLevelShuttlesVal');
const avgSpeedVal = $('avgSpeedVal');
const bigCount = $('bigCount');
const trackMarker = $('trackMarker');
const remainVal = $('remainVal');
let lastDisplay: DisplayState | null = null;

const distanceLabel = $('distanceLabel');
const calorieLabel = $('calorieLabel');

/** 言語を適用する: 静的なラベル類を全部差し替える（動的な値は次の描画で追随する） */
function applyLang(l: Lang): void {
  lang = l;
  localStorage.setItem('mugen-lang', l);
  setFormatLang(l);
  document.documentElement.lang = l;
  const s = STR[l];
  document.title = s.title;
  $('titleText').textContent = s.title;
  $('subtitleText').textContent = s.subtitle;
  $('lblSettings').textContent = s.settings;
  $('lblMode').textContent = s.mode;
  modeSelect.options[0].textContent = s.modeNormal;
  modeSelect.options[1].textContent = s.modeDetail;
  $('lblTone').textContent = s.tone;
  const toneOpt = toneSelect.querySelector<HTMLOptionElement>('option[value="default"]');
  if (toneOpt) toneOpt.textContent = s.toneDefault;
  $('lblWeight').textContent = s.weight;
  $('lblInitSpeed').textContent = s.initSpeed;
  $('lblSpeedRate').textContent = s.speedRate;
  $('lblLevelInterval').textContent = s.levelInterval;
  $('levelIntervalUnit').textContent = s.levelIntervalUnit;
  $('startBtn').textContent = s.start;
  $('startNote').textContent = s.startNote;
  $('lblShuttleCount').textContent = s.shuttleCount;
  $('captionPre').textContent = s.captionPre;
  $('captionPost').textContent = s.captionPost;
  $('lblLevel').textContent = s.level;
  $('lblSpeed').textContent = s.speed;
  $('lblNote').textContent = s.note;
  $('lblShuttleTime').textContent = s.shuttleTime;
  $('lblPace').textContent = s.pace;
  $('lblAvgSpeed').textContent = s.avgSpeed;
  $('lblNextLevel').textContent = s.nextLevel;
  $('lblNextShuttles').textContent = s.nextShuttles;
  $('lblElapsed').textContent = s.elapsed;
  $('stopBtn').textContent = s.stop;
  distanceLabel.textContent = `${s.distance} m`;
  calorieLabel.textContent = `${s.calories} kcal`;
  $('langJa').classList.toggle('active', l === 'ja');
  $('langEn').classList.toggle('active', l === 'en');
  renderConvStatus();
}
$('langJa').addEventListener('click', () => applyLang('ja'));
$('langEn').addEventListener('click', () => applyLang('en'));
applyLang(lang);

// ---- 無限に増える数値の表示（単位を段階的に上げ、桁が伸び続けないようにする） ----
// 整形ロジックは format.ts（単体テスト対象）

// 表示幅に合わせてフォントを自動で縮める。
// 実測はレイアウト計算を強いるので、「要素 × 文字数」ごとに結果を覚えて使い回す
// （同じ長さの値が毎フレーム来ても、測るのは最初の1回だけ）。
const fitCache = new WeakMap<HTMLElement, Map<number, number>>();
function setFit(el: HTMLElement, text: string, maxPx: number): void {
  if (el.dataset.t === text) return;
  el.dataset.t = text;
  el.textContent = text;

  let byLength = fitCache.get(el);
  const cached = byLength?.get(text.length);
  if (cached !== undefined) {
    el.style.fontSize = `${cached}px`;
    return;
  }

  el.style.fontSize = `${maxPx}px`;
  const avail = (el.parentElement?.clientWidth ?? 260) - 20;
  if (avail <= 40) return; // 非表示中は測れないので最大サイズのままにする
  const w = el.scrollWidth;
  const size = w > avail && w > 0 ? Math.max(13, Math.floor((maxPx * avail) / w)) : maxPx;
  el.style.fontSize = `${size}px`;
  if (!byLength) {
    byLength = new Map();
    fitCache.set(el, byLength);
  }
  byLength.set(text.length, size);
}

// カウンターは「無限」が前提: 20桁でも収まるよう自動で縮める。
// 横長（配信）では中央にどでかく出すため基準サイズを上げる
function renderCount(n: number): void {
  const base =
    window.innerWidth >= 900 ? (window.innerHeight <= 850 ? 170 : 250) : 92;
  setFit(bigCount, n.toLocaleString('en-US'), base);
}

// フレーム単位のリアルタイム描画
let rafId = 0;
function renderRT(): void {
  rafId = requestAnimationFrame(renderRT);
  const d = lastDisplay;
  if (!d || d.phase !== 'running') return;
  const info = engine.live();
  if (!info) return;

  renderCount(info.completed);

  // 20m トラック上のマーカー（往復で向きが反転する）
  const pos = info.shuttleIndex % 2 === 1 ? info.shuttleProgress : 1 - info.shuttleProgress;
  trackMarker.style.left = `${(pos * 100).toFixed(2)}%`;
  remainVal.textContent = info.shuttleRemaining.toFixed(2);

  setFit(timeVal, fmtDurationFull(info.elapsed), 42);
  noteVal.textContent = STR[lang].notes[info.noteIndex] ?? STR[lang].notes[0];
  setFit(shuttleTimeVal, fmtDuration(info.shuttleDuration), 42);
  setFit(nextLevelVal, fmtDuration(info.nextLevelInSec), 42);
  setFit(nextLevelShuttlesVal, lang === 'ja' ? `${info.nextLevelShuttles} 本` : String(info.nextLevelShuttles), 42);
  const dist = fmtDistance(info.distanceM);
  setFit(distanceVal, dist.text, 42);
  distanceLabel.textContent = `${STR[lang].distance} ${dist.unit}`;
  const cal = fmtCalories(1.05 * sessionWeightKg * (info.distanceM / 1000));
  setFit(calorieVal, cal.text, 42);
  calorieLabel.textContent = `${STR[lang].calories} ${cal.unit}`;
  setFit(avgSpeedVal, info.elapsed > 1 ? ((info.distanceM / info.elapsed) * 3.6).toFixed(1) : d.speed.toFixed(1), 42);
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
  setFit(levelVal, String(d.level), 42);
  setFit(speedVal, d.speed.toFixed(1), 42);
  const speed = Math.max(d.speed, 0.1);
  const paceSec = 3600 / speed;
  setFit(paceVal, `${Math.floor(paceSec / 60)}:${String(Math.floor(paceSec % 60)).padStart(2, '0')}`, 30);
};

$('startBtn').addEventListener('click', async () => {
  const tone = TONE_SETS.find((t) => t.id === toneSelect.value) ?? defaultTone;
  await setLevelUpSource(tone.levelup).catch(() => undefined);
  sessionWeightKg = Math.min(200, Math.max(20, parseFloat(weightKg.value) || 60));
  const params = !isDetail()
    ? { ...NORMAL_PARAMS }
    : {
        initialSpeed: parseFloat(initialSpeed.value),
        speedRate: parseFloat(speedRate.value),
        levelIntervalSec: parseFloat(levelInterval.value),
      };
  // 実行画面の値を初期状態に戻す（前回の値がカウントダウン中に残らないように）
  bigCount.dataset.t = '';
  renderCount(0);
  trackMarker.style.left = '0%';
  timeVal.dataset.t = '';
  setFit(timeVal, fmtDurationFull(0), 42);
  noteVal.textContent = STR[lang].notes[0];
  const shuttleSec = 72 / Math.max(params.initialSpeed, 0.1);
  setFit(shuttleTimeVal, fmtDuration(shuttleSec), 42);
  remainVal.textContent = shuttleSec.toFixed(2);
  setFit(nextLevelVal, '--', 42);
  setFit(nextLevelShuttlesVal, '--', 42);
  setFit(distanceVal, '0', 42);
  distanceLabel.textContent = `${STR[lang].distance} m`;
  setFit(calorieVal, '0', 42);
  calorieLabel.textContent = `${STR[lang].calories} kcal`;
  setFit(avgSpeedVal, params.initialSpeed.toFixed(1), 42);
  runPanel.classList.toggle('detail', isDetail());
  await engine.start(params, tone);
  cancelAnimationFrame(rafId);
  rafId = requestAnimationFrame(renderRT);
});

$('stopBtn').addEventListener('click', () => engine.stop());

if ('serviceWorker' in navigator) {
  // 新しい SW に切り替わったら自動で1回だけ再読み込みし、古い画面が残らないようにする
  const hadController = !!navigator.serviceWorker.controller;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloading) {
      reloading = true;
      location.reload();
    }
  });
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js')
      .then((reg) => reg.update())
      .catch(() => undefined);
  });
}
