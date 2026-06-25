import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type { PinnedFactsStore } from './pinned-facts.ts'
import type { SummaryStore } from './summarization/store.ts'

const DEFAULT_PERSONA = `You are gpt, a Discord bot backed by an OpenAI model. Be helpful, concise, and match the channel's tone. You can respond with text, an emoji reaction, or both.`

// Always-present tool-use rules. Lives separate from the (per-guild-overridable)
// persona so it survives every persona swap. Fixes the failure where the model
// answered "no hits / I don't have that" about people/facts WITHOUT actually
// calling its search tools — i.e. confabulating a negative instead of looking.
const TOOL_USE_DIRECTIVE = `## Tools — use them, don't guess

You have real tools. USE them before answering — never fabricate an answer or a "no results" when a tool could check:

- **search_squad_memory** — shared durable facts about people, projects, preferences. Before answering ANY question about a person, a fact, a project, "who is X", "what's my Y", or anything that could be a stored fact, you MUST call search_squad_memory FIRST. Try a couple of query variations (English + Chinese, full name + nickname) before concluding nothing is there.
- **search_squad_files** — shared documents/specs/notes. Use when asked about a file, doc, or longer reference.
- **fetch_url / web search** — for URLs and current info.
- **browser_* (Playwright)** — you have REAL interactive control of a live, logged-in Chrome on this host: \`browser_navigate\`, \`browser_snapshot\`, \`browser_click\`, \`browser_type\`, \`browser_fill_form\`, \`browser_take_screenshot\`, etc. When asked to look at, open, browse, search on, or DO something on a website (check a listing, pull a page that needs a login, click through a flow), actually call these tools — don't say "I can't see your screen" or "I can't browse." You can. Drive it. And per Jeff's standing preference: if the result is visual (a listing grid, a chart, a page), \`browser_take_screenshot\` and ATTACH it to your reply by default — show what you looked at, don't make him ask.

Hard rule: NEVER say "no hits", "I don't have that", "I couldn't find it", "I can't browse/see that", or invent a profile/fact from thin air WITHOUT having actually called the relevant tool this turn. If a search returns nothing, say you searched and found nothing — but only after really searching. Confabulating a negative (or a made-up fact), or claiming you lack a capability you actually have, is the worst failure mode; an honest tool call is always better than a confident guess.`

function stateDir(): string {
  return process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
}

export class PersonaLoader {
  private persona: string = DEFAULT_PERSONA
  private activePersonaFile: string = 'persona.md'
  // Per-guild persona overrides discovered from `persona.<guildId>.md`
  // sibling files in the state dir. Loaded once at boot via load() and
  // refreshed on subsequent reloads.
  private guildPersonas: Map<string, string> = new Map()
  private pinnedFacts: PinnedFactsStore | null = null
  private summaryStore: SummaryStore | null = null

  setPinnedFactsStore(store: PinnedFactsStore): void {
    this.pinnedFacts = store
  }

  setSummaryStore(store: SummaryStore): void {
    this.summaryStore = store
  }

  async load(filename?: string): Promise<void> {
    if (filename) this.activePersonaFile = filename
    this.persona = await this.readPersona(this.activePersonaFile)
    await this.discoverGuildPersonas()
  }

  private async discoverGuildPersonas(): Promise<void> {
    this.guildPersonas.clear()
    try {
      const entries = await fs.readdir(stateDir())
      for (const name of entries) {
        // Discord snowflakes are 17-20 digits. Tolerant filename match so
        // we don't accidentally pick up persona.md.bak or similar.
        const m = name.match(/^persona\.(\d{17,20})\.md$/)
        if (!m) continue
        const text = await this.readPersona(name)
        this.guildPersonas.set(m[1], text)
      }
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e
    }
  }

  private async readPersona(filename: string): Promise<string> {
    const file = path.join(stateDir(), filename)
    try {
      const text = (await fs.readFile(file, 'utf8')).trim()
      return text || DEFAULT_PERSONA
    } catch (e: any) {
      if (e.code === 'ENOENT') return DEFAULT_PERSONA
      throw e
    }
  }

  buildSystemPrompt(channelId: string, guildId?: string | null): string {
    // Per-guild persona overrides the default when one is set for this guild
    // (DM channels have no guildId — fall through to default). Lookup is
    // O(1) on the in-memory Map populated at load() time.
    const persona = (guildId && this.guildPersonas.get(guildId)) || this.persona
    const pinned = this.pinnedFacts?.readForChannelSync(channelId) ?? ''
    const summary = this.summaryStore?.get(channelId)?.summary ?? ''
    // Wall-clock stamp, rebuilt every turn so the model knows the current time
    // (matches the squad's cc-inject-time hook format on the Claude bots).
    const now = new Date()
    const wallClock = `Current time: ${now.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })} (${Intl.DateTimeFormat().resolvedOptions().timeZone})`
    const sections: string[] = [persona, TOOL_USE_DIRECTIVE, wallClock]
    if (summary) {
      sections.push(`## Conversation summary (older context)\n\n${summary}`)
    }
    if (pinned) {
      sections.push(`## Pinned facts for this channel\n\n${pinned}`)
    }
    return sections.join('\n\n---\n\n')
  }
}
