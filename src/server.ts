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

interface SearchConfig {
  requestTimeoutMs: number
  fetchTimeoutMs: number
  mediaTimeoutMs: number
  termShardConcurrency: number
  documentShardConcurrency: number
  maxDocumentIds: number
  maxSearchResults: number
  maxImagesPerResult: number
  maxVideosPerResult: number
  maxImageSignedUrls: number
  signedUrlExpires: number
}

const CONFIG: SearchConfig = {
  requestTimeoutMs: 25000,
  fetchTimeoutMs: 10000,
  mediaTimeoutMs: 12000,
  termShardConcurrency: 12,
  documentShardConcurrency: 12,
  maxDocumentIds: 1000,
  maxSearchResults: 25,
  maxImagesPerResult: 4,
  maxVideosPerResult: 2,
  maxImageSignedUrls: 100,
  signedUrlExpires: 3600
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
}

function loadEnv(): Env {
  const SUPABASE_URL =
    process.env.SUPABASE_URL?.trim() || ""

  const SUPABASE_SECRET_KEY =
    process.env.SUPABASE_SECRET_KEY?.trim() || ""

  if (!SUPABASE_URL) {
    throw new Error("Missing SUPABASE_URL")
  }

  if (!SUPABASE_SECRET_KEY) {
    throw new Error("Missing SUPABASE_SECRET_KEY")
  }

  return {
    SUPABASE_URL: SUPABASE_URL.replace(/\/+$/, ""),
    SUPABASE_SECRET_KEY
  }
}

function storageUrl(
  env: Env,
  path: string
): string {
  return `${env.SUPABASE_URL}/storage/v1/object/authenticated/seendex/${path}`
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

function createAbortController(
  timeoutMs: number
): {
  controller: AbortController
  timer: NodeJS.Timeout
} {
  const controller = new AbortController()

  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  return {
    controller,
    timer
  }
}

function remainingTime(
  deadline: number
): number {
  return Math.max(
    0,
    deadline - Date.now()
  )
}

function effectiveTimeout(
  deadline: number,
  preferred: number
): number {
  const remaining =
    remainingTime(deadline)

  if (remaining <= 0) {
    return 0
  }

  return Math.min(
    preferred,
    Math.max(250, remaining)
  )
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  if (timeoutMs <= 0) {
    throw new Error("Request deadline exceeded")
  }

  const controller =
    new AbortController()

  const externalSignal =
    init.signal

  let externalAbortHandler:
    (() => void) | undefined

  if (externalSignal) {
    if (externalSignal.aborted) {
      controller.abort()
    } else {
      externalAbortHandler = () => {
        controller.abort()
      }

      externalSignal.addEventListener(
        "abort",
        externalAbortHandler,
        { once: true }
      )
    }
  }

  const timer = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timer)

    if (
      externalSignal &&
      externalAbortHandler
    ) {
      externalSignal.removeEventListener(
        "abort",
        externalAbortHandler
      )
    }
  }
}

async function fetchGzipText(
  env: Env,
  path: string,
  deadline: number,
  signal: AbortSignal,
  timeoutOverride?: number
): Promise<string> {
  const timeoutMs =
    effectiveTimeout(
      deadline,
      timeoutOverride ??
        CONFIG.fetchTimeoutMs
    )

  if (timeoutMs <= 0) {
    throw new Error(
      `Request deadline exceeded: ${path}`
    )
  }

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

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    )

  const decompressed =
    await gunzipAsync(buffer)

  return decompressed.toString("utf8")
}

