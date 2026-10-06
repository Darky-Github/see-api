import http from "node:http"
import { gunzip } from "node:zlib"
import { promisify } from "node:util"

const gunzipAsync = promisify(gunzip)

type Env = {
  SUPABASE_URL: string
  SUPABASE_SECRET_KEY: string
}

type JsonObject = Record<string, unknown>

type SearchResult = {
  id: number
  url: string
  title: string
  description: string
  score: number
  images: MediaItem[]
  videos: MediaItem[]
}

type MediaItem = {
  url?: string
  path?: string
  title?: string
  alt?: string
  type?: string
  mime_type?: string
  thumbnail?: string
  thumbnail_path?: string
  [key: string]: unknown
}

type Document = {
  id: number
  url: string
  title?: string
  description?: string
  text?: string
  [key: string]: unknown
}

type Posting = {
  id: number
  tf?: number
  title_tf?: number
  [key: string]: unknown
}

type DictionaryEntry = {
  term?: string
  df?: number
  idf?: number
  postings?: Posting[]
  [key: string]: unknown
}

type Manifest = {
  docs_shards?: unknown
  term_shards?: unknown
  fingerprints?: unknown
  images?: unknown
  videos?: unknown
  [key: string]: unknown
}

type Release = {
  manifest?: string
  manifest_path?: string
  [key: string]: unknown
}

const CONFIG = {
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

function loadEnv(): Env {
  const SUPABASE_URL = process.env.SUPABASE_URL
  const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY

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

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = CONFIG.fetchTimeoutMs,
  signal?: AbortSignal
): Promise<Response> {
  const controller = new AbortController()

  const timeout = setTimeout(() => {
    controller.abort()
  }, timeoutMs)

  const abortFromParent = () => {
    controller.abort()
  }

  if (signal) {
    if (signal.aborted) {
      controller.abort()
    } else {
      signal.addEventListener("abort", abortFromParent, { once: true })
    }
  }

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)

    if (signal) {
      signal.removeEventListener("abort", abortFromParent)
    }
  }
}

async function fetchBytes(
  url: string,
  timeoutMs = CONFIG.fetchTimeoutMs,
  signal?: AbortSignal
): Promise<Uint8Array> {
  const response = await fetchWithTimeout(
    url,
    {},
    timeoutMs,
    signal
  )

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`)
  }

  return new Uint8Array(await response.arrayBuffer())
}

async function fetchGzipText(
  url: string,
  timeoutMs = CONFIG.fetchTimeoutMs,
  signal?: AbortSignal
): Promise<string> {
  const bytes = await fetchBytes(url, timeoutMs, signal)

  const decompressed = await gunzipAsync(bytes)

  return decompressed.toString("utf8")
}

async function fetchJson<T>(
  url: string,
  timeoutMs = CONFIG.fetchTimeoutMs,
  signal?: AbortSignal
): Promise<T> {
  const text = await fetchGzipText(url, timeoutMs, signal)

  return JSON.parse(text) as T
}

function parseJsonOrJsonl<T>(text: string): T[] | T {
  const trimmed = text.trim()

  if (!trimmed) {
    return []
  }

  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    return JSON.parse(trimmed) as T[] | T
  }

  return trimmed
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as T)
}

function asArray<T>(value: T[] | T): T[] {
  if (Array.isArray(value)) {
    return value
  }

  return [value]
}

function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    return path
  }

  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`
}

function getStorageObjectUrl(
  env: Env,
  bucket: string,
  path: string
): string {
  return `${env.SUPABASE_URL}/storage/v1/object/public/${bucket}/${path}`
}

