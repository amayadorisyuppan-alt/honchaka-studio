// 画像のフォルダのサムネイルを作る。(2026-10-12 改修の希望 2)
//
// **大きな原画を毎回読み直さない。** 販売用の原画は1枚 10MB を超えることがあり、
// 一覧のたびに全部を読むと重い。小さく作って IndexedDB に覚えておき(project/imageFolder.ts)、
// ファイルが変わっていなければ覚えたものを出す。作るのは1枚ずつ(呼び出し側が間に一息入れる)。
//
// ブラウザ専用(createImageBitmap と canvas を使う)。

/** サムネイルの長い辺(px)。一覧の箱は2列で約 200px 幅なので、細かい画面でもにじまない大きさ */
export const THUMB_SIDE = 360;
const THUMB_QUALITY = 0.8;

/** 原画のファイルから、長い辺 THUMB_SIDE の JPEG を作る。読めない画像は例外 */
export async function makeThumb(file: Blob): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  try {
    const scale = Math.min(1, THUMB_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    if (typeof OffscreenCanvas !== 'undefined') {
      const c = new OffscreenCanvas(w, h);
      const ctx = c.getContext('2d');
      if (!ctx) throw new Error('canvas');
      // 透けている絵は、JPEG にすると黒く潰れるので白い下地を敷く(一覧の箱の地と同じ)
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bmp, 0, 0, w, h);
      return await c.convertToBlob({ type: 'image/jpeg', quality: THUMB_QUALITY });
    }
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    if (!ctx) throw new Error('canvas');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, w, h);
    return await new Promise<Blob>((resolve, reject) =>
      c.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob'))), 'image/jpeg', THUMB_QUALITY),
    );
  } finally {
    bmp.close();
  }
}
