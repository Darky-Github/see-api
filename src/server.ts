import http from "node:http"
import { gunzip } from "node:zlib"
import { promisify } from "node:util"

const gunzipAsync = promisify(gunzip)

interface Env {
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
}

interface Manifest {
  version: string
  docs_shards: string[]
  term_shards: string[]
  fingerprints?: string
  images?: string
  videos?: string
}

interface CurrentRelease {
  version: string
  manifest: string
  fingerprints?: string
  documents: number
  images: number
  videos: number
}

interface Document {
  id: number
  url: string
  title: string
  description: string
  text: string
  content_hash?: string
}

interface TermEntry {
  id: string | number
  tf: number
  title?: number
}

interface SearchResult {
  id: number
  url: string
  title: string
  description: string
  score: number
  images: MediaItem[]
  videos: MediaItem[]
}

interface MediaItem {
  url?: string
  path?: string
  title?: string
  alt?: string
  type?: string
  mime_type?: string
  thumbnail?: string
  thumbnail_path?: string
}

const MAX_DOCUMENT_IDS = 1000
const MAX_SEARCH_RESULTS = 25
const MAX_IMAGES_PER_RESULT = 4
const MAX_VIDEOS_PER_RESULT = 2
const MAX_IMAGE_SIGNED_URLS = 100
const SIGNED_URL_EXPIRES = 3600

const MAX_TERM_SHARDS_PER_SEARCH = 128
const MAX_DOCUMENT_SHARDS_PER_SEARCH = 128
const MAX_TERM_ENTRY_DOCUMENTS = 1000

const SEARCH_TIMEOUT_MS = 15000
const MEDIA_TIMEOUT_MS = 4000

const TERM_SHARD_CONCURRENCY = 12
const DOCUMENT_SHARD_CONCURRENCY = 12

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
}

function loadEnv(): Env {
  const SUPABASE_URL =
    process.env.SUPABASE_URL?.trim()

  const SUPABASE_SECRET_KEY =
    process.env.SUPABASE_SECRET_KEY?.trim()

  if (!SUPABASE_URL) {
    throw new Error(
      "Missing SUPABASE_URL environment variable"
    )
  }

  if (!SUPABASE_SECRET_KEY) {
    throw new Error(
      "Missing SUPABASE_SECRET_KEY environment variable"
    )
  }

  return {
    SUPABASE_URL:
      SUPABASE_URL.replace(/\/+$/, ""),
    SUPABASE_SECRET_KEY
  }
}

function withTimeout(
  signal: AbortSignal | undefined,
  timeoutMs: number
): AbortSignal {
  if (signal) {
    return AbortSignal.any([
      signal,
      AbortSignal.timeout(timeoutMs)
    ])
  }

  return AbortSignal.timeout(timeoutMs)
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = SEARCH_TIMEOUT_MS
): Promise<Response> {
  return fetch(input, {
    ...init,
    signal: withTimeout(
      init.signal ?? undefined,
      timeoutMs
    )
  })
}

function jsonResponse(
  data: unknown,
  status = 200
): Response {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        ...CORS_HEADERS,
        "Content-Type":
          "application/json; charset=utf-8"
      }
    }
  )
}

function storageUrl(
  env: Env,
  path: string
): string {
  return (
    `${env.SUPABASE_URL}` +
    `/storage/v1/object/authenticated/seendex/` +
    path
  )
}

function supabaseHeaders(
  env: Env
): HeadersInit {
  return {
    Authorization:
      `Bearer ${env.SUPABASE_SECRET_KEY}`,
    apikey:
      env.SUPABASE_SECRET_KEY
  }
}