async function createSignedUrl(
  env: Env,
  bucket: string,
  path: string,
  expiresIn = CONFIG.signedUrlExpires,
  signal?: AbortSignal
): Promise<string | null> {
  if (!path) {
    return null
  }

  const url =
    `${env.SUPABASE_URL}/storage/v1/object/sign/` +
    `${encodeURIComponent(bucket)}/${path.replace(/^\/+/, "")}`

  try {
    const response = await fetchWithTimeout(
      url,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
          apikey: env.SUPABASE_SECRET_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          expiresIn
        })
      },
      CONFIG.mediaTimeoutMs,
      signal
    )

    if (!response.ok) {
      return null
    }

    const data = await response.json() as {
      signedURL?: string
      signedUrl?: string
      path?: string
      token?: string
    }

    if (data.signedURL) {
      if (data.signedURL.startsWith("http")) {
        return data.signedURL
      }

      return `${env.SUPABASE_URL}${data.signedURL}`
    }

    if (data.signedUrl) {
      if (data.signedUrl.startsWith("http")) {
        return data.signedUrl
      }

      return `${env.SUPABASE_URL}${data.signedUrl}`
    }

    if (data.path) {
      if (data.path.startsWith("http")) {
        return data.path
      }

      return `${env.SUPABASE_URL}${data.path}`
    }

    if (data.token) {
      return (
        `${env.SUPABASE_URL}/storage/v1/object/sign/` +
        `${encodeURIComponent(bucket)}/` +
        `${path.replace(/^\/+/, "")}?token=${encodeURIComponent(data.token)}`
      )
    }

    return null
  } catch {
    return null
  }
}

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean)
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)]
}

function getString(
  object: JsonObject | undefined,
  keys: string[]
): string {
  if (!object) {
    return ""
  }

  for (const key of keys) {
    const value = object[key]

    if (typeof value === "string") {
      return value
    }
  }

  return ""
}

function getNumber(
  object: JsonObject | undefined,
  keys: string[],
  fallback = 0
): number {
  if (!object) {
    return fallback
  }

  for (const key of keys) {
    const value = object[key]

    if (typeof value === "number" && Number.isFinite(value)) {
      return value
    }

    if (typeof value === "string") {
      const parsed = Number(value)

      if (Number.isFinite(parsed)) {
        return parsed
      }
    }
  }

  return fallback
}

function extractShardList(
  value: unknown
): string[] {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value.filter(
      item => typeof item === "string"
    ) as string[]
  }

  if (typeof value === "string") {
    return [value]
  }

  if (typeof value === "object") {
    const object = value as JsonObject

    for (const key of [
      "shards",
      "files",
      "paths",
      "items",
      "urls"
    ]) {
      const result = extractShardList(object[key])

      if (result.length) {
        return result
      }
    }
  }

  return []
}

function getManifestPath(
  release: Release
): string {
  return (
    getString(release, [
      "manifest",
      "manifest_path"
    ]) ||
    ""
  )
}

async function loadCurrentRelease(
  env: Env,
  signal?: AbortSignal
): Promise<Release> {
  const url = getStorageObjectUrl(
    env,
    "seendex",
    "current.json"
  )

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
        apikey: env.SUPABASE_SECRET_KEY
      }
    },
    CONFIG.fetchTimeoutMs,
    signal
  )

  if (!response.ok) {
    throw new Error(
      `Unable to load current.json: HTTP ${response.status}`
    )
  }

  return await response.json() as Release
}

async function loadManifest(
  env: Env,
  release: Release,
  signal?: AbortSignal
): Promise<Manifest> {
  const manifestPath = getManifestPath(release)

  if (!manifestPath) {
    throw new Error("Release does not contain a manifest path")
  }

  const url = getStorageObjectUrl(
    env,
    "seendex",
    manifestPath
  )

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
        apikey: env.SUPABASE_SECRET_KEY
      }
    },
    CONFIG.fetchTimeoutMs,
    signal
  )

  if (!response.ok) {
    throw new Error(
      `Unable to load manifest: HTTP ${response.status}`
    )
  }

  const data = await response.json()

  return data as Manifest
}

async function fetchShard(
  env: Env,
  path: string,
  signal?: AbortSignal
): Promise<string> {
  const url = getStorageObjectUrl(
    env,
    "seendex",
    path
  )

  return fetchGzipText(
    url,
    CONFIG.fetchTimeoutMs,
    signal
  )
}

async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)

  let cursor = 0

  async function runWorker() {
    while (true) {
      const index = cursor++

      if (index >= items.length) {
        return
      }

      results[index] = await worker(items[index], index)
    }
  }

  const workers = Math.min(
    Math.max(1, concurrency),
    items.length
  )

  await Promise.all(
    Array.from(
      { length: workers },
      () => runWorker()
    )
  )

  return results
}

