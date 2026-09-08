import path from 'node:path'
import { Gunzip, Unzip, UnzipInflate } from 'fflate'

const CHAR_CAP = 400_000
const ARCHIVE_ENTRY_CAP = 64
const ARCHIVE_EXPANDED_CAP = 8 * 1024 * 1024
const ARCHIVE_MIN_EXPANDED_CAP = 1024 * 1024
const ARCHIVE_MAX_EXPANSION_RATIO = 200
const ARCHIVE_INPUT_CHUNK = 256

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.ndjson',
  '.xml', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.log',
  '.html', '.htm', '.css', '.js', '.jsx', '.ts', '.tsx', '.py', '.rb',
  '.go', '.rs', '.java', '.c', '.h', '.cpp', '.hpp', '.sh', '.sql',
  '.srt', '.vtt', '.ass', '.ssa', '.svg',
])

const OFFICE_TYPE: Record<string, string> = {
  '.docm': 'docx', '.dotm': 'docx',
  '.pptm': 'pptx', '.potm': 'pptx', '.ppsm': 'pptx',
  '.xlsm': 'xlsx', '.xltm': 'xlsx',
}

export function extensionMime(name: string): string {
  const ext = path.extname(name).toLowerCase()
  if (TEXT_EXTENSIONS.has(ext)) {
    if (ext === '.svg') return 'image/svg+xml'
    if (ext === '.json' || ext === '.jsonl' || ext === '.ndjson' || ext === '.ipynb') return 'application/json'
    return 'text/plain'
  }
  return ({
    '.ipynb': 'application/x-ipynb+json',
    '.eml': 'message/rfc822', '.msg': 'application/vnd.ms-outlook',
    '.epub': 'application/epub+zip',
    '.pages': 'application/vnd.apple.pages',
    '.numbers': 'application/vnd.apple.numbers',
    '.key': 'application/vnd.apple.keynote',
    '.docm': 'application/vnd.ms-word.document.macroenabled.12',
    '.dotm': 'application/vnd.ms-word.template.macroenabled.12',
    '.pptm': 'application/vnd.ms-powerpoint.presentation.macroenabled.12',
    '.potm': 'application/vnd.ms-powerpoint.template.macroenabled.12',
    '.ppsm': 'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
    '.xlsm': 'application/vnd.ms-excel.sheet.macroenabled.12',
    '.xltm': 'application/vnd.ms-excel.template.macroenabled.12',
    '.xlsb': 'application/vnd.ms-excel.sheet.binary.macroenabled.12',
    '.zip': 'application/zip', '.tar': 'application/x-tar',
    '.tgz': 'application/gzip', '.gz': 'application/gzip',
    '.7z': 'application/x-7z-compressed',
  } as Record<string, string>)[ext] ?? ''
}

export function officeParserType(name: string): string | undefined {
  return OFFICE_TYPE[path.extname(name).toLowerCase()]
}

export function isLocallyExtractable(name: string, mime: string): boolean {
  const ext = path.extname(name).toLowerCase()
  return TEXT_EXTENSIONS.has(ext) || [
    '.ipynb', '.eml', '.msg', '.pages', '.numbers', '.key', '.xlsb', '.zip', '.tar',
    '.tgz', '.gz', '.7z',
  ].includes(ext) || [
    'message/rfc822', 'application/vnd.ms-outlook', 'application/x-ipynb+json',
    'image/svg+xml', 'application/zip', 'application/x-tar', 'application/gzip',
  ].includes(mime)
}

// This parser intentionally stays synchronous and is only called inside the
// bounded attachment worker. Keeping the untrusted decompression off the main
// event loop means a malformed archive cannot stall Discord heartbeats.
export function extractLocalTextUnsafe(buffer: Buffer, name: string): string {
  const ext = path.extname(name).toLowerCase()
  if (ext === '.ipynb') return extractNotebook(buffer)
  if (ext === '.eml') return extractEml(buffer)
  if (ext === '.msg' || ext === '.xlsb') return printableStrings(buffer)
  if (ext === '.pages' || ext === '.numbers' || ext === '.key') return extractZipText(buffer, name, true)
  if (ext === '.zip') return extractZipText(buffer, name, false)
  if (ext === '.gz' || ext === '.tgz') {
    const inflated = gunzipBounded(buffer)
    return ext === '.tgz' || name.toLowerCase().endsWith('.tar.gz') ? printableStrings(inflated) : decodeText(inflated)
  }
  if (ext === '.tar' || ext === '.7z') return printableStrings(buffer)
  return decodeText(buffer)
}

