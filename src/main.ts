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

engine.onDisplay = (d: DisplayState) => {
  if (d.phase === 'idle') {
    homePanel.hidden = false;
    runPanel.hidden = true;
    return;
  }
  homePanel.hidden = true;
  runPanel.hidden = false;
  countOverlay.hidden = d.phase !== 'countdown';
  countNum.textContent = String(d.count);
  levelVal.textContent = String(d.level);
  speedVal.textContent = d.speed.toFixed(1);
  shuttleVal.textContent = String(d.shuttles);
  timeVal.textContent = fmtTime(d.elapsedSec);
};

$('startBtn').addEventListener('click', async () => {
  const tone = TONE_SETS.find((t) => t.id === toneSelect.value) ?? defaultTone;
  await setLevelUpSource(tone.levelup).catch(() => undefined);
  await engine.start(
    {
      initialSpeed: parseFloat(initialSpeed.value),
      speedRate: parseFloat(speedRate.value),
      levelIntervalSec: parseFloat(levelInterval.value),
    },
    tone,
  );
});

$('stopBtn').addEventListener('click', () => engine.stop());

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => undefined);
  });
}
