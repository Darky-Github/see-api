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

const MAX_DOCUMENT_IDS = 1000

const MAX_SEARCH_RESULTS = 25

const MAX_IMAGES_PER_RESULT = 4

const MAX_VIDEOS_PER_RESULT = 2

const MAX_IMAGE_SIGNED_URLS = 100

const MAX_VIDEO_SIGNED_URLS = 100

const SIGNED_URL_EXPIRES = 3600

const MAX_TERM_SHARDS_PER_SEARCH = 128

const MAX_DOCUMENT_SHARDS_PER_SEARCH = 128

const MAX_TERM_ENTRY_DOCUMENTS = 1000

const TERM_SHARD_CONCURRENCY = 12

const DOCUMENT_SHARD_CONCURRENCY = 12

const MEDIA_MANIFEST_CONCURRENCY = 2

const SIGNED_URL_CONCURRENCY = 12

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
    SUPABASE_URL:
      SUPABASE_URL.replace(/\/+$/, ""),

    SUPABASE_SECRET_KEY
  }
}

const env = loadEnv()

/* =========================================================
   REQUEST HELPERS
   ========================================================= */

function timeoutSignal(
  timeoutMs: number,
  signal?: AbortSignal | null
): AbortSignal {
  const timeout =
    AbortSignal.timeout(timeoutMs)

  if (!signal) {
    return timeout
  }

  return AbortSignal.any([
    signal,
    timeout
  ])
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = SEARCH_TIMEOUT_MS
): Promise<Response> {
  return fetch(
    input,
    {
      ...init,
      signal:
        timeoutSignal(
          timeoutMs,
          init.signal
        )
    }
  )
}

/* =========================================================
   CORS / RESPONSES
   ========================================================= */

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
    path.replace(/^\/+/, "")
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
      storageUrl(
        env,
        path
      ),
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

  const decompressed =
    await gunzipAsync(bytes)

  return decompressed.toString(
    "utf8"
  )
}

async function fetchJson(
  env: Env,
  path: string,
  timeoutMs = SEARCH_TIMEOUT_MS
): Promise<any> {
  const response =
    await fetchWithTimeout(
      storageUrl(
        env,
        path
      ),
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
    return JSON.parse(
      trimmed
    )
  } catch {
    const lines =
      trimmed
        .split(/\r?\n/)
        .map(
          line =>
            line.trim()
        )
        .filter(Boolean)

    return lines.map(
      line =>
        JSON.parse(line)
    )
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

  return parseJsonOrJsonl(
    text
  )
}

function releasePath(
  version: string,
  path: string
): string {
  if (
    path.startsWith(
      "releases/"
    )
  ) {
    return path
  }

  return `${version}/${path}`
}

/* =========================================================
   GENERIC CONCURRENCY
   ========================================================= */

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (
    item: T,
    index: number
  ) => Promise<R>
): Promise<R[]> {
  if (
    items.length === 0
  ) {
    return []
  }

  const results =
    new Array<R>(
      items.length
    )

  let cursor = 0

  async function runner() {
    while (true) {
      const index =
        cursor++

      if (
        index >=
        items.length
      ) {
        return
      }

      results[index] =
        await worker(
          items[index],
          index
        )
    }
  }

  const workers =
    Math.min(
      Math.max(
        1,
        concurrency
      ),
      items.length
    )

  await Promise.all(
    Array.from(
      {
        length:
          workers
      },
      () =>
        runner()
    )
  )

  return results
}

/* =========================================================
   SIGNED URLS
   ========================================================= */

async function createSignedUrls(
  env: Env,
  bucket: string,
  paths: string[]
): Promise<
  Map<string, string>
