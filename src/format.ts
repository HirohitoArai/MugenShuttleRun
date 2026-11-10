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

/** 時間: 秒 → 分 → 時間 → 日 → 年 と単位を上げる */
export function fmtDuration(sec: number): { text: string; unit: string } {
  if (sec < 60) return { text: sec.toFixed(2), unit: '秒' };
  const min = sec / 60;
  if (min < 60) return { text: fmtScaled(min), unit: '分' };
  const hr = min / 60;
  if (hr < 24) return { text: fmtScaled(hr), unit: '時間' };
  const day = hr / 24;
  if (day < 365) return { text: fmtScaled(day), unit: '日' };
  return { text: fmtScaled(day / 365), unit: '年' };
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