async function fetchGzipText(
  env: Env,
  path: string,
  timeoutMs = SEARCH_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<string> {
  const response =
    await fetchWithTimeout(
      storageUrl(env, path),
      {
        headers:
          supabaseHeaders(env),
        signal
      },
      timeoutMs
    )

  if (!response.ok) {
    const body =
      await response.text()

    throw new Error(
      `Supabase gzip request failed: ` +
      `${response.status} ` +
      `${response.statusText} | ` +
      `${path} | ` +
      `${body.slice(0, 500)}`
    )
  }

  const bytes =
    Buffer.from(
      await response.arrayBuffer()
    )

  const decompressed =
    await gunzipAsync(bytes)

  return decompressed.toString("utf8")
}

async function fetchJson(
  env: Env,
  path: string,
  timeoutMs = SEARCH_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<any> {
  const response =
    await fetchWithTimeout(
      storageUrl(env, path),
      {
        headers:
          supabaseHeaders(env),
        signal
      },
      timeoutMs
    )

  if (!response.ok) {
    const body =
      await response.text()

    throw new Error(
      `Supabase request failed: ` +
      `${response.status} ` +
      `${response.statusText} | ` +
      `${path} | ` +
      `${body.slice(0, 500)}`
    )
  }

  return response.json()
}

function parseJsonOrJsonl(
  text: string
): any {
  const trimmed =
    text.trim()

  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const lines =
      trimmed
        .split(/\r?\n/)
        .map(
          line =>
            line.trim()
        )
        .filter(Boolean)

    const values: any[] =
      []

    for (
      let index = 0;
      index < lines.length;
      index++
    ) {
      try {
        values.push(
          JSON.parse(
            lines[index]
          )
        )
      } catch (error) {
        throw new Error(
          `Invalid JSONL at line ${
            index + 1
          }: ${
            error instanceof Error
              ? error.message
              : String(error)
          }`
        )
      }
    }

    return values
  }
}

async function fetchGzipJson(
  env: Env,
  path: string,
  timeoutMs = SEARCH_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<any> {
  const text =
    await fetchGzipText(
      env,
      path,
      timeoutMs,
      signal
    )

  return parseJsonOrJsonl(text)
}

function releasePath(
  version: string,
  path: string
): string {
  if (
    path.startsWith("releases/")
  ) {
    return path
  }

  return `${version}/${path}`
}

async function createSignedUrls(
  env: Env,
  bucket: string,
  paths: string[]
): Promise<Map<string, string>> {
  const uniquePaths = [
    ...new Set(
      paths.filter(Boolean)
    )
  ]

  if (
    uniquePaths.length === 0
  ) {
    return new Map()
  }

  const url =
    `${env.SUPABASE_URL}` +
    `/storage/v1/object/sign/${bucket}`

  const response =
    await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          ...supabaseHeaders(env),
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          expiresIn:
            SIGNED_URL_EXPIRES,
          paths:
            uniquePaths
        })
      },
      MEDIA_TIMEOUT_MS
    )

  if (!response.ok) {
    const body =
      await response.text()

    throw new Error(
      `Supabase signed URLs failed: ` +
      `${response.status} ` +
      `${response.statusText} | ` +
      `${bucket} | ` +
      `${body.slice(0, 500)}`
    )
  }

  const data =
    await response.json() as Array<{
      path?: string
      signedURL?: string
      error?: string
    }>

  const result =
    new Map<string, string>()

  for (
    const item of data
  ) {
    if (
      !item.path ||
      !item.signedURL
    ) {
      continue
    }

    const signedURL =
      item.signedURL.startsWith(
        "http://"
      ) ||
      item.signedURL.startsWith(
        "https://"
      )
        ? item.signedURL
        : `${env.SUPABASE_URL}` +
          `/storage/v1${item.signedURL}`

    result.set(
      item.path,
      signedURL
    )
  }

  return result
}

