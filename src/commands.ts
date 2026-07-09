import { SlashCommandBuilder, PermissionFlagsBits, ChatInputCommandInteraction, AttachmentBuilder } from 'discord.js'
import path from 'node:path'
import os from 'node:os'
import { AccessManager, CODEX_MODELS, type ReasoningEffort, type CodexModel } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { snapshot as cacheSnapshot, globalSnapshot } from './cache-stats.ts'
import { readLatestRateLimits, readSessionHistory, type RateLimits, type RateWindow } from './codex-chat.ts'
import { INTERRUPTED_MARKER } from './interruption-label.ts'
import { DEFAULT_OPENAI_MODEL } from './models.ts'

// Render the ChatGPT-sub rate-limit windows as bars + reset countdowns. Shared by
// /gpt limits and /gpt stats.
function fmtLimitLines(rl: RateLimits | null): string[] {
  if (!rl || (!rl.primary && !rl.secondary)) return ['limits:   (no codex snapshot yet — run a turn first)']
  const bar = (p: number) => { const f = Math.max(0, Math.min(10, Math.round(p / 10))); return '\u2588'.repeat(f) + '\u2591'.repeat(10 - f) }
  const nowSec = Math.floor(Date.now() / 1000)
  // Always days+hours for long spans (weekly window can be 100h+ → "4d 7h", not "103h").
  const reset = (ts: number) => {
    const s = ts - nowSec
    if (s <= 0) return 'now'
    const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
    return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`
  }
  // The snapshot is frozen at the last codex turn, but resetsAt is an ABSOLUTE
  // time — so even with no new turns we can tell when the window rolled over. Once
  // resetsAt is in the past, the quota HAS reset to 0; the fresh window's clock
  // doesn't start until the next message goes through. Show that explicitly
  // instead of a stale used% (Jeff 2026-06-27 "calculate the reset / starts when
  // you send a message").
  const line = (label: string, w?: RateWindow) => {
    if (!w) return null
    if (w.resetsAt > 0 && w.resetsAt <= nowSec) {
      return `${label} ${bar(0)}   0%  \u00b7 reset — new window starts when you send a message`
    }
    return `${label} ${bar(w.usedPercent)} ${String(Math.round(w.usedPercent)).padStart(3)}%  \u00b7 resets in ${reset(w.resetsAt)}`
  }
  const out: string[] = []
  const p = line('5-hour:', rl.primary); if (p) out.push(p)
  const s = line('weekly:', rl.secondary); if (s) out.push(s)
  return out
}
import { channelSessions } from './channel-sessions.ts'
import { activeTurns } from './active-turns.ts'

export const gptCommand = new SlashCommandBuilder()
  .setName('gpt')
  .setDescription('Admin controls for the gpt bot')
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  .addSubcommand(s => s
    .setName('allow')
    .setDescription('Allow a user to interact with the bot')
    .addUserOption(o => o.setName('user').setDescription('The user to allow').setRequired(true))
  )
  .addSubcommand(s => s
    .setName('revoke')
    .setDescription("Revoke a user's access to the bot")
    .addUserOption(o => o.setName('user').setDescription('The user to revoke').setRequired(true))
  )
  .addSubcommand(s => s
    .setName('channel')
    .setDescription('Enable a channel + set its mention rule. Other flags via the /gpt subcommands.')
    .addChannelOption(o => o.setName('channel').setDescription('The channel to configure').setRequired(true))
    .addBooleanOption(o => o.setName('enabled').setDescription('Enable bot in this channel').setRequired(true))
    .addBooleanOption(o => o.setName('require_mention').setDescription('Require explicit mention').setRequired(true))
  )
  .addSubcommand(s => s
    .setName('persona')
    .setDescription('Hot-swap the bot persona file')
    .addStringOption(o => o.setName('filename').setDescription('The persona filename (e.g. persona.md)').setRequired(true))
  )
  .addSubcommand(s => s
    .setName('compact')
    .setDescription('Force a context-summary rollup now, regardless of the message threshold')
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('stop')
    .setDescription('Abort the in-flight turn in this channel (kill a stuck codex turn).')
  )
  .addSubcommand(s => s
    .setName('clear')
    .setDescription('Reset this channel — the next codex turn starts from a blank slate.')
  )
  .addSubcommand(s => s
    .setName('history')
    .setDescription('Print this channel\'s codex session conversation (inline, or .md if long).')
  )
  .addSubcommand(s => s
    .setName('stats')
    .setDescription('Token usage + $-equivalent (gpt-5.6 rates; flat sub = ~$0 actual) since boot.')
  )
  .addSubcommand(s => s
    .setName('limits')
    .setDescription('ChatGPT-sub usage left: the 5-hour + weekly rate-limit windows.')
  )
  .addSubcommand(s => s
    .setName('settings')
    .setDescription('Show every resolved setting for this channel (read-only).')
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('model')
    .setDescription('Codex engine model (5.6 default). Omit value to read current.')
    .addStringOption(o => o.setName('value').setDescription('omit to show current; else pick a model').setRequired(false)
      .addChoices(
        { name: 'gpt-5.6 — Sol, flagship reasoning/coding', value: 'gpt-5.6' },
        { name: 'gpt-5.6-terra — balanced cost/intelligence', value: 'gpt-5.6-terra' },
        { name: 'gpt-5.6-luna — cheapest high-volume 5.6', value: 'gpt-5.6-luna' },
      ))
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('cache')
    .setDescription('Show recent prompt-cache hit telemetry for this channel (rolling window of last 50 turns).')
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('effort')
    .setDescription('Reasoning effort for this channel (gpt-5.6 / codex): none | low | medium | high | xhigh.')
    .addStringOption(o => o
      .setName('value')
      .setDescription('none | low | medium | high | xhigh')
      .setRequired(true)
      .addChoices(
        { name: 'none - no reasoning, fastest', value: 'none' },
        { name: 'low', value: 'low' },
        { name: 'medium', value: 'medium' },
        { name: 'high', value: 'high' },
        { name: 'xhigh - deepest, slowest', value: 'xhigh' },
      )
    )
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('counter')
    .setDescription('Footer counter for this channel: off | token | both.')
    .addStringOption(o => o
      .setName('value')
      .setDescription('off | token | both')
      .setRequired(true)
      .addChoices(
        { name: 'off - no footer', value: 'off' },
        { name: 'token - tokens + time only', value: 'token' },
        { name: 'both - tokens + cached/reasoning', value: 'both' },
      )
    )
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('engine')
    .setDescription('Set this channel chat engine: codex (flat sub) or api (metered).')
    .addStringOption(o => o
      .setName('value')
      .setDescription('codex | api')
      .setRequired(true)
      .addChoices(
        { name: 'codex - flat sub (default)', value: 'codex' },
        { name: 'api - metered OpenAI API', value: 'api' },
      )
    )
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('trace')
    .setDescription('Tool-trace card for this channel: off | on | collapse.')
    .addStringOption(o => o
      .setName('value').setDescription('off | on | collapse').setRequired(true)
      .addChoices(
        { name: 'off', value: 'off' },
        { name: 'on — keep the trace card', value: 'on' },
        { name: 'collapse — show live, delete after the reply', value: 'collapse' },
      )
    )
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('thinking')
    .setDescription('Reasoning-summary card for this channel: off | on | collapse.')
    .addStringOption(o => o
      .setName('value').setDescription('off | on | collapse').setRequired(true)
      .addChoices(
        { name: 'off', value: 'off' },
        { name: 'on — keep the reasoning card', value: 'on' },
        { name: 'collapse — show live, delete after the reply', value: 'collapse' },
      )
    )
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('mention')
    .setDescription('Require an @-mention before responding in this channel: on | off.')
    .addStringOption(o => o
      .setName('value').setDescription('on | off').setRequired(true)
      .addChoices(
        { name: 'on — only respond when @-mentioned', value: 'on' },
        { name: 'off — respond to all messages', value: 'off' },
      )
    )
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )

export interface CommandDeps {
  // Optional — present only when the SQLite-backed summarization scheduler
  // wired up successfully. /gpt compact reports gracefully when null.
  summarizer: { runForChannel(channelId: string): Promise<{ messageCount: number } | null> } | null
}

export async function executeGptCommand(
  interaction: ChatInputCommandInteraction,
  access: AccessManager,
  persona: PersonaLoader,
  adminUserId: string | undefined,
  deps: CommandDeps = { summarizer: null }
) {
  if (adminUserId && interaction.user.id !== adminUserId) {
    return interaction.reply({ content: 'Unauthorized. You are not the designated bot admin.', ephemeral: true })
  }

  const subcommand = interaction.options.getSubcommand()

  try {
    if (subcommand === 'allow') {
      const targetUser = interaction.options.getUser('user', true)
      await access.allowUser(targetUser.id)
      return interaction.reply({ content: `✅ Access granted to ${targetUser.tag}.`, ephemeral: true })
    }

    if (subcommand === 'revoke') {
      const targetUser = interaction.options.getUser('user', true)
      await access.revokeUser(targetUser.id)
      return interaction.reply({ content: `✅ Access revoked for ${targetUser.tag}.`, ephemeral: true })
    }

    if (subcommand === 'channel') {
      const channel = interaction.options.getChannel('channel', true)
      const enabled = interaction.options.getBoolean('enabled', true)
      const requireMention = interaction.options.getBoolean('require_mention', true)
      await access.setChannel(channel.id, enabled, requireMention)
      const flags = access.channelFlags(channel.id)
      return interaction.reply({
        content: `✅ <#${channel.id}> configured. enabled=${enabled}, requireMention=${requireMention}. flags: engine=${flags.engine}, codexModel=${flags.codexModel}, reasoning=${flags.reasoning}, counter=${flags.counter}, trace=${flags.trace}, thinking=${flags.thinking} — change via the \`/gpt\` subcommands.`,
        ephemeral: true
      })
    }

    if (subcommand === 'persona') {
      const filename = interaction.options.getString('filename', true)
      await persona.load(filename)
      return interaction.reply({ content: `✅ Persona swapped to \`${filename}\`.`, ephemeral: true })
    }

    if (subcommand === 'history') {
      const sid = channelSessions.get(interaction.channelId)
      if (!sid) {
        return interaction.reply({ content: 'ℹ️ No active session in this channel yet — nothing to show.', ephemeral: true })
      }
      await interaction.deferReply({ ephemeral: true })
      const turns = await readSessionHistory(sid)
      if (!turns.length) {
        return interaction.editReply('⚠️ Session found but no readable conversation in the rollout.')
      }
      const raw = turns.map(t => `${t.role === 'user' ? '🧑 USER' : '🤖 GPT'}: ${t.text}`).join('\n\n')
      const text = raw.replace(/```/g, '`\u200b`\u200b`')  // neutralize fences so they don't break our code block
      const MAX_INLINE = 10000
      if (text.length <= MAX_INLINE) {
        const chunks: string[] = []
        for (let i = 0; i < text.length; i += 1900) chunks.push(text.slice(i, i + 1900))
        await interaction.editReply('```\n' + chunks[0] + '\n```')
        for (let i = 1; i < chunks.length; i++) {
          await interaction.followUp({ content: '```\n' + chunks[i] + '\n```', ephemeral: true })
        }
      } else {
        const file = new AttachmentBuilder(Buffer.from(raw, 'utf8'), { name: `gpt-session-${sid.slice(0, 8)}.md` })
        await interaction.editReply({ content: `📜 Session history — ${turns.length} turns, ${text.length} chars (too long for inline, attached):`, files: [file] })
      }
      return
    }

    if (subcommand === 'stop') {
      const killed = activeTurns.stop(interaction.channelId)
      return interaction.reply({
        content: killed ? INTERRUPTED_MARKER : 'ℹ️ Nothing is running in this channel right now.',
        ephemeral: true,
      })
    }

    if (subcommand === 'clear') {
      // clear() drops the codex session AND stamps the history cutoff, so the next
      // turn ignores all prior channel messages — a true reset regardless of
      // whether a codex session object existed. Always confirm (Jeff 2026-06-27).
      channelSessions.clear(interaction.channelId)
      return interaction.reply({
        content: '🧹 Cleared — the next turn starts fresh (codex session dropped + prior messages won\'t be used as context).',
        ephemeral: true,
      })
    }

    if (subcommand === 'compact') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved.', ephemeral: true })
      }
      if (!deps.summarizer) {
        return interaction.reply({ content: '⚠️ Summarization unavailable on this runtime (sqlite-vss / better-sqlite3 didn\'t load — usually means Node version too old).', ephemeral: true })
      }
      await interaction.deferReply({ ephemeral: true })
      try {
        const result = await deps.summarizer.runForChannel(channel.id)
        if (!result) {
          return interaction.editReply(`✅ <#${channel.id}> nothing new to summarize.`)
        }
        return interaction.editReply(`✅ <#${channel.id}> compacted ${result.messageCount} messages into the rolling summary.`)
      } catch (e: any) {
        return interaction.editReply(`❌ compact failed: ${e?.message ?? String(e)}`)
      }
    }

    if (subcommand === 'model') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      const raw = interaction.options.getString('value')
      if (!raw) {
        const cur = access.channelFlags(channel.id).codexModel ?? DEFAULT_OPENAI_MODEL
        return interaction.reply({ content: `\ud83e\udd16 <#${channel.id}> codex model = \`${cur}\` (codex engine; the API-fallback path uses its own model).`, ephemeral: true })
      }
      const value = raw.trim().toLowerCase()
      if (!(CODEX_MODELS as readonly string[]).includes(value)) {
        return interaction.reply({ content: `❌ \`model\` must be one of: ${CODEX_MODELS.join(' | ')} (got \`${value}\`)`, ephemeral: true })
      }
      const updated = await access.setChannelFlags(channel.id, { codexModel: value as CodexModel })
      return interaction.reply({ content: `✅ <#${channel.id}> codex model = \`${updated.codexModel}\` (codex engine only; API path unchanged).`, ephemeral: true })
    }

    if (subcommand === 'limits') {
      const rl = await readLatestRateLimits()
      const plan = rl?.planType ? ` (plan: ${rl.planType})` : ''
      const body = ['\ud83c\udfab @gpt — ChatGPT-sub limits' + plan, '```', ...fmtLimitLines(rl), '```'].join('\n')
      return interaction.reply({ content: body, ephemeral: true })
    }

    if (subcommand === 'stats') {
      const g = globalSnapshot()
      const n = (x: number) => x.toLocaleString('en-US')
      // Humanize big token counts so they don't sprawl: 4.39M / 45k / 1,234.
      const h = (x: number) => x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e4 ? `${Math.round(x / 1e3)}k` : n(x)
      const uncachedIn = Math.max(0, g.inputTokens - g.cachedInputTokens)
      const dIn = uncachedIn * 5.00 / 1e6        // gpt-5.6 Sol, per 1M
      const dCached = g.cachedInputTokens * 0.50 / 1e6
      const dOut = g.outputTokens * 30.00 / 1e6
      const dTotal = dIn + dCached + dOut
      const total = g.inputTokens + g.outputTokens
      const cachePct = g.inputTokens > 0 ? Math.round((g.cachedInputTokens / g.inputTokens) * 100) : 0
      const upMin = Math.floor((Date.now() - g.bootTs) / 60000)
      const up = `${Math.floor(upMin / 60)}h ${upMin % 60}m`
      const engines = Object.entries(g.byModel).map(([m, ct]) => `${m} ${ct}`).join(' · ') || '—'
      const rl = await readLatestRateLimits()
      const body = [
        '\ud83d\udcca @gpt usage — cumulative across restarts, all channels',
        '```',
        `turns:    ${n(g.turns)}`,
        `input:    ${h(g.inputTokens)} tok  (${h(g.cachedInputTokens)} cached, ${cachePct}%)`,
        `output:   ${h(g.outputTokens)} tok  (${h(g.reasoningTokens)} reasoning)`,
        `total:    ${h(total)} tok`,
        '',
        `$-equiv:  $${dTotal.toFixed(2)}   (gpt-5.6 Sol API rates, est.)`,
        `          in $${dIn.toFixed(2)} \u00b7 cached $${dCached.toFixed(2)} \u00b7 out $${dOut.toFixed(2)}`,
        '',
        `engines:  ${engines}`,
        `uptime:   ${up}`,
        '',
        ...fmtLimitLines(rl),
        '```',
      ].join('\n')
      return interaction.reply({ content: body, ephemeral: true })
    }

    // /gpt settings — read-only dump of every RESOLVED setting for a channel.
    // Unified across the squad bots (gem/llm share this layout): one fenced
    // block, `key : value (default X)`, showing the effective value (per-channel
    // pick or code default) so there's no guessing what a channel is set to.
    if (subcommand === 'settings') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      const f = access.channelFlags(channel.id)
      const lingerMs = Number(process.env.GPT_THOUGHT_LINGER_MS) || 60_000
      const rows: Array<[string, string]> = [
        ['engine', `${f.engine} (default codex)`],
        ['codex model', `${f.codexModel} (default ${DEFAULT_OPENAI_MODEL})`],
        ['api model', `${process.env.GPT_MODEL || DEFAULT_OPENAI_MODEL} (env, global)`],
        ['effort', `${f.reasoning} (default high)`],
        ['thinking', `${f.thinking} (default off)`],
        ['trace', `${f.trace} (default off)`],
        ['counter', `${f.counter} (default both)`],
        ['require @', f.requireMention ? 'yes' : 'no'],
        ['collapse linger', `${Math.round(lingerMs / 1000)}s`],
      ]
      const pad = Math.max(...rows.map(([k]) => k.length))
      const cardBody = rows.map(([k, v]) => `${k.padEnd(pad)} : ${v}`).join('\n')
      const card = `⚙️ **gpt settings** — <#${channel.id}>\n\`\`\`\n${cardBody}\n\`\`\``
      return interaction.reply({ content: card, ephemeral: true })
    }

    if (subcommand === 'cache') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved.', ephemeral: true })
      }
      const snap = cacheSnapshot(channel.id)
      if (snap.turns === 0) {
        return interaction.reply({
          content: `📊 <#${channel.id}> no turns recorded yet (rolling window is empty — try chatting first).`,
          ephemeral: true
        })
      }
      const ageMs = snap.newestTs && snap.oldestTs ? snap.newestTs - snap.oldestTs : 0
      const ageMin = (ageMs / 60000).toFixed(1)
      const hitPct = (snap.cacheHitRate * 100).toFixed(1)
      const inK = (snap.inputTokens / 1000).toFixed(1)
      const cachedK = (snap.cachedInputTokens / 1000).toFixed(1)
      const outK = (snap.outputTokens / 1000).toFixed(1)
      const reasoningK = (snap.reasoningTokens / 1000).toFixed(1)
      const reasoningLine = snap.reasoningTokens > 0
        ? `\nReasoning tokens: ${reasoningK}k (counted in output, billed separately)`
        : ''
      const modelsLine = snap.models.length > 0
        ? `\nModels seen: ${snap.models.join(', ')}`
        : ''
      return interaction.reply({
        content: [
          `📊 <#${channel.id}> prompt-cache telemetry (last ${snap.turns} turns, window ${ageMin}min)`,
          '```',
          `cache hit rate: ${hitPct}%`,
          `input tokens:   ${inK}k total · ${cachedK}k cached (50% rate)`,
          `output tokens:  ${outK}k` + reasoningLine + modelsLine,
          '```',
          `_OpenAI caches prompt prefixes automatically — no TTL or flush controls. Cached tokens bill at ~50% of the input rate._`
        ].join('\n'),
        ephemeral: true
      })
    }

    if (subcommand === 'effort') {
      const value = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: 'No channel resolved (run inside a channel or pass the channel arg).', ephemeral: true })
      }
      if (!['none', 'low', 'medium', 'high', 'xhigh'].includes(value)) {
        return interaction.reply({ content: `effort must be none, low, medium, high, or xhigh (got ${value})`, ephemeral: true })
      }
      try {
        const updated = await access.setChannelFlags(channel.id, { reasoning: value as ReasoningEffort })
        return interaction.reply({ content: `<#${channel.id}> reasoning effort set to ${updated.reasoning} (${updated.codexModel}/codex)`, ephemeral: true })
      } catch (e: any) {
        return interaction.reply({ content: `Error: ${e.message}`, ephemeral: true })
      }
    }

    if (subcommand === 'counter') {
      const value = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: 'No channel resolved (run inside a channel or pass the channel arg).', ephemeral: true })
      }
      if (value !== 'off' && value !== 'token' && value !== 'both') {
        return interaction.reply({ content: `counter must be off, token, or both (got ${value})`, ephemeral: true })
      }
      try {
        const updated = await access.setChannelFlags(channel.id, { counter: value })
        return interaction.reply({ content: `<#${channel.id}> footer counter set to ${updated.counter}`, ephemeral: true })
      } catch (e: any) {
        return interaction.reply({ content: `Error: ${e.message}`, ephemeral: true })
      }
    }

    if (subcommand === 'engine') {
      const value = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: 'No channel resolved (run inside a channel or pass the channel arg).', ephemeral: true })
      }
      if (value !== 'codex' && value !== 'api') {
        return interaction.reply({ content: `engine must be codex or api (got ${value})`, ephemeral: true })
      }
      try {
        const updated = await access.setChannelFlags(channel.id, { engine: value })
        const note = value === 'codex'
          ? 'codex (flat sub) - falls back to the API on error/rate-limit'
          : 'api (metered OpenAI) - bypasses codex entirely'
        return interaction.reply({ content: `<#${channel.id}> chat engine set to ${updated.engine} - ${note}`, ephemeral: true })
      } catch (e: any) {
        return interaction.reply({ content: `Error: ${e.message}`, ephemeral: true })
      }
    }

    if (subcommand === 'trace' || subcommand === 'thinking') {
      const value = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      if (!['off', 'on', 'collapse'].includes(value)) {
        return interaction.reply({ content: `❌ \`${subcommand}\` must be off | on | collapse (got \`${value}\`)`, ephemeral: true })
      }
      try {
        const tri = value as 'off' | 'on' | 'collapse'
        const updated = await access.setChannelFlags(channel.id,
          subcommand === 'trace' ? { trace: tri } : { thinking: tri })
        const note = value === 'collapse' ? ' — shown live, deleted after the reply' : ''
        return interaction.reply({ content: `✅ <#${channel.id}> \`${subcommand}\` = \`${value}\`${note}. (trace=${updated.trace}, thinking=${updated.thinking})`, ephemeral: true })
      } catch (e: any) {
        return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
      }
    }

    if (subcommand === 'mention') {
      const value = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      if (!['on', 'off'].includes(value)) {
        return interaction.reply({ content: `❌ \`mention\` must be on | off (got \`${value}\`)`, ephemeral: true })
      }
      try {
        const updated = await access.setChannelFlags(channel.id, { requireMention: value === 'on' })
        return interaction.reply({ content: `✅ <#${channel.id}> require-mention = \`${value}\` (${updated.requireMention}).`, ephemeral: true })
      } catch (e: any) {
        return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
      }
    }

    return interaction.reply({ content: `❌ Unknown subcommand: ${subcommand}`, ephemeral: true })
  } catch (e: any) {
    if (interaction.replied || interaction.deferred) {
      return interaction.followUp({ content: `❌ Error: ${e.message}`, ephemeral: true })
    }
    return interaction.reply({ content: `❌ Error: ${e.message}`, ephemeral: true })
  }
}
