import http from "node:http"
import { gunzip } from "node:zlib"
import { promisify } from "node:util"

const gunzipAsync = promisify(gunzip)

interface Env {
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
  DECISIONRANK_URL: string
  DECISIONRANK_API_KEY: string
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

interface SearchResult {
  id: number
  url: string
  title: string
  description: string
  images: MediaItem[]
  videos: MediaItem[]
}

interface DecisionCandidate {
  id: string
  url: string
  title: string
  description: string
  text: string
  images: MediaItem[]
  videos: MediaItem[]
}

interface DecisionRankResponse {
  decision: "allow" | "block"
  reason_code: string | null
  approved_ids: string[]
}

interface SearchOutput {
  decision: "allow" | "block"
  reason_code: string | null
  results: SearchResult[]
}

const MAX_DOCUMENT_IDS = 1000
const MAX_RANK_CANDIDATES = 200
const MAX_SEARCH_RESULTS = 25

const MAX_IMAGES_PER_RESULT = 4
const MAX_VIDEOS_PER_RESULT = 2

const MAX_IMAGE_SIGNED_URLS = 100
const MAX_VIDEO_SIGNED_URLS = 100

const MAX_RANK_TEXT_LENGTH = 4000

const SIGNED_URL_EXPIRES = 3600

const MAX_TERM_SHARDS_PER_SEARCH = 128
const MAX_DOCUMENT_SHARDS_PER_SEARCH = 128

const TERM_SHARD_CONCURRENCY = 12
const DOCUMENT_SHARD_CONCURRENCY = 12
const SIGNED_URL_CONCURRENCY = 12

const SEARCH_TIMEOUT_MS = 15000
const MEDIA_TIMEOUT_MS = 5000
const DECISIONRANK_TIMEOUT_MS = 12000

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Max-Age": "86400"
}

function loadEnv(): Env {
  const SUPABASE_URL =
    process.env.SUPABASE_URL?.trim()

  const SUPABASE_SECRET_KEY =
    process.env.SUPABASE_SECRET_KEY?.trim()

  const DECISIONRANK_URL =
    (
      process.env.DECISIONRANK_URL ||
      "https://decisionrank.onrender.com"
    ).trim().replace(/\/+$/, "")

  const DECISIONRANK_API_KEY =
    process.env.DECISIONRANK_API_KEY?.trim() || ""

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

  try {
    const parsed = new URL(DECISIONRANK_URL)

    if (
      parsed.protocol !== "https:" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1"
    ) {
      throw new Error("DecisionRank must use HTTPS")
    }
  } catch {
    throw new Error("Invalid DECISIONRANK_URL")
  }

  return {
    SUPABASE_URL: SUPABASE_URL.replace(/\/+$/, ""),
    SUPABASE_SECRET_KEY,
    DECISIONRANK_URL,
    DECISIONRANK_API_KEY
  }
}

const env = loadEnv()