function extractNotebook(buffer: Buffer): string {
  const notebook = JSON.parse(buffer.toString('utf8')) as {
    cells?: Array<{ cell_type?: string, source?: string[] | string, outputs?: Array<Record<string, unknown>> }>
  }
  return (notebook.cells ?? []).map((cell, index) => {
    const source = Array.isArray(cell.source) ? cell.source.join('') : (cell.source ?? '')
    const outputs = (cell.outputs ?? []).flatMap(output => {
      const text = output.text
      if (Array.isArray(text)) return text.join('')
      if (typeof text === 'string') return text
      const data = output.data as Record<string, unknown> | undefined
      const plain = data?.['text/plain']
      return Array.isArray(plain) ? plain.join('') : (typeof plain === 'string' ? plain : '')
    }).filter(Boolean).join('\n')
    return `[cell ${index + 1}: ${cell.cell_type ?? 'unknown'}]\n${source}${outputs ? `\n[output]\n${outputs}` : ''}`
  }).join('\n\n').slice(0, CHAR_CAP)
}

function extractEml(buffer: Buffer): string {
  const raw = buffer.toString('utf8').replace(/\r\n/g, '\n')
  const [headerBlock, ...bodyParts] = raw.split('\n\n')
  const headers = headerBlock.replace(/\n[ \t]+/g, ' ')
    .split('\n')
    .filter(line => /^(from|to|cc|date|subject):/i.test(line))
    .join('\n')
  return `${headers}\n\n${bodyParts.join('\n\n')}`.slice(0, CHAR_CAP)
}

function extractZipText(buffer: Buffer, archiveName: string, includeBinaryStrings: boolean): string {
  const blocks: string[] = []
  let expanded = 0
  let entries = 0
  let failure: Error | undefined
  const expandedCap = archiveExpandedCap(buffer.length)
  const unzip = new Unzip(file => {
    entries += 1
    const ext = path.extname(file.name).toLowerCase()
    const selected = !file.name.endsWith('/') && (
      TEXT_EXTENSIONS.has(ext)
      || ['.json', '.xml', '.html', '.txt'].includes(ext)
      || (includeBinaryStrings && ext === '.iwa')
    )
    if (entries > ARCHIVE_ENTRY_CAP) failure ??= new Error('archive entry cap exceeded')
    if ((file.originalSize ?? 0) + expanded > expandedCap) {
      failure ??= new Error('archive expanded size cap exceeded')
    }
    if (!selected || failure) {
      file.ondata = () => {}
      return
    }

    const chunks: Buffer[] = []
    let entryBytes = 0
    file.ondata = (error, chunk, final) => {
      if (failure) return
      if (error) {
        failure = error
        return
      }
      entryBytes += chunk.byteLength
      expanded += chunk.byteLength
      if (expanded > expandedCap) {
        failure = new Error('archive expanded size cap exceeded')
        file.terminate()
        return
      }
      chunks.push(Buffer.from(chunk))
      if (!final) return
      try {
        const bytes = Buffer.concat(chunks, entryBytes)
        const text = includeBinaryStrings && ext === '.iwa'
          ? printableStrings(bytes)
          : decodeText(bytes)
        if (text) blocks.push(`[${file.name}]\n${text}`)
      } catch (error) {
        failure = error as Error
      }
    }
    try {
      file.start()
    } catch (error) {
      failure = error as Error
    }
  })
  unzip.register(UnzipInflate)
  for (let offset = 0; offset < buffer.length; offset += ARCHIVE_INPUT_CHUNK) {
    const end = Math.min(offset + ARCHIVE_INPUT_CHUNK, buffer.length)
    unzip.push(buffer.subarray(offset, end), end === buffer.length)
    if (failure) throw failure
  }
  if (failure) throw failure
  if (!blocks.length) throw new Error(`${archiveName} contained no extractable text`)
  return blocks.join('\n\n').slice(0, CHAR_CAP)
}

function gunzipBounded(buffer: Buffer): Buffer {
  const chunks: Buffer[] = []
  let expanded = 0
  let failure: Error | undefined
  const expandedCap = archiveExpandedCap(buffer.length)
  const gunzip = new Gunzip((chunk) => {
    if (failure) return
    expanded += chunk.byteLength
    if (expanded > expandedCap) {
      failure = new Error('archive expanded size cap exceeded')
      return
    }
    chunks.push(Buffer.from(chunk))
  })
  for (let offset = 0; offset < buffer.length; offset += ARCHIVE_INPUT_CHUNK) {
    const end = Math.min(offset + ARCHIVE_INPUT_CHUNK, buffer.length)
    gunzip.push(buffer.subarray(offset, end), end === buffer.length)
    if (failure) throw failure
  }
  if (failure) throw failure
  return Buffer.concat(chunks, expanded)
}

function archiveExpandedCap(compressedBytes: number): number {
  return Math.min(
    ARCHIVE_EXPANDED_CAP,
    Math.max(ARCHIVE_MIN_EXPANDED_CAP, compressedBytes * ARCHIVE_MAX_EXPANSION_RATIO),
  )
}

function decodeText(buffer: Buffer): string {
  if (buffer.includes(0)) throw new Error('binary data')
  return buffer.toString('utf8').slice(0, CHAR_CAP)
}

function printableStrings(buffer: Buffer): string {
  return (buffer.toString('latin1').match(/[ -~\t]{4,}/g) ?? [])
    .map(value => value.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, CHAR_CAP)
}
