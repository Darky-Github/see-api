import http from "node:http"
import { gunzip } from "node:zlib"
import { promisify } from "node:util"

const gunzipAsync = promisify(gunzip)

/* =========================================================
   TYPES
   ========================================================= */

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

/* =========================================================
   CONFIGURATION
   ========================================================= */

/*
  These are search-work limits, not Cloudflare
  subrequest limits.

  Render does not impose the Worker-style
  per-request subrequest budget that the old
  implementation was designed around.
*/

const MAX_DOCUMENT_IDS = 1000

const MAX_SEARCH_RESULTS = 25

const MAX_IMAGES_PER_RESULT = 4

const MAX_VIDEOS_PER_RESULT = 2

const MAX_IMAGE_SIGNED_URLS = 100

const SIGNED_URL_EXPIRES = 3600

/*
  Safety limits for the larger Render instance.
*/

const MAX_TERM_SHARDS_PER_SEARCH = 128

const MAX_DOCUMENT_SHARDS_PER_SEARCH = 128

const MAX_TERM_ENTRY_DOCUMENTS = 1000

const SEARCH_TIMEOUT_MS = 15000

const MEDIA_TIMEOUT_MS = 5000

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
}

/* =========================================================
   ENVIRONMENT
   ========================================================= */

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
    SUPABASE_URL: SUPABASE_URL.replace(/\/+$/, ""),
    SUPABASE_SECRET_KEY
  }
}

/* =========================================================
   REQUEST HELPERS
   ========================================================= */

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

/* =========================================================
   CORS
   ========================================================= */

function applyCors(
  response: Response
): Response {
  const headers = new Headers(
    response.headers
  )

  for (
    const [key, value]
    of Object.entries(CORS_HEADERS)
  ) {
    headers.set(key, value)
  }

  return new Response(
    response.body,
    {
      status: response.status,
      statusText: response.statusText,
      headers
    }
  )
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
        "Content-Type": "application/json; charset=utf-8"
      }
    }
  )
}

/* =========================================================
   SUPABASE STORAGE
   ========================================================= */

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

/* =========================================================
   GZIP STORAGE
   ========================================================= */