function timeoutSignal(
  timeoutMs: number,
  signal?: AbortSignal | null
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)

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
  return fetch(input, {
    ...init,
    signal: timeoutSignal(
      timeoutMs,
      init.signal
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
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store"
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

async function fetchGzipText(
  env: Env,
  path: string,
  timeoutMs = SEARCH_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<string> {
  const response = await fetchWithTimeout(
    storageUrl(env, path),
    {
      headers: supabaseHeaders(env),
      signal
    },
    timeoutMs
  )

  if (!response.ok) {
    const body = await response.text()

    throw new Error(
      `Supabase gzip request failed: ` +
      `${response.status} ${response.statusText} | ` +
      `${path} | ${body.slice(0, 500)}`
    )
  }

  const bytes = Buffer.from(
    await response.arrayBuffer()
  )

  const decompressed = await gunzipAsync(bytes)

  return decompressed.toString("utf8")
}

async function fetchJson(
  env: Env,
  path: string,
  timeoutMs = SEARCH_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<any> {
  const response = await fetchWithTimeout(
    storageUrl(env, path),
    {
      headers: supabaseHeaders(env),
      signal
    },
    timeoutMs
  )

  if (!response.ok) {
    const body = await response.text()

    throw new Error(
      `Supabase request failed: ` +
      `${response.status} ${response.statusText} | ` +
      `${path} | ${body.slice(0, 500)}`
    )
  }

  return response.json()
}

function parseJsonOrJsonl(
  text: string
): any {
  const trimmed = text.trim()

  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed)
  } catch {
    const lines = trimmed
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)

    return lines.map(line => JSON.parse(line))
  }
}

async function fetchGzipJson(
  env: Env,
  path: string,
  timeoutMs = SEARCH_TIMEOUT_MS,
  signal?: AbortSignal
): Promise<any> {
  const text = await fetchGzipText(
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
  if (path.startsWith("releases/")) {
    return path
  }

  return `${version}/${path}`
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (
    item: T,
    index: number
  ) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) {
    return []
  }

  const results = new Array<R>(items.length)
  let cursor = 0

  async function runner(): Promise<void> {
    while (true) {
      const index = cursor++

      if (index >= items.length) {
        return
      }

      results[index] = await worker(
        items[index],
        index
      )
    }
  }

  const workers = Math.min(
    Math.max(1, concurrency),
    items.length
  )

  await Promise.all(
    Array.from(
      { length: workers },
      () => runner()
    )
  )

  return results
}

async function createSignedUrls(
  env: Env,
  bucket: string,
  paths: string[],
  signal?: AbortSignal
): Promise<Map<string, string>> {
  const uniquePaths: string[] = [
  ...new Set<string>(
    paths.filter(
      (path): path is string =>
        typeof path === "string" && path.length > 0
    )
  )
]

  if (uniquePaths.length === 0) {
    return new Map()
  }

  const batches: string[][] = []

  for (
    let index = 0;
    index < uniquePaths.length;
    index += 100
  ) {
    batches.push(
      uniquePaths.slice(index, index + 100)
    )
  }

  const url =
    `${env.SUPABASE_URL}` +
    `/storage/v1/object/sign/${bucket}`

  const results = await mapConcurrent(
    batches,
    SIGNED_URL_CONCURRENCY,
    async batch => {
      try {
        const response = await fetchWithTimeout(
          url,
          {
            method: "POST",
            headers: {
              ...supabaseHeaders(env),
              "Content-Type": "application/json"
            },
            body: JSON.stringify({
              expiresIn: SIGNED_URL_EXPIRES,
              paths: batch
            }),
            signal
          },
          MEDIA_TIMEOUT_MS
        )

        if (!response.ok) {
          console.error(
            `[media] Signed URL request failed: ` +
            `${response.status} for bucket ${bucket}`
          )

          return []
        }

        return await response.json() as Array<{
          path?: string
          signedURL?: string
          error?: string
        }>
      } catch (error) {
        if (signal?.aborted) {
          throw error
        }

        console.error(
          `[media] Signed URL request error for ${bucket}:`,
          error
        )

        return []
      }
    }
  )

  const output = new Map<string, string>()

  for (const batch of results) {
    for (const item of batch) {
      if (!item.path || !item.signedURL) {
        continue
      }

      const signedURL =
        item.signedURL.startsWith("http://") ||
        item.signedURL.startsWith("https://")
          ? item.signedURL
          : `${env.SUPABASE_URL}/storage/v1${item.signedURL}`

      output.set(item.path, signedURL)
    }
  }

  return output
}

function tokenize(
  query: string
): string[] {
  return query
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

async function loadCurrentRelease(
  env: Env,
  signal?: AbortSignal
): Promise<CurrentRelease> {
  const current = await fetchGzipJson(
    env,
    "current.json",
    SEARCH_TIMEOUT_MS,
    signal
  )

  if (
    !current ||
    typeof current !== "object"
  ) {
    throw new Error("Invalid current.json")
  }

  if (
    typeof current.version !== "string" ||
    typeof current.manifest !== "string"
  ) {
    throw new Error(
      "current.json is missing version or manifest"
    )
  }

  return current as CurrentRelease
}

async function loadManifest(
  env: Env,
  current: CurrentRelease,
  signal?: AbortSignal
): Promise<Manifest> {
  const path = releasePath(
    current.version,
    current.manifest
  )

  const manifest = await fetchGzipJson(
    env,
    path,
    SEARCH_TIMEOUT_MS,
    signal
  )

  if (
    !manifest ||
    typeof manifest !== "object"
  ) {
    throw new Error("Invalid manifest")
  }

  if (
    !Array.isArray(manifest.docs_shards) ||
    !Array.isArray(manifest.term_shards)
  ) {
    throw new Error(
      "Manifest is missing docs_shards or term_shards"
    )
  }

  return manifest as Manifest
}

function normalizeTermShard(
  data: any
): Map<string, TermEntry[]> {
  const result = new Map<string, TermEntry[]>()

  if (
    data &&
    typeof data === "object" &&
    !Array.isArray(data)
  ) {
    for (const [term, entries] of Object.entries(data)) {
      if (!Array.isArray(entries)) {
        continue
      }

      result.set(
        term.toLowerCase(),
        entries
          .filter(
            entry =>
              entry &&
              typeof entry === "object"
          )
          .map(entry => {
            const value = entry as any

            return {
              ...value,
              id: String(value.id),
              tf: Number(value.tf || 0),
              title:
                value.title !== undefined
                  ? Number(value.title)
                  : 0
            }
          })
      )
    }

    return result
  }

  if (Array.isArray(data)) {
    for (const item of data) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.term !== "string" ||
        !Array.isArray(item.entries)
      ) {
        continue
      }

      result.set(
        item.term.toLowerCase(),
        item.entries
          .filter(
            (entry: any) =>
              entry &&
              typeof entry === "object"
          )
          .map((entry: any) => ({
            ...entry,
            id: String(entry.id),
            tf: Number(entry.tf || 0),
            title:
              entry.title !== undefined
                ? Number(entry.title)
                : 0
          }))
      )
    }
  }

  return result
}

async function getTermEntries(
  env: Env,
  manifest: Manifest,
  current: CurrentRelease,
  terms: string[],
  signal?: AbortSignal
): Promise<Map<string, TermEntry[]>> {
  const wanted = new Set(
    terms.map(term => term.toLowerCase())
  )

  const found = new Map<string, TermEntry[]>()

  const shardNames = manifest.term_shards.slice(
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
      if (signal?.aborted) {
        throw new Error("Search aborted")
      }

      if (found.size === wanted.size) {
        return
      }

      try {
        const path = releasePath(
          current.version,
          shardName
        )

        const data = await fetchGzipJson(
          env,
          path,
          SEARCH_TIMEOUT_MS,
          signal
        )

        const entries = normalizeTermShard(data)

        for (const term of wanted) {
          if (found.has(term)) {
            continue
          }

          const value = entries.get(term)

          if (value) {
            found.set(term, value)
          }
        }
      } catch (error) {
        if (signal?.aborted) {
          throw error
        }

        console.error(
          `[search] Term shard failed: ${shardName}`,
          error
        )
      }
    }
  )

  console.log(
    `[search] Terms requested=${wanted.size}, found=${found.size}, ` +
    `shards=${shardNames.length}`
  )

  return found
}

