
import { NextRequest, NextResponse } from 'next/server';
import { getAuthInfoFromCookie } from '@/lib/auth';

export const runtime = 'nodejs';

const OPEN_API = 'https://api.opensubtitles.com/api/v1';
const SUBDL_API = 'https://api.subdl.com/api/v1/subtitles';

function normalizeLanguage(language: string) {
  const value = language.toLowerCase();
  if (['zh', 'zho', 'chi', 'chs', 'cht'].includes(value)) return 'ZH';
  if (['en', 'eng'].includes(value)) return 'EN';
  return value.toUpperCase();
}

async function searchSubDL(
  query: string,
  year: string,
  season: string | null,
  episode: string | null
) {
  const apiKey = process.env.SUBDL_API_KEY;
  if (!apiKey) return null;

  const url = new URL(SUBDL_API);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('film_name', query);
  url.searchParams.set('type', 'movie');
  url.searchParams.set('languages', 'EN,ZH');

  if (/^\d{4}$/.test(year)) {
    url.searchParams.set('year', year);
  }

  if (season && /^\d{1,2}$/.test(season)) {
    url.searchParams.set('season_number', season);
    url.searchParams.set('type', 'tv');
  }

  if (episode && /^\d{1,3}$/.test(episode)) {
    url.searchParams.set('episode_number', episode);
    url.searchParams.set('type', 'tv');
  }

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`SubDL HTTP ${response.status}`);
  }

  const payload = await response.json();
  const results = (Array.isArray(payload?.subtitles) ? payload.subtitles : [])
    .map((item: any) => {
      const fileId = item?.url;
      if (typeof fileId !== 'string' || !fileId) return null;

      const language = normalizeLanguage(item?.lang || item?.language || '');
      if (!['ZH', 'EN'].includes(language)) return null;

      const fileName =
        item?.release || item?.name || `${query}.${language}.srt`;

      return {
        fileId: fileId.startsWith('subdl:')
          ? fileId
          : `subdl:${fileId}`,
        fileName: fileName.toLowerCase().endsWith('.srt')
          ? fileName
          : `${fileName}.srt`,
        title: query,
        release: item?.release || item?.name || '',
        language,
        downloads: 0,
        hearingImpaired: false,
        season: season ? Number(season) : 0,
        episode: episode ? Number(episode) : 0,
        provider: 'SubDL',
      };
    })
    .filter(Boolean)
    .slice(0, 20);

  return results;
}

async function searchOpenSubtitles(
  query: string,
  year: string,
  season: string | null,
  episode: string | null
) {
  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) return null;

  const upstream = new URL(`${OPEN_API}/subtitles`);
  upstream.searchParams.set('query', query);
  upstream.searchParams.set('languages', 'chi,zho,eng');
  upstream.searchParams.set('order_by', 'download_count');
  upstream.searchParams.set('order_direction', 'desc');
  upstream.searchParams.set('page', '1');

  if (/^\d{4}$/.test(year)) upstream.searchParams.set('year', year);
  if (season && /^\d{1,2}$/.test(season)) {
    upstream.searchParams.set('season_number', season);
  }
  if (episode && /^\d{1,3}$/.test(episode)) {
    upstream.searchParams.set('episode_number', episode);
  }

  const response = await fetch(upstream, {
    headers: {
      'Api-Key': apiKey,
      'User-Agent': 'MoonTVPlus v1.0',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(10000),
    cache: 'no-store',
  });

  if (!response.ok) {
    throw new Error(`OpenSubtitles HTTP ${response.status}`);
  }

  const payload = await response.json();

  return (Array.isArray(payload?.data) ? payload.data : [])
    .map((item: any) => {
      const file = Array.isArray(item?.attributes?.files)
        ? item.attributes.files.find((candidate: any) =>
            Number.isInteger(candidate?.file_id)
          )
        : null;

      if (!file) return null;

      const attributes = item.attributes || {};
      const feature = attributes.feature_details || {};

      return {
        fileId: file.file_id,
        fileName: file.file_name || 'subtitle.srt',
        title: feature.title || attributes.release || query,
        release: attributes.release || '',
        language: normalizeLanguage(attributes.language || ''),
        downloads: attributes.download_count || 0,
        hearingImpaired: !!attributes.hearing_impaired,
        season: feature.season_number ?? null,
        episode: feature.episode_number ?? null,
        provider: 'OpenSubtitles',
      };
    })
    .filter(Boolean)
    .slice(0, 20);
}

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);

  if (!authInfo?.username) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const params = new URL(request.url).searchParams;
  const query = (params.get('query') || '').trim().slice(0, 120);
  const year = (params.get('year') || '').trim();
  const season = params.get('season');
  const episode = params.get('episode');

  if (!query) {
    return NextResponse.json(
      { error: '请输入影片名称' },
      { status: 400 }
    );
  }

  let subdlError: unknown;

  try {
    const results = await searchSubDL(query, year, season, episode);

    if (results && results.length > 0) {
      return NextResponse.json({ results, provider: 'SubDL' });
    }
  } catch (error) {
    subdlError = error;
    console.error('[OnlineSubtitle] SubDL search failed:', error);
  }

  try {
    const results = await searchOpenSubtitles(
      query,
      year,
      season,
      episode
    );

    if (results && results.length > 0) {
      return NextResponse.json({
        results,
        provider: 'OpenSubtitles',
      });
    }

    if (!results && !process.env.SUBDL_API_KEY) {
      return NextResponse.json(
        { error: '请配置 SUBDL_API_KEY 或 OPENSUBTITLES_API_KEY' },
        { status: 503 }
      );
    }

    return NextResponse.json({
      results: [],
      provider: 'OpenSubtitles',
    });
  } catch (error) {
    console.error('[OnlineSubtitle] OpenSubtitles search failed:', error);

    return NextResponse.json(
      {
        error: subdlError
          ? 'SubDL 和 OpenSubtitles 搜索均失败，请检查 API Key 和服务状态'
          : 'OpenSubtitles 搜索失败，请检查 API Key 和服务状态',
      },
      { status: 502 }
    );
  }
}