function normalizeDictionary(
  value: unknown
): DictionaryEntry[] {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value.filter(
      item =>
        item !== null &&
        typeof item === "object"
    ) as DictionaryEntry[]
  }

  if (typeof value === "object") {
    const object = value as JsonObject

    if (Array.isArray(object.items)) {
      return object.items.filter(
        item =>
          item !== null &&
          typeof item === "object"
      ) as DictionaryEntry[]
    }

    return Object.entries(object).map(
      ([term, data]) => {
        if (
          data &&
          typeof data === "object" &&
          !Array.isArray(data)
        ) {
          return {
            term,
            ...(data as JsonObject)
          } as DictionaryEntry
        }

        return {
          term
        }
      }
    )
  }

  return []
}

function getDictionaryTerm(
  entry: DictionaryEntry
): string {
  return (
    entry.term ||
    getString(entry, ["key", "token", "word"])
  ).toLowerCase()
}

function getPostings(
  entry: DictionaryEntry
): Posting[] {
  const postings = entry.postings

  if (Array.isArray(postings)) {
    return postings.filter(
      posting =>
        posting !== null &&
        typeof posting === "object"
    ) as Posting[]
  }

  const object = entry as JsonObject

  for (const key of [
    "docs",
    "documents",
    "posting",
    "ids"
  ]) {
    const value = object[key]

    if (Array.isArray(value)) {
      return value.map(item => {
        if (
          typeof item === "number"
        ) {
          return {
            id: item
          }
        }

        if (
          typeof item === "string"
        ) {
          return {
            id: Number(item)
          }
        }

        if (
          item &&
          typeof item === "object"
        ) {
          return item as Posting
        }

        return {
          id: -1
        }
      }).filter(
        posting =>
          Number.isFinite(posting.id)
      )
    }
  }

  return []
}

function getPostingId(
  posting: Posting
): number {
  return getNumber(
    posting as JsonObject,
    ["id", "doc_id", "docId", "document_id"],
    -1
  )
}

function getPostingTf(
  posting: Posting
): number {
  return getNumber(
    posting as JsonObject,
    ["tf", "term_frequency", "termFrequency"],
    1
  )
}

function getPostingTitleTf(
  posting: Posting
): number {
  return getNumber(
    posting as JsonObject,
    ["title_tf", "titleTf"],
    0
  )
}

function getDictionaryDf(
  entry: DictionaryEntry
): number {
  return getNumber(
    entry as JsonObject,
    ["df", "document_frequency", "documentFrequency"],
    0
  )
}

function getDictionaryIdf(
  entry: DictionaryEntry
): number {
  return getNumber(
    entry as JsonObject,
    ["idf"],
    0
  )
}

async function loadTermEntries(
  env: Env,
  manifest: Manifest,
  terms: string[],
  signal?: AbortSignal
): Promise<Map<string, DictionaryEntry>> {
  const shardPaths = extractShardList(
    manifest.term_shards
  )

  const output = new Map<string, DictionaryEntry>()

  if (!shardPaths.length || !terms.length) {
    return output
  }

  const wanted = new Set(terms)

  const texts = await mapConcurrent(
    shardPaths,
    CONFIG.termShardConcurrency,
    async path => {
      try {
        return await fetchShard(
          env,
          path,
          signal
        )
      } catch {
        return ""
      }
    }
  )

  for (const text of texts) {
    if (!text) {
      continue
    }

    let parsed: DictionaryEntry[] = []

    try {
      parsed = normalizeDictionary(
        parseJsonOrJsonl<DictionaryEntry>(text)
      )
    } catch {
      continue
    }

    for (const entry of parsed) {
      const term = getDictionaryTerm(entry)

      if (wanted.has(term)) {
        output.set(term, entry)
      }
    }
  }

  return output
}

function documentFromUnknown(
  value: unknown
): Document | null {
  if (!value || typeof value !== "object") {
    return null
  }

  const object = value as JsonObject

  const id = getNumber(
    object,
    ["id", "doc_id", "docId", "document_id"],
    -1
  )

  if (!Number.isFinite(id) || id < 0) {
    return null
  }

  const url = getString(
    object,
    ["url", "link", "href"]
  )

  if (!url) {
    return null
  }

  return {
    ...object,
    id,
    url,
    title: getString(object, [
      "title",
      "name"
    ]),
    description: getString(object, [
      "description",
      "desc",
      "snippet"
    ]),
    text: getString(object, [
      "text",
      "content",
      "body"
    ])
  }
}

