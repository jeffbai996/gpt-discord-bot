export interface ImageOptions {
  prompt: string
  model?: string
  size?: string
  quality?: string
}

/** Direct Images API: no automatic retries of potentially billable generation. */
export async function generateImage(apiKey: string, options: ImageOptions, request: typeof fetch = fetch) {
  if (!apiKey) throw new Error('OPENAI_API_KEY is not configured.')
  const model = options.model ?? 'gpt-image-2'
  if (!['gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini'].includes(model)) throw new Error('Unsupported image model.')
  const size = options.size ?? '1024x1024'
  const quality = options.quality ?? 'medium'
  if (!['1024x1024', '1536x1024', '1024x1536', 'auto'].includes(size)) throw new Error('Unsupported image size.')
  if (!['low', 'medium', 'high', 'auto'].includes(quality)) throw new Error('Unsupported image quality.')
  if (!options.prompt.trim() || options.prompt.length > 4000) throw new Error('Prompt must be 1–4000 characters.')
  const response = await request('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: options.prompt, size, quality, n: 1, output_format: 'png' }),
    signal: AbortSignal.timeout(300_000),
  })
  if (!response.ok) {
    const hint = response.status === 403 ? 'Check model access and organization verification.'
      : response.status === 429 ? 'Check API quota or try again later.' : 'Check API access and request options.'
    throw new Error(`Image API returned HTTP ${response.status}. ${hint}`)
  }
  const result = await response.json() as { data?: Array<{ b64_json?: string }> }
  const encoded = result.data?.[0]?.b64_json
  if (!encoded) throw new Error('Image API returned no image.')
  const attachment = Buffer.from(encoded, 'base64')
  if (!attachment.length) throw new Error('Image API returned no image.')
  if (attachment.length > 10 * 1024 * 1024) throw new Error('Generated image exceeds the 10 MB attachment limit. Try a smaller size.')
  return { attachment, name: 'gpt-image.png' }
}
