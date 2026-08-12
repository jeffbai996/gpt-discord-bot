import { createHmac, timingSafeEqual } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export interface RelayConfig {
  helper_id: string
  secret: string
  relay_user?: string
  relay_user_id?: string
  self_id: string
}

export interface RelayInput {
  messageId: string
  channelId: string
  authorId: string
  content: string
}

export interface TrustedRelay {
  payload: string
  userId: string
  userName: string
}

export function loadRelayConfig(stateDir: string): RelayConfig | null {
  try {
    const value = JSON.parse(readFileSync(path.join(stateDir, 'relay.json'), 'utf8')) as RelayConfig
    if (!value.helper_id || !value.secret || !value.self_id) return null
    return value
  } catch {
    return null
  }
}

export class TrustedRelayVerifier {
  private readonly consumed = new Set<string>()
  private readonly consumedOrder: string[] = []

  constructor(
    private readonly config: () => RelayConfig | null,
    private readonly maxConsumed = 1024,
  ) {}

  verify(input: RelayInput, consume = true): TrustedRelay | null {
    if (this.consumed.has(input.messageId)) return null
    const cfg = this.config()
    if (!cfg || input.authorId !== cfg.helper_id) return null

    const match = /^⟦vc-relay:([^:⟧]*):([0-9a-f]{64})⟧\s*([\s\S]*)$/.exec(input.content)
    if (!match) return null
    const [, target, signature, payload] = match

    // Unlike the legacy Claude-plugin path, gpt never accepts broadcasts. A
    // choice card records its asker, so the helper can and must target gpt.
    if (!target || target !== cfg.self_id) return null

    const expected = createHmac('sha256', cfg.secret)
      .update(`${input.channelId}\n${target}\n${payload}`)
      .digest('hex')
    const actualBytes = Buffer.from(signature, 'utf8')
    const expectedBytes = Buffer.from(expected, 'utf8')
    if (actualBytes.length !== expectedBytes.length
        || !timingSafeEqual(actualBytes, expectedBytes)) return null

    if (consume) this.remember(input.messageId)
    return {
      payload,
      userId: cfg.relay_user_id || input.authorId,
      userName: cfg.relay_user || 'choice-tap',
    }
  }

  private remember(messageId: string): void {
    this.consumed.add(messageId)
    this.consumedOrder.push(messageId)
    while (this.consumedOrder.length > this.maxConsumed) {
      const oldest = this.consumedOrder.shift()
      if (oldest) this.consumed.delete(oldest)
    }
  }
}