function extractDocuments(
  value: unknown
): Document[] {
  if (!value) {
    return []
  }

  if (Array.isArray(value)) {
    return value
      .map(documentFromUnknown)
      .filter(
        (document): document is Document =>
          document !== null
      )
  }

  if (typeof value === "object") {
    const object = value as JsonObject

    for (const key of [
      "documents",
      "docs",
      "items",
      "data"
    ]) {
      if (object[key]) {
        const documents = extractDocuments(
          object[key]
        )

        if (documents.length) {
          return documents
        }
      }
    }

    const document = documentFromUnknown(
      object
    )

    return document ? [document] : []
  }

  return []
}

function documentShardIndex(
  id: number
): number {
  return Math.floor(id / 250)
}

function resolveDocumentShardPath(
  manifest: Manifest,
  shardIndex: number
): string | null {
  const shards = extractShardList(
    manifest.docs_shards
  )

  if (!shards.length) {
    return null
  }

  if (
    shardIndex >= 0 &&
    shardIndex < shards.length
  ) {
    return shards[shardIndex]
  }

  const candidates = [
    String(shardIndex),
    `${shardIndex}.json.gz`,
    `docs_${shardIndex}.json.gz`,
    `docs-${shardIndex}.json.gz`,
    `shard_${shardIndex}.json.gz`,
    `shard-${shardIndex}.json.gz`
  ]

  for (const candidate of candidates) {
    const match = shards.find(
      path =>
        path === candidate ||
        path.endsWith(`/${candidate}`)
    )

    if (match) {
      return match
    }
  }

  return null
}

async function loadDocuments(
  env: Env,
  manifest: Manifest,
  ids: number[],
  signal?: AbortSignal
): Promise<Map<number, Document>> {
  const output = new Map<number, Document>()

  if (!ids.length) {
    return output
  }

  const shardIds = unique(
    ids.map(documentShardIndex)
  )

  const shardPaths = shardIds
    .map(index => ({
      index,
      path: resolveDocumentShardPath(
        manifest,
        index
      )
    }))
    .filter(
      item => Boolean(item.path)
    ) as {
      index: number
      path: string
    }[]

  const texts = await mapConcurrent(
    shardPaths,
    CONFIG.documentShardConcurrency,
    async item => {
      try {
        return {
          index: item.index,
          text: await fetchShard(
            env,
            item.path,
            signal
          )
        }
      } catch {
        return {
          index: item.index,
          text: ""
        }
      }
    }
  )

  const wanted = new Set(ids)

  for (const shard of texts) {
    if (!shard.text) {
      continue
    }

    let parsed: unknown

    try {
      parsed = parseJsonOrJsonl<unknown>(
        shard.text
      )
    } catch {
      continue
    }

    for (const document of extractDocuments(
      parsed
    )) {
      if (wanted.has(document.id)) {
        output.set(document.id, document)
      }
    }
  }

  return output
}

function scoreDocument(
  document: Document,
  query: string,
  queryTerms: string[],
  entries: Map<string, DictionaryEntry>,
  postingMap: Map<number, Map<string, Posting>>
): number {
  const title = (
    document.title || ""
  ).toLowerCase()

  const description = (
    document.description || ""
  ).toLowerCase()

  const text = (
    document.text || ""
  ).toLowerCase()

  const url = document.url.toLowerCase()

  let score = 0

  for (const term of queryTerms) {
    if (title.includes(term)) {
      score += 25
    }

    if (description.includes(term)) {
      score += 8
    }

    if (text.includes(term)) {
      score += 3
    }

    if (url.includes(term)) {
      score += 5
    }

    const posting = postingMap
      .get(document.id)
      ?.get(term)

    if (posting) {
      score += getPostingTf(posting) * 2
      score += getPostingTitleTf(posting) * 8
    }

    const entry = entries.get(term)

    if (entry) {
      const idf = getDictionaryIdf(entry)

      if (idf > 0) {
        score += idf
      }
    }
  }

  if (
    query &&
    title.includes(query.toLowerCase())
  ) {
    score += 25
  }

  const textLength = text.length

  score += Math.min(
    5,
    textLength / 2000
  )

  return score
}

function normalizeUrl(
  value: unknown
): string {
  if (typeof value !== "string") {
    return ""
  }

  try {
    const url = new URL(value)

    url.hash = ""

    let normalized = url.toString()

    if (normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1)
    }

    return normalized.toLowerCase()
  } catch {
    return value
      .trim()
      .replace(/#.*$/, "")
      .replace(/\/+$/, "")
      .toLowerCase()
  }
}