function normalizeDocuments(
  data: any
): Document[] {
  let documents: any[] = []

  if (Array.isArray(data)) {
    documents = data
  } else if (
    data &&
    typeof data === "object"
  ) {
    if (Array.isArray(data.documents)) {
      documents = data.documents
    } else if (data.id !== undefined) {
      documents = [data]
    }
  }

  return documents
    .filter(
      item =>
        item &&
        typeof item === "object" &&
        item.id !== undefined
    )
    .map(item => ({
      ...item,
      id: Number(item.id),
      url: String(item.url || ""),
      title: String(item.title || ""),
      description: String(item.description || ""),
      text: String(item.text || "")
    }))
    .filter(
      item =>
        Number.isInteger(item.id) &&
        item.url.length > 0
    ) as Document[]
}

async function getDocuments(
  env: Env,
  manifest: Manifest,
  current: CurrentRelease,
  ids: number[],
  signal?: AbortSignal
): Promise<Document[]> {
  if (ids.length === 0) {
    return []
  }

  const requestedIds = new Set(
    ids.slice(0, MAX_DOCUMENT_IDS)
  )

  const shardIds = [...requestedIds].map(
    id => Math.floor(id / 250)
  )

  const uniqueShardIds = [
    ...new Set(shardIds)
  ]

  const limitedShardIds = uniqueShardIds.slice(
    0,
    MAX_DOCUMENT_SHARDS_PER_SEARCH
  )

  const documents = new Map<number, Document>()

  await mapConcurrent(
    limitedShardIds,
    DOCUMENT_SHARD_CONCURRENCY,
    async shardId => {
      if (signal?.aborted) {
        throw new Error("Search aborted")
      }

      if (documents.size === requestedIds.size) {
        return
      }

      const shardName = manifest.docs_shards[shardId]

      if (!shardName) {
        console.error(
          `[search] No document shard at index ${shardId}`
        )

        return
      }

      try {
        const path = releasePath(
          current.version,
          shardName
        )

        const data = await fetchGzipJson(
          env,
          path,
          SEARCH_TIMEOUT_MS,
          signal
        )

        const shardDocuments = normalizeDocuments(data)

        for (const document of shardDocuments) {
          if (requestedIds.has(document.id)) {
            documents.set(document.id, document)
          }
        }
      } catch (error) {
        if (signal?.aborted) {
          throw error
        }

        console.error(
          `[search] Document shard failed: ${shardName}`,
          error
        )
      }
    }
  )

  const output = [...requestedIds]
    .map(id => documents.get(id))
    .filter(
      (document): document is Document =>
        Boolean(document)
    )

  console.log(
    `[search] Document IDs requested=${requestedIds.size}, ` +
    `documents loaded=${output.length}`
  )

  return output
}

