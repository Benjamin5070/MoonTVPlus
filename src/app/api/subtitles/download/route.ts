import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';

export const runtime = 'nodejs';

const API_BASE = 'https://api.opensubtitles.com/api/v1';

export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: '未授权' }, { status: 401 });
  }

  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;
  if (!apiKey || !username || !password) {
    return NextResponse.json(
      { error: '服务器需配置 OPENSUBTITLES_API_KEY、OPENSUBTITLES_USERNAME 和 OPENSUBTITLES_PASSWORD' },
      { status: 503 }
    );
  }

  const body = await request.json().catch(() => null);
  const fileId = Number(body?.fileId);
  if (!Number.isSafeInteger(fileId) || fileId <= 0) {
    return NextResponse.json({ error: '无效的字幕文件 ID' }, { status: 400 });
  }

  try {
    const loginResponse = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'User-Agent': 'MoonTVPlus v1.0',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(12000),
    });
    const login = await loginResponse.json().catch(() => null);
    if (!loginResponse.ok || !login?.token) {
      return NextResponse.json({ error: 'OpenSubtitles 登录失败，请检查服务器端账号配置' }, { status: 502 });
    }

    const downloadResponse = await fetch(`${API_BASE}/download`, {
      method: 'POST',
      headers: {
        'Api-Key': apiKey,
        'User-Agent': 'MoonTVPlus v1.0',
        Authorization: `Bearer ${login.token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(12000),
    });
    const download = await downloadResponse.json().catch(() => null);
    if (!downloadResponse.ok || !download?.link) {
      return NextResponse.json(
        { error: download?.message || '获取字幕下载链接失败' },
        { status: downloadResponse.status === 429 ? 429 : 502 }
      );
    }

    const fileResponse = await fetch(download.link, {
      signal: AbortSignal.timeout(20000),
    });
    if (!fileResponse.ok) {
      return NextResponse.json({ error: '下载字幕文件失败' }, { status: 502 });
    }

    const bytes = await fileResponse.arrayBuffer();
    if (bytes.byteLength > 8 * 1024 * 1024) {
      return NextResponse.json({ error: '字幕文件超过 8 MB 限制' }, { status: 413 });
    }
    const fileName = String(download.file_name || body?.fileName || 'online-subtitle.srt')
      .replace(/[\\/\r\n"]/g, '_')
      .slice(0, 180);
    const extension = fileName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || 'srt';
    if (!['srt', 'vtt', 'ass', 'ssa', 'ttml', 'dfxp', 'xml', 'sbv', 'sub', 'lrc'].includes(extension)) {
      return NextResponse.json({ error: '该在线字幕格式暂不支持' }, { status: 415 });
    }

    return new NextResponse(bytes, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'Cache-Control': 'no-store',
      },
    });
  } catch (error) {
    console.error('[OnlineSubtitle] download failed:', error);
    return NextResponse.json({ error: '在线字幕下载失败或超时' }, { status: 502 });
  }
}