async function fetchJson(
  env: Env,
  path: string,
  deadline: number,
  signal: AbortSignal
): Promise<any> {
  const timeoutMs =
    effectiveTimeout(
      deadline,
      CONFIG.fetchTimeoutMs
    )

  if (timeoutMs <= 0) {
    throw new Error(
      `Request deadline exceeded: ${path}`
    )
  }

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
          `Invalid JSONL at line ${index + 1}: ` +
          `${
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
  deadline: number,
  signal: AbortSignal,
  timeoutOverride?: number
): Promise<any> {
  const text =
    await fetchGzipText(
      env,
      path,
      deadline,
      signal,
      timeoutOverride
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
  paths: string[],
  deadline: number,
  signal: AbortSignal
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

  const timeoutMs =
    effectiveTimeout(
      deadline,
      CONFIG.fetchTimeoutMs
    )

  if (timeoutMs <= 0) {
    return new Map()
  }

  const url =
    `${env.SUPABASE_URL}` +
    `/storage/v1/object/sign/` +
    bucket

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
            CONFIG.signedUrlExpires,
          paths: uniquePaths
        }),
        signal
      },
      timeoutMs
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

  for (const item of data) {
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
        : `${env.SUPABASE_URL}/storage/v1${item.signedURL}`

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
    query.trim().toLowerCase()

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
  word: string,
  deadline: number,
  signal: AbortSignal
): Promise<any> {
  const timeoutMs =
    effectiveTimeout(
      deadline,
      CONFIG.fetchTimeoutMs
    )

  if (timeoutMs <= 0) {
    return null
  }

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
        },
        signal
      },
      timeoutMs
    )

  if (!response.ok) {
    return null
  }

  return response.json()
}

async function loadCurrentRelease(
  env: Env,
  deadline: number,
  signal: AbortSignal
): Promise<CurrentRelease> {
  return fetchGzipJson(
    env,
    "current.json",
    deadline,
    signal
  )
}

async function loadManifest(
  env: Env,
  current: CurrentRelease,
  deadline: number,
  signal: AbortSignal
): Promise<Manifest> {
  const manifestPath =
    releasePath(
      current.version,
      current.manifest
    )

  return fetchGzipJson(
    env,
    manifestPath,
    deadline,
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
    typeof data === "object" &&
    !Array.isArray(data)
  ) {
    for (
      const [term, entries]
      of Object.entries(data)
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
              ...entry,
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
  terms: string[],
  deadline: number,
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

  if (
    wanted.size === 0
  ) {
    return found
  }

  for (
    let offset = 0;
    offset <
      manifest.term_shards.length;
    offset +=
      CONFIG.termShardConcurrency
  ) {
    if (
      remainingTime(deadline) <=
      500
    ) {
      break
    }

    const shardNames =
      manifest.term_shards.slice(
        offset,
        offset +
          CONFIG.termShardConcurrency
      )

    const tasks =
      shardNames.map(
        async shardName => {
          const shard =
            releasePath(
              current.version,
              shardName
            )

          try {
            const data =
              await fetchGzipJson(
                env,
                shard,
                deadline,
                signal
              )

            return normalizeTermShard(
              data
            )
          } catch {
            return null
          }
        }
      )

    const settled =
      await Promise.allSettled(
        tasks
      )

    for (
      const item of settled
    ) {
      if (
        item.status !==
        "fulfilled" ||
        !item.value
      ) {
        continue
      }

      for (
        const term of wanted
      ) {
        if (
          found.has(term)
        ) {
          continue
        }

        const entries =
          item.value.get(term)

        if (entries) {
          found.set(
            term,
            entries
          )
        }
      }
    }

    if (
      found.size ===
      wanted.size
    ) {
      break
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
      documents = [data]
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
      id: Number(item.id)
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
  deadline: number,
  signal: AbortSignal
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
        CONFIG.maxDocumentIds
      )
    )

  const shardIds = [
    ...new Set(
      [
        ...requestedIds
      ].map(
        id =>
          Math.floor(
            id / 250
          )
      )
    )
  ]

  const documents =
    new Map<
      number,
      Document
    >()

  for (
    let offset = 0;
    offset <
      shardIds.length;
    offset +=
      CONFIG.documentShardConcurrency
  ) {
    if (
      remainingTime(deadline) <=
      500
    ) {
      break
    }

    const batch =
      shardIds.slice(
        offset,
        offset +
          CONFIG.documentShardConcurrency
      )

    const tasks =
      batch.map(
        async shardId => {
          const shardName =
            manifest.docs_shards[
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

          try {
            const data =
              await fetchGzipJson(
                env,
                shard,
                deadline,
                signal
              )

            return normalizeDocuments(
              data
            )
          } catch {
            return []
          }
        }
      )

    const settled =
      await Promise.allSettled(
        tasks
      )

    for (
      const item of settled
    ) {
      if (
        item.status !==
        "fulfilled"
      ) {
        continue
      }

      for (
        const document
        of item.value
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
        const entryId =
          Number(entry.id)

        if (
          entryId ===
          document.id
        ) {
          score +=
            entry.tf * 2

          score +=
            (
              entry.title ||
              0
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
      typeof item?.[field] ===
        "string" &&
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
    getMediaPageUrl(item)

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

async function attachMedia(
  env: Env,
  manifest: Manifest,
  current: CurrentRelease,
  results: SearchResult[],
  deadline: number,
  signal: AbortSignal
): Promise<SearchResult[]> {
  if (
    results.length === 0
  ) {
    return results
  }

  let images: any[] =
    []

  let videos: any[] =
    []

  const imagePromise =
    manifest.images
      ? fetchGzipJson(
          env,
          releasePath(
            current.version,
            manifest.images
          ),
          deadline,
          signal,
          CONFIG.mediaTimeoutMs
        )
          .then(
            data =>
              normalizeMedia(
                data
              )
          )
          .catch(
            () => []
          )
      : Promise.resolve(
          []
        )

  const videoPromise =
    manifest.videos
      ? fetchGzipJson(
          env,
          releasePath(
            current.version,
            manifest.videos
          ),
          deadline,
          signal,
          CONFIG.mediaTimeoutMs
        )
          .then(
            data =>
              normalizeMedia(
                data
              )
          )
          .catch(
            () => []
          )
      : Promise.resolve(
          []
        )

  const [
    loadedImages,
    loadedVideos
  ] =
    await Promise.all([
      imagePromise,
      videoPromise
    ])

  images =
    loadedImages

  videos =
    loadedVideos

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

  const imagePaths:
    string[] = []

  const thumbnailPaths:
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
          CONFIG.maxImagesPerResult
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
          CONFIG.maxVideosPerResult
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
      CONFIG.maxImageSignedUrls
    )

  const limitedThumbnailPaths =
    [
      ...new Set(
        thumbnailPaths
      )
    ].slice(
      0,
      CONFIG.maxImageSignedUrls
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

  const imageSigningPromise =
    limitedImagePaths.length >
      0
      ? createSignedUrls(
          env,
          "images",
          limitedImagePaths,
          deadline,
          signal
        ).catch(
          () =>
            new Map<
              string,
              string
            >()
        )
      : Promise.resolve(
          new Map<
            string,
            string
          >()
      )

  const thumbnailSigningPromise =
    limitedThumbnailPaths.length >
      0
      ? createSignedUrls(
          env,
          "videos",
          limitedThumbnailPaths,
          deadline,
          signal
        ).catch(
          () =>
            new Map<
              string,
              string
            >()
        )
      : Promise.resolve(
          new Map<
            string,
            string
          >()
      )

  const [
    signedImages,
    signedThumbnails
  ] =
    await Promise.all([
      imageSigningPromise,
      thumbnailSigningPromise
    ])

  imageSignedUrls =
    signedImages

  thumbnailSignedUrls =
    signedThumbnails

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

  return results
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
      document.description || "",
    score,
    images: [],
    videos: []
  }
}

async function handleSearch(
  request: Request,
  env: Env,
  deadline: number,
  signal: AbortSignal
): Promise<Response> {
  const url =
    new URL(
      request.url
    )

  const query =
    url.searchParams
      .get("q")
      ?.trim() || ""

  if (!query) {
    return Response.json(
      {
        error:
          "Missing query parameter"
      },
      {
        status: 400,
        headers:
          CORS_HEADERS
      }
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
        dictionaryQuery.word,
        deadline,
        signal
      )

    return Response.json(
      {
        query,
        dictionary
      },
      {
        headers:
          CORS_HEADERS
      }
    )
  }

  const terms =
    tokenize(query)

  if (
    terms.length === 0
  ) {
    return Response.json(
      {
        query,
        dictionary: null,
        results: []
      },
      {
        headers:
          CORS_HEADERS
      }
    )
  }

  const current =
    await loadCurrentRelease(
      env,
      deadline,
      signal
    )

  const manifest =
    await loadManifest(
      env,
      current,
      deadline,
      signal
    )

  const termEntries =
    await getTermEntries(
      env,
      manifest,
      current,
      terms,
      deadline,
      signal
    )

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
        documentIds.add(
          id
        )

        if (
          documentIds.size >=
          CONFIG.maxDocumentIds
        ) {
          break
        }
      }
    }

    if (
      documentIds.size >=
      CONFIG.maxDocumentIds
    ) {
      break
    }
  }

  const documents =
    await getDocuments(
      env,
      manifest,
      current,
      [...documentIds],
      deadline,
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
      .sort(
        (a, b) =>
          b.score -
          a.score
      )
      .slice(
        0,
        CONFIG.maxSearchResults
      )

  const results =
    scored.map(
      item =>
        compactResult(
          item.document,
          item.score
        )
    )

  await attachMedia(
    env,
    manifest,
    current,
    results,
    deadline,
    signal
  )

  let dictionary =
    null

  if (
    dictionaryQuery.word &&
    !dictionaryQuery.dictionaryOnly &&
    remainingTime(deadline) >
      500
  ) {
    try {
      dictionary =
        await getDictionary(
          dictionaryQuery.word,
          deadline,
          signal
        )
    } catch {
      dictionary =
        null
    }
  }

  return Response.json(
    {
      query,
      dictionary,
      results
    },
    {
      headers:
        CORS_HEADERS
    }
  )
}

function jsonResponse(
  body: unknown,
  status = 200
): Response {
  return new Response(
    JSON.stringify(body),
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

function readRequestBody(
  request: http.IncomingMessage
): Promise<string> {
  return new Promise(
    (resolve, reject) => {
      let data = ""

      request.setEncoding(
        "utf8"
      )

      request.on(
        "data",
        chunk => {
          data += chunk

          if (
            data.length >
            1024 * 1024
          ) {
            reject(
              new Error(
                "Request body too large"
              )
            )

            request.destroy()
          }
        }
      )

      request.on(
        "end",
        () => resolve(data)
      )

      request.on(
        "error",
        reject
      )
    }
  )
}

async function handleHttpRequest(
  request: http.IncomingMessage
): Promise<Response> {
  const host =
    request.headers.host ||
    "localhost"

  const protocol =
    "http"

  const url =
    new URL(
      request.url ||
        "/",
      `${protocol}://${host}`
    )

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
      headers.set(
        key,
        value.join(", ")
      )
    } else if (
      value !== undefined
    ) {
      headers.set(
        key,
        value
      )
    }
  }

  const body =
    request.method ===
      "GET" ||
    request.method ===
      "HEAD"
      ? undefined
      : await readRequestBody(
          request
        )

  return new Request(
    url,
    {
      method:
        request.method ||
        "GET",
      headers,
      body
    }
  )
}