function normalizeMedia(data: any): any[] {
  if (Array.isArray(data)) {
    return data
  }

  if (data && typeof data === "object") {
    for (const key of [
      "items",
      "media",
      "images",
      "videos"
    ]) {
      if (Array.isArray(data[key])) {
        return data[key]
      }
    }
  }

  return []
}

function normalizeUrl(value: unknown): string {
  if (typeof value !== "string") {
    return ""
  }

  try {
    const url = new URL(value)

    url.hash = ""

    if (
      url.pathname.length > 1 &&
      url.pathname.endsWith("/")
    ) {
      url.pathname = url.pathname.slice(0, -1)
    }

    return url.toString().toLowerCase()
  } catch {
    return value
      .trim()
      .replace(/#.*$/, "")
      .replace(/\/+$/, "")
      .toLowerCase()
  }
}

function getMediaPageUrl(item: any): string {
  for (const key of [
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
  ]) {
    if (typeof item?.[key] === "string") {
      return item[key]
    }
  }

  return ""
}

function mediaMatchesDocument(
  item: any,
  documentUrl: string
): boolean {
  const target = normalizeUrl(documentUrl)

  const mediaPage = normalizeUrl(
    getMediaPageUrl(item)
  )

  if (mediaPage && mediaPage === target) {
    return true
  }

  const mediaUrl = normalizeUrl(item?.url)

  if (mediaUrl && mediaUrl === target) {
    return true
  }

  return false
}

function compactMedia(item: any): MediaItem {
  const result: MediaItem = {}

  if (typeof item.url === "string") {
    result.url = item.url
  }

  if (typeof item.path === "string") {
    result.path = item.path
  }

  if (typeof item.title === "string") {
    result.title = item.title
  }

  if (typeof item.alt === "string") {
    result.alt = item.alt
  }

  if (typeof item.type === "string") {
    result.type = item.type
  }

  if (typeof item.mime_type === "string") {
    result.mime_type = item.mime_type
  }

  if (typeof item.thumbnail === "string") {
    result.thumbnail = item.thumbnail
  }

  if (typeof item.thumbnail_path === "string") {
    result.thumbnail_path = item.thumbnail_path
  }

  return result
}

async function loadMediaFile(
  env: Env,
  current: CurrentRelease,
  path: string,
  signal?: AbortSignal
): Promise<any[]> {
  try {
    const data = await fetchGzipJson(
      env,
      releasePath(current.version, path),
      MEDIA_TIMEOUT_MS,
      signal
    )

    return normalizeMedia(data)
  } catch (error) {
    if (signal?.aborted) {
      throw error
    }

    console.error(
      `[media] Media manifest failed: ${path}`,
      error
    )

    return []
  }
}

async function loadMediaCollection(
  env: Env,
  current: CurrentRelease,
  path?: string,
  signal?: AbortSignal
): Promise<any[]> {
  if (!path) {
    return []
  }

  return loadMediaFile(
    env,
    current,
    path,
    signal
  )
}

async function attachMedia(
  env: Env,
  manifest: Manifest,
  current: CurrentRelease,
  results: SearchResult[],
  signal?: AbortSignal
): Promise<void> {
  if (results.length === 0) {
    return
  }

  const [images, videos] = await Promise.all([
    loadMediaCollection(
      env,
      current,
      manifest.images,
      signal
    ),
    loadMediaCollection(
      env,
      current,
      manifest.videos,
      signal
    )
  ])

  const imagePaths: string[] = []
  const videoThumbnailPaths: string[] = []

  for (const result of results) {
    const matchedImages = images
      .filter(image =>
        mediaMatchesDocument(image, result.url)
      )
      .slice(0, MAX_IMAGES_PER_RESULT)

    const matchedVideos = videos
      .filter(video =>
        mediaMatchesDocument(video, result.url)
      )
      .slice(0, MAX_VIDEOS_PER_RESULT)

    result.images = matchedImages.map(compactMedia)
    result.videos = matchedVideos.map(compactMedia)

    for (const image of result.images) {
      if (image.path) {
        imagePaths.push(image.path)
      }
    }

    for (const video of result.videos) {
      if (video.thumbnail_path) {
        videoThumbnailPaths.push(video.thumbnail_path)
      }
    }
  }

  const uniqueImagePaths = [
    ...new Set(imagePaths)
  ].slice(0, MAX_IMAGE_SIGNED_URLS)

  const uniqueVideoPaths = [
    ...new Set(videoThumbnailPaths)
  ].slice(0, MAX_VIDEO_SIGNED_URLS)

  const [
    imageSignedUrls,
    videoSignedUrls
  ] = await Promise.all([
    createSignedUrls(
      env,
      "images",
      uniqueImagePaths,
      signal
    ),
    createSignedUrls(
      env,
      "videos",
      uniqueVideoPaths,
      signal
    )
  ])

  for (const result of results) {
    for (const image of result.images) {
      if (
        image.path &&
        imageSignedUrls.has(image.path)
      ) {
        image.url = imageSignedUrls.get(image.path)
      }
    }

    for (const video of result.videos) {
      if (
        video.thumbnail_path &&
        videoSignedUrls.has(video.thumbnail_path)
      ) {
        video.thumbnail =
          videoSignedUrls.get(video.thumbnail_path)
      }
    }
  }
}

async function callDecisionRank(
  query: string,
  safe: "strict" | "moderate",
  documents: Document[],
  results: SearchResult[],
  signal?: AbortSignal
): Promise<DecisionRankResponse> {
  if (!env.DECISIONRANK_API_KEY) {
    throw new Error(
      "DecisionRank API key is not configured"
    )
  }

  const resultById = new Map(
    results.map(result => [
      String(result.id),
      result
    ])
  )

  const documentById = new Map(
    documents.map(document => [
      String(document.id),
      document
    ])
  )

  const candidateIds = results
    .slice(0, MAX_RANK_CANDIDATES)
    .map(result => String(result.id))

  const candidates: DecisionCandidate[] =
    candidateIds.map(id => {
      const result = resultById.get(id)!
      const document = documentById.get(id)

      return {
        id,
        url: result.url,
        title: result.title,
        description: result.description,
        text: (document?.text || "").slice(
          0,
          MAX_RANK_TEXT_LENGTH
        ),
        images: result.images,
        videos: result.videos
      }
    })

  const endpoint =
    `${env.DECISIONRANK_URL}/rank`

  let response: Response

  try {
    response = await fetchWithTimeout(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization":
            `Bearer ${env.DECISIONRANK_API_KEY}`
        },
        body: JSON.stringify({
          query,
          safe,
          candidates
        }),
        signal
      },
      DECISIONRANK_TIMEOUT_MS
    )
  } catch (error) {
    console.error(
      "[DecisionRank] Connection failed:",
      error
    )

    throw new Error(
      "DecisionRank is unavailable"
    )
  }

  if (!response.ok) {
    const body = await response.text()

    console.error(
      `[DecisionRank] HTTP ${response.status}: ` +
      body.slice(0, 500)
    )

    throw new Error(
      response.status === 503
        ? "DecisionRank engine is not ready"
        : "DecisionRank request failed"
    )
  }

  let data: any

  try {
    data = await response.json()
  } catch {
    throw new Error(
      "DecisionRank returned invalid JSON"
    )
  }

  if (
    !data ||
    (
      data.decision !== "allow" &&
      data.decision !== "block"
    )
  ) {
    throw new Error(
      "DecisionRank returned an invalid decision"
    )
  }

  if (data.decision === "block") {
    return {
      decision: "block",
      reason_code:
        typeof data.reason_code === "string"
          ? data.reason_code
          : "search_blocked",
      approved_ids: []
    }
  }

  if (!Array.isArray(data.approved_ids)) {
    throw new Error(
      "DecisionRank response is missing approved_ids"
    )
  }

  const allowedIds = new Set(candidateIds)

  const approvedIds: string[] = []

