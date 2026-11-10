// 無限に増える数値の整形。単位を段階的に上げて、桁が際限なく伸びないようにする。

export function fmtGrouped(x: number, dec: number): string {
  const [i, f] = x.toFixed(dec).split('.');
  const grouped = Number(i).toLocaleString('en-US');
  return f ? `${grouped}.${f}` : grouped;
}

/** 大きさに応じて小数の桁を落とす */
export function fmtScaled(v: number): string {
  if (v < 100) return v.toFixed(2);
  if (v < 1000) return fmtGrouped(v, 1);
  return fmtGrouped(v, 0);
}

const MAN_UNITS = ['', '万', '億', '兆', '京', '垓'];

/** 万進法: 1万以上は 万→億→兆→京→垓 と単位を上げ、数値側を小さく保つ */
export function fmtMan(x: number): { text: string; suffix: string } {
  if (x < 10000) {
    const dec = x < 100 ? 2 : x < 1000 ? 1 : 0;
    return { text: fmtGrouped(x, dec), suffix: '' };
  }
  let v = x;
  let u = 0;
  while (v >= 10000 && u < MAN_UNITS.length - 1) {
    v /= 10000;
    u++;
  }
  return { text: fmtScaled(v), suffix: MAN_UNITS[u] };
}

/**
 * 時間: 「何分何秒」の複合表記にする（1.55分 のような小数表記はしない）。
 * 60秒未満は秒（小数2桁）、1時間未満は 分＋秒（小数2桁）、
 * 24時間未満は 時間＋分＋秒、365日未満は 日＋時間＋分、それ以上は 年＋日。
 */
export function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec.toFixed(2)}秒`;
  if (sec < 3600) {
    const m = Math.floor(sec / 60);
    const s = sec - m * 60;
    return `${m}分${s.toFixed(2).padStart(5, '0')}秒`;
  }
  if (sec < 86400) {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${h}時間${m}分${s}秒`;
  }
  if (sec < 86400 * 365) {
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${d}日${h}時間${m}分`;
  }
  const y = Math.floor(sec / (86400 * 365));
  const d = Math.floor((sec % (86400 * 365)) / 86400);
  return `${y}年${d}日`;
}

/**
 * 経過時間専用の全桁表示。既定の項は「時間・分・秒」の3項で、1時間未満でも
 * 「0時間1分33.62秒」のように時間の項を出す。日・年は桁が上がったら上に足す。
 * 秒はどれだけ長くなっても必ず小数2桁まで表示する。
 * 100分の1秒単位で丸めてから分解するので、59.999秒は「0時間1分00.00秒」と繰り上がる。
 */
export function fmtDurationFull(sec: number): string {
  let rest = Math.round(Math.max(0, sec) * 100); // 100分の1秒単位
  const years = Math.floor(rest / 3153600000);
  rest %= 3153600000;
  const days = Math.floor(rest / 8640000);
  rest %= 8640000;
  const hours = Math.floor(rest / 360000);
  rest %= 360000;
  const minutes = Math.floor(rest / 6000);
  rest %= 6000;
  const seconds = `${String(Math.floor(rest / 100)).padStart(2, '0')}.${String(rest % 100).padStart(2, '0')}`;

  const tail = `${hours}時間${minutes}分${seconds}秒`;
  if (years > 0) return `${years}年${days}日${tail}`;
  if (days > 0) return `${days}日${tail}`;
  return tail;
}

/** 距離: m → km → 万km → 億km … */
export function fmtDistance(m: number): { text: string; unit: string } {
  if (m < 1000) return { text: m.toFixed(1), unit: 'm' };
  const r = fmtMan(m / 1000);
  return { text: r.text, unit: `${r.suffix}km` };
}

/** カロリー: kcal → 万kcal → 億kcal …（ラベル用の単位も返す） */
export function fmtCalories(kcal: number): { text: string; unit: string } {
  const r = fmtMan(kcal);
  return { text: r.text, unit: `${r.suffix}kcal` };
}
