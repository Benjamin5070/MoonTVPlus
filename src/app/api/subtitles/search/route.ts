import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';

export const runtime = 'nodejs';

const API_BASE = 'https://api.opensubtitles.com/api/v1';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: '服务器未配置 OpenSubtitles API Key' },
      { status: 503 }
    );
  }

  const params = new URL(request.url).searchParams;
  const query = (params.get('query') || '').trim().slice(0, 120);
  const year = (params.get('year') || '').trim();
  const season = params.get('season');
  const episode = params.get('episode');
  if (!query) {
    return NextResponse.json({ error: '请输入影片名称' }, { status: 400 });
  }

  const upstream = new URL(`${API_BASE}/subtitles`);
  upstream.searchParams.set('query', query);
  upstream.searchParams.set('languages', 'chi,zho,eng');
  upstream.searchParams.set('order_by', 'download_count');
  upstream.searchParams.set('order_direction', 'desc');
  upstream.searchParams.set('page', '1');
  if (/^\d{4}$/.test(year)) upstream.searchParams.set('year', year);
  if (season && /^\d{1,2}$/.test(season)) upstream.searchParams.set('season_number', season);
  if (episode && /^\d{1,3}$/.test(episode)) upstream.searchParams.set('episode_number', episode);

  try {
    const response = await fetch(upstream, {
      headers: {
        'Api-Key': apiKey,
        'User-Agent': 'MoonTVPlus v1.0',
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(12000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      return NextResponse.json(
        { error: payload?.message || 'OpenSubtitles 搜索失败' },
        { status: response.status === 429 ? 429 : 502 }
      );
    }

    const results = (Array.isArray(payload?.data) ? payload.data : [])
      .map((item: any) => {
        const file = Array.isArray(item?.attributes?.files)
          ? item.attributes.files.find((candidate: any) => Number.isInteger(candidate?.file_id))
          : null;
        if (!file) return null;
        const attributes = item.attributes || {};
        const feature = attributes.feature_details || {};
        return {
          fileId: file.file_id,
          fileName: file.file_name || 'subtitle.srt',
          title: feature.title || attributes.release || query,
          release: attributes.release || '',
          language: attributes.language || '',
          downloads: attributes.download_count || 0,
          hearingImpaired: !!attributes.hearing_impaired,
          season: feature.season_number ?? null,
          episode: feature.episode_number ?? null,
        };
      })
      .filter(Boolean)
      .slice(0, 20);

    return NextResponse.json({ results });
  } catch (error) {
    console.error('[OnlineSubtitle] search failed:', error);
    return NextResponse.json({ error: '在线字幕搜索超时或网络错误' }, { status: 502 });
  }
}
