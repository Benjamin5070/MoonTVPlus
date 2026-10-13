import { NextRequest, NextResponse } from 'next/server';
import { getAuthInfoFromCookie } from '@/lib/auth';

export const runtime = 'nodejs';

const OPEN_API = 'https://api.opensubtitles.com/api/v1';
const DANMU_API_BASE = (process.env.DANMU_API_BASE || 'https://danmuapi-green-seven.vercel.app').replace(/\/$/, '');

type SubtitleResult = {
  fileId: string | number;
  fileName: string;
  title: string;
  release: string;
  language: string;
  downloads: number;
  hearingImpaired: boolean;
  season: number | null;
  episode: number | null;
  provider: 'SubDL' | 'OpenSubtitles';
};

function normalizeLanguage(language: unknown) {
  const value = String(language || '').toLowerCase();
  if (['zh', 'zho', 'chi', 'chs', 'cht', 'chinese', '简体中文', '繁體中文'].includes(value)) return 'ZH';
  if (['en', 'eng', 'english'].includes(value)) return 'EN';
  return value.toUpperCase();
}

async function searchSubDL(
  query: string,
  year: string,
  season: string | null,
  episode: string | null
): Promise<SubtitleResult[] | null> {
  const url = new URL(`${DANMU_API_BASE}/api/v2/subtitles/search`);
  url.searchParams.set('query', query);
  if (/^\d{4}$/.test(year)) url.searchParams.set('year', year);
  if (season && /^\d{1,2}$/.test(season)) url.searchParams.set('season', season);
  if (episode && /^\d{1,3}$/.test(episode)) url.searchParams.set('episode', episode);

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`danmu-api/SubDL HTTP ${response.status}`);

  const payload = await response.json();
  const rows = Array.isArray(payload?.results)
    ? payload.results
    : Array.isArray(payload?.subtitles)
      ? payload.subtitles
      : [];

  return rows.map((item: any): SubtitleResult | null => {
    const fileId = item?.fileId ?? item?.file_id ?? item?.url;
    if (!(typeof fileId === 'string' && fileId) && !(Number.isSafeInteger(fileId) && fileId > 0)) return null;
    const language = normalizeLanguage(item?.language || item?.lang);
    if (language && !['ZH', 'EN'].includes(language)) return null;
    const rawName = String(item?.fileName || item?.file_name || item?.release || item?.name || `subtitle.${language || 'EN'}.srt`);
    const fileName = /\.(srt|vtt|ass|ssa|ttml|dfxp|xml|sbv|sub|lrc|sup|pgs)$/i.test(rawName)
      ? rawName
      : `${rawName}.srt`;
    return {
      fileId: typeof fileId === 'string' && !fileId.startsWith('subdl:')
        ? `subdl:${fileId}`
        : fileId,
      fileName,
      title: String(item?.title || query),
      release: String(item?.release || item?.name || ''),
      language: language || 'EN',
      downloads: Number(item?.downloads || item?.download_count || 0),
      hearingImpaired: Boolean(item?.hearingImpaired || item?.hearing_impaired),
      season: Number.isInteger(item?.season) ? item.season : (season ? Number(season) : null),
      episode: Number.isInteger(item?.episode) ? item.episode : (episode ? Number(episode) : null),
      provider: 'SubDL',
    };
  }).filter((item: SubtitleResult | null): item is SubtitleResult => item !== null).slice(0, 30);
}

async function searchOpenSubtitles(
  query: string,
  year: string,
  season: string | null,
  episode: string | null
): Promise<SubtitleResult[] | null> {
  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) return null;

  const upstream = new URL(`${OPEN_API}/subtitles`);
  upstream.searchParams.set('query', query);
  upstream.searchParams.set('languages', 'chi,zho,eng');
  upstream.searchParams.set('order_by', 'download_count');
  upstream.searchParams.set('order_direction', 'desc');
  upstream.searchParams.set('page', '1');
  if (/^\d{4}$/.test(year)) upstream.searchParams.set('year', year);
  if (season && /^\d{1,2}$/.test(season)) upstream.searchParams.set('season_number', season);
  if (episode && /^\d{1,3}$/.test(episode)) upstream.searchParams.set('episode_number', episode);

  const response = await fetch(upstream, {
    headers: { 'Api-Key': apiKey, 'User-Agent': 'MoonTVPlus v1.0', Accept: 'application/json' },
    signal: AbortSignal.timeout(12000),
    cache: 'no-store',
  });
  if (!response.ok) throw new Error(`OpenSubtitles HTTP ${response.status}`);
  const payload = await response.json();

  return (Array.isArray(payload?.data) ? payload.data : []).map((item: any): SubtitleResult | null => {
    const attributes = item?.attributes || {};
    const file = Array.isArray(attributes.files)
      ? attributes.files.find((candidate: any) => Number.isSafeInteger(candidate?.file_id) && candidate.file_id > 0)
      : null;
    if (!file) return null;
    const feature = attributes.feature_details || {};
    return {
      fileId: file.file_id,
      fileName: file.file_name || 'subtitle.srt',
      title: feature.title || attributes.release || query,
      release: attributes.release || '',
      language: normalizeLanguage(attributes.language),
      downloads: Number(attributes.download_count || 0),
      hearingImpaired: Boolean(attributes.hearing_impaired),
      season: feature.season_number ?? null,
      episode: feature.episode_number ?? null,
      provider: 'OpenSubtitles',
    };
  }).filter((item: SubtitleResult | null): item is SubtitleResult => item !== null).slice(0, 30);
}

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) return NextResponse.json({ error: '未授权' }, { status: 401 });

  const params = new URL(request.url).searchParams;
  const query = (params.get('query') || '').trim().slice(0, 120);
  const year = (params.get('year') || '').trim();
  const season = params.get('season');
  const episode = params.get('episode');
  if (!query) return NextResponse.json({ error: '请输入影片名称' }, { status: 400 });

  let subdlError: unknown;
  try {
    const results = await searchSubDL(query, year, season, episode);
    if (results?.length) return NextResponse.json({ results, provider: 'SubDL' });
  } catch (error) {
    subdlError = error;
    console.error('[OnlineSubtitle] SubDL/danmu-api search failed:', error);
  }

  try {
    const results = await searchOpenSubtitles(query, year, season, episode);
    if (results?.length) return NextResponse.json({ results, provider: 'OpenSubtitles' });
    if (!results) {
      return NextResponse.json({
        error: 'SubDL 没有可用结果，且未配置 OPENSUBTITLES_API_KEY',
        detail: subdlError ? 'SubDL 接口请求失败' : undefined,
      }, { status: 503 });
    }
    return NextResponse.json({ results: [], provider: 'OpenSubtitles' });
  } catch (error) {
    console.error('[OnlineSubtitle] OpenSubtitles search failed:', error);
    return NextResponse.json({
      error: subdlError
        ? 'SubDL 和 OpenSubtitles 搜索均失败，请检查接口和 API 配置'
        : 'OpenSubtitles 搜索失败，请检查 API Key 和服务状态',
    }, { status: 502 });
  }
}