function normalizeMedia(
  data: unknown
): MediaItem[] {
  if (Array.isArray(data)) {
    return data.filter(
      item =>
        item !== null &&
        typeof item === "object"
    ) as MediaItem[]
  }

  if (!data || typeof data !== "object") {
    return []
  }

  const object = data as JsonObject

  for (const key of [
    "items",
    "media",
    "images",
    "videos"
  ]) {
    const value = object[key]

    if (Array.isArray(value)) {
      return value.filter(
        item =>
          item !== null &&
          typeof item === "object"
      ) as MediaItem[]
    }
  }

  return []
}

function getMediaPageUrl(
  item: MediaItem
): string {
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
    const value = item[key]

    if (typeof value === "string") {
      return value
    }
  }

  return ""
}

function mediaMatchesDocument(
  item: MediaItem,
  documentUrl: string
): boolean {
  const normalizedDocument =
    normalizeUrl(documentUrl)

  const mediaPage =
    normalizeUrl(
      getMediaPageUrl(item)
    )

  if (
    mediaPage &&
    mediaPage === normalizedDocument
  ) {
    return true
  }

  const mediaUrl =
    normalizeUrl(item.url)

  if (
    mediaUrl &&
    mediaUrl === normalizedDocument
  ) {
    return true
  }

  return false
}

function compactMedia(
  item: MediaItem
): MediaItem {
  return {
    ...(item.url !== undefined
      ? { url: item.url }
      : {}),
    ...(item.path !== undefined
      ? { path: item.path }
      : {}),
    ...(item.title !== undefined
      ? { title: item.title }
      : {}),
    ...(item.alt !== undefined
      ? { alt: item.alt }
      : {}),
    ...(item.type !== undefined
      ? { type: item.type }
      : {}),
    ...(item.mime_type !== undefined
      ? { mime_type: item.mime_type }
      : {}),
    ...(item.thumbnail !== undefined
      ? { thumbnail: item.thumbnail }
      : {}),
    ...(item.thumbnail_path !== undefined
      ? { thumbnail_path: item.thumbnail_path }
      : {})
  }
}

async function loadMediaManifest(
  env: Env,
  path: string,
  signal?: AbortSignal
): Promise<MediaItem[]> {
  try {
    const text = await fetchShard(
      env,
      path,
      signal
    )

    const parsed =
      parseJsonOrJsonl<MediaItem>(text)

    return normalizeMedia(parsed)
  } catch {
    return []
  }
}

async function attachMedia(
  env: Env,
  manifest: Manifest,
  results: SearchResult[],
  signal?: AbortSignal
): Promise<void> {
  const imagePaths =
    extractShardList(
      manifest.images
    )

  const videoPaths =
    extractShardList(
      manifest.videos
    )

  if (
    !imagePaths.length &&
    !videoPaths.length
  ) {
    return
  }

  const [imageResults, videoResults] =
    await Promise.all([
      Promise.all(
        imagePaths.map(path =>
          loadMediaManifest(
            env,
            path,
            signal
          )
        )
      ),
      Promise.all(
        videoPaths.map(path =>
          loadMediaManifest(
            env,
            path,
            signal
          )
        )
      )
    ])

  const allImages =
    imageResults.flat()

  const allVideos =
    videoResults.flat()

  const imageSigningPaths: string[] = []

  for (const result of results) {
    const matchedImages =
      allImages
        .filter(item =>
          mediaMatchesDocument(
            item,
            result.url
          )
        )
        .slice(
          0,
          CONFIG.maxImagesPerResult
        )
        .map(compactMedia)

    const matchedVideos =
      allVideos
        .filter(item =>
          mediaMatchesDocument(
            item,
            result.url
          )
        )
        .slice(
          0,
          CONFIG.maxVideosPerResult
        )
        .map(compactMedia)

    result.images = matchedImages
    result.videos = matchedVideos

    for (const image of matchedImages) {
      if (image.path) {
        imageSigningPaths.push(
          image.path
        )
      }
    }
  }

  const uniqueImagePaths =
    unique(imageSigningPaths)
      .slice(
        0,
        CONFIG.maxImageSignedUrls
      )

  const signedImageEntries =
    await Promise.all(
      uniqueImagePaths.map(
        async path => [
          path,
          await createSignedUrl(
            env,
            "images",
            path,
            CONFIG.signedUrlExpires,
            signal
          )
        ] as const
      )
    )

  const signedImages =
    new Map(
      signedImageEntries
        .filter(
          ([, value]) =>
            Boolean(value)
        ) as [
          string,
          string
        ][]
    )

  const videoThumbnailPaths =
    unique(
      results.flatMap(
        result =>
          result.videos
            .map(
              video =>
                video.thumbnail_path
            )
            .filter(
              (
                path
              ): path is string =>
                Boolean(path)
            )
      )
    )

  const signedVideoEntries =
    await Promise.all(
      videoThumbnailPaths.map(
        async path => [
          path,
          await createSignedUrl(
            env,
            "videos",
            path,
            CONFIG.signedUrlExpires,
            signal
          )
        ] as const
      )
    )

  const signedVideos =
    new Map(
      signedVideoEntries
        .filter(
          ([, value]) =>
            Boolean(value)
        ) as [
          string,
          string
        ][]
    )

  for (const result of results) {
    for (const image of result.images) {
      if (
        image.path &&
        signedImages.has(image.path)
      ) {
        image.url =
          signedImages.get(
            image.path
          )!
      }
    }

    for (const video of result.videos) {
      if (
        video.thumbnail_path &&
        signedVideos.has(
          video.thumbnail_path
        )
      ) {
        video.thumbnail =
          signedVideos.get(
            video.thumbnail_path
          )!
      }
    }
  }
}

