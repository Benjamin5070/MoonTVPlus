/* eslint-disable @typescript-eslint/no-explicit-any, no-console */

import { NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { safeFetch } from '@/lib/safe-http';
import { getNextApiKey } from '@/lib/tmdb.client';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CACHE_DURATION = 60 * 60 * 1000;
const REGIONS = ['US', 'GB', 'MY', 'JP', 'KR'];
let cache: { data: { movies: any[]; tvShows: any[] }; timestamp: number } | null = null;

async function discoverNetflix(
  apiKey: string,
  mediaType: 'movie' | 'tv',
  region: string,
  proxy?: string,
  reverseProxyBaseUrl?: string
) {
  const baseUrl = (reverseProxyBaseUrl || 'https://api.themoviedb.org').replace(/\/$/, '');
  const params = new URLSearchParams({
    api_key: getNextApiKey(apiKey),
    language: 'zh-CN',
    page: '1',
    sort_by: 'popularity.desc',
    watch_region: region,
    with_watch_providers: '8',
    with_watch_monetization_types: 'flatrate',
  });
  const response = await safeFetch(
    `${baseUrl}/3/discover/${mediaType}?${params.toString()}`,
    { signal: AbortSignal.timeout(15000) },
    proxy
  );
  if (!response.ok) {
    throw new Error(`TMDB ${mediaType} ${region} 请求失败：${response.status}`);
  }
  const data = await response.json() as { results?: any[] };
  return (data.results || []).map((item) => ({
    id: Number(item.id),
    title: item.title || item.name || '',
    poster_path: item.poster_path || null,
    backdrop_path: item.backdrop_path || null,
    release_date: item.release_date || item.first_air_date || '',
    overview: item.overview || '',
    vote_average: Number(item.vote_average || 0),
    media_type: mediaType,
    genre_ids: item.genre_ids || [],
    popularity: Number(item.popularity || 0),
    origin_country: item.origin_country || [],
  }));
}

export async function GET() {
  try {
    if (cache && Date.now() - cache.timestamp < CACHE_DURATION) {
      return NextResponse.json({ code: 200, ...cache.data, cached: true });
    }

    const config = await getConfig();
    const apiKey = config.SiteConfig?.TMDBApiKey;
    const proxy = config.SiteConfig?.TMDBProxy;
    const reverseProxy = config.SiteConfig?.TMDBReverseProxy;

    if (!apiKey) {
      return NextResponse.json(
        { code: 400, message: 'TMDB API Key 未配置' },
        { status: 400 }
      );
    }

    const requests = await Promise.all(
      REGIONS.flatMap((region) => [
        discoverNetflix(apiKey, 'movie', region, proxy, reverseProxy),
        discoverNetflix(apiKey, 'tv', region, proxy, reverseProxy),
      ])
    );

    const moviesMap = new Map<number, any>();
    const tvMap = new Map<number, any>();
    requests.forEach((items, index) => {
      const target = index % 2 === 0 ? moviesMap : tvMap;
      items.forEach((item: any) => {
        const existing = target.get(item.id);
        if (!existing || item.popularity > existing.popularity) {
          target.set(item.id, item);
        }
      });
    });

    const sortAndLimit = (items: Map<number, any>) =>
      Array.from(items.values())
        .sort((a, b) => b.popularity - a.popularity)
        .slice(0, 24)
        .map(({ popularity: _popularity, ...item }) => item);

    const data = {
      movies: sortAndLimit(moviesMap),
      tvShows: sortAndLimit(tvMap),
    };
    cache = { data, timestamp: Date.now() };

    return NextResponse.json({ code: 200, ...data, cached: false }, {
      headers: {
        'Cache-Control': 'public, max-age=3600, s-maxage=3600',
      },
    });
  } catch (error) {
    console.error('获取 Netflix 全球热门失败:', error);
    return NextResponse.json(
      { code: 500, message: '获取 Netflix 热门数据失败' },
      { status: 500 }
    );
  }
}
