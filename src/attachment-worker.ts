import { parentPort, workerData } from 'node:worker_threads'
import { parseOffice } from 'officeparser'
import { extractLocalTextUnsafe } from './attachment-text.ts'

const DOCUMENT_TEXT_CHAR_CAP = 400_000

interface AttachmentWorkerInput {
  mode: 'local' | 'office'
  bytes: Uint8Array
  name: string
  fileType?: string
}

interface AttachmentWorkerResult {
  ok: boolean
  text?: string
  error?: string
}

async function run(input: AttachmentWorkerInput): Promise<string> {
  const buffer = Buffer.from(input.bytes)
  if (input.mode === 'local') return extractLocalTextUnsafe(buffer, input.name)

  const ast = await parseOffice(buffer, { fileType: input.fileType as any })
  const text = ast.toText().trim().slice(0, DOCUMENT_TEXT_CHAR_CAP)
  if (!text) throw new Error('document contained no extractable text')
  return text
}

void run(workerData as AttachmentWorkerInput).then(
  text => parentPort?.postMessage({ ok: true, text } satisfies AttachmentWorkerResult),
  error => parentPort?.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  } satisfies AttachmentWorkerResult),
)