function tokenize(
  query: string
): string[] {
  return query
    .toLowerCase()
    .normalize("NFKC")
    .replace(
      /[^\p{L}\p{N}]+/gu,
      " "
    )
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

function detectDictionaryQuery(
  query: string
): {
  word: string | null
  dictionaryOnly: boolean
} {
  const normalized =
    query
      .trim()
      .toLowerCase()

  const meaningOf =
    normalized.match(
      /^meaning\s+of\s+(.+)$/
    )

  if (meaningOf) {
    return {
      word:
        meaningOf[1].trim(),
      dictionaryOnly: true
    }
  }

  const trailingMeaning =
    normalized.match(
      /^(.+?)\s+meaning$/
    )

  if (trailingMeaning) {
    return {
      word:
        trailingMeaning[1].trim(),
      dictionaryOnly: true
    }
  }

  const tokens =
    tokenize(query)

  if (
    tokens.length === 1
  ) {
    return {
      word: tokens[0],
      dictionaryOnly: false
    }
  }

  return {
    word: null,
    dictionaryOnly: false
  }
}

async function getDictionary(
  word: string
): Promise<any> {
  const url =
    `https://en.wiktionary.org/api/rest_v1/page/definition/` +
    encodeURIComponent(word)

  const response =
    await fetchWithTimeout(
      url,
      {
        headers: {
          Accept:
            "application/json"
        }
      },
      3000
    )

  if (!response.ok) {
    return null
  }

  return response.json()
}

async function loadCurrentRelease(
  env: Env,
  signal?: AbortSignal
): Promise<CurrentRelease> {
  return fetchGzipJson(
    env,
    "current.json",
    SEARCH_TIMEOUT_MS,
    signal
  )
}

async function loadManifest(
  env: Env,
  current: CurrentRelease,
  signal?: AbortSignal
): Promise<Manifest> {
  const manifestPath =
    releasePath(
      current.version,
      current.manifest
    )

  return fetchGzipJson(
    env,
    manifestPath,
    SEARCH_TIMEOUT_MS,
    signal
  )
}

function normalizeTermShard(
  data: any
): Map<string, TermEntry[]> {
  const result =
    new Map<
      string,
      TermEntry[]
    >()

  if (
    data &&
    typeof data ===
      "object" &&
    !Array.isArray(data)
  ) {
    for (
      const [
        term,
        entries
      ] of Object.entries(data)
    ) {
      if (
        Array.isArray(entries)
      ) {
        result.set(
          term,
          entries
            .filter(
              entry =>
                entry &&
                typeof entry ===
                  "object" &&
                (entry as any).id !==
                  undefined
            )
            .map(
              entry => ({
                ...(entry as any),
                id: String(
                  (entry as any).id
                )
              })
            ) as TermEntry[]
        )
      }
    }

    return result
  }

  if (
    Array.isArray(data)
  ) {
    for (
      const item of data
    ) {
      if (
        item &&
        typeof item ===
          "object" &&
        typeof item.term ===
          "string" &&
        Array.isArray(
          item.entries
        )
      ) {
        result.set(
          item.term,
          item.entries
            .filter(
              (entry: any) =>
                entry &&
                typeof entry ===
                  "object" &&
                entry.id !==
                  undefined
            )
            .map(
              (entry: any) => ({
                ...entry,
                id: String(
                  entry.id
                )
              })
            )
        )
      }
    }
  }

  return result
}

async function getTermEntries(
  env: Env,
  manifest: Manifest,
  current: CurrentRelease,
  terms: string[],
  signal: AbortSignal
): Promise<
  Map<string, TermEntry[]>
> {
  const wanted =
    new Set(terms)

  const found =
    new Map<
      string,
      TermEntry[]
    >()

  const shardLimit =
    Math.min(
      manifest.term_shards.length,
      MAX_TERM_SHARDS_PER_SEARCH
    )

  for (
    let index = 0;
    index < shardLimit;
    index += TERM_SHARD_CONCURRENCY
  ) {
    if (
      signal.aborted ||
      found.size ===
        wanted.size
    ) {
      break
    }

    const batch =
      manifest.term_shards.slice(
        index,
        index +
          TERM_SHARD_CONCURRENCY
      )

    const shardResults =
      await Promise.allSettled(
        batch.map(
          async shardName => {
            if (
              signal.aborted
            ) {
              return null
            }

            const shard =
              releasePath(
                current.version,
                shardName
              )

            const timeout =
              Math.max(
                1000,
                Math.min(
                  5000,
                  remainingTime(
                    signal
                  )
                )
              )

            return fetchGzipJson(
              env,
              shard,
              timeout,
              signal
            )
          }
        )
      )

    for (
      const result
      of shardResults
    ) {
      if (
        result.status !==
        "fulfilled" ||
        !result.value
      ) {
        continue
      }

      const entries =
        normalizeTermShard(
          result.value
        )

      for (
        const term of wanted
      ) {
        if (
          found.has(term)
        ) {
          continue
        }

        const termEntries =
          entries.get(term)

        if (
          termEntries &&
          termEntries.length
        ) {
          found.set(
            term,
            termEntries
          )
        }
      }
    }
  }

  return found
}

function normalizeDocuments(
  data: any
): Document[] {
  let documents: any[] =
    []

  if (
    Array.isArray(data)
  ) {
    documents = data
  } else if (
    data &&
    typeof data ===
      "object"
  ) {
    if (
      Array.isArray(
        data.documents
      )
    ) {
      documents =
        data.documents
    } else if (
      data.id !== undefined
    ) {
      documents = [
        data
      ]
    }
  }

  return documents
    .filter(
      item =>
        item &&
        typeof item ===
          "object" &&
        item.id !==
          undefined
    )
    .map(item => ({
      ...item,
      id: Number(
        item.id
      )
    }))
    .filter(
      item =>
        Number.isInteger(
          item.id
        )
    ) as Document[]
}

async function getDocuments(
  env: Env,
  manifest: Manifest,
  current: CurrentRelease,
  ids: number[],
  signal: AbortSignal
): Promise<Document[]> {
  if (
    ids.length === 0 ||
    signal.aborted
  ) {
    return []
  }

  const requestedIds =
    new Set(
      ids.slice(
        0,
        MAX_DOCUMENT_IDS
      )
    )

  const shardIds =
    [
      ...requestedIds
    ].map(
      id =>
        Math.floor(
          id / 250
        )
    )

  const uniqueShardIds =
    [
      ...new Set(
        shardIds
      )
    ]

  const documents =
    new Map<
      number,
      Document
    >()

  const limitedShardIds =
    uniqueShardIds.slice(
      0,
      MAX_DOCUMENT_SHARDS_PER_SEARCH
    )

  for (
    let index = 0;
    index <
      limitedShardIds.length;
    index +=
      DOCUMENT_SHARD_CONCURRENCY
  ) {
    if (
      signal.aborted
    ) {
      break
    }

    const batch =
      limitedShardIds.slice(
        index,
        index +
          DOCUMENT_SHARD_CONCURRENCY
      )

    const shardResults =
      await Promise.allSettled(
        batch.map(
          async shardId => {
            if (
              signal.aborted
            ) {
              return []
            }

            const shardName =
              manifest
                .docs_shards[
                shardId
              ]

            if (!shardName) {
              return []
            }

            const shard =
              releasePath(
                current.version,
                shardName
              )

            const timeout =
              Math.max(
                1000,
                Math.min(
                  5000,
                  remainingTime(
                    signal
                  )
                )
              )

            const data =
              await fetchGzipJson(
                env,
                shard,
                timeout,
                signal
              )

            return normalizeDocuments(
              data
            )
          }
        )
      )

    for (
      const result
      of shardResults
    ) {
      if (
        result.status !==
        "fulfilled"
      ) {
        continue
      }

      for (
        const document
        of result.value
      ) {
        if (
          requestedIds.has(
            document.id
          )
        ) {
          documents.set(
            document.id,
            document
          )
        }
      }
    }
  }

  return [
    ...requestedIds
  ]
    .map(
      id =>
        documents.get(id)
    )
    .filter(
      (
        document
      ): document is Document =>
        Boolean(document)
    )
}

function truth25(
  document: Document,
  query: string,
  terms: string[],
  entries: Map<
    string,
    TermEntry[]
  >
): number {
  const title =
    (
      document.title ||
      ""
    ).toLowerCase()

  const description =
    (
      document.description ||
      ""
    ).toLowerCase()

  const text =
    (
      document.text ||
      ""
    ).toLowerCase()

  const url =
    (
      document.url ||
      ""
    ).toLowerCase()

  const normalizedQuery =
    query.toLowerCase()

  let score = 0

  for (
    const term of terms
  ) {
    if (
      title.includes(term)
    ) {
      score += 25
    }

    if (
      description.includes(
        term
      )
    ) {
      score += 8
    }

    if (
      text.includes(term)
    ) {
      score += 3
    }

    if (
      url.includes(term)
    ) {
      score += 5
    }

    const termEntries =
      entries.get(term)

    if (
      termEntries
    ) {
      for (
        const entry
        of termEntries
      ) {
        if (
          Number(entry.id) ===
          document.id
        ) {
          score +=
            entry.tf * 2

          score +=
            (entry.title || 0) *
            8

          break
        }
      }
    }
  }

  if (
    title.includes(
      normalizedQuery
    )
  ) {
    score += 25
  }

  if (
    document.text &&
    document.text.length > 0
  ) {
    score += Math.min(
      document.text.length /
        10000,
      5
    )
  }

  return score
}

function normalizeMedia(
  data: any
): any[] {
  if (
    Array.isArray(data)
  ) {
    return data
  }

  if (
    data &&
    typeof data ===
      "object"
  ) {
    if (
      Array.isArray(
        data.items
      )
    ) {
      return data.items
    }

    if (
      Array.isArray(
        data.media
      )
    ) {
      return data.media
    }

    if (
      Array.isArray(
        data.images
      )
    ) {
      return data.images
    }

    if (
      Array.isArray(
        data.videos
      )
    ) {
      return data.videos
    }
  }

  return []
}

function normalizeUrl(
  value: unknown
): string {
  if (
    typeof value !==
    "string"
  ) {
    return ""
  }

  try {
    const url =
      new URL(value)

    url.hash = ""

    if (
      url.pathname.length >
        1 &&
      url.pathname.endsWith(
        "/"
      )
    ) {
      url.pathname =
        url.pathname.slice(
          0,
          -1
        )
    }

    return url
      .toString()
      .toLowerCase()
  } catch {
    return value
      .trim()
      .replace(
        /\/+$/,
        ""
      )
      .toLowerCase()
  }
}

function mediaDocumentIds(
  item: any
): string[] {
  const fields = [
    "document_id",
    "documentId",
    "doc_id",
    "docId",
    "result_id",
    "resultId",
    "page_id",
    "pageId",
    "parent_id",
    "parentId",
    "source_id",
    "sourceId"
  ]

  const ids: string[] =
    []

  for (
    const field of fields
  ) {
    const value =
      item?.[field]

    if (
      value !== undefined &&
      value !== null &&
      String(value).trim()
    ) {
      ids.push(
        String(value)
      )
    }
  }

  return ids
}

function mediaDocumentUrls(
  item: any
): string[] {
  const fields = [
    "page_url",
    "pageUrl",
    "source_url",
    "sourceUrl",
    "source",
    "document_url",
    "documentUrl",
    "parent_url",
    "parentUrl",
    "origin_url",
    "originUrl",
    "source_page",
    "sourcePage",
    "page",
    "parent",
    "url"
  ]

  const urls: string[] =
    []

  for (
    const field of fields
  ) {
    const value =
      item?.[field]

    if (
      typeof value ===
        "string" &&
      value.trim()
    ) {
      urls.push(
        normalizeUrl(value)
      )
    }
  }

  return [
    ...new Set(
      urls.filter(Boolean)
    )
  ]
}

function mediaMatchesDocument(
  item: any,
  document: Document
): boolean {
  const documentId =
    String(document.id)

  const ids =
    mediaDocumentIds(item)

  if (
    ids.includes(
      documentId
    )
  ) {
    return true
  }

  const documentUrl =
    normalizeUrl(
      document.url
    )

  if (!documentUrl) {
    return false
  }

  const urls =
    mediaDocumentUrls(item)

  if (
    urls.includes(
      documentUrl
    )
  ) {
    return true
  }

  try {
    const target =
      new URL(
        documentUrl
      )

    for (
      const mediaUrl
      of urls
    ) {
      try {
        const source =
          new URL(
            mediaUrl
          )

        if (
          source.hostname ===
            target.hostname &&
          source.pathname ===
            target.pathname
        ) {
          return true
        }
      } catch {}
    }
  } catch {}

  return false
}

function compactMedia(
  item: any
): MediaItem {
  const media: MediaItem =
    {}

  if (
    typeof item.url ===
      "string"
  ) {
    media.url =
      item.url
  }

  if (
    typeof item.path ===
      "string"
  ) {
    media.path =
      item.path
  }

  if (
    typeof item.title ===
      "string"
  ) {
    media.title =
      item.title
  }

  if (
    typeof item.alt ===
      "string"
  ) {
    media.alt =
      item.alt
  }

  if (
    typeof item.type ===
      "string"
  ) {
    media.type =
      item.type
  }

  if (
    typeof item.mime_type ===
      "string"
  ) {
    media.mime_type =
      item.mime_type
  }

  if (
    typeof item.thumbnail ===
      "string"
  ) {
    media.thumbnail =
      item.thumbnail
  }

  if (
    typeof item.thumbnail_path ===
      "string"
  ) {
    media.thumbnail_path =
      item.thumbnail_path
  }

  return media
}

async function createSignedUrlsSafe(
  env: Env,
  bucket: string,
  paths: string[]
): Promise<Map<string, string>> {
  if (
    paths.length === 0
  ) {
    return new Map()
  }

  try {
    return await createSignedUrls(
      env,
      bucket,
      paths
    )
  } catch {
    return new Map()
  }
}

async function attachMedia(
  env: Env,
  manifest: Manifest,
  current: CurrentRelease,
  results: SearchResult[],
  signal: AbortSignal
): Promise<void> {
  if (
    results.length === 0 ||
    signal.aborted
  ) {
    return
  }

  const mediaResults =
    await Promise.allSettled([
      manifest.images
        ? fetchGzipJson(
            env,
            releasePath(
              current.version,
              manifest.images
            ),
            Math.min(
              MEDIA_TIMEOUT_MS,
              Math.max(
                1000,
                remainingTime(
                  signal
                )
              )
            ),
            signal
          )
        : Promise.resolve([]),

      manifest.videos
        ? fetchGzipJson(
            env,
            releasePath(
              current.version,
              manifest.videos
            ),
            Math.min(
              MEDIA_TIMEOUT_MS,
              Math.max(
                1000,
                remainingTime(
                  signal
                )
              )
            ),
            signal
          )
        : Promise.resolve([])
    ])

  const images =
    mediaResults[0]?.status ===
    "fulfilled"
      ? normalizeMedia(
          mediaResults[0].value
        )
      : []

  const videos =
    mediaResults[1]?.status ===
    "fulfilled"
      ? normalizeMedia(
          mediaResults[1].value
        )
      : []

  const imagePaths: string[] =
    []

  const videoThumbnailPaths:
    string[] =
    []

  const imageMatches =
    new Map<
      number,
      any[]
    >()

  const videoMatches =
    new Map<
      number,
      any[]
    >()

  for (
    const result of results
  ) {
    const document: Document = {
      id: result.id,
      url: result.url,
      title: result.title,
      description:
        result.description,
      text: ""
    }

    const matchedImages =
      images
        .filter(
          image =>
            mediaMatchesDocument(
              image,
              document
            )
        )
        .slice(
          0,
          MAX_IMAGES_PER_RESULT
        )

    const matchedVideos =
      videos
        .filter(
          video =>
            mediaMatchesDocument(
              video,
              document
            )
        )
        .slice(
          0,
          MAX_VIDEOS_PER_RESULT
        )

    imageMatches.set(
      result.id,
      matchedImages
    )

    videoMatches.set(
      result.id,
      matchedVideos
    )

    for (
      const image
      of matchedImages
    ) {
      if (
        typeof image.path ===
          "string"
      ) {
        imagePaths.push(
          image.path
        )
      }
    }

    for (
      const video
      of matchedVideos
    ) {
      if (
        typeof video.thumbnail_path ===
          "string"
      ) {
        videoThumbnailPaths.push(
          video.thumbnail_path
        )
      }
    }
  }

  const imageSignedUrls =
    await createSignedUrlsSafe(
      env,
      "images",
      [
        ...new Set(
          imagePaths
        )
      ].slice(
        0,
        MAX_IMAGE_SIGNED_URLS
      )
    )

  const videoThumbnailSignedUrls =
    await createSignedUrlsSafe(
      env,
      "videos",
      [
        ...new Set(
          videoThumbnailPaths
        )
      ].slice(
        0,
        MAX_IMAGE_SIGNED_URLS
      )
    )

  for (
    const result of results
  ) {
    const matchedImages =
      imageMatches.get(
        result.id
      ) || []

    const matchedVideos =
      videoMatches.get(
        result.id
      ) || []

    result.images =
      matchedImages.map(
        image => {
          const media =
            compactMedia(
              image
            )

          if (
            image.path &&
            imageSignedUrls.has(
              image.path
            )
          ) {
            media.url =
              imageSignedUrls.get(
                image.path
              )
          }

          return media
        }
      )

    result.videos =
      matchedVideos.map(
        video => {
          const media =
            compactMedia(
              video
            )

          if (
            video.thumbnail_path &&
            videoThumbnailSignedUrls.has(
              video.thumbnail_path
            )
          ) {
            media.thumbnail =
              videoThumbnailSignedUrls.get(
                video.thumbnail_path
              )
          }

          return media
        }
      )
  }
}

function compactResult(
  document: Document,
  score: number
): SearchResult {
  return {
    id: document.id,
    url: document.url,
    title:
      document.title || "",
    description:
      document.description ||
      "",
    score,
    images: [],
    videos: []
  }
}

function remainingTime(
  signal: AbortSignal
): number {
  if (
    signal.aborted
  ) {
    return 1
  }

  return 12000
}

async function handleSearch(
  request: Request,
  env: Env,
  signal: AbortSignal
): Promise<Response> {
  const url =
    new URL(request.url)

  const query =
    url.searchParams
      .get("q")
      ?.trim() || ""

  if (!query) {
    return jsonResponse(
      {
        error:
          "Missing query parameter"
      },
      400
    )
  }

  const dictionaryQuery =
    detectDictionaryQuery(
      query
    )

  if (
    dictionaryQuery.dictionaryOnly &&
    dictionaryQuery.word
  ) {
    const dictionary =
      await getDictionary(
        dictionaryQuery.word
      )

    return jsonResponse({
      query,
      dictionary
    })
  }

  const terms =
    tokenize(query)

  if (
    terms.length === 0
  ) {
    return jsonResponse({
      query,
      dictionary: null,
      results: []
    })
  }

  const current =
    await loadCurrentRelease(
      env,
      signal
    )

  const manifest =
    await loadManifest(
      env,
      current,
      signal
    )

  const termEntries =
    await getTermEntries(
      env,
      manifest,
      current,
      terms,
      signal
    )

  if (
    termEntries.size === 0
  ) {
    return jsonResponse({
      query,
      dictionary: null,
      results: []
    })
  }

  const documentIds =
    new Set<number>()

  for (
    const entries
    of termEntries.values()
  ) {
    for (
      const entry
      of entries
    ) {
      const id =
        Number(entry.id)

      if (
        Number.isInteger(id) &&
        id >= 0
      ) {
        documentIds.add(id)

        if (
          documentIds.size >=
          MAX_DOCUMENT_IDS
        ) {
          break
        }
      }
    }

    if (
      documentIds.size >=
      MAX_DOCUMENT_IDS
    ) {
      break
    }
  }

  if (
    documentIds.size === 0
  ) {
    return jsonResponse({
      query,
      dictionary: null,
      results: []
    })
  }

  const documents =
    await getDocuments(
      env,
      manifest,
      current,
      [
        ...documentIds
      ],
      signal
    )

  const scored =
    documents
      .map(
        document => ({
          document,
          score:
            truth25(
              document,
              query,
              terms,
              termEntries
            )
        })
      )
      .filter(
        item =>
          item.score > 0
      )
      .sort(
        (a, b) =>
          b.score -
          a.score
      )
      .slice(
        0,
        MAX_SEARCH_RESULTS
      )

  const results =
    scored.map(
      item =>
        compactResult(
          item.document,
          item.score
        )
    )

  if (
    results.length > 0 &&
    !signal.aborted
  ) {
    await attachMedia(
      env,
      manifest,
      current,
      results,
      signal
    )
  }

  let dictionary =
    null

  if (
    dictionaryQuery.word &&
    !signal.aborted
  ) {
    try {
      dictionary =
        await getDictionary(
          dictionaryQuery.word
        )
    } catch {
      dictionary =
        null
    }
  }

  return jsonResponse({
    query,
    dictionary,
    results
  })
}

const env =
  loadEnv()

const port =
  Number(
    process.env.PORT || 10000
  )

const host =
  "0.0.0.0"

const server =
  http.createServer(
    async (
      req,
      res
    ) => {
      const started =
        Date.now()

      try {
        if (
          req.method ===
          "OPTIONS"
        ) {
          res.writeHead(
            204,
            CORS_HEADERS
          )

          res.end()
          return
        }

        if (
          req.method !==
          "GET"
        ) {
          const response =
            jsonResponse(
              {
                error:
                  "Method not allowed"
              },
              405
            )

          const body =
            await response.text()

          res.writeHead(
            405,
            Object.fromEntries(
              response.headers
            )
          )

          res.end(body)
          return
        }

        const requestUrl =
          new URL(
            req.url || "/",
            `http://${
              req.headers.host ||
              "localhost"
            }`
          )

        if (
          requestUrl.pathname ===
          "/health"
        ) {
          const response =
            jsonResponse({
              ok: true,
              service:
                "seerchsqapi",
              runtime:
                "render",
              uptime:
                process.uptime()
            })

          const body =
            await response.text()

          res.writeHead(
            200,
            Object.fromEntries(
              response.headers
            )
          )

          res.end(body)
          return
        }

        if (
          requestUrl.pathname ===
          "/search"
        ) {
          const request =
            new Request(
              `http://localhost${requestUrl.pathname}${requestUrl.search}`,
              {
                method:
                  "GET"
              }
            )

          const controller =
            new AbortController()

          const timeout =
            setTimeout(
              () => {
                controller.abort()
              },
              SEARCH_TIMEOUT_MS
            )

          try {
            const response =
              await handleSearch(
                request,
                env,
                controller.signal
              )

            const body =
              await response.text()

            res.writeHead(
              response.status,
              Object.fromEntries(
                response.headers
              )
            )

            res.end(body)

            console.log(
              `[search] q=${JSON.stringify(
                requestUrl.searchParams.get(
                  "q"
                ) || ""
              )} status=${response.status} ${Date.now() - started}ms`
            )
          } finally {
            clearTimeout(
              timeout
            )
          }

          return
        }

        const response =
          jsonResponse(
            {
              error:
                "Not found"
            },
            404
          )

        const body =
          await response.text()

        res.writeHead(
          404,
          Object.fromEntries(
            response.headers
          )
        )

        res.end(body)
      } catch (error) {
        console.error(
          "[server] request failed:",
          error
        )

        const message =
          error instanceof Error
            ? error.message
            : String(error)

        const response =
          jsonResponse(
            {
              error:
                message
            },
            500
          )

        const body =
          await response.text()

        res.writeHead(
          500,
          Object.fromEntries(
            response.headers
          )
        )

        res.end(body)
      }
    }
  )

server.listen(
  port,
  host,
  () => {
    console.log(
      `Seendex Remade API listening on ${host}:${port}`
    )
  }
)

function shutdown(
  signal: string
) {
  console.log(
    `[server] received ${signal}, shutting down`
  )

  server.close(
    () => {
      process.exit(0)
    }
  )

  setTimeout(
    () => {
      process.exit(1)
    },
    10000
  ).unref()
}

process.on(
  "SIGTERM",
  () =>
    shutdown("SIGTERM")
)

process.on(
  "SIGINT",
  () =>
    shutdown("SIGINT")
)
