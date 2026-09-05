import { SlashCommandBuilder, PermissionFlagsBits, ChatInputCommandInteraction } from 'discord.js'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { AccessManager, CODEX_MODELS, type ReasoningEffort, type CodexModel } from './access.ts'
import { globalSnapshot } from './cache-stats.ts'
import { readLatestRateLimits, readSessionStats, type RateLimits, type RateWindow } from './codex-chat.ts'
import { INTERRUPTED_MARKER } from './interruption-label.ts'
import { DEFAULT_CODEX_MODEL, DEFAULT_OPENAI_MODEL } from './models.ts'
import {
  appendRuntimeChecks,
  type DoctorCheck,
  type DoctorReport,
  type DoctorRuntimeDeps,
} from './runtime-doctor.ts'

// Render the Codex subscription rate-limit windows as bars + reset countdowns. Shared by
// /gpt limits and /gpt stats.
export function fmtLimitLines(rl: RateLimits | null): string[] {
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
  const label = (w: RateWindow) => {
    if (w.windowMinutes === 10_080) return 'weekly:'
    if (w.windowMinutes === 300) return '5-hour:'
    if (w.windowMinutes > 0 && w.windowMinutes % 1_440 === 0) return `${w.windowMinutes / 1_440}-day:`
    if (w.windowMinutes > 0 && w.windowMinutes % 60 === 0) return `${w.windowMinutes / 60}-hour:`
    return `${w.windowMinutes}-minute:`
  }
  const out: string[] = []
  const p = rl.primary ? line(label(rl.primary), rl.primary) : null; if (p) out.push(p)
  const s = rl.secondary ? line(label(rl.secondary), rl.secondary) : null; if (s) out.push(s)
  return out
}

export function fmtContextPressureLine(
  snapshot: Pick<RateLimits, 'lastInputTokens' | 'modelContextWindow'> | null,
): string | null {
  const input = snapshot?.lastInputTokens ?? 0
  const window = snapshot?.modelContextWindow ?? 0
  if (input <= 0 || window <= 0) return null
  const compact = (x: number) => x >= 1_000 ? `${Math.round(x / 1_000)}k` : x.toLocaleString('en-US')
  const percent = Math.round((input / window) * 100)
  return `context:  ${compact(input)} / ${compact(window)} tok  (${percent}%)`
}

export function fmtClearAcknowledgement(channelId: string): string {
  return `🧹 <#${channelId}> cleared — next turn starts fresh.`
}

export function fmtSettingChange(label: string, value: string, previous: string): string {
  const changed = value === previous ? '' : ` (was \`${previous}\`)`
  return `✅ ${label} → \`${value}\`${changed}`
}

export function fmtModelStatus(channelId: string, model: string, effort: string): string {
  return `🤖 <#${channelId}> model \`${model}\` · effort \`${effort}\``
}