> {
  const uniquePaths =
    [
      ...new Set(
        paths.filter(Boolean)
      )
    ]

  if (
    uniquePaths.length ===
    0
  ) {
    return new Map()
  }

  const batches: string[][] =
    []

  for (
    let index = 0;
    index <
      uniquePaths.length;
    index += 100
  ) {
    batches.push(
      uniquePaths.slice(
        index,
        index + 100
      )
    )
  }

  const url =
    `${env.SUPABASE_URL}` +
    `/storage/v1/object/sign/${bucket}`

  const results =
    await mapConcurrent(
      batches,
      SIGNED_URL_CONCURRENCY,
      async batch => {
        try {
          const response =
            await fetchWithTimeout(
              url,
              {
                method:
                  "POST",

                headers: {
                  ...supabaseHeaders(
                    env
                  ),

                  "Content-Type":
                    "application/json"
                },

                body:
                  JSON.stringify({
                    expiresIn:
                      SIGNED_URL_EXPIRES,

                    paths:
                      batch
                  })
              },
              MEDIA_TIMEOUT_MS
            )

          if (
            !response.ok
          ) {
            return []
          }

          const data =
            await response.json() as Array<{
              path?: string
              signedURL?: string
              error?: string
            }>

          return data
        } catch {
          return []
        }
      }
    )

  const output =
    new Map<
      string,
      string
    >()

  for (
    const batch of results
  ) {
    for (
      const item of batch
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

      output.set(
        item.path,
        signedURL
      )
    }
  }

  return output
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

  if (
    meaningOf
  ) {
    return {
      word:
        meaningOf[1].trim(),

      dictionaryOnly:
        true
    }
  }

  const trailingMeaning =
    normalized.match(
      /^(.+?)\s+meaning$/
    )

  if (
    trailingMeaning
  ) {
    return {
      word:
        trailingMeaning[1].trim(),

      dictionaryOnly:
        true
    }
  }

  const tokens =
    tokenize(query)

  if (
    tokens.length === 1
  ) {
    return {
      word:
        tokens[0],

      dictionaryOnly:
        false
    }
  }

  return {
    word: null,
    dictionaryOnly:
      false
  }
}

/* =========================================================
   DICTIONARY
   ========================================================= */

async function getDictionary(
  word: string
): Promise<any> {
  try {
    const url =
      `https://en.wiktionary.org/api/rest_v1/page/definition/` +
      encodeURIComponent(
        word
      )

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

    if (
      !response.ok
    ) {
      return null
    }

    return response.json()
  } catch {
    return null
  }
}

/* =========================================================
   RELEASE / MANIFEST
   ========================================================= */

async function loadCurrentRelease(
  env: Env
): Promise<CurrentRelease> {
  const current =
    await fetchGzipJson(
      env,
      "current.json"
    )

  if (
    !current ||
    typeof current !==
      "object"
  ) {
    throw new Error(
      "Invalid current.json"
    )
  }

  if (
    typeof current.version !==
      "string" ||
    typeof current.manifest !==
      "string"
  ) {
    throw new Error(
      "current.json is missing version or manifest"
    )
  }

  return current as CurrentRelease
}

async function loadManifest(
  env: Env,
  current: CurrentRelease
): Promise<Manifest> {
  const path =
    releasePath(
      current.version,
      current.manifest
    )

  const manifest =
    await fetchGzipJson(
      env,
      path
    )

  if (
    !manifest ||
    typeof manifest !==
      "object"
  ) {
    throw new Error(
      "Invalid manifest"
    )
  }

  if (
    !Array.isArray(
      manifest.docs_shards
    ) ||
    !Array.isArray(
      manifest.term_shards
    )
  ) {
    throw new Error(
      "Manifest is missing docs_shards or term_shards"
    )
  }

  return manifest as Manifest
}

/* =========================================================
   TERM SHARDS
   ========================================================= */

function normalizeTermShard(
  data: any
): Map<
  string,
  TermEntry[]
