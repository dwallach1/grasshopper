import { extractText as extractPdfText, getDocumentProxy } from 'unpdf';

import type { Database } from './database';

const MAX_DOWNLOAD_BYTES = 25 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 500_000;
const MAX_REDIRECTS = 5;

export type ArticleTask = { kind: 'article'; bookmarkId: string; url: string };

export type PreparedArticle = {
  task: ArticleTask;
  fetched: { data: Uint8Array; mimeType: string; finalUrl: string; status: number } | null;
  extraction: Extraction | null;
  title: string | null;
  fetchError: string | null;
  checksum: string | null;
  capturedAt: string;
  documentType: string | null;
  storagePath: string | null;
};

export type Extraction = { text: string | null; status: 'complete' | 'pending' | 'unsupported' | 'failed'; error: string | null };

function decodeEntities(value: string): string {
  const named = new Map([
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
    ['apos', "'"],
    ['nbsp', ' '],
  ]);
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named.get(entity.toLowerCase()) ?? match;
  });
}

export function cleanHtml(raw: string) {
  const titleMatch = raw.match(/<title[^>]*>(.*?)<\/title>/is);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/\s+/g, ' ')).trim() : null;
  const withoutChrome = raw
    .replace(/<(script|style|noscript|svg|header|footer|nav)[^>]*>.*?<\/\1>/gis, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|h[1-6]|li|blockquote)>/gi, '\n');
  const text = decodeEntities(withoutChrome.replace(/<[^>]+>/gis, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 1)
    .join('\n');
  return { title, text };
}

export async function extractDocumentText(data: Uint8Array, mimeType: string): Promise<Extraction> {
  const base = mimeType.split(';', 1)[0].trim().toLowerCase();
  try {
    if (base === 'text/html' || base === 'application/xhtml+xml') {
      return { text: cleanHtml(new TextDecoder().decode(data)).text.slice(0, MAX_EXTRACTED_CHARS), status: 'complete', error: null };
    }
    if (base.startsWith('text/') || ['application/json', 'application/xml', 'application/x-ndjson'].includes(base)) {
      return { text: new TextDecoder().decode(data).slice(0, MAX_EXTRACTED_CHARS), status: 'complete', error: null };
    }
    if (base === 'application/pdf') {
      const pdf = await getDocumentProxy(data);
      const extracted = await extractPdfText(pdf, { mergePages: true });
      const text = extracted.text;
      return { text: text.slice(0, MAX_EXTRACTED_CHARS), status: 'complete', error: null };
    }
    return { text: null, status: 'unsupported', error: `No worker extractor for ${base || 'unknown MIME type'}` };
  } catch (error) {
    return { text: null, status: 'failed', error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 1000) : 'Unknown extraction error' };
  }
}

export function documentTypeFor(mimeType: string, sourceName: string): string {
  const base = mimeType.split(';', 1)[0].toLowerCase();
  const path = new URL(sourceName).pathname.toLowerCase();
  if (base === 'application/pdf' || path.endsWith('.pdf')) return sourceName.toLowerCase().includes('filing') ? 'filing' : 'pdf';
  if (base === 'text/html' || base === 'application/xhtml+xml') return 'article';
  if (base.includes('presentation') || /\.(ppt|pptx)$/.test(path)) return 'presentation';
  if (base.includes('spreadsheet') || /\.(csv|tsv|xls|xlsx)$/.test(path)) return 'spreadsheet';
  if (base.startsWith('image/')) return 'image';
  if (base.startsWith('text/')) return 'transcript';
  return 'other';
}

function extensionFor(mimeType: string, sourceName: string): string {
  const suffix = new URL(sourceName).pathname.match(/\.([a-z0-9]{1,8})$/i)?.[0]?.toLowerCase();
  if (suffix) return suffix;
  const base = mimeType.split(';', 1)[0].toLowerCase();
  const known = new Map([
    ['application/pdf', '.pdf'],
    ['text/html', '.html'],
    ['application/xhtml+xml', '.html'],
    ['application/json', '.json'],
    ['text/plain', '.txt'],
    ['text/csv', '.csv'],
  ]);
  return known.get(base) || '.bin';
}

export function objectPathFor(checksum: string, documentType: string, capturedAt: string, mimeType: string, sourceName: string): string {
  return `${documentType}/${capturedAt.slice(0, 7).replace('-', '/')}/${checksum}${extensionFor(mimeType, sourceName)}`;
}

function isPrivateHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower === 'localhost' || lower.endsWith('.localhost') || lower.endsWith('.local')) return true;
  if (/^(127|10)\./.test(lower) || lower.startsWith('169.254.') || lower.startsWith('192.168.')) return true;
  const match = lower.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return lower === '::1' || lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80:');
}

function validateRemoteUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || isPrivateHostname(url.hostname)) {
    throw new Error('Source URL is not allowed');
  }
  return url;
}