/** Read-only runtime diagnostics. It deliberately creates no probe files. */
export async function runGptDoctor(
  stateDir = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord'),
  rolloutDir = path.join(os.homedir(), '.codex', 'sessions'),
  runtime?: DoctorRuntimeDeps,
): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [
    { name: 'process', ok: true, detail: `running · pid ${process.pid} · node ${process.version}` },
    { name: 'slash schema', ok: true, detail: `${gptCommand.toJSON().options?.length ?? 0} controls loaded` },
  ]
  const directoryCheck = async (name: string, dir: string) => {
    try {
      await fs.access(dir, fsConstants.R_OK | fsConstants.W_OK)
      checks.push({ name, ok: true, detail: 'read/write' })
    } catch (error: any) {
      checks.push({ name, ok: false, detail: error?.code ?? String(error) })
    }
  }
  const lazyDirectoryCheck = async (name: string, dir: string) => {
    try {
      await fs.access(dir, fsConstants.R_OK | fsConstants.W_OK)
      checks.push({ name, ok: true, detail: 'read/write' })
    } catch (error: any) {
      if (error?.code !== 'ENOENT') {
        checks.push({ name, ok: false, detail: error?.code ?? String(error) })
        return
      }
      try {
        await fs.access(path.dirname(dir), fsConstants.R_OK | fsConstants.W_OK)
        checks.push({ name, ok: true, detail: 'ready · created on first agent' })
      } catch (parentError: any) {
        checks.push({ name, ok: false, detail: parentError?.code ?? String(parentError) })
      }
    }
  }
  await directoryCheck('state directory', stateDir)
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(stateDir, 'access.json'), 'utf8'))
    const ok = parsed && typeof parsed === 'object' && parsed.channels && typeof parsed.channels === 'object'
    checks.push({ name: 'access config', ok: !!ok, detail: ok ? `version ${parsed.version ?? 'legacy'}` : 'invalid shape' })
  } catch (error: any) {
    checks.push({ name: 'access config', ok: false, detail: error?.code ?? error?.message ?? String(error) })
  }
  try {
    const persona = (await fs.readFile(path.join(stateDir, 'persona.md'), 'utf8')).trim()
    checks.push({ name: 'persona', ok: persona.length > 0, detail: persona ? `${persona.length} chars` : 'empty' })
  } catch (error: any) {
    checks.push({ name: 'persona', ok: false, detail: error?.code ?? error?.message ?? String(error) })
  }
  await directoryCheck('rollout store', rolloutDir)
  await lazyDirectoryCheck('agent registry', path.join(stateDir, 'agent-registry'))
  if (runtime) await appendRuntimeChecks(checks, runtime)
  return { ok: checks.every(check => check.ok), checks }
}

import { channelSessions } from './channel-sessions.ts'
import { activeTurns } from './active-turns.ts'