for (const id of data.approved_ids as unknown[]) {
  if (
    typeof id === "string" &&
    allowedIds.has(id) &&
    !approvedIds.includes(id)
  ) {
    approvedIds.push(id)
  }
}

return {
  decision: "allow",
  reason_code: null,
  approved_ids: approvedIds
}
}

async function performSearch(
  env: Env,
  query: string,
  safe: "strict" | "moderate",
  page: number,
  limit: number,
  signal?: AbortSignal
): Promise<SearchOutput> {
  const terms = tokenize(query)

  if (terms.length === 0) {
    const decision = await callDecisionRank(
      query,
      safe,
      [],
      [],
      signal
    )

    return {
      decision: decision.decision,
      reason_code: decision.reason_code,
      results: []
    }
  }

  const current = await loadCurrentRelease(
    env,
    signal
  )

  const manifest = await loadManifest(
    env,
    current,
    signal
  )

  const termEntries = await getTermEntries(
    env,
    manifest,
    current,
    terms,
    signal
  )

  const documentIds = new Set<number>()

  for (const entries of termEntries.values()) {
    for (const entry of entries) {
      const id = Number(entry.id)

      if (!Number.isInteger(id) || id < 0) {
        continue
      }

      documentIds.add(id)

      if (documentIds.size >= MAX_DOCUMENT_IDS) {
        break
      }
    }

    if (documentIds.size >= MAX_DOCUMENT_IDS) {
      break
    }
  }

  const documents = await getDocuments(
    env,
    manifest,
    current,
    [...documentIds],
    signal
  )

  const candidates = documents.slice(
    0,
    MAX_RANK_CANDIDATES
  )

  const results: SearchResult[] = candidates.map(
    document => ({
      id: document.id,
      url: document.url,
      title: document.title,
      description: document.description,
      images: [],
      videos: []
    })
  )

  if (results.length > 0) {
    await attachMedia(
      env,
      manifest,
      current,
      results,
      signal
    )
  }

  console.log(
    `[search] Query="${query}", ` +
    `terms=${terms.length}, ` +
    `termEntries=${termEntries.size}, ` +
    `candidateIDs=${documentIds.size}, ` +
    `loaded=${documents.length}, ` +
    `sentToDecisionRank=${results.length}`
  )

  const decision = await callDecisionRank(
    query,
    safe,
    candidates,
    results,
    signal
  )

  if (decision.decision === "block") {
    return {
      decision: "block",
      reason_code: decision.reason_code,
      results: []
    }
  }

  const resultMap = new Map(
    results.map(result => [
      String(result.id),
      result
    ])
  )

  const orderedResults = decision.approved_ids
    .map(id => resultMap.get(id))
    .filter(
      (result): result is SearchResult =>
        Boolean(result)
    )

  const offset = (page - 1) * limit

  return {
    decision: "allow",
    reason_code: null,
    results: orderedResults.slice(
      offset,
      offset + limit
    )
  }
}

