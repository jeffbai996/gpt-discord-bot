import { Worker } from 'node:worker_threads'

const ATTACHMENT_PARSE_TIMEOUT_MS = 5_000
const DOCUMENT_TEXT_CHAR_CAP = 400_000

interface AttachmentWorkerResult {
  ok: boolean
  text?: string
  error?: string
}

export function extractLocalText(buffer: Buffer, name: string): Promise<string> {
  return runAttachmentWorker({ mode: 'local', bytes: buffer, name })
}

export function extractOfficeText(buffer: Buffer, name: string, fileType: string): Promise<string> {
  return runAttachmentWorker({ mode: 'office', bytes: buffer, name, fileType })
}

function runAttachmentWorker(workerData: {
  mode: 'local' | 'office'
  bytes: Buffer
  name: string
  fileType?: string
}): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./attachment-worker-bootstrap.mjs', import.meta.url), {
      workerData,
      execArgv: ['--import', 'tsx'],
      resourceLimits: {
        maxOldGenerationSizeMb: 96,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 2,
      },
    })
    let settled = false
    const finish = (error?: Error, text?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      if (error) reject(error)
      else resolve(text ?? '')
    }
    const timer = setTimeout(() => {
      finish(new Error(`attachment parse exceeded ${ATTACHMENT_PARSE_TIMEOUT_MS}ms`))
    }, ATTACHMENT_PARSE_TIMEOUT_MS)
    timer.unref()

    worker.once('message', (result: AttachmentWorkerResult) => {
      if (!result.ok) {
        finish(new Error(result.error ?? 'attachment parse failed'))
        return
      }
      if (typeof result.text !== 'string' || result.text.length > DOCUMENT_TEXT_CHAR_CAP) {
        finish(new Error('attachment parser returned an invalid result'))
        return
      }
      finish(undefined, result.text)
    })
    worker.once('error', error => finish(error))
    worker.once('exit', code => {
      if (code !== 0) finish(new Error(`attachment parser exited with code ${code}`))
    })
  })
}