async function fetchGzipText(
  env: Env,
  path: string,
  timeoutMs = SEARCH_TIMEOUT_MS
): Promise<string> {
  const response =
    await fetchWithTimeout(
      storageUrl(env, path),
      {
        headers:
          supabaseHeaders(env)
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

  /*
    Supabase Storage contains actual .gz files.
    Decompress them explicitly on Node rather than
    relying on Cloudflare's DecompressionStream.
  */

  const decompressed =
    await gunzipAsync(bytes)

  return decompressed.toString("utf8")
}

async function fetchJson(
  env: Env,
  path: string
): Promise<any> {
  const response =
    await fetchWithTimeout(
      storageUrl(env, path)
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
        .map(line => line.trim())
        .filter(Boolean)

    const values: any[] = []

    for (
      let index = 0;
      index < lines.length;
      index++
    ) {
      try {
        values.push(
          JSON.parse(lines[index])
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
  timeoutMs = SEARCH_TIMEOUT_MS
): Promise<any> {
  const text =
    await fetchGzipText(
      env,
      path,
      timeoutMs
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

/* =========================================================
   SIGNED URLS
   ========================================================= */

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

/* =========================================================
   TOKENIZATION
   ========================================================= */

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

/* =========================================================
   DICTIONARY
   ========================================================= */

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
      5000
    )

  if (!response.ok) {
    return null
  }

  return response.json()
}

/* =========================================================
   RELEASE / MANIFEST
   ========================================================= */

async function loadCurrentRelease(
  env: Env
): Promise<CurrentRelease> {
  return fetchGzipJson(
    env,
    "current.json"
  )
}

async function loadManifest(
  env: Env,
  current: CurrentRelease
): Promise<Manifest> {
  const manifestPath =
    releasePath(
      current.version,
      current.manifest
    )

  return fetchGzipJson(
    env,
    manifestPath
  )
}

/* =========================================================
   TERM SHARDS
   ========================================================= */

function normalizeTermShard(
  data: any
): Map<string, TermEntry[]> {
  const result =
    new Map<string, TermEntry[]>()

  if (
    data &&
    typeof data === "object" &&
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
                  "object"
            )
            .map(entry => ({
              ...(entry as any),
              id: String(
                (entry as any).id
              )
            })) as TermEntry[]
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
        typeof item === "object" &&
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
                  "object"
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
  terms: string[]
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

  /*
    This preserves your current generic
    shard format.

    We can later replace this with direct
    term → shard routing if the indexer
    provides shard metadata.
  */

  for (
    let index = 0;
    index < shardLimit;
    index++
  ) {
    if (
      found.size ===
      wanted.size
    ) {
      break
    }

    const shardName =
      manifest.term_shards[index]

    const shard =
      releasePath(
        current.version,
        shardName
      )

    const data =
      await fetchGzipJson(
        env,
        shard
      )

    const entries =
      normalizeTermShard(data)

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
        termEntries
      ) {
        found.set(
          term,
          termEntries
        )
      }
    }
  }

  return found
}

/* =========================================================
   DOCUMENT SHARDS
   ========================================================= */

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
  ids: number[]
): Promise<Document[]> {
  if (
    ids.length === 0
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

  /*
    Fetch several document shards
    concurrently. Render has considerably
    more headroom than the Worker, but the
    concurrency is still bounded.
  */

  const CONCURRENCY = 8

  for (
    let index = 0;
    index <
      limitedShardIds.length;
    index += CONCURRENCY
  ) {
    const batch =
      limitedShardIds.slice(
        index,
        index + CONCURRENCY
      )

    await Promise.all(
      batch.map(
        async shardId => {
          const shardName =
            manifest
              .docs_shards[
              shardId
            ]

          if (!shardName) {
            return
          }

          const shard =
            releasePath(
              current.version,
              shardName
            )

          const data =
            await fetchGzipJson(
              env,
              shard
            )

          const shardDocuments =
            normalizeDocuments(
              data
            )

          for (
            const document
            of shardDocuments
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
      )
    )

    if (
      documents.size ===
      requestedIds.size
    ) {
      break
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

/* =========================================================
   TRUTH25
   ========================================================= */

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
        const entryId =
          Number(entry.id)

        if (
          entryId ===
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

/* =========================================================
   MEDIA
   ========================================================= */

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

function getMediaPageUrl(
  item: any
): string {
  const fields = [
    "page_url",
    "source_url",
    "source",
    "document_url",
    "documentUrl",
    "parent_url",
    "parentUrl",
    "origin_url",
    "originUrl",
    "page",
    "source_page",
    "sourcePage"
  ]

  for (
    const field of fields
  ) {
    if (
      typeof item?.[
        field
      ] === "string" &&
      item[field].trim()
    ) {
      return item[field]
    }
  }

  return ""
}

function mediaMatchesDocument(
  item: any,
  documentUrl: string
): boolean {
  const target =
    normalizeUrl(
      documentUrl
    )

  if (!target) {
    return false
  }

  const pageUrl =
    getMediaPageUrl(
      item
    )

  if (
    pageUrl &&
    normalizeUrl(
      pageUrl
    ) === target
  ) {
    return true
  }

  const mediaUrl =
    typeof item?.url ===
      "string"
      ? item.url
      : ""

  if (
    mediaUrl &&
    normalizeUrl(
      mediaUrl
    ) === target
  ) {
    return true
  }

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

/* =========================================================
   ATTACH MEDIA
   ========================================================= */

async function attachMedia(
  env: Env,
  manifest: Manifest,
  current: CurrentRelease,
  results: SearchResult[]
): Promise<void> {
  let images: any[] =
    []

  let videos: any[] =
    []

  if (
    manifest.images
  ) {
    try {
      const path =
        releasePath(
          current.version,
          manifest.images
        )

      const data =
        await fetchGzipJson(
          env,
          path,
          MEDIA_TIMEOUT_MS
        )

      images =
        normalizeMedia(
          data
        )
    } catch {
      images = []
    }
  }

  if (
    manifest.videos
  ) {
    try {
      const path =
        releasePath(
          current.version,
          manifest.videos
        )

      const data =
        await fetchGzipJson(
          env,
          path,
          MEDIA_TIMEOUT_MS
        )

      videos =
        normalizeMedia(
          data
        )
    } catch {
      videos = []
    }
  }

  const resultImages =
    new Map<
      SearchResult,
      any[]
    >()

  const resultVideos =
    new Map<
      SearchResult,
      any[]
    >()

  const imagePaths: string[] =
    []

  const thumbnailPaths: string[] =
    []

  for (
    const result of results
  ) {
    const matchedImages =
      images
        .filter(
          image =>
            mediaMatchesDocument(
              image,
              result.url
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
              result.url
            )
        )
        .slice(
          0,
          MAX_VIDEOS_PER_RESULT
        )

    resultImages.set(
      result,
      matchedImages
    )

    resultVideos.set(
      result,
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
        thumbnailPaths.push(
          video.thumbnail_path
        )
      }
    }
  }

  const limitedImagePaths =
    [
      ...new Set(
        imagePaths
      )
    ].slice(
      0,
      MAX_IMAGE_SIGNED_URLS
    )

  const limitedThumbnailPaths =
    [
      ...new Set(
        thumbnailPaths
      )
    ].slice(
      0,
      MAX_IMAGE_SIGNED_URLS
    )

  let imageSignedUrls =
    new Map<
      string,
      string
    >()

  let thumbnailSignedUrls =
    new Map<
      string,
      string
    >()

  if (
    limitedImagePaths.length >
    0
  ) {
    try {
      imageSignedUrls =
        await createSignedUrls(
          env,
          "images",
          limitedImagePaths
        )
    } catch {
      imageSignedUrls =
        new Map()
    }
  }

  if (
    limitedThumbnailPaths.length >
    0
  ) {
    try {
      thumbnailSignedUrls =
        await createSignedUrls(
          env,
          "videos",
          limitedThumbnailPaths
        )
    } catch {
      thumbnailSignedUrls =
        new Map()
    }
  }

  for (
    const result of results
  ) {
    const matchedImages =
      resultImages.get(
        result
      ) || []

    const matchedVideos =
      resultVideos.get(
        result
      ) || []

    result.images =
      matchedImages.map(
        image => {
          const media =
            compactMedia(
              image
            )

          if (
            typeof image.path ===
              "string" &&
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
            typeof video.thumbnail_path ===
              "string" &&
            thumbnailSignedUrls.has(
              video.thumbnail_path
            )
          ) {
            media.thumbnail =
              thumbnailSignedUrls.get(
                video.thumbnail_path
              )
          }

          return media
        }
      )
  }
}

/* =========================================================
   RESULT FORMAT
   ========================================================= */

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

/* =========================================================
   SEARCH
   ========================================================= */

async function handleSearch(
  request: Request,
  env: Env
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

  /*
    Dictionary-only requests don't
    need the Seendex index.
  */

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
      env
    )

  const manifest =
    await loadManifest(
      env,
      current
    )

  const termEntries =
    await getTermEntries(
      env,
      manifest,
      current,
      terms
    )

  /*
    IMPORTANT:
    If no term exists anywhere, return
    immediately.

    This avoids document-shard work,
    media work, signing work and dictionary
    work for a guaranteed empty search.
  */

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
          MAX_TERM_ENTRY_DOCUMENTS
        ) {
          break
        }
      }
    }

    if (
      documentIds.size >=
      MAX_TERM_ENTRY_DOCUMENTS
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
      ]
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
      .sort(
        (a, b) =>
          b.score -
          a.score
      )
      .slice(
        0,
        MAX_SEARCH_RESULTS
      )

  /*
    Don't return zero-score documents
    simply because their ID appeared in
    a posting list.
  */

  const useful =
    scored.filter(
      item =>
        item.score > 0
    )

  const results =
    useful.map(
      item =>
        compactResult(
          item.document,
          item.score
        )
    )

  /*
    Media is only worth doing when
    actual results exist.
  */

  if (
    results.length > 0
  ) {
    await attachMedia(
      env,
      manifest,
      current,
      results
    )
  }

  let dictionary =
    null

  if (
    dictionaryQuery.word
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

/* =========================================================
   NODE HTTP SERVER
   ========================================================= */

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

        const requestUrl =
          new URL(
            req.url || "/",
            `http://${req.headers.host || "localhost"}`
          )

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

          const response =
            await Promise.race([
              handleSearch(
                request,
                env
              ),

              new Promise<Response>(
                (_, reject) =>
                  setTimeout(
                    () =>
                      reject(
                        new Error(
                          "Search request timed out"
                        )
                      ),
                    SEARCH_TIMEOUT_MS
                  )
              )
            ])

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
  () => shutdown("SIGTERM")
)

process.on(
  "SIGINT",
  () => shutdown("SIGINT")
)