// The one settings card. /gpt settings renders it, and every setter ack
// appends it after a one-line "what changed" — same pattern as gem-bot
// (Jeff 2026-07-27 copy-edit run: the card replaces prose flag dumps).
function settingsCard(access: AccessManager, channelId: string): string {
  const f = access.channelFlags(channelId)
  const lingerMs = Number(process.env.GPT_THOUGHT_LINGER_MS) || 60_000
  const rows: Array<[string, string]> = [
    ['engine', `${f.engine} (default codex)`],
    ['codex model', `${f.codexModel} (default ${DEFAULT_CODEX_MODEL})`],
    ['api model', `${process.env.GPT_MODEL || DEFAULT_OPENAI_MODEL} (env, global)`],
    ['effort', `${f.reasoning} (default high)`],
        ['thinking', `${f.thinking} (default live)`],
        ['trace', `${f.trace} (default collapse)`],
    ['counter', `${f.counter} (default both)`],
    ['require @', f.requireMention ? 'yes' : 'no'],
    ['collapse linger', `${Math.round(lingerMs / 1000)}s`],
  ]
  const pad = Math.max(...rows.map(([k]) => k.length))
  const body = rows.map(([k, v]) => `${k.padEnd(pad)} : ${v}`).join('\n')
  return `⚙️ **gpt settings** — <#${channelId}>\n\`\`\`\n${body}\n\`\`\``
}

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
    .setDescription('Enable a channel and set its mention rule')
    .addChannelOption(o => o.setName('channel').setDescription('The channel to configure').setRequired(true))
    .addBooleanOption(o => o.setName('enabled').setDescription('Enable bot in this channel').setRequired(true))
    .addBooleanOption(o => o.setName('require_mention').setDescription('Require explicit mention').setRequired(true))
  )
  .addSubcommand(s => s
    .setName('stop')
    .setDescription('Stop the active turn')
  )
  .addSubcommand(s => s
    .setName('clear')
    .setDescription('Reset this channel')
  )
  .addSubcommand(s => s
    .setName('compact')
    .setDescription('Summarize this channel and start a fresh Codex session')
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('session')
    .setDescription('Show this channel’s current Codex session usage')
  )
  .addSubcommand(s => s
    .setName('doctor')
    .setDescription('Validate gpt runtime state and rollout plumbing')
  )
  .addSubcommand(s => s
    .setName('stats')
    .setDescription('Show cumulative token usage')
  )
  .addSubcommand(s => s
    .setName('limits')
    .setDescription('Show Codex subscription usage')
  )
  .addSubcommand(s => s
    .setName('settings')
    .setDescription('Show this channel’s settings')
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('model')
    .setDescription('Set or show the Codex model')
    .addStringOption(o => o.setName('value').setDescription('omit to show current; else pick a model').setRequired(false)
      .addChoices(
        { name: 'gpt-6-astra', value: 'gpt-6-astra' },
        { name: 'gpt-5.6-sol - frontier coding', value: 'gpt-5.6-sol' },
        { name: 'gpt-5.6-terra - balanced', value: 'gpt-5.6-terra' },
        { name: 'gpt-5.6-luna - high-throughput', value: 'gpt-5.6-luna' },
        { name: 'Daybreak Blue - defensive cyber', value: 'gpt-daybreak-blue-latest' },
      ))
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('effort')
    .setDescription('Set or show reasoning effort')
    .addStringOption(o => o
      .setName('value')
      .setDescription('low | medium | high | xhigh | max | ultra')
      .setRequired(true)
      .addChoices(
        { name: 'low', value: 'low' },
        { name: 'medium', value: 'medium' },
        { name: 'high', value: 'high' },
        { name: 'xhigh', value: 'xhigh' },
        { name: 'max - deepest, slowest', value: 'max' },
        { name: 'ultra - automatic delegation', value: 'ultra' },
      )
    )
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('counter')
    .setDescription('Set or show the footer counter')
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
    .setDescription('Set or show the chat engine')
    .addStringOption(o => o
      .setName('value')
      .setDescription('codex | api')
      .setRequired(true)
      .addChoices(
        { name: 'codex - Codex subscription (default)', value: 'codex' },
        { name: 'api - metered OpenAI API', value: 'api' },
      )
    )
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('trace')
    .setDescription('Set or show tool traces')
    .addStringOption(o => o
      .setName('value').setDescription('off | on | live | collapse').setRequired(true)
      .addChoices(
        { name: 'off', value: 'off' },
        { name: 'on — keep the full paginated trace', value: 'on' },
        { name: 'live — one rolling trace window', value: 'live' },
        { name: 'collapse — full trace, delete after the reply', value: 'collapse' },
      )
    )
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('thinking')
    .setDescription('Set or show reasoning display')
    .addStringOption(o => o
      .setName('value').setDescription('off | on | live | collapse').setRequired(true)
      .addChoices(
        { name: 'off', value: 'off' },
        { name: 'on — keep the reasoning card', value: 'on' },
        { name: 'live — show only the current thought', value: 'live' },
        { name: 'collapse — stream the full trace, then collapse', value: 'collapse' },
      )
    )
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('mention')
    // Arg-less TOGGLE: the setting is binary, so forcing a menu pick is a
    // wasted tap — read the current value and flip it (Jeff 2026-07-29).
    .setDescription('Toggle mention gating for this channel')
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )

export interface CompactCommandDeps {
  summarizer: { runForChannel(channelId: string): Promise<{ messageCount: number } | null> } | null
  isTurnActive?: (channelId: string) => boolean
  dropSession?: (channelId: string) => boolean
  doctor?: DoctorRuntimeDeps
  admission?: () => {
    running: number
    queued: number
    oldestWaitMs: number
    pausedForMemory: boolean
  }
  stopChannel?: (channelIds: Array<string | null | undefined>) => string | null
}

export type CompactResult =
  | { status: 'busy' }
  | { status: 'unavailable' }
  | { status: 'compacted'; messageCount: number; droppedSession: boolean }

/** Preserve channel history in the rolling summary, then discard the bloated
 * Codex process context. Unlike /gpt clear, this never stamps a history cutoff. */
