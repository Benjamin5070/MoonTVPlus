
import { NextRequest, NextResponse } from 'next/server';
import { getAuthInfoFromCookie } from '@/lib/auth';

export const runtime = 'nodejs';

const OPEN_API = 'https://api.opensubtitles.com/api/v1';
const SUBDL_DOWNLOAD_API = 'https://api.subdl.com/api/v1/subtitles';

const ALLOWED_EXTENSIONS = new Set([
  'srt', 'vtt', 'ass', 'ssa', 'ttml', 'dfxp',
  'xml', 'sbv', 'sub', 'lrc', 'sup', 'pgs',
]);

function safeFileName(value: unknown) {
  return String(value || 'online-subtitle.srt')
    .replace(/[\\/\r\n"]/g, '_')
    .slice(0, 180);
}

function getExtension(fileName: string) {
  return (
    fileName.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() ||
    'srt'
  );
}

async function downloadSubDL(fileId: string, requestedName: string) {
  const apiKey = process.env.SUBDL_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: '服务器未配置 SUBDL_API_KEY' },
      { status: 503 }
    );
  }

  // SubDL 搜索返回的 fileId 通常是：
  // subdl:/subtitle/xxxx/yyyy
  // 去掉内部标识后，交给 SubDL API 查询下载地址。
  const path = fileId.replace(/^subdl:/, '');

  if (!/^\/subtitle\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_-]+$/.test(path)) {
    return NextResponse.json(
      { error: '无效的 SubDL 字幕文件 ID' },
      { status: 400 }
    );
  }

  const url = new URL(SUBDL_DOWNLOAD_API);
  url.searchParams.set('api_key', apiKey);
  url.searchParams.set('file_id', path);

  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(15000),
    cache: 'no-store',
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    return NextResponse.json(
      { error: payload?.message || 'SubDL 获取字幕失败' },
      { status: response.status === 429 ? 429 : 502 }
    );
  }

  // 不同 SubDL API 版本的响应结构可能不同。
  // 若响应没有明确的下载 URL，不要误把 JSON 当作字幕文件。
  const downloadUrl =
    payload?.url ||
    payload?.link ||
    payload?.download_url ||
    payload?.downloadLink;

  if (typeof downloadUrl !== 'string') {
    return NextResponse.json(
      {
        error:
          'SubDL 未返回可识别的下载地址，请检查其 API 响应格式',
      },
      { status: 502 }
    );
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(downloadUrl);
  } catch {
    return NextResponse.json(
      { error: 'SubDL 返回了无效的下载地址' },
      { status: 502 }
    );
  }

  if (parsedUrl.protocol !== 'https:') {
    return NextResponse.json(
      { error: '字幕下载地址必须使用 HTTPS' },
      { status: 502 }
    );
  }

  const fileResponse = await fetch(parsedUrl, {
    signal: AbortSignal.timeout(20000),
    cache: 'no-store',
  });

  if (!fileResponse.ok) {
    return NextResponse.json(
      { error: '下载 SubDL 字幕文件失败' },
      { status: 502 }
    );
  }

  const bytes = await fileResponse.arrayBuffer();

  if (bytes.byteLength > 8 * 1024 * 1024) {
    return NextResponse.json(
      { error: '字幕文件超过 8 MB 限制' },
      { status: 413 }
    );
  }

  const contentType = fileResponse.headers.get('content-type') || '';

  if (
    contentType.includes('application/json') ||
    contentType.includes('text/html')
  ) {
    return NextResponse.json(
      { error: 'SubDL 返回的不是字幕文件，请检查下载地址' },
      { status: 502 }
    );
  }

  const fileName = safeFileName(
    payload?.file_name || payload?.fileName || requestedName
  );

  if (!ALLOWED_EXTENSIONS.has(getExtension(fileName))) {
    return NextResponse.json(
      { error: '该在线字幕格式暂不支持' },
      { status: 415 }
    );
  }

  return new NextResponse(bytes, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}

async function downloadOpenSubtitles(fileId: number, requestedName: string) {
  const apiKey = process.env.OPENSUBTITLES_API_KEY;
  const username = process.env.OPENSUBTITLES_USERNAME;
  const password = process.env.OPENSUBTITLES_PASSWORD;

  if (!apiKey || !username || !password) {
    return NextResponse.json(
      {
        error:
          '服务器需配置 OPENSUBTITLES_API_KEY、OPENSUBTITLES_USERNAME 和 OPENSUBTITLES_PASSWORD',
      },
      { status: 503 }
    );
  }

  const headers = {
    'Api-Key': apiKey,
    'User-Agent': 'MoonTVPlus v1.0',
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  const loginResponse = await fetch(`${OPEN_API}/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(12000),
  });

  const login = await loginResponse.json().catch(() => null);

  if (!loginResponse.ok || !login?.token) {
    return NextResponse.json(
      { error: 'OpenSubtitles 登录失败，请检查服务器端账号配置' },
      { status: 502 }
    );
  }

  const downloadResponse = await fetch(`${OPEN_API}/download`, {
    method: 'POST',
    headers: {
      ...headers,
      Authorization: `Bearer ${login.token}`,
    },
    body: JSON.stringify({ file_id: fileId }),
    signal: AbortSignal.timeout(12000),
  });

  const download = await downloadResponse.json().catch(() => null);

  if (!downloadResponse.ok || !download?.link) {
    return NextResponse.json(
      { error: download?.message || '获取字幕下载链接失败' },
      {
        status: downloadResponse.status === 429 ? 429 : 502,
      }
    );
  }

  const fileResponse = await fetch(download.link, {
    signal: AbortSignal.timeout(20000),
  });

  if (!fileResponse.ok) {
    return NextResponse.json(
      { error: '下载字幕文件失败' },
      { status: 502 }
    );
  }

  const bytes = await fileResponse.arrayBuffer();

  if (bytes.byteLength > 8 * 1024 * 1024) {
    return NextResponse.json(
      { error: '字幕文件超过 8 MB 限制' },
      { status: 413 }
    );
  }

  const fileName = safeFileName(
    download.file_name || requestedName
  );

  if (!ALLOWED_EXTENSIONS.has(getExtension(fileName))) {
    return NextResponse.json(
      { error: '该在线字幕格式暂不支持' },
      { status: 415 }
    );
  }

  return new NextResponse(bytes, {
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Cache-Control': 'no-store',
    },
  });
}

export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);

  if (!authInfo?.username) {
    return NextResponse.json(
      { error: '未授权' },
      { status: 401 }
    );
  }

  const body = await request.json().catch(() => null);
  const fileId = body?.fileId;
  const fileName = String(body?.fileName || 'online-subtitle.srt');

  try {
    if (typeof fileId === 'string' && fileId.startsWith('subdl:')) {
      return await downloadSubDL(fileId, fileName);
    }

    const numericId =
      typeof fileId === 'number'
        ? fileId
        : typeof fileId === 'string' && /^\d+$/.test(fileId)
          ? Number(fileId)
          : NaN;

    if (!Number.isSafeInteger(numericId) || numericId <= 0) {
      return NextResponse.json(
        { error: '无效的字幕文件 ID' },
        { status: 400 }
      );
    }

    return await downloadOpenSubtitles(numericId, fileName);
  } catch (error) {
    console.error('[OnlineSubtitle] download failed:', error);

    return NextResponse.json(
      { error: '在线字幕下载失败或超时' },
      { status: 502 }
    );
  }
}