async function readBounded(response: Response): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_DOWNLOAD_BYTES) throw new Error(`Document exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_DOWNLOAD_BYTES) {
        await reader.cancel('document size limit exceeded');
        throw new Error(`Document exceeds ${MAX_DOWNLOAD_BYTES} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

async function fetchDocument(source: string): Promise<{ data: Uint8Array; mimeType: string; finalUrl: string; status: number }> {
  let url = validateRemoteUrl(source);
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    const response = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': 'ThesisForge/1.0 worker-archive', accept: '*/*' },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirect === MAX_REDIRECTS) throw new Error('Document redirect limit exceeded');
      url = validateRemoteUrl(new URL(location, url).toString());
      continue;
    }
    const data = await readBounded(response);
    return {
      data,
      mimeType: response.headers.get('content-type') || 'application/octet-stream',
      finalUrl: url.toString(),
      status: response.status,
    };
  }
  throw new Error('Document redirect limit exceeded');
}

async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(data).buffer));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function prepareArticleTask(
  bucket: R2Bucket,
  task: ArticleTask,
): Promise<PreparedArticle> {
  let fetched: { data: Uint8Array; mimeType: string; finalUrl: string; status: number };
  try {
    fetched = await fetchDocument(task.url);
  } catch (error) {
    return {
      task,
      fetched: null,
      extraction: null,
      title: null,
      fetchError: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 1000) : 'Unknown fetch error',
      checksum: null,
      capturedAt: new Date().toISOString(),
      documentType: null,
      storagePath: null,
    };
  }
  const extraction = await extractDocumentText(fetched.data, fetched.mimeType);
  const html = fetched.mimeType.toLowerCase().startsWith('text/html') ? cleanHtml(new TextDecoder().decode(fetched.data)) : null;
  const title = html?.title || new URL(fetched.finalUrl).pathname.split('/').pop() || fetched.finalUrl;
  if (!(fetched.status >= 200 && fetched.status < 300)) {
    return {
      task, fetched, extraction, title, fetchError: null, checksum: null,
      capturedAt: new Date().toISOString(), documentType: null, storagePath: null,
    };
  }

  const checksum = await sha256Hex(fetched.data);
  const capturedAt = new Date().toISOString();
  const documentType = documentTypeFor(fetched.mimeType, fetched.finalUrl);
  const storagePath = objectPathFor(checksum, documentType, capturedAt, fetched.mimeType, fetched.finalUrl);
  if (!(await bucket.head(storagePath))) {
    await bucket.put(storagePath, fetched.data, {
      httpMetadata: { contentType: fetched.mimeType.split(';', 1)[0] },
      customMetadata: { sha256: checksum, sourceUrl: fetched.finalUrl.slice(0, 1024) },
    });
  }
  return { task, fetched, extraction, title, fetchError: null, checksum, capturedAt, documentType, storagePath };
}

export async function persistPreparedArticle(
  database: Database,
  prepared: PreparedArticle,
): Promise<{ articleId: number; documentId: number | null; status: number }> {
  const { task, fetched } = prepared;
  if (!fetched) {
    const rows = await database.query<{ id: number }>(`
      insert into articles(bookmark_id,url,title,fetched_at,status_code,content_type,text,error)
      values ($1,$2,null,now(),null,null,null,$3)
      on conflict(url) do update set bookmark_id=excluded.bookmark_id,fetched_at=excluded.fetched_at,error=excluded.error
      returning id
    `, [task.bookmarkId, task.url, prepared.fetchError]);
    return { articleId: Number(rows[0].id), documentId: null, status: 0 };
  }
  const article = await database.query<{ id: number }>(`
    insert into articles(bookmark_id,url,title,fetched_at,status_code,content_type,text,error)
    values ($1,$2,$3,now(),$4,$5,$6,$7)
    on conflict(url) do update set bookmark_id=excluded.bookmark_id,title=excluded.title,
      fetched_at=excluded.fetched_at,status_code=excluded.status_code,content_type=excluded.content_type,
      text=excluded.text,error=excluded.error
    returning id
  `, [
    task.bookmarkId,
    task.url,
    prepared.title,
    fetched.status,
    fetched.mimeType,
    prepared.extraction?.text ?? null,
    fetched.status >= 200 && fetched.status < 300 ? prepared.extraction?.error ?? null : `HTTP ${fetched.status}`,
  ]);
  if (!(fetched.status >= 200 && fetched.status < 300)) return { articleId: Number(article[0].id), documentId: null, status: fetched.status };

  const { checksum, capturedAt, documentType, storagePath } = prepared;
  if (!checksum || !documentType || !storagePath || !prepared.extraction) throw new Error('Prepared article is missing archive metadata');
  const documentRows = await database.query<{ id: number }>(`
    insert into research_documents(
      sha256,storage_provider,storage_bucket,storage_path,mime_type,document_type,
      byte_size,extracted_text,extraction_status,extraction_error,captured_at
    ) values ($1,'r2',$2,$3,$4,$5,$6,$7,$8,$9,$10)
    on conflict(sha256) do update set
      extracted_text=coalesce(research_documents.extracted_text,excluded.extracted_text),
      extraction_status=case when excluded.extraction_status='complete' then 'complete' else research_documents.extraction_status end,
      extraction_error=case when excluded.extraction_status='complete' then null else research_documents.extraction_error end
    returning id
  `, [checksum, 'thesisforge-research-originals', storagePath, fetched.mimeType, documentType, fetched.data.byteLength, prepared.extraction.text, prepared.extraction.status, prepared.extraction.error, capturedAt]);
  const documentId = Number(documentRows[0].id);
  await database.execute(`
    insert into research_document_sources(document_id,article_id,source_url,title,publisher,usefulness,captured_at)
    values ($1,$2,$3,$4,$5,'inbox',$6)
    on conflict(article_id) where article_id is not null do update set
      document_id=excluded.document_id,source_url=excluded.source_url,title=excluded.title,
      publisher=excluded.publisher,captured_at=excluded.captured_at
  `, [documentId, Number(article[0].id), fetched.finalUrl, prepared.title, new URL(fetched.finalUrl).hostname.replace(/^www\./, ''), capturedAt]);
  return { articleId: Number(article[0].id), documentId, status: fetched.status };
}