async function handleRequest(
  request: Request
): Promise<Response> {
  const url = new URL(request.url)

  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS
    })
  }

  if (request.method !== "GET") {
    return jsonResponse(
      { error: "Method not allowed" },
      405
    )
  }

  if (url.pathname === "/health") {
    return jsonResponse({
      ok: true,
      service: "seerchsqapi",
      runtime: "render",
      uptime: process.uptime(),
      ranking_service: "DecisionRank",
      ranking_service_url: env.DECISIONRANK_URL,
      ranking_configured: Boolean(
        env.DECISIONRANK_API_KEY
      )
    })
  }

  if (url.pathname !== "/search") {
    return jsonResponse(
      { error: "Not found" },
      404
    )
  }

  const query =
    url.searchParams.get("q")?.trim() || ""

  if (!query) {
    return jsonResponse(
      { error: "Missing query parameter" },
      400
    )
  }

  const requestedSafe =
    url.searchParams.get("safe") || "strict"

  if (
    requestedSafe !== "strict" &&
    requestedSafe !== "moderate"
  ) {
    return jsonResponse(
      {
        error: "Invalid safe parameter",
        allowed: ["strict", "moderate"]
      },
      400
    )
  }

  const safe = requestedSafe as
    "strict" | "moderate"

  const requestedPage = Number(
    url.searchParams.get("page") || 1
  )

  const requestedLimit = Number(
    url.searchParams.get("limit") || 20
  )

  const page = Number.isFinite(requestedPage)
    ? Math.min(
        1000,
        Math.max(1, Math.floor(requestedPage))
      )
    : 1

  const limit = Number.isFinite(requestedLimit)
    ? Math.min(
        MAX_SEARCH_RESULTS,
        Math.max(1, Math.floor(requestedLimit))
      )
    : 20

  const controller = new AbortController()

  const timeout = setTimeout(() => {
    controller.abort()
  }, SEARCH_TIMEOUT_MS + DECISIONRANK_TIMEOUT_MS + 5000)

  try {
    const output = await performSearch(
      env,
      query,
      safe,
      page,
      limit,
      controller.signal
    )

    if (controller.signal.aborted) {
      return jsonResponse(
        { error: "Search request timed out" },
        504
      )
    }

    return jsonResponse({
      query,
      safe,
      decision: output.decision,
      reason_code: output.reason_code,
      results: output.results
    })
  } catch (error) {
    console.error("[search]", error)

    if (controller.signal.aborted) {
      return jsonResponse(
        { error: "Search request timed out" },
        504
      )
    }

    const message =
      error instanceof Error
        ? error.message
        : "Search failed"

    if (
      message.includes("DecisionRank")
    ) {
      return jsonResponse(
        {
          error: "DecisionRank unavailable",
          message
        },
        503
      )
    }

    return jsonResponse(
      { error: message },
      500
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function nodeRequestToWebRequest(
  request: http.IncomingMessage
): Promise<Request> {
  const protocol = (
    request.headers["x-forwarded-proto"] ||
    "http"
  )
    .toString()
    .split(",")[0]
    .trim()

  const host = (
    request.headers.host ||
    "localhost"
  ).toString()

  const url =
    `${protocol}://${host}${request.url || "/"}`

  const headers = new Headers()

  for (const [key, value] of Object.entries(
    request.headers
  )) {
    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item)
      }
    } else if (value !== undefined) {
      headers.set(key, value)
    }
  }

  return new Request(url, {
    method: request.method || "GET",
    headers
  })
}

