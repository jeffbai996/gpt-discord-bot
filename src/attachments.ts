import OpenAI, { toFile } from 'openai'
import type { Attachment as DiscordAttachment } from 'discord.js'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

// 20 MB default cap. Discord's per-attachment max is 25/100/500MB depending
// on guild boost tier; the smaller cap protects against "user dropped a 4-hour
// video, please summarize it" failure modes.
const MAX_BYTES = 20 * 1024 * 1024

// gpt-4o family + gpt-5.x accept these as `image_url` content parts (data: URIs
// or fetchable URLs). Anything else gets surfaced as a text placeholder so the
// model knows the user attached something but we couldn't ingest it.
const IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/webp', 'image/gif'
])

// Whisper / gpt-4o-transcribe input — we transcribe audio to text and inject
// the transcript inline. Saves us the hassle of wiring the realtime audio API.
const AUDIO_MIMES = new Set([
  'audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/wav', 'audio/x-wav',
  'audio/webm', 'audio/ogg', 'audio/flac', 'audio/x-flac', 'audio/m4a'
])

// Text/document mimes we extract inline. PDFs would need OCR or the Responses
// API path — for now we surface them as a placeholder rather than silently
// drop. Plain text we cap at 100KB to avoid blowing up the prompt.
const TEXT_MIMES = new Set([
  'text/plain', 'text/markdown', 'text/csv', 'text/html', 'text/xml',
  'application/json', 'text/javascript', 'application/javascript',
  'text/typescript', 'text/x-typescript'
])
const TEXT_INLINE_BYTE_CAP = 100 * 1024

const EXTENSION_MIMES: Record<string, string> = {
  '.gif': 'image/gif', '.jpeg': 'image/jpeg', '.jpg': 'image/jpeg',
  '.png': 'image/png', '.webp': 'image/webp',
  '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg',
  '.mp4': 'audio/mp4', '.oga': 'audio/ogg', '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg', '.wav': 'audio/wav', '.webm': 'audio/webm',
}

function resolvedMime(contentType: string | null, name: string): string {
  const declared = (contentType ?? '').split(';')[0].trim().toLowerCase()
  // Discord occasionally labels voice messages as generic binary data. In
  // that case the filename extension is more informative than the declaration.
  if (declared && declared !== 'application/octet-stream') return declared
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? (EXTENSION_MIMES[name.slice(dot).toLowerCase()] ?? '') : ''
}

type SkipReason =
  | 'too_large'
  | 'unsupported_type'
  | 'download_failed'
  | 'transcription_failed'

interface SkippedAttachment {
  name: string
  reason: SkipReason
}

export interface ProcessedAttachments {
  // Content parts ready to splice into a `user` message. Text-only context
  // (transcripts, file extracts, skipped notes) end up in `text`; image parts
  // go in `parts` for the vision-capable models.
  text: string
  imageParts: OpenAI.Chat.Completions.ChatCompletionContentPartImage[]
  imagePaths: string[]
  skipped: SkippedAttachment[]
}

const EMPTY: ProcessedAttachments = { text: '', imageParts: [], imagePaths: [], skipped: [] }

export async function processAttachments(
  attachments: DiscordAttachment[],
  client: OpenAI,
  transcribeModel: string = 'whisper-1'
): Promise<ProcessedAttachments> {
  if (attachments.length === 0) return EMPTY

  const result: ProcessedAttachments = { text: '', imageParts: [], imagePaths: [], skipped: [] }
  const textBlocks: string[] = []
  let imageDir: string | undefined

  for (const att of attachments) {
    const name = att.name ?? '(unnamed)'
    const mime = resolvedMime(att.contentType, name)

    if (att.size > MAX_BYTES) {
      result.skipped.push({ name, reason: 'too_large' })
      continue
    }

    if (IMAGE_MIMES.has(mime)) {
      try {
        // Discord attachment URLs are signed and can expire or be rejected by
        // OpenAI's fetcher. Download while Discord's URL is fresh and send the
        // bytes as a data URI so vision input is deterministic.
        const buf = await downloadToBuffer(att.url, MAX_BYTES)
        imageDir ??= await mkdtemp(path.join(tmpdir(), 'gpt-discord-images-'))
        const ext = path.extname(name).toLowerCase() || mimeExtension(mime)
        const imagePath = path.join(imageDir, `${result.imagePaths.length}${ext}`)
        await writeFile(imagePath, buf, { mode: 0o600 })
        result.imageParts.push({
          type: 'image_url',
          image_url: { url: `data:${mime};base64,${buf.toString('base64')}` }
        })
        result.imagePaths.push(imagePath)
      } catch (e) {
        console.error('image fetch failed for', name, e)
        result.skipped.push({ name, reason: 'download_failed' })
      }
      continue
    }

    if (AUDIO_MIMES.has(mime)) {
      try {
        const buf = await downloadToBuffer(att.url, MAX_BYTES)
        // Node 22 does not provide a global File constructor on this host.
        // The SDK helper creates its Node-safe FileLike upload instead.
        const file = await toFile(buf, name, { type: mime })
        const transcription = await client.audio.transcriptions.create({
          model: transcribeModel,
          file
        })
        textBlocks.push(`[transcribed audio: ${name}]\n${transcription.text}`)
      } catch (e) {
        console.error('transcription failed for', name, e)
        result.skipped.push({ name, reason: 'transcription_failed' })
      }
      continue
    }

    if (TEXT_MIMES.has(mime) || mime.startsWith('text/')) {
      try {
        const buf = await downloadToBuffer(att.url, TEXT_INLINE_BYTE_CAP)
        const text = buf.toString('utf8')
        textBlocks.push(`[attached file: ${name}]\n\`\`\`\n${text}\n\`\`\``)
      } catch (e) {
        console.error('text fetch failed for', name, e)
        result.skipped.push({ name, reason: 'download_failed' })
      }
      continue
    }

    // PDF, video, archive, anything else — surface as a stub so the model
    // knows there's an attachment it can ask about, but we don't pretend to
    // have ingested it.
    result.skipped.push({ name, reason: 'unsupported_type' })
  }

  if (result.skipped.length > 0) {
    const lines = result.skipped.map(s => `- ${s.name} (${s.reason})`)
    textBlocks.push(`[attachments not ingested]\n${lines.join('\n')}`)
  }

  result.text = textBlocks.join('\n\n')
  return result
}

export async function cleanupAttachmentFiles(imagePaths: string[]): Promise<void> {
  const dirs = new Set(imagePaths.map(p => path.dirname(p)))
  await Promise.all([...dirs].map(dir => rm(dir, { recursive: true, force: true })))
}

function mimeExtension(mime: string): string {
  if (mime === 'image/jpeg') return '.jpg'
  if (mime === 'image/webp') return '.webp'
  if (mime === 'image/gif') return '.gif'
  return '.png'
}

async function downloadToBuffer(url: string, maxBytes: number): Promise<Buffer> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`fetch ${resp.status} ${resp.statusText}`)
  const ab = await resp.arrayBuffer()
  if (ab.byteLength > maxBytes) {
    throw new Error(`exceeds ${maxBytes} byte cap (${ab.byteLength})`)
  }
  return Buffer.from(ab)
}
