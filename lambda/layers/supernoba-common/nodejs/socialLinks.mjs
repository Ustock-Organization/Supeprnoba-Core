/**
 * Supernoba Social Links Layer
 *
 * 플랫폼 정보 및 소셜 링크 처리를 위한 공유 유틸리티
 * Frontend와 Backend에서 동일하게 사용 가능
 */

/**
 * 지원되는 플랫폼 목록 및 정규화 매핑
 */
export const PLATFORMS = Object.freeze({
  YOUTUBE: 'youtube',
  X: 'twitter',        // X는 twitter로 정규화
  TWITTER: 'twitter',
  INSTAGRAM: 'instagram',
  TWITCH: 'twitch',
  TIKTOK: 'tiktok',
  CHZZK: 'chzzk',
  AFREECATV: 'afreecatv',
  AFREECA: 'afreecatv', // 별칭
  ETC: 'etc',
});

/**
 * 플랫폼별 색상 (UI용)
 */
export const PLATFORM_COLORS = Object.freeze({
  YOUTUBE: '#FF0000',
  X: '#000000',
  TWITTER: '#1DA1F2',
  TWITCH: '#9146FF',
  INSTAGRAM: '#E4405F',
  TIKTOK: '#000000',
  AFREECATV: '#0066FF',
  CHZZK: '#00FFA3',
  ETC: '#888888',
});

/**
 * 플랫폼별 표시 라벨
 */
export const PLATFORM_LABELS = Object.freeze({
  YOUTUBE: 'YouTube',
  X: 'X (Twitter)',
  TWITTER: 'Twitter',
  TWITCH: 'Twitch',
  INSTAGRAM: 'Instagram',
  TIKTOK: 'TikTok',
  AFREECATV: '아프리카TV',
  CHZZK: '치지직',
  ETC: '기타',
});

/**
 * 플랫폼 URL 패턴 (자동 감지용)
 */
export const PLATFORM_PATTERNS = Object.freeze({
  YOUTUBE: ['youtube.com', 'youtu.be'],
  X: ['twitter.com', 'x.com'],
  INSTAGRAM: ['instagram.com'],
  TWITCH: ['twitch.tv'],
  TIKTOK: ['tiktok.com'],
  CHZZK: ['chzzk.naver.com'],
  AFREECATV: ['afreecatv.com', 'play.afreecatv.com'],
});

/**
 * 소셜 링크 빌드 함수
 *
 * 기존 소셜 링크에 플랫폼별 URL을 병합합니다.
 *
 * @param {string} platform - 플랫폼 이름 (대소문자 무관)
 * @param {string} creatorUrl - 크리에이터 URL
 * @param {Object} [existingSocialLinks={}] - 기존 소셜 링크 객체
 * @returns {Object} 병합된 소셜 링크 객체
 *
 * @example
 * const links = buildSocialLinks('YOUTUBE', 'https://youtube.com/@creator', {
 *   twitter: 'https://twitter.com/creator'
 * });
 * // { youtube: 'https://youtube.com/@creator', twitter: 'https://twitter.com/creator', ... }
 */
export function buildSocialLinks(platform, creatorUrl, existingSocialLinks = {}) {
  const links = {
    youtube: existingSocialLinks?.youtube || null,
    twitter: existingSocialLinks?.twitter || null,
    instagram: existingSocialLinks?.instagram || null,
    twitch: existingSocialLinks?.twitch || null,
    tiktok: existingSocialLinks?.tiktok || null,
    chzzk: existingSocialLinks?.chzzk || null,
    afreecatv: existingSocialLinks?.afreecatv || null,
  };

  if (creatorUrl && platform) {
    const normalizedKey = PLATFORMS[platform.toUpperCase()];
    if (normalizedKey && normalizedKey !== 'etc' && links.hasOwnProperty(normalizedKey)) {
      links[normalizedKey] = creatorUrl;
    }
  }

  return links;
}

/**
 * 플랫폼 이름 정규화
 *
 * @param {string} platform - 플랫폼 이름
 * @returns {string} 정규화된 플랫폼 이름 (대문자)
 *
 * @example
 * normalizePlatform('youtube') // 'YOUTUBE'
 * normalizePlatform('x')       // 'X'
 * normalizePlatform('unknown') // 'ETC'
 */
export function normalizePlatform(platform) {
  if (!platform) return 'ETC';
  const upper = platform.toUpperCase();
  return PLATFORMS[upper] ? upper : 'ETC';
}

/**
 * 플랫폼 색상 조회
 *
 * @param {string} platform - 플랫폼 이름
 * @returns {string} 색상 코드 (HEX)
 */
export function getPlatformColor(platform) {
  const normalized = normalizePlatform(platform);
  return PLATFORM_COLORS[normalized] || PLATFORM_COLORS.ETC;
}

/**
 * 플랫폼 라벨 조회
 *
 * @param {string} platform - 플랫폼 이름
 * @returns {string} 표시용 라벨
 */
export function getPlatformLabel(platform) {
  const normalized = normalizePlatform(platform);
  return PLATFORM_LABELS[normalized] || PLATFORM_LABELS.ETC;
}

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

/**
 * 드롭다운/셀렉트용 플랫폼 옵션 배열 생성
 *
 * @param {boolean} [includeEtc=true] - '기타' 옵션 포함 여부
 * @returns {Array<{value: string, label: string}>} 옵션 배열
 */
export function getPlatformOptions(includeEtc = true) {
  const options = [
    { value: 'YOUTUBE', label: 'YouTube' },
    { value: 'X', label: 'X (Twitter)' },
    { value: 'INSTAGRAM', label: 'Instagram' },
    { value: 'TIKTOK', label: 'TikTok' },
    { value: 'TWITCH', label: 'Twitch' },
    { value: 'CHZZK', label: '치지직' },
    { value: 'AFREECATV', label: '아프리카TV' },
  ];

  if (includeEtc) {
    options.push({ value: 'ETC', label: '기타' });
  }

  return options;
}

/**
 * 소셜 링크 객체에서 유효한 링크만 추출
 *
 * @param {Object} socialLinks - 소셜 링크 객체
 * @returns {Object} null이 아닌 링크만 포함된 객체
 */
export function getValidSocialLinks(socialLinks) {
  if (!socialLinks) return {};

  return Object.fromEntries(
    Object.entries(socialLinks).filter(([, value]) => value != null && value !== '')
  );
}

/**
 * 소셜 링크 개수 계산
 *
 * @param {Object} socialLinks - 소셜 링크 객체
 * @returns {number} 유효한 링크 개수
 */
export function countSocialLinks(socialLinks) {
  return Object.keys(getValidSocialLinks(socialLinks)).length;
}

// 기본 export
export default {
  PLATFORMS,
  PLATFORM_COLORS,
  PLATFORM_LABELS,
  PLATFORM_PATTERNS,
  buildSocialLinks,
  normalizePlatform,
  getPlatformColor,
  getPlatformLabel,
  detectPlatformFromUrl,
  getPlatformOptions,
  getValidSocialLinks,
  countSocialLinks,
};
