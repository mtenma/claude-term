// コスト画面とお知らせの窓で共有する、色の計算

/** 相対輝度(WCAG)。形が違えば null */
function luminance(hex: string): number | null {
  const match = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!match) return null
  const channel = (offset: number) => {
    const c = parseInt(match[1].slice(offset, offset + 2), 16) / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** 背景色が明るいか(相対輝度)。明るい背景では面の段差とグラフの色を切り替える */
export function isLightColor(hex: string): boolean {
  return (luminance(hex) ?? 0) > 0.4
}

/**
 * その色で塗った上に置く文字の色。黒と白のうちコントラスト比の高いほう(境目は相対輝度 約 0.179)。
 * 背景の明暗のしきい値(0.4)をそのまま使うと、既定の強調色 #d97757 で白になり 3.1:1 しか取れない
 */
export function textColorOn(hex: string): '#000000' | '#ffffff' {
  const l = luminance(hex) ?? 0
  return (l + 0.05) / 0.05 >= 1.05 / (l + 0.05) ? '#000000' : '#ffffff'
}