> {
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
        Array.isArray(
          entries
        )
      ) {
        result.set(
          term.toLowerCase(),

          entries
            .filter(
              entry =>
                entry &&
                typeof entry ===
                  "object"
            )
            .map(
              entry => {
                const value =
                  entry as any

                return {
                  ...value,

                  id:
                    String(
                      value.id
                    ),

                  tf:
                    Number(
                      value.tf ||
                        0
                    ),

                  title:
                    value.title !==
                    undefined
                      ? Number(
                          value.title
                        )
                      : 0
                }
              }
            )
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
        !item ||
        typeof item !==
          "object" ||
        typeof item.term !==
          "string" ||
        !Array.isArray(
          item.entries
        )
      ) {
        continue
      }

      result.set(
        item.term.toLowerCase(),

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

              id:
                String(
                  entry.id
                ),

              tf:
                Number(
                  entry.tf ||
                    0
                ),

              title:
                entry.title !==
                undefined
                  ? Number(
                      entry.title
                    )
                  : 0
            })
          )
      )
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
    new Set(
      terms.map(
        term =>
          term.toLowerCase()
      )
    )

  const found =
    new Map<
      string,
      TermEntry[]
    >()

  const shardNames =
    manifest.term_shards.slice(
      0,
      Math.min(
        manifest.term_shards.length,
        MAX_TERM_SHARDS_PER_SEARCH
      )
    )

  await mapConcurrent(
    shardNames,
    TERM_SHARD_CONCURRENCY,
    async shardName => {
      if (
        found.size ===
        wanted.size
      ) {
        return
      }

      try {
        const path =
          releasePath(
            current.version,
            shardName
          )

        const data =
          await fetchGzipJson(
            env,
            path,
            SEARCH_TIMEOUT_MS
          )

        const entries =
          normalizeTermShard(
            data
          )

        for (
          const term of wanted
        ) {
          if (
            found.has(term)
          ) {
            continue
          }

          const value =
            entries.get(
              term
            )

          if (
            value
          ) {
            found.set(
              term,
              value
            )
          }
        }
      } catch {
      }
    }
  )

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
    documents =
      data
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
      data.id !==
      undefined
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
    .map(
      item => ({
        ...item,

        id:
          Number(
            item.id
          ),

        url:
          String(
            item.url ||
              ""
          ),

        title:
          String(
            item.title ||
              ""
          ),

        description:
          String(
            item.description ||
              ""
          ),

        text:
          String(
            item.text ||
              ""
          )
      })
    )
    .filter(
      item =>
        Number.isInteger(
          item.id
        ) &&
        item.url.length >
          0
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

  const limitedShardIds =
    uniqueShardIds.slice(
      0,
      MAX_DOCUMENT_SHARDS_PER_SEARCH
    )

  const documents =
    new Map<
      number,
      Document
    >()

  await mapConcurrent(
    limitedShardIds,
    DOCUMENT_SHARD_CONCURRENCY,
    async shardId => {
      if (
        documents.size ===
        requestedIds.size
      ) {
        return
      }

      const shardName =
        manifest
          .docs_shards[
            shardId
          ]

      if (
        !shardName
      ) {
        return
      }

      try {
        const path =
          releasePath(
            current.version,
            shardName
          )

        const data =
          await fetchGzipJson(
            env,
            path,
            SEARCH_TIMEOUT_MS
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
      } catch {
      }
    }
  )

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
    document.title
      .toLowerCase()

  const description =
    document.description
      .toLowerCase()

  const text =
    document.text
      .toLowerCase()

  const url =
    document.url
      .toLowerCase()

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
            Number(
              entry.tf || 0
            ) * 2

          score +=
            Number(
              entry.title || 0
            ) * 8

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

  score += Math.min(
    5,
    document.text.length /
      10000
  )

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
    for (
      const key of [
        "items",
        "media",
        "images",
        "videos"
      ]
    ) {
      if (
        Array.isArray(
          data[key]
        )
      ) {
        return data[key]
      }
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
        /#.*$/,
        ""
      )
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
  for (
    const key of [
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
  ) {
    if (
      typeof item?.[
        key
      ] === "string"
    ) {
      return item[key]
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

  const mediaPage =
    normalizeUrl(
      getMediaPageUrl(
        item
      )
    )

  if (
    mediaPage &&
    mediaPage === target
  ) {
    return true
  }

  const mediaUrl =
    normalizeUrl(
      item?.url
    )

  if (
    mediaUrl &&
    mediaUrl === target
  ) {
    return true
  }

  return false
}

function compactMedia(
  item: any
): MediaItem {
  const result:
    MediaItem = {}

  if (
    typeof item.url ===
      "string"
  ) {
    result.url =
      item.url
  }

  if (
    typeof item.path ===
      "string"
  ) {
    result.path =
      item.path
  }

  if (
    typeof item.title ===
      "string"
  ) {
    result.title =
      item.title
  }

  if (
    typeof item.alt ===
      "string"
  ) {
    result.alt =
      item.alt
  }

  if (
    typeof item.type ===
      "string"
  ) {
    result.type =
      item.type
  }

  if (
    typeof item.mime_type ===
      "string"
  ) {
    result.mime_type =
      item.mime_type
  }

  if (
    typeof item.thumbnail ===
      "string"
  ) {
    result.thumbnail =
      item.thumbnail
  }

  if (
    typeof item.thumbnail_path ===
      "string"
  ) {
    result.thumbnail_path =
      item.thumbnail_path
  }

  return result
}

/* =========================================================
   MEDIA MANIFEST LOADING
   ========================================================= */

async function loadMediaFile(
  env: Env,
  current: CurrentRelease,
  path: string
): Promise<any[]> {
  try {
    const data =
      await fetchGzipJson(
        env,
        releasePath(
          current.version,
          path
        ),
        MEDIA_TIMEOUT_MS
      )

    return normalizeMedia(
      data
    )
  } catch {
    return []
  }
}

async function loadMediaCollection(
  env: Env,
  current: CurrentRelease,
  path?: string
): Promise<any[]> {
  if (
    !path
  ) {
    return []
  }

  return loadMediaFile(
    env,
    current,
    path
  )
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
  if (
    results.length === 0
  ) {
    return
  }

  const [
    images,
    videos
  ] =
    await Promise.all([
      loadMediaCollection(
        env,
        current,
        manifest.images
      ),

      loadMediaCollection(
        env,
        current,
        manifest.videos
      )
    ])

  const imagePaths:
    string[] = []

  const videoThumbnailPaths:
    string[] = []

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

    result.images =
      matchedImages.map(
        compactMedia
      )

    result.videos =
      matchedVideos.map(
        compactMedia
      )

    for (
      const image
      of result.images
    ) {
      if (
        image.path
      ) {
        imagePaths.push(
          image.path
        )
      }
    }

    for (
      const video
      of result.videos
    ) {
      if (
        video.thumbnail_path
      ) {
        videoThumbnailPaths.push(
          video.thumbnail_path
        )
      }
    }
  }

  const uniqueImagePaths =
    [
      ...new Set(
        imagePaths
      )
    ].slice(
      0,
      MAX_IMAGE_SIGNED_URLS
    )

  const uniqueVideoPaths =
    [
      ...new Set(
        videoThumbnailPaths
      )
    ].slice(
      0,
      MAX_VIDEO_SIGNED_URLS
    )

  const [
    imageSignedUrls,
    videoSignedUrls
  ] =
    await Promise.all([
      createSignedUrls(
        env,
        "images",
        uniqueImagePaths
      ),

      createSignedUrls(
        env,
        "videos",
        uniqueVideoPaths
      )
    ])

  for (
    const result of results
  ) {
    for (
      const image
      of result.images
    ) {
      if (
        image.path &&
        imageSignedUrls.has(
          image.path
        )
      ) {
        image.url =
          imageSignedUrls.get(
            image.path
          )
      }
    }

    for (
      const video
      of result.videos
    ) {
      if (
        video.thumbnail_path &&
        videoSignedUrls.has(
          video.thumbnail_path
        )
      ) {
        video.thumbnail =
          videoSignedUrls.get(
            video.thumbnail_path
          )
      }
    }
  }
}

/* =========================================================
   SEARCH
   ========================================================= */

async function performSearch(
  env: Env,
  query: string,
  signal?: AbortSignal
): Promise<{
  results: SearchResult[]
  dictionary: any
}> {
  const terms =
    tokenize(query)

  if (
    terms.length === 0
  ) {
    return {
      results: [],
      dictionary: null
    }
  }

  const dictionaryQuery =
    detectDictionaryQuery(
      query
    )

  if (
    dictionaryQuery.dictionaryOnly &&
    dictionaryQuery.word
  ) {
    return {
      results: [],
      dictionary:
        await getDictionary(
          dictionaryQuery.word
        )
    }
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

  if (
    termEntries.size ===
    0
  ) {
    return {
      results: [],
      dictionary: null
    }
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
        !Number.isInteger(
          id
        ) ||
        id < 0
      ) {
        continue
      }

      documentIds.add(id)

      if (
        documentIds.size >=
        MAX_DOCUMENT_IDS
      ) {
        break
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
    documentIds.size ===
    0
  ) {
    return {
      results: [],
      dictionary: null
    }
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
      item => ({
        id:
          item.document.id,

        url:
          item.document.url,

        title:
          item.document.title,

        description:
          item.document.description,

        score:
          item.score,

        images: [],

        videos: []
      })
    )

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
    dictionary =
      await getDictionary(
        dictionaryQuery.word
      )
  }

  return {
    results,
    dictionary
  }
}

/* =========================================================
   REQUEST HANDLER
   ========================================================= */

async function handleRequest(
  request: Request
): Promise<Response> {
  const url =
    new URL(
      request.url
    )

  if (
    request.method ===
    "OPTIONS"
  ) {
    return new Response(
      null,
      {
        status: 204,
        headers:
          CORS_HEADERS
      }
    )
  }

  if (
    request.method !==
    "GET"
  ) {
    return jsonResponse(
      {
        error:
          "Method not allowed"
      },
      405
    )
  }

  if (
    url.pathname ===
    "/health"
  ) {
    return jsonResponse({
      ok: true,
      service:
        "seerchsqapi",
      runtime:
        "render",
      uptime:
        process.uptime()
    })
  }

  if (
    url.pathname !==
    "/search"
  ) {
    return jsonResponse(
      {
        error:
          "Not found"
      },
      404
    )
  }

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
    const result =
      await performSearch(
        env,
        query,
        controller.signal
      )

    return jsonResponse({
      query,

      dictionary:
        result.dictionary,

      results:
        result.results
    })
  } catch (error) {
    console.error(
      "[search]",
      error
    )

    if (
      controller.signal.aborted
    ) {
      return jsonResponse(
        {
          error:
            "Search request timed out"
        },
        504
      )
    }

    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "Search failed"
      },
      500
    )
  } finally {
    clearTimeout(
      timeout
    )
  }
}