function sendNodeResponse(
  response: Response,
  nodeResponse: http.ServerResponse
): void {
  const headers:
    Record<string, string> =
    {}

  response.headers.forEach(
    (value, key) => {
      headers[key] =
        value
    }
  )

  nodeResponse.writeHead(
    response.status,
    headers
  )

  if (
    response.body
  ) {
    response
      .arrayBuffer()
      .then(
        buffer => {
          nodeResponse.end(
            Buffer.from(
              buffer
            )
          )
        }
      )
      .catch(
        error => {
          nodeResponse.destroy(
            error
          )
        }
      )

    return
  }

  nodeResponse.end()
}

const env =
  loadEnv()

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
          await handleHttpRequest(
            nodeRequest
          )

        if (
          request.method ===
          "OPTIONS"
        ) {
          sendNodeResponse(
            new Response(
              null,
              {
                status: 204,
                headers:
                  CORS_HEADERS
              }
            ),
            nodeResponse
          )

          return
        }

        if (
          request.method !==
          "GET"
        ) {
          sendNodeResponse(
            jsonResponse(
              {
                error:
                  "Method not allowed"
              },
              405
            ),
            nodeResponse
          )

          return
        }

        const requestUrl =
          new URL(
            request.url
          )

        if (
          requestUrl.pathname ===
          "/health"
        ) {
          sendNodeResponse(
            jsonResponse({
              ok: true,
              service:
                "seerchsqapi",
              runtime:
                "render"
            }),
            nodeResponse
          )

          return
        }

        if (
          requestUrl.pathname !==
          "/search"
        ) {
          sendNodeResponse(
            jsonResponse(
              {
                error:
                  "Not found"
              },
              404
            ),
            nodeResponse
          )

          return
        }

        const deadline =
          Date.now() +
          CONFIG.requestTimeoutMs

        const controller =
          new AbortController()

        const timer =
          setTimeout(
            () => {
              controller.abort()
            },
            CONFIG.requestTimeoutMs
          )

        try {
          const response =
            await handleSearch(
              request,
              env,
              deadline,
              controller.signal
            )

          sendNodeResponse(
            response,
            nodeResponse
          )

          const elapsed =
            Date.now() -
            started

          console.log(
            JSON.stringify({
              type:
                "search",
              query:
                requestUrl.searchParams.get(
                  "q"
                ) || "",
              status:
                response.status,
              duration_ms:
                elapsed
            })
          )
        } finally {
          clearTimeout(timer)
        }
      } catch (error) {
        const elapsed =
          Date.now() -
          started

        console.error(
          JSON.stringify({
            type:
              "request_error",
            duration_ms:
              elapsed,
            error:
              error instanceof Error
                ? error.stack ||
                  error.message
                : String(error)
          })
        )

        if (
          !nodeResponse.headersSent
        ) {
          sendNodeResponse(
            jsonResponse(
              {
                error:
                  error instanceof Error
                    ? error.message
                    : String(error)
              },
              500
            ),
            nodeResponse
          )
        } else {
          nodeResponse.destroy()
        }
      }
    }
  )

const port =
  Number(
    process.env.PORT ||
      10000
  )

server.listen(
  port,
  "0.0.0.0",
  () => {
    console.log(
      JSON.stringify({
        service:
          "seerchsqapi",
        runtime:
          "render",
        port,
        request_timeout_ms:
          CONFIG.requestTimeoutMs,
        term_concurrency:
          CONFIG.termShardConcurrency,
        document_concurrency:
          CONFIG.documentShardConcurrency
      })
    )
  }
)

function shutdown(
  signal: string
): void {
  console.log(
    `Received ${signal}, shutting down`
  )

  server.close(
    error => {
      if (error) {
        console.error(
          error
        )
        process.exit(1)
      }

      process.exit(0)
    }
  )
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
