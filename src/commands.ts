import { SlashCommandBuilder, PermissionFlagsBits, ChatInputCommandInteraction } from 'discord.js'
import path from 'node:path'
import os from 'node:os'
import { AccessManager, type ReasoningEffort } from './access.ts'
import { PersonaLoader } from './persona.ts'
import { snapshot as cacheSnapshot } from './cache-stats.ts'
import { rewriteEnvVar, scheduleSelfRestart } from './restart.ts'

const ALLOWED_MODELS = ['gpt-5.5', 'gpt-5.4-mini', 'o3'] as const

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
    .setDescription('Set bot access for a channel — enable + mention rule. Other flags via /gpt set.')
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
    .setName('model')
    .setDescription('Swap the default model (writes OPENAI_MODEL in .env, restarts the bot in ~1.5s).')
    .addStringOption(o => o
      .setName('value')
      .setDescription('Model name (gpt-5.5 | gpt-5.4-mini | o3)')
      .setRequired(true)
      .addChoices(
        { name: 'gpt-5.5 — flagship', value: 'gpt-5.5' },
        { name: 'gpt-5.4-mini — cheaper, low-latency', value: 'gpt-5.4-mini' },
        { name: 'o3 — strongest reasoning', value: 'o3' },
      )
    )
  )
  .addSubcommand(s => s
    .setName('cache')
    .setDescription('Show recent prompt-cache hit telemetry for this channel (rolling window of last 50 turns).')
    .addChannelOption(o => o.setName('channel').setDescription('Channel (defaults to current)').setRequired(false))
  )
  .addSubcommand(s => s
    .setName('set')
    .setDescription('Set a per-channel flag: model, reasoning, show_code, verbose, trace, thinking, require_mention.')
    .addStringOption(o => o
      .setName('flag')
      .setDescription('Which flag to set')
      .setRequired(true)
      .addChoices(
        { name: 'model — gpt-5.5 | gpt-5.4-mini | o3 (or "default" to clear)', value: 'model' },
        { name: 'reasoning — minimal | low | medium | high (o-series only)', value: 'reasoning' },
        { name: 'show_code — render tool-call artifacts', value: 'show_code' },
        { name: 'verbose — usage/finish_reason footer', value: 'verbose' },
        { name: 'trace — diff-style tool-trace card', value: 'trace' },
        { name: 'thinking — post the model reasoning summary', value: 'thinking' },
        { name: 'require_mention — only respond when @-mentioned', value: 'require_mention' },
      )
    )
    .addStringOption(o => o
      .setName('value')
      .setDescription('See flag choices for valid values.')
      .setRequired(true)
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
      const modelDisplay = flags.model ?? '(default)'
      return interaction.reply({
        content: `✅ <#${channel.id}> configured. enabled=${enabled}, requireMention=${requireMention}. flags: model=${modelDisplay}, reasoning=${flags.reasoning}, showCode=${flags.showCode}, verbose=${flags.verbose} — change via \`/gpt set\`.`,
        ephemeral: true
      })
    }

    if (subcommand === 'persona') {
      const filename = interaction.options.getString('filename', true)
      await persona.load(filename)
      return interaction.reply({ content: `✅ Persona swapped to \`${filename}\`.`, ephemeral: true })
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
      const newModel = interaction.options.getString('value', true)
      if (!ALLOWED_MODELS.includes(newModel as typeof ALLOWED_MODELS[number])) {
        return interaction.reply({
          content: `❌ Model must be one of: ${ALLOWED_MODELS.join(', ')}. Got \`${newModel}\`.`,
          ephemeral: true
        })
      }
      const stateDir = process.env.GPT_STATE_DIR || path.join(os.homedir(), '.gpt', 'channels', 'discord')
      const envPath = path.join(stateDir, '.env')
      try {
        await rewriteEnvVar(envPath, 'OPENAI_MODEL', newModel)
      } catch (e: any) {
        return interaction.reply({
          content: `❌ Could not write \`${envPath}\`: ${e?.message ?? e}`,
          ephemeral: true,
        })
      }
      // Reply BEFORE scheduling the restart so Discord acks while the process
      // is still alive. The detached `bash -c 'sleep ... && systemctl restart'`
      // outlives this process; systemd brings us back up reading the new env.
      await interaction.reply({
        content: `🔁 Model set to \`${newModel}\`. Restarting in ~1.5s — back in a few seconds with the new model loaded.`,
        ephemeral: true,
      })
      scheduleSelfRestart('gpt', 1500)
      return
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
          `output tokens:  ${outK}k`,
          '```' + reasoningLine + modelsLine,
          `_OpenAI caches prompt prefixes automatically — no TTL or flush controls. Cached tokens bill at ~50% of the input rate._`
        ].join('\n'),
        ephemeral: true
      })
    }

    if (subcommand === 'set') {
      const flag = interaction.options.getString('flag', true)
      const rawValue = interaction.options.getString('value', true).trim().toLowerCase()
      const channel = interaction.options.getChannel('channel') ?? interaction.channel
      if (!channel) {
        return interaction.reply({ content: '❌ No channel resolved (run from inside a channel or pass the channel arg).', ephemeral: true })
      }

      try {
        let updated
        if (flag === 'model') {
          // "default" sentinel clears the per-channel override.
          if (rawValue === 'default' || rawValue === '') {
            updated = await access.setChannelFlags(channel.id, { model: null })
          } else if (!ALLOWED_MODELS.includes(rawValue as typeof ALLOWED_MODELS[number])) {
            return interaction.reply({
              content: `❌ \`model\` value must be one of: ${ALLOWED_MODELS.join(', ')} (or "default" to clear). Got \`${rawValue}\`.`,
              ephemeral: true
            })
          } else {
            updated = await access.setChannelFlags(channel.id, { model: rawValue })
          }
        } else if (flag === 'reasoning') {
          if (!['minimal', 'low', 'medium', 'high'].includes(rawValue)) {
            return interaction.reply({
              content: `❌ \`reasoning\` value must be one of: minimal, low, medium, high (got \`${rawValue}\`)`,
              ephemeral: true
            })
          }
          updated = await access.setChannelFlags(channel.id, { reasoning: rawValue as ReasoningEffort })
        } else if (flag === 'show_code' || flag === 'verbose' || flag === 'trace' || flag === 'thinking' || flag === 'require_mention') {
          const truthy = ['true', 't', 'yes', 'y', 'on', '1']
          const falsy = ['false', 'f', 'no', 'n', 'off', '0']
          let parsed: boolean
          if (truthy.includes(rawValue)) parsed = true
          else if (falsy.includes(rawValue)) parsed = false
          else {
            return interaction.reply({
              content: `❌ \`${flag}\` value must be true or false (got \`${rawValue}\`)`,
              ephemeral: true
            })
          }
          const fieldKey =
            flag === 'show_code' ? 'showCode'
            : flag === 'verbose' ? 'verbose'
            : flag === 'trace' ? 'trace'
            : flag === 'thinking' ? 'thinking'
            : 'requireMention'
          updated = await access.setChannelFlags(channel.id, { [fieldKey]: parsed })
        } else {
          return interaction.reply({
            content: `❌ unknown flag \`${flag}\`. Choices: model, reasoning, show_code, verbose, trace, thinking, require_mention.`,
            ephemeral: true
          })
        }

        const modelDisplay = updated.model ?? '(default)'
        const summary = `model=${modelDisplay}, reasoning=${updated.reasoning}, showCode=${updated.showCode}, verbose=${updated.verbose}, trace=${updated.trace}, thinking=${updated.thinking}, requireMention=${updated.requireMention}`
        return interaction.reply({
          content: `✅ <#${channel.id}> \`${flag}\` set. ${summary}`,
          ephemeral: true
        })
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