function sortResults(
  results: SearchResult[]
): SearchResult[] {
  return results.sort(
    (a, b) =>
      b.score - a.score
  )
}

async function search(
  env: Env,
  query: string,
  signal?: AbortSignal
): Promise<SearchResult[]> {
  const normalizedQuery =
    query.trim().toLowerCase()

  if (!normalizedQuery) {
    return []
  }

  const queryTerms =
    unique(
      tokenize(normalizedQuery)
    )

  if (!queryTerms.length) {
    return []
  }

  const release =
    await loadCurrentRelease(
      env,
      signal
    )

  const manifest =
    await loadManifest(
      env,
      release,
      signal
    )

  const dictionary =
    await loadTermEntries(
      env,
      manifest,
      queryTerms,
      signal
    )

  const postingMap =
    new Map<
      number,
      Map<string, Posting>
    >()

  const candidateIds =
    new Set<number>()

  for (const term of queryTerms) {
    const entry =
      dictionary.get(term)

    if (!entry) {
      continue
    }

    const postings =
      getPostings(entry)

    for (const posting of postings) {
      const id =
        getPostingId(posting)

      if (
        id < 0 ||
        !Number.isFinite(id)
      ) {
        continue
      }

      if (
        !postingMap.has(id)
      ) {
        postingMap.set(
          id,
          new Map()
        )
      }

      postingMap
        .get(id)!
        .set(
          term,
          posting
        )

      if (
        candidateIds.size <
        CONFIG.maxDocumentIds
      ) {
        candidateIds.add(id)
      }
    }
  }

  if (!candidateIds.size) {
    return []
  }

  const documents =
    await loadDocuments(
      env,
      manifest,
      [...candidateIds],
      signal
    )

  const results: SearchResult[] = []

  for (const id of candidateIds) {
    const document =
      documents.get(id)

    if (!document) {
      continue
    }

    const score =
      scoreDocument(
        document,
        normalizedQuery,
        queryTerms,
        dictionary,
        postingMap
      )

    results.push({
      id: document.id,
      url: document.url,
      title:
        document.title || "",
      description:
        document.description || "",
      score,
      images: [],
      videos: []
    })
  }

  sortResults(results)

  const limitedResults =
    results.slice(
      0,
      CONFIG.maxSearchResults
    )

  await attachMedia(
    env,
    manifest,
    limitedResults,
    signal
  )

  return limitedResults
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
        "Content-Type":
          "application/json; charset=utf-8",
        "Cache-Control":
          "no-store"
      }
    }
  )
}

async function handleSearch(
  request: Request,
  env: Env,
  deadline: number,
  signal?: AbortSignal
): Promise<Response> {
  const url =
    new URL(request.url)

  const query =
    url.searchParams.get("q") ||
    url.searchParams.get("query") ||
    ""

  if (!query.trim()) {
    return jsonResponse(
      {
        query: "",
        dictionary: null,
        results: []
      },
      400
    )
  }

  if (
    Date.now() >= deadline
  ) {
    return jsonResponse(
      {
        error: "Request timeout"
      },
      504
    )
  }

  try {
    const results =
      await search(
        env,
        query,
        signal
      )

    return jsonResponse({
      query,
      dictionary: null,
      results
    })
  } catch (error) {
    console.error(
      "Search error:",
      error
    )

    return jsonResponse(
      {
        error:
          error instanceof Error
            ? error.message
            : "Search failed"
      },
      500
    )
  }
}