async function sendResponse(
  response: http.ServerResponse,
  webResponse: Response
): Promise<void> {
  response.statusCode = webResponse.status

  webResponse.headers.forEach((value, key) => {
    response.setHeader(key, value)
  })

  const body = await webResponse.arrayBuffer()

  response.end(Buffer.from(body))
}

const port = Number(
  process.env.PORT || 10000
)

const server = http.createServer(
  async (nodeRequest, nodeResponse) => {
    const started = Date.now()

    try {
      const request = await nodeRequestToWebRequest(
        nodeRequest
      )

      const response = await handleRequest(request)

      await sendResponse(
        nodeResponse,
        response
      )

      const url = new URL(request.url)

      console.log(
        `[request] ${request.method} ` +
        `${url.pathname}${url.search} ` +
        `${response.status} ` +
        `${Date.now() - started}ms`
      )
    } catch (error) {
      console.error("[server]", error)

      if (!nodeResponse.headersSent) {
        const response = jsonResponse(
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
      `SEErch² Search API listening on port ${port}`
    )

    console.log(
      `DecisionRank endpoint: ${env.DECISIONRANK_URL}/rank`
    )
  }
)

function shutdown(signal: string): void {
  console.log(
    `[server] received ${signal}, shutting down`
  )

  server.close(() => {
    process.exit(0)
  })

  setTimeout(() => {
    process.exit(1)
  }, 10000).unref()
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))