/* =========================================================
   NODE ADAPTER
   ========================================================= */

async function nodeRequestToWebRequest(
  request: http.IncomingMessage
): Promise<Request> {
  const protocol =
    (
      request.headers[
        "x-forwarded-proto"
      ] ||
      "http"
    )
      .toString()
      .split(",")[0]
      .trim()

  const host =
    (
      request.headers.host ||
      "localhost"
    ).toString()

  const url =
    `${protocol}://${host}${request.url || "/"}`

  const headers =
    new Headers()

  for (
    const [
      key,
      value
    ]
    of Object.entries(
      request.headers
    )
  ) {
    if (
      Array.isArray(value)
    ) {
      for (
        const item
        of value
      ) {
        headers.append(
          key,
          item
        )
      }
    } else if (
      value !== undefined
    ) {
      headers.set(
        key,
        value
      )
    }
  }

  return new Request(
    url,
    {
      method:
        request.method ||
        "GET",

      headers
    }
  )
}

async function sendResponse(
  response: http.ServerResponse,
  webResponse: Response
): Promise<void> {
  response.statusCode =
    webResponse.status

  webResponse.headers.forEach(
    (
      value,
      key
    ) => {
      response.setHeader(
        key,
        value
      )
    }
  )

  const body =
    await webResponse.arrayBuffer()

  response.end(
    Buffer.from(body)
  )
}

