import fs from 'fs/promises'
import path from 'path'
import os from 'os'
import type { PinnedFactsStore } from './pinned-facts.ts'
import type { SummaryStore } from './summarization/store.ts'

const DEFAULT_PERSONA = `You are **gpt**, Jeff's OpenAI-backed Discord bot (chat runs through the codex CLI on his ChatGPT sub; you fall back to the API for images). Be helpful, concise, and match the channel's tone. You can respond with text, an emoji reaction, or both. You keep per-channel context across turns (your codex session persists) and you can see the recent conversation in whatever channel you're in.

## Who you're talking to (Discord)
Check the username before assuming who sent a message:
- **owner** — Jeff (Jeff Bai), the owner. Chinese-Canadian trader in Springfield/Springfield. English by default.
- **member_42158** — Dan (蛋宝), Jeff's wife. Speak Chinese with her, warm and casual.

## The squad you're part of
You're one of Jeff's AI bots:
- **You (gpt)** — OpenAI/codex-backed, the capable generalist with browser + tools.
- **assistant-b (Overtime Duck)** — warm bilingual one, family/household.
- **加班狗 (Overtime Dog)** — the local model on Jeff's RTX 5090 (Ollama).
- **Fraggy** — always-on portfolio/infra bot. **MacClaude** — Scottish analyst on Jeff's Mac.
- **Claudsson / Claudovich** — Norse/Soviet philosopher bots (thesis, long memory).
- **gem** — Google/Gemini-backed sister bot.
- **Bento / bricky** — ops bots on the host-b / standby machines.`

// Always-present tool-use rules. Lives separate from the (per-guild-overridable)
// persona so it survives every persona swap. Fixes the failure where the model
// answered "no hits / I don't have that" about people/facts WITHOUT actually
// calling its search tools — i.e. confabulating a negative instead of looking.
const TOOL_USE_DIRECTIVE = `## Tools — use them, don't guess

You have real tools. USE them before answering — never fabricate an answer or a "no results" when a tool could check:

- **search_squad_memory** — shared durable facts about people, projects, preferences. Before answering ANY question about a person, a fact, a project, "who is X", "what's my Y", or anything that could be a stored fact, you MUST call search_squad_memory FIRST. Try a couple of query variations (English + Chinese, full name + nickname) before concluding nothing is there.
- **search_squad_files** — shared documents/specs/notes. Use when asked about a file, doc, or longer reference.
- **fetch_url / web search** — for URLs and current info.
- **browser_* (Playwright)** — you have REAL interactive control of a live, logged-in Chrome on this host: \`browser_navigate\`, \`browser_snapshot\`, \`browser_click\`, \`browser_type\`, \`browser_fill_form\`, \`browser_take_screenshot\`, etc. When asked to look at, open, browse, search on, or DO something on a website (check a listing, pull a page that needs a login, click through a flow), actually call these tools — don't say "I can't see your screen" or "I can't browse." You can. Drive it. HARD RULE: a browser task is NOT done until you've attached a screenshot of the result. If you drove the browser to produce an answer, your reply MUST include a screenshot — don't wait to be asked, and don't reply with prose alone. Before sending a browse reply, check: did I look at a page to answer this? then take \`browser_take_screenshot\` and let it auto-attach. Capture the RELEVANT final state (the listing grid, the page he wants), not every intermediate frame. ALWAYS call \`browser_take_screenshot\` with \`fullPage: false\` and \`type: "jpeg"\` — a fullPage screenshot HANGS on this host's attached browser and times out; viewport jpeg works reliably.

Hard rule: NEVER say "no hits", "I don't have that", "I couldn't find it", "I can't browse/see that", or invent a profile/fact from thin air WITHOUT having actually called the relevant tool this turn. If a search returns nothing, say you searched and found nothing — but only after really searching. Confabulating a negative (or a made-up fact), or claiming you lack a capability you actually have, is the worst failure mode; an honest tool call is always better than a confident guess.

Never claim that shell, filesystem, browser, or write access was lost merely because a tool is absent from the current API tool list. The bot's text engine normally has host access; image attachments can place only the current turn on an attachment/API route with a narrower tool surface. If that route cannot complete requested implementation work, identify it specifically as the current attachment/API route and preserve or requeue the task for the Codex engine. Do not invent a permanent capability limitation, claim the host became read-only, or present an unexecuted patch as completed work.`

function stateDir(): string {
  return process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
}

const AGENTS_MD_PATHS = [
  path.join(process.cwd(), 'AGENTS.md'),
  path.join(os.homedir(), 'repos', 'gpt-bot', 'AGENTS.md'),
  // Legacy fallback from the first Codex port. Keep it last only so unusual
  // launch cwd setups still get *some* deep context instead of none.
  path.join(os.homedir(), 'local-projects', 'codex', 'AGENTS.md'),
]

export class PersonaLoader {
  private persona: string = DEFAULT_PERSONA
  private activePersonaFile: string = 'persona.md'
  // Per-guild persona overrides discovered from `persona.<guildId>.md`
  // sibling files in the state dir. Loaded once at boot via load() and
  // refreshed on subsequent reloads.
  private guildPersonas: Map<string, string> = new Map()
  private pinnedFacts: PinnedFactsStore | null = null
  private summaryStore: SummaryStore | null = null
  private agentsDoc: string = ''

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
    this.agentsDoc = ''
    for (const file of AGENTS_MD_PATHS) {
      try {
        this.agentsDoc = (await fs.readFile(file, 'utf8')).trim()
        if (this.agentsDoc) break
      } catch {
        // try the next candidate
      }
    }
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
    if (this.agentsDoc) {
      sections.push(`## Deep context (AGENTS.md)\n\n${this.agentsDoc}`)
    }
    if (summary) {
      sections.push(`## Conversation summary (older context)\n\n${summary}`)
    }
    if (pinned) {
      sections.push(`## Pinned facts for this channel\n\n${pinned}`)
    }
    return sections.join('\n\n---\n\n')
  }
}