export async function compactChannel(
  channelId: string,
  deps: CompactCommandDeps,
): Promise<CompactResult> {
  const isTurnActive = deps.isTurnActive ?? (id => activeTurns.isActive(id))
  if (isTurnActive(channelId)) return { status: 'busy' }
  if (!deps.summarizer) return { status: 'unavailable' }

  const summary = await deps.summarizer.runForChannel(channelId)
  const dropSession = deps.dropSession ?? (id => channelSessions.dropSession(id))
  const droppedSession = dropSession(channelId)
  return {
    status: 'compacted',
    messageCount: summary?.messageCount ?? 0,
    droppedSession,
  }
}

export async function executeGptCommand(
  interaction: ChatInputCommandInteraction,
  access: AccessManager,
  adminUserId: string | undefined,
  deps: CompactCommandDeps = { summarizer: null },
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
      const previous = access.channelConfig(channel.id)
      await access.setChannel(channel.id, enabled, requireMention)
      const was = previous
        ? ` (was ${previous.enabled ? 'enabled' : 'disabled'} · require @ ${previous.requireMention ? 'yes' : 'no'})`
        : ''
      return interaction.reply({
        content: `✅ <#${channel.id}> ${enabled ? 'enabled' : 'disabled'} · require @ ${requireMention ? 'yes' : 'no'}${was}\n\n${settingsCard(access, channel.id)}`,
        ephemeral: true
      })
    }

    if (subcommand === 'session') {
      const sid = channelSessions.get(interaction.channelId)
      if (!sid) {
        return interaction.reply({ content: 'ℹ️ No active Codex session in this channel.', ephemeral: true })
      }
      await interaction.deferReply({ ephemeral: true })
      const stats = await readSessionStats(sid)
      if (!stats) return interaction.editReply('⚠️ Session pointer exists but its rollout is unreadable.')
      const h = (value: number) => value.toLocaleString('en-US')
      const contextPct = stats.contextWindow > 0
        ? `${Math.round(stats.lastInputTokens / stats.contextWindow * 100)}%`
        : 'unknown'
      return interaction.editReply([
        `🧠 **gpt session** — \`${sid.slice(0, 8)}\``,
        '```',
        `turns:      ${h(stats.turns)}`,
        `model:      ${stats.model} · effort ${stats.effort}`,
        `input:      ${h(stats.inputTokens)} (${h(stats.cachedInputTokens)} cached)`,
        `output:     ${h(stats.outputTokens)} (${h(stats.reasoningTokens)} reasoning)`,
        `total:      ${h(stats.totalTokens)}`,
        `context:    ${h(stats.lastInputTokens)} / ${h(stats.contextWindow)} (${contextPct})`,
        '```',
      ].join('\n'))
    }

    if (subcommand === 'doctor') {
      await interaction.deferReply({ ephemeral: true })
      const report = await runGptDoctor(undefined, undefined, deps.doctor)
      const lines = report.checks.map(check =>
        `${check.ok ? 'ok' : 'FAIL'}  ${check.name.padEnd(16)} ${check.detail}`)
      return interaction.editReply([
        `${report.ok ? '✅' : '⚠️'} **gpt doctor**`,
        '```', ...lines, '```',
      ].join('\n'))
    }

    if (subcommand === 'stop') {
      const parentId = interaction.channel?.isThread() ? interaction.channel.parentId : null
      const stoppedChannelId = deps.stopChannel?.([interaction.channelId, parentId])
        ?? activeTurns.stopResolvable([interaction.channelId, parentId])
      return interaction.reply({
        content: stoppedChannelId ? INTERRUPTED_MARKER : 'ℹ️ Nothing running here',
        ephemeral: true,
      })
    }

    if (subcommand === 'clear') {
      // clear() drops the codex session AND stamps the history cutoff, so the next
      // turn ignores all prior channel messages — a true reset regardless of
      // whether a codex session object existed. Always confirm (Jeff 2026-06-27).
      channelSessions.clear(interaction.channelId)
      return interaction.reply({
        content: fmtClearAcknowledgement(interaction.channelId),
        ephemeral: true,
      })
    }

    if (subcommand === 'compact') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved.', ephemeral: true })
      }
      if ((deps.isTurnActive ?? (id => activeTurns.isActive(id)))(channel.id)) {
        return interaction.reply({
          content: `⚠️ <#${channel.id}> has a turn running. Compact it after that finishes.`,
          ephemeral: true,
        })
      }
      if (!deps.summarizer) {
        return interaction.reply({
          content: '⚠️ Summarization is unavailable on this runtime, so I left the session intact.',
          ephemeral: true,
        })
      }

      await interaction.deferReply({ ephemeral: true })
      try {
        const result = await compactChannel(channel.id, deps)
        if (result.status === 'busy') {
          return interaction.editReply(`⚠️ <#${channel.id}> started a turn before compaction could run. Try again when it finishes.`)
        }
        if (result.status === 'unavailable') {
          return interaction.editReply('⚠️ Summarization became unavailable, so I left the session intact.')
        }
        const summarized = result.messageCount > 0
          ? `summarized ${result.messageCount} new messages`
          : 'rolling summary already current'
        const session = result.droppedSession
          ? 'fresh Codex session starts next turn'
          : 'no active Codex session needed dropping'
        return interaction.editReply(`🧹 <#${channel.id}> compacted — ${summarized}; ${session}.`)
      } catch (e: any) {
        return interaction.editReply(`❌ compact failed; existing session preserved: ${e?.message ?? String(e)}`)
      }
    }

    if (subcommand === 'model') {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      const raw = interaction.options.getString('value')
      if (!raw) {
        const flags = access.channelFlags(channel.id)
        const cur = flags.codexModel ?? DEFAULT_CODEX_MODEL
        return interaction.reply({ content: fmtModelStatus(channel.id, cur, flags.reasoning), ephemeral: true })
      }
      const value = raw.trim().toLowerCase()
      if (!(CODEX_MODELS as readonly string[]).includes(value)) {
        return interaction.reply({ content: `❌ \`model\` must be one of: ${CODEX_MODELS.join(' | ')} (got \`${value}\`)`, ephemeral: true })
      }
      const previous = access.channelFlags(channel.id).codexModel
      const updated = await access.setChannelFlags(channel.id, { codexModel: value as CodexModel })
      return interaction.reply({ content: `${fmtSettingChange('codex model', updated.codexModel!, previous)}\n\n${settingsCard(access, channel.id)}`, ephemeral: true })
    }

    if (subcommand === 'limits') {
      const rl = await readLatestRateLimits()
      const plan = rl?.planType ? ` (plan: ${rl.planType})` : ''
      const body = ['\ud83c\udfab @gpt — Codex subscription limits' + plan, '```', ...fmtLimitLines(rl), '```'].join('\n')
      return interaction.reply({ content: body, ephemeral: true })
    }

    if (subcommand === 'stats') {
      const g = globalSnapshot()
      const n = (x: number) => x.toLocaleString('en-US')
      // Humanize big token counts so they don't sprawl: 4.39M / 45k / 1,234.
      const h = (x: number) => x >= 1e6 ? `${(x / 1e6).toFixed(2)}M` : x >= 1e4 ? `${Math.round(x / 1e3)}k` : n(x)
      const uncachedIn = Math.max(0, g.inputTokens - g.cachedInputTokens)
      const dIn = uncachedIn * 5.00 / 1e6        // gpt-5.6-sol, per 1M
      const dCached = g.cachedInputTokens * 0.50 / 1e6
      const dOut = g.outputTokens * 30.00 / 1e6
      const dTotal = dIn + dCached + dOut
      const total = g.inputTokens + g.outputTokens
      const cachePct = g.inputTokens > 0 ? Math.round((g.cachedInputTokens / g.inputTokens) * 100) : 0
      const upMin = Math.floor((Date.now() - g.bootTs) / 60000)
      const up = `${Math.floor(upMin / 60)}h ${upMin % 60}m`
      const engines = Object.entries(g.byModel).map(([m, ct]) => `${m} ${ct}`).join(' · ') || '—'
      const rl = await readLatestRateLimits()
      const contextPressure = fmtContextPressureLine(rl)
      const admission = deps.admission?.()
      const admissionLine = admission
        ? `work:      ${admission.running} running · ${admission.queued} queued`
          + `${admission.pausedForMemory ? ' · memory paused' : ''}`
        : ''
      const body = [
        '\ud83d\udcca @gpt usage — cumulative across restarts, all channels',
        '```',
        `turns:    ${n(g.turns)}`,
        `input:    ${h(g.inputTokens)} tok  (${h(g.cachedInputTokens)} cached, ${cachePct}%)`,
        `output:   ${h(g.outputTokens)} tok  (${h(g.reasoningTokens)} reasoning)`,
        `total:    ${h(total)} tok`,
        '',
        `Sol-equiv: $${dTotal.toFixed(2)}   (API-rate estimate)`,
        `          in $${dIn.toFixed(2)} \u00b7 cached $${dCached.toFixed(2)} \u00b7 out $${dOut.toFixed(2)}`,
        '',
        `engines:  ${engines}`,
        `uptime:   ${up}`,
        ...(admissionLine ? [admissionLine] : []),
        ...(contextPressure ? [contextPressure] : []),
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
      return interaction.reply({ content: settingsCard(access, channel.id), ephemeral: true })
    }

    if (subcommand === 'effort') {
      const value = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: 'No channel resolved (run inside a channel or pass the channel arg).', ephemeral: true })
      }
      if (!['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(value)) {
        return interaction.reply({ content: `effort must be none, low, medium, high, xhigh, max, or ultra (got ${value})`, ephemeral: true })
      }
      try {
        const previous = access.channelFlags(channel.id).reasoning
        const updated = await access.setChannelFlags(channel.id, { reasoning: value as ReasoningEffort })
        return interaction.reply({ content: `${fmtSettingChange('effort', updated.reasoning!, previous)}\n\n${settingsCard(access, channel.id)}`, ephemeral: true })
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
        const previous = access.channelFlags(channel.id).counter
        const updated = await access.setChannelFlags(channel.id, { counter: value })
        return interaction.reply({ content: `${fmtSettingChange('counter', updated.counter!, previous)}\n\n${settingsCard(access, channel.id)}`, ephemeral: true })
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
        const previous = access.channelFlags(channel.id).engine
        const updated = await access.setChannelFlags(channel.id, { engine: value })
        return interaction.reply({ content: `${fmtSettingChange('engine', updated.engine!, previous)}\n\n${settingsCard(access, channel.id)}`, ephemeral: true })
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
      const valid = subcommand === 'thinking'
        ? ['off', 'on', 'live', 'collapse']
        : ['off', 'on', 'live', 'collapse']
      if (!valid.includes(value)) {
        return interaction.reply({ content: `❌ \`${subcommand}\` must be ${valid.join(' | ')} (got \`${value}\`)`, ephemeral: true })
      }
      try {
        const tri = value as 'off' | 'on' | 'live' | 'collapse'
        const previous = access.channelFlags(channel.id)[subcommand]
        const updated = await access.setChannelFlags(channel.id,
          subcommand === 'trace'
            ? { trace: tri }
            : { thinking: tri })
        const shown = subcommand === 'trace' ? updated.trace : updated.thinking
        return interaction.reply({ content: `${fmtSettingChange(subcommand, String(shown), String(previous))}\n\n${settingsCard(access, channel.id)}`, ephemeral: true })
      } catch (e: any) {
        return interaction.reply({ content: `❌ ${e.message}`, ephemeral: true })
      }
    }

    if (subcommand === 'mention') {
      // No 'value' read here any more — the option is gone, and
      // getString('value', true) THROWS on a missing required option, so
      // leaving it would break /mention at runtime while typechecking clean.
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }
      try {
        const wasOn = !!access.channelFlags(channel.id).requireMention
        const previous = wasOn ? 'yes' : 'no'
        const updated = await access.setChannelFlags(channel.id, { requireMention: !wasOn })
        return interaction.reply({ content: `${fmtSettingChange('require @', updated.requireMention ? 'yes' : 'no', previous)}\n\n${settingsCard(access, channel.id)}`, ephemeral: true })
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