/* =========================================================
   SERVER
   ========================================================= */

const port =
  Number(
    process.env.PORT ||
      10000
  )

const server =
  http.createServer(
    async (
      nodeRequest,
      nodeResponse
    ) => {
      const started =
        Date.now()

      try {
        const request =
          await nodeRequestToWebRequest(
            nodeRequest
          )

        const response =
          await handleRequest(
            request
          )

        await sendResponse(
          nodeResponse,
          response
        )

        const url =
          new URL(
            request.url
          )

        console.log(
          `[request] ${request.method} ` +
          `${url.pathname}${url.search} ` +
          `${response.status} ` +
          `${Date.now() - started}ms`
        )
      } catch (error) {
        console.error(
          "[server]",
          error
        )

        if (
          !nodeResponse.headersSent
        ) {
          const response =
            jsonResponse(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : "Internal server error"
              },
              500
            )

          await sendResponse(
            nodeResponse,
            response
          )
        } else {
          nodeResponse.end()
        }
      }
    }
  )

server.listen(
  port,
  "0.0.0.0",
  () => {
    console.log(
      `Seendex Remade API listening on port ${port}`
    )
  }
)

/* =========================================================
   SHUTDOWN
   ========================================================= */

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
    shutdown(
      "SIGTERM"
    )
)

process.on(
  "SIGINT",
  () =>
    shutdown(
      "SIGINT"
    )
)
