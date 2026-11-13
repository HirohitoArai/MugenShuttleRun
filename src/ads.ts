// 広告（AdMob バナー）。ネイティブアプリ（Capacitor）でのみ初期化し、Web では何もしない。
// 開発中は Google 公式のテスト広告 ID を使う。本番 ID は AdMob 登録後に差し替える。
const TEST_BANNER_ID = 'ca-app-pub-3940256099942544/6300978111';

export async function initAds(): Promise<void> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (!Capacitor.isNativePlatform()) return;
    const { AdMob, BannerAdSize, BannerAdPosition } = await import('@capacitor-community/admob');
    await AdMob.initialize({});
    // バナーに画面下部を隠されないよう、余白を足してから表示する
    document.body.classList.add('native-ads');
    await AdMob.showBanner({
      adId: TEST_BANNER_ID,
      adSize: BannerAdSize.ADAPTIVE_BANNER,
      position: BannerAdPosition.BOTTOM_CENTER,
      margin: 0,
      isTesting: true,
    });
  } catch {
    // 広告が初期化できなくてもアプリ本体は動かす
  }
}
