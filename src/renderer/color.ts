// コスト画面とお知らせの窓で共有する、色の計算

/** 背景色が明るいか(相対輝度)。明るい背景では面の段差とグラフの色を切り替える */
export function isLightColor(hex: string): boolean {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) return false
  const channel = (offset: number) => {
    const c = parseInt(match[1].slice(offset, offset + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4) > 0.4
}
