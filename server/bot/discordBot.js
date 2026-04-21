const {
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  REST,
  Routes
} = require("discord.js");

const { commandPayloads } = require("./commands");

function getNotificationColor(event) {
  switch (event) {
    case "LOCKER_OPENED":
    case "KEY_RETURNED":
      return 0x22c55e;
    case "INVALID_CODE":
      return 0xef4444;
    case "CODE_DEACTIVATED":
    case "KEY_REMOVED":
      return 0xf59e0b;
    default:
      return 0x3b82f6;
  }
}

function getLogText(log) {
  switch (log.event) {
    case "LOCKER_OPENED":
      return `Skrytka S${log.locker} została otwarta kodem \`${log.code}\`.`;
    case "INVALID_CODE":
      return `Wprowadzono nieprawidłowy kod \`${log.code}\`.`;
    case "CODE_GENERATED":
      return `Wygenerowano kod \`${log.code}\` dla skrytki S${log.locker}.`;
    case "CODE_DEACTIVATED":
      return `Dezaktywowano kod \`${log.code}\` dla skrytki S${log.locker}.`;
    case "KEY_REMOVED":
      return `Klucz został wyjęty ze skrytki S${log.locker}.`;
    case "KEY_RETURNED":
      return `Klucz został zwrócony do skrytki S${log.locker}.`;
    default:
      return "Wystąpiło nowe zdarzenie w systemie.";
  }
}

function buildLogEmbed(log) {
  const embed = new EmbedBuilder()
    .setColor(getNotificationColor(log.event))
    .setTitle(`LIVE: ${log.event}`)
    .setDescription(getLogText(log))
    .setTimestamp(new Date(log.timestamp || Date.now()));

  if (log.source || log.actor) {
    embed.addFields({
      name: "Źródło",
      value: `${log.source || "system"}${log.actor ? ` • ${log.actor}` : ""}`
    });
  }

  return embed;
}

async function registerCommands(config) {
  const rest = new REST({ version: "10" }).setToken(config.token);

  if (config.guildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.clientId, config.guildId),
      { body: commandPayloads }
    );
    return "guild";
  }

  await rest.put(
    Routes.applicationCommands(config.clientId),
    { body: commandPayloads }
  );
  return "global";
}

function formatActiveCodes(codes) {
  if (codes.length === 0) {
    return "Brak aktywnych kodów.";
  }

  return codes
    .map(code => `• \`${code.code}\` • S${code.locker} • do ${new Date(code.expiresAt).toLocaleString("pl-PL")}`)
    .join("\n");
}

function formatLockers(lockers) {
  return lockers
    .map(locker => `• S${locker.locker}: ${locker.hasTag ? "tag obecny" : "brak tagu"}`)
    .join("\n");
}

async function createDiscordBot(config, lockerService) {
  if (!config.token || !config.clientId) {
    return null;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  let notificationsChannel = null;

  client.once("ready", async readyClient => {
    const scope = await registerCommands(config);
    if (config.notificationsChannelId) {
      notificationsChannel = await readyClient.channels.fetch(config.notificationsChannelId).catch(() => null);
    }

    console.log(`Discord bot zalogowany jako ${readyClient.user.tag} (${scope} commands).`);
  });

  client.on("interactionCreate", async interaction => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const actor = `${interaction.user.tag} (${interaction.user.id})`;

    try {
      switch (interaction.commandName) {
        case "locker-generate": {
          const locker = interaction.options.getInteger("skrytka", true);
          const hours = interaction.options.getInteger("godziny", true);
          const result = await lockerService.generateCode(locker, hours, {
            source: "discord",
            actor
          });

          await interaction.reply({
            content: `Wygenerowano kod \`${result.code}\` dla skrytki S${locker}. Ważny do ${new Date(result.expiresAt).toLocaleString("pl-PL")}.`,
            ephemeral: true
          });
          break;
        }

        case "locker-status": {
          const lockers = await lockerService.getLockers();
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(0x3b82f6)
                .setTitle("Status skrytek")
                .setDescription(formatLockers(lockers))
            ],
            ephemeral: true
          });
          break;
        }

        case "locker-codes": {
          const codes = await lockerService.getActiveCodes();
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setColor(0x3b82f6)
                .setTitle("Aktywne kody")
                .setDescription(formatActiveCodes(codes))
            ],
            ephemeral: true
          });
          break;
        }

        case "locker-deactivate": {
          const code = interaction.options.getString("kod", true);
          await lockerService.deactivateCode(code, {
            source: "discord",
            actor
          });

          await interaction.reply({
            content: `Kod \`${code}\` został dezaktywowany.`,
            ephemeral: true
          });
          break;
        }

        case "locker-logs-clear": {
          await lockerService.clearLogs({
            source: "discord",
            actor
          });

          await interaction.reply({
            content: "Logi zostały wyczyszczone.",
            ephemeral: true
          });
          break;
        }
      }
    } catch (error) {
      const message = error.status && error.status < 500
        ? error.message
        : "Nie udało się wykonać komendy.";

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: message, ephemeral: true }).catch(() => {});
      } else {
        await interaction.reply({ content: message, ephemeral: true }).catch(() => {});
      }
    }
  });

  lockerService.on("log", log => {
    if (!notificationsChannel) {
      return;
    }

    notificationsChannel.send({ embeds: [buildLogEmbed(log)] }).catch(error => {
      console.error("Nie udało się wysłać powiadomienia Discord.", error);
    });
  });

  lockerService.on("logs-cleared", payload => {
    if (!notificationsChannel) {
      return;
    }

    notificationsChannel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(0xf59e0b)
          .setTitle("LIVE: LOGS_CLEARED")
          .setDescription("Logi systemowe zostały wyczyszczone.")
          .addFields({
            name: "Źródło",
            value: `${payload.source || "system"}${payload.actor ? ` • ${payload.actor}` : ""}`
          })
          .setTimestamp(new Date())
      ]
    }).catch(error => {
      console.error("Nie udało się wysłać powiadomienia o czyszczeniu logów.", error);
    });
  });

  await client.login(config.token);
  return client;
}

module.exports = {
  createDiscordBot
};
