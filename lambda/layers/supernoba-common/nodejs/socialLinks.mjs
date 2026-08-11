/**
 * Supernoba Social Links Layer
 *
 * 플랫폼 정보 및 소셜 링크 처리를 위한 공유 유틸리티
 */

/**
 * 플랫폼 URL 패턴 (자동 감지용)
 */
const PLATFORM_PATTERNS = Object.freeze({
  YOUTUBE: ['youtube.com', 'youtu.be'],
  X: ['twitter.com', 'x.com'],
  INSTAGRAM: ['instagram.com'],
  TWITCH: ['twitch.tv'],
  TIKTOK: ['tiktok.com'],
  CHZZK: ['chzzk.naver.com'],
  AFREECATV: ['afreecatv.com', 'play.afreecatv.com'],
});

/**
 * URL에서 플랫폼 자동 감지
 *
 * @param {string} url - 검사할 URL
 * @returns {string|null} 감지된 플랫폼 이름 (대문자) 또는 null
 *
 * @example
 * detectPlatformFromUrl('https://youtube.com/@creator') // 'YOUTUBE'
 * detectPlatformFromUrl('https://example.com')          // null
 */
export function detectPlatformFromUrl(url) {
  if (!url) return null;

  const lowerUrl = url.toLowerCase();

  for (const [platform, patterns] of Object.entries(PLATFORM_PATTERNS)) {
    if (patterns.some((pattern) => lowerUrl.includes(pattern))) {
      return platform;
    }
  }

  return null;
}

// 기본 export
export default { detectPlatformFromUrl };
