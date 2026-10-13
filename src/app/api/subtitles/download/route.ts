import { NextRequest, NextResponse } from 'next/server';
import { getAuthInfoFromCookie } from '@/lib/auth';

export const runtime = 'nodejs';

const API_BASE = 'https://api.opensubtitles.com/api/v1';
const DANMU_API_BASE = (process.env.DANMU_API_BASE || 'https://danmuapi-green-seven.vercel.app').replace(/\/$/, '');
const ALLOWED_EXTENSIONS = new Set(['srt', 'vtt', 'ass', 'ssa', 'ttml', 'dfxp', 'xml', 'sbv', 'sub', 'lrc', 'sup', 'pgs']);

function safeFileName(value: unknown) {
  return String(value || 'online-subtitle.srt').replace(/[\\/\r\n"]/g, '_').slice(0, 180);
}

function validExtension(fileName: string) {
  const extension = fileName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || 'srt';
  return ALLOWED_EXTENSIONS.has(extension);
}

export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) return NextResponse.json({ error: '未授权' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const rawFileId = body?.fileId;
  const fileName = safeFileName(body?.fileName);
  if (!(typeof rawFileId === 'string' && rawFileId.length > 0 && rawFileId.length <= 500)
      && !(Number.isSafeInteger(rawFileId) && rawFileId > 0)) {
    return NextResponse.json({ error: '无效的字幕文件 ID' }, { status: 400 });
  }
  if (!validExtension(fileName)) return NextResponse.json({ error: '该在线字幕格式暂不支持' }, { status: 415 });

  try {
    if (typeof rawFileId === 'string' && rawFileId.startsWith('subdl:')) {
      const response = await fetch(`${DANMU_API_BASE}/api/v2/subtitles/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/octet-stream, application/json' },
        body: JSON.stringify({ fileId: rawFileId, fileName }),
        signal: AbortSignal.timeout(25000),
        cache: 'no-store',
      });
      if (!response.ok) {
        const message = (await response.text().catch(() => '')).slice(0, 500);
        console.error('[OnlineSubtitle] SubDL download failed:', response.status, message);
        return NextResponse.json({ error: 'SubDL 字幕下载失败，请稍后重试' }, { status: response.status === 429 ? 429 : 502 });
      }
      const bytes = await response.arrayBuffer();
      if (!bytes.byteLength) return NextResponse.json({ error: '下载到的字幕文件为空' }, { status: 502 });
      if (bytes.byteLength > 8 * 1024 * 1024) return NextResponse.json({ error: '字幕文件超过 8 MB 限制' }, { status: 413 });
      return new NextResponse(bytes, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${fileName}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    const fileId = Number(rawFileId);
    const apiKey = process.env.OPENSUBTITLES_API_KEY;
    const username = process.env.OPENSUBTITLES_USERNAME;
    const password = process.env.OPENSUBTITLES_PASSWORD;
    if (!apiKey || !username || !password) {
      return NextResponse.json({ error: '服务器需配置 OPENSUBTITLES_API_KEY、OPENSUBTITLES_USERNAME 和 OPENSUBTITLES_PASSWORD' }, { status: 503 });
    }
    if (!Number.isSafeInteger(fileId) || fileId <= 0) return NextResponse.json({ error: '无效的 OpenSubtitles 文件 ID' }, { status: 400 });

    const loginResponse = await fetch(`${API_BASE}/login`, {
      method: 'POST',
      headers: { 'Api-Key': apiKey, 'User-Agent': 'MoonTVPlus v1.0', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ username, password }),
      signal: AbortSignal.timeout(12000),
    });
    const login = await loginResponse.json().catch(() => null);
    if (!loginResponse.ok || !login?.token) {
      return NextResponse.json({ error: 'OpenSubtitles 登录失败，请检查服务器端账号配置' }, { status: 502 });
    }

    const downloadResponse = await fetch(`${API_BASE}/download`, {
      method: 'POST',
      headers: { 'Api-Key': apiKey, 'User-Agent': 'MoonTVPlus v1.0', Authorization: `Bearer ${login.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ file_id: fileId }),
      signal: AbortSignal.timeout(12000),
    });
    const download = await downloadResponse.json().catch(() => null);
    if (!downloadResponse.ok || !download?.link) {
      return NextResponse.json({ error: download?.message || '获取字幕下载链接失败' }, { status: downloadResponse.status === 429 ? 429 : 502 });
    }

    const fileResponse = await fetch(download.link, { signal: AbortSignal.timeout(20000), cache: 'no-store' });
    if (!fileResponse.ok) return NextResponse.json({ error: '下载字幕文件失败' }, { status: 502 });
    const bytes = await fileResponse.arrayBuffer();
    if (!bytes.byteLength) return NextResponse.json({ error: '下载到的字幕文件为空' }, { status: 502 });
    if (bytes.byteLength > 8 * 1024 * 1024) return NextResponse.json({ error: '字幕文件超过 8 MB 限制' }, { status: 413 });

    const finalName = safeFileName(download.file_name || fileName);
    if (!validExtension(finalName)) return NextResponse.json({ error: '该在线字幕格式暂不支持' }, { status: 415 });
    return new NextResponse(bytes, {
      headers: { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${finalName}"`, 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    console.error('[OnlineSubtitle] download failed:', error);
    return NextResponse.json({ error: '在线字幕下载失败或超时' }, { status: 502 });
  }
}