async function handleHttpRequest(
  request: http.IncomingMessage
): Promise<Request> {
  const protocol =
    (
      request.headers["x-forwarded-proto"] ||
      "http"
    )
      .toString()
      .split(",")[0]
      .trim()

  const host =
    (
      request.headers.host ||
      "localhost"
    )
      .toString()

  const url =
    `${protocol}://${host}${request.url || "/"}`

  const headers =
    new Headers()

  for (
    const [key, value]
    of Object.entries(
      request.headers
    )
  ) {
    if (Array.isArray(value)) {
      for (const item of value) {
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

  let body:
    | Uint8Array
    | undefined

  if (
    request.method !== "GET" &&
    request.method !== "HEAD" &&
    request.method !== "OPTIONS"
  ) {
    const chunks: Buffer[] = []

    for await (
      const chunk of request
    ) {
      chunks.push(
        Buffer.from(chunk)
      )
    }

    body =
      Buffer.concat(chunks)
  }

  return new Request(
    url,
    {
      method:
        request.method || "GET",
      headers,
      body:
        body
          ? new Uint8Array(body)
          : undefined
    }
  )
}

async function sendNodeResponse(
  nodeResponse: http.ServerResponse,
  response: Response
): Promise<void> {
  nodeResponse.statusCode =
    response.status

  response.headers.forEach(
    (value, key) => {
      nodeResponse.setHeader(
        key,
        value
      )
    }
  )

  const body =
    await response.arrayBuffer()

  nodeResponse.end(
    Buffer.from(body)
  )
}

async function main(): Promise<void> {
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

        const controller =
          new AbortController()

        const timeout =
          setTimeout(
            () => {
              controller.abort()
            },
            CONFIG.requestTimeoutMs
          )

        try {
          const webRequest =
            await handleHttpRequest(
              nodeRequest
            )

          const method =
            webRequest.method
              .toUpperCase()

          if (
            method === "OPTIONS"
          ) {
            const response =
              new Response(
                null,
                {
                  status: 204,
                  headers: {
                    "Access-Control-Allow-Origin":
                      "*",
                    "Access-Control-Allow-Methods":
                      "GET,OPTIONS",
                    "Access-Control-Allow-Headers":
                      "Content-Type"
                  }
                }
              )

            await sendNodeResponse(
              nodeResponse,
              response
            )

            return
          }

          const url =
            new URL(
              webRequest.url
            )

          if (
            method === "GET" &&
            url.pathname ===
              "/health"
          ) {
            const response =
              jsonResponse({
                status: "ok",
                service: "see-api",
                uptime:
                  process.uptime()
              })

            response.headers.set(
              "Access-Control-Allow-Origin",
              "*"
            )

            await sendNodeResponse(
              nodeResponse,
              response
            )

            return
          }

          if (
            method === "GET" &&
            url.pathname ===
              "/search"
          ) {
            const deadline =
              Date.now() +
              CONFIG.requestTimeoutMs

            const response =
              await handleSearch(
                webRequest,
                env,
                deadline,
                controller.signal
              )

            response.headers.set(
              "Access-Control-Allow-Origin",
              "*"
            )

            await sendNodeResponse(
              nodeResponse,
              response
            )

            console.log(
              `${nodeRequest.method} ${url.pathname}${url.search} ` +
              `${response.status} ` +
              `${Date.now() - started}ms`
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

          response.headers.set(
            "Access-Control-Allow-Origin",
            "*"
          )

          await sendNodeResponse(
            nodeResponse,
            response
          )
        } catch (error) {
          console.error(
            "Request error:",
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

            response.headers.set(
              "Access-Control-Allow-Origin",
              "*"
            )

            await sendNodeResponse(
              nodeResponse,
              response
            )
          } else {
            nodeResponse.end()
          }
        } finally {
          clearTimeout(timeout)
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
        `SEErch² API listening on port ${port}`
      )
    }
  )
}

main().catch(error => {
  console.error(
    "Fatal startup error:",
    error
  )

  process.exit(1)
})
