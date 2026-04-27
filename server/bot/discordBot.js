const {
  ActionRowBuilder,
  MessageFlags,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  ModalBuilder,
  REST,
  TextInputBuilder,
  TextInputStyle,
  Routes
} = require("discord.js");

const { commandPayloads } = require("./commands");

const CUSTOM_IDS = {
  OVERVIEW: "safekeys:overview",
  STATUS: "safekeys:status",
  CODES: "safekeys:codes",
  LOGS: "safekeys:logs",
  OPEN_LOCKER_1: "safekeys:open-locker:1",
  OPEN_LOCKER_2: "safekeys:open-locker:2",
  OPEN_LOCKER_3: "safekeys:open-locker:3",
  DEACTIVATE: "safekeys:deactivate",
  CLEAR_LOGS: "safekeys:clear-logs",
  RELEASE_ALL: "safekeys:release-all",
  DEACTIVATE_MODAL: "safekeys:deactivate-modal",
  DEACTIVATE_CODE_INPUT: "safekeys:deactivate-code-input"
};

const BRAND = {
  name: "SafeKeys Control",
  accent: 0x2563eb,
  success: 0x16a34a,
  danger: 0xdc2626,
  warning: 0xea580c,
  neutral: 0x0f172a
};

const EVENT_META = {
  LOCKER_OPENED: {
    color: BRAND.success,
    label: "Skrytka otwarta",
    emoji: "🔓"
  },
  INVALID_CODE: {
    color: BRAND.danger,
    label: "Bledny kod",
    emoji: "🚫"
  },
  CODE_GENERATED: {
    color: BRAND.accent,
    label: "Kod wygenerowany",
    emoji: "✨"
  },
  CODE_EMAIL_SENT: {
    color: BRAND.success,
    label: "Kod wyslany e-mailem",
    emoji: "✉️"
  },
  CODE_EMAIL_FAILED: {
    color: BRAND.danger,
    label: "Blad wysylki e-mail",
    emoji: "📭"
  },
  CODE_DEACTIVATED: {
    color: BRAND.warning,
    label: "Kod dezaktywowany",
    emoji: "🛑"
  },
  KEY_REMOVED: {
    color: BRAND.warning,
    label: "Klucz odebrany",
    emoji: "🗝️"
  },
  KEY_RETURNED: {
    color: BRAND.success,
    label: "Klucz zwrocony",
    emoji: "📥"
  },
  LOGS_CLEARED: {
    color: BRAND.warning,
    label: "Logi wyczyszczone",
    emoji: "🧹"
  },
  LOCKER_DOOR_OPENED: {
    color: BRAND.warning,
    label: "Drzwiczki otwarte",
    emoji: "🚪"
  },
  LOCKER_DOOR_CLOSED: {
    color: BRAND.success,
    label: "Drzwiczki zamkniete",
    emoji: "✅"
  },
  REMOTE_UNLOCK_REQUESTED: {
    color: BRAND.accent,
    label: "Zdalne otwarcie",
    emoji: "🛰️"
  },
  REMOTE_RELEASE_ALL_REQUESTED: {
    color: BRAND.warning,
    label: "Zwolnienie wszystkich blokad",
    emoji: "⚠️"
  },
  RFID_ACCESS_GRANTED: {
    color: BRAND.success,
    label: "Dostep RFID przyznany",
    emoji: "🪪"
  },
  RFID_ACCESS_DENIED: {
    color: BRAND.danger,
    label: "Dostep RFID odrzucony",
    emoji: "⛔"
  },
  RFID_USER_CREATED: {
    color: BRAND.accent,
    label: "Uzytkownik RFID dodany",
    emoji: "👤"
  },
  RFID_USER_UPDATED: {
    color: BRAND.accent,
    label: "Uzytkownik RFID zaktualizowany",
    emoji: "🛠️"
  },
  RFID_USER_DELETED: {
    color: BRAND.warning,
    label: "Uzytkownik RFID usuniety",
    emoji: "🗑️"
  }
};

function getEventMeta(event) {
  return EVENT_META[event] || {
    color: BRAND.accent,
    label: "Zdarzenie systemowe",
    emoji: "📡"
  };
}

function formatDate(value) {
  return new Date(value).toLocaleString("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function formatRelativeExpiry(value) {
  const diffMs = new Date(value).getTime() - Date.now();
  const diffMinutes = Math.max(0, Math.round(diffMs / 60000));

  if (diffMinutes < 60) {
    return `${diffMinutes} min`;
  }

  const hours = Math.floor(diffMinutes / 60);
  const minutes = diffMinutes % 60;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}

function getLogText(log) {
  switch (log.event) {
    case "LOCKER_OPENED":
      return `Skrytka S${log.locker} zostala otwarta kodem \`${log.code}\`.`;
    case "INVALID_CODE":
      return `Wprowadzono nieprawidlowy kod \`${log.code}\`.`;
    case "CODE_GENERATED":
      return `Wygenerowano nowy kod \`${log.code}\` dla skrytki S${log.locker}.`;
    case "CODE_EMAIL_SENT":
      return `Kod \`${log.code}\` dla skrytki S${log.locker} zostal wyslany e-mailem.`;
    case "CODE_EMAIL_FAILED":
      return `Nie udalo sie wyslac kodu \`${log.code}\` dla skrytki S${log.locker} e-mailem.`;
    case "CODE_DEACTIVATED":
      return `Kod \`${log.code}\` dla skrytki S${log.locker} zostal dezaktywowany.`;
    case "KEY_REMOVED":
      return `Klucz zostal wyjety ze skrytki S${log.locker}.`;
    case "KEY_RETURNED":
      return `Klucz zostal zwrocony do skrytki S${log.locker}.`;
    case "LOCKER_DOOR_OPENED":
      return `Drzwiczki skrytki S${log.locker} sa otwarte.`;
    case "LOCKER_DOOR_CLOSED":
      return `Drzwiczki skrytki S${log.locker} zostaly domkniete.`;
    case "REMOTE_UNLOCK_REQUESTED":
      return `Wyslano zdalne polecenie otwarcia skrytki S${log.locker}.`;
    case "REMOTE_RELEASE_ALL_REQUESTED":
      return "Wyslano polecenie zwolnienia blokady wszystkich skrytek.";
    case "RFID_ACCESS_GRANTED":
      return "Przylozono autoryzowana karte RFID i odblokowano przypisane skrytki.";
    case "RFID_ACCESS_DENIED":
      return "Wykryto nieautoryzowany tag RFID na czytniku uzytkownika.";
    case "RFID_USER_CREATED":
      return "Dodano nowego uzytkownika RFID do systemu.";
    case "RFID_USER_UPDATED":
      return "Zaktualizowano konfiguracje uzytkownika RFID.";
    case "RFID_USER_DELETED":
      return "Usunieto uzytkownika RFID z systemu.";
    default:
      return "W systemie pojawilo sie nowe zdarzenie.";
  }
}

function buildBaseEmbed(title, color = BRAND.accent) {
  return new EmbedBuilder()
    .setColor(color)
    .setAuthor({ name: BRAND.name })
    .setTitle(title)
    .setTimestamp(new Date());
}

function buildLogEmbed(log) {
  const meta = getEventMeta(log.event);
  const embed = buildBaseEmbed(`${meta.emoji} ${meta.label}`, meta.color)
    .setDescription(getLogText(log))
    .setTimestamp(new Date(log.timestamp || Date.now()));

  const fields = [];

  if (log.locker) {
    fields.push({
      name: "Skrytka",
      value: `S${log.locker}`,
      inline: true
    });
  }

  if (log.code) {
    fields.push({
      name: "Kod",
      value: `\`${log.code}\``,
      inline: true
    });
  }

  fields.push({
    name: "Zrodlo",
    value: `${log.source || "system"}${log.actor ? ` • ${log.actor}` : ""}`,
    inline: false
  });

  embed.addFields(fields);
  return embed;
}

function buildSuccessEmbed(title, description) {
  return buildBaseEmbed(title, BRAND.success).setDescription(description);
}

function buildErrorEmbed(description) {
  return buildBaseEmbed("Problem z wykonaniem komendy", BRAND.danger)
    .setDescription(description);
}

function formatActiveCodes(codes) {
  if (codes.length === 0) {
    return "Brak aktywnych kodow w tej chwili.";
  }

  return codes
    .map(code => [
      `\`${code.code}\` • skrytka S${code.locker}`,
      `wygasa: ${formatDate(code.expiresAt)}`,
      `pozostalo: ${formatRelativeExpiry(code.expiresAt)}`
    ].join("\n"))
    .join("\n\n");
}

function formatLockerStatus(lockers) {
  return lockers
    .map(locker => {
      const state = locker.hasTag ? "klucz obecny" : "klucza brak";
      const badge = locker.hasTag ? "🟢" : "🔴";
      const door = locker.isDoorClosed ? "drzwiczki domkniete" : "drzwiczki otwarte";
      const doorBadge = locker.isDoorClosed ? "🧲" : "🚪";
      return `${badge} S${locker.locker} • ${state}\n${doorBadge} ${door}`;
    })
    .join("\n");
}

function formatRecentLogs(logs) {
  if (logs.length === 0) {
    return "Brak zdarzen do wyswietlenia.";
  }

  return logs
    .slice(0, 8)
    .map(log => {
      const meta = getEventMeta(log.event);
      return `${meta.emoji} ${meta.label} • ${formatDate(log.timestamp)}${log.locker ? ` • S${log.locker}` : ""}${log.code ? ` • \`${log.code}\`` : ""}`;
    })
    .join("\n");
}

function buildOverviewEmbed(lockers, codes, logs) {
  const occupiedCount = lockers.filter(locker => locker.hasTag).length;
  const availableCount = lockers.length - occupiedCount;
  const openDoorsCount = lockers.filter(locker => !locker.isDoorClosed).length;
  const nearestExpiry = codes[0];

  const embed = buildBaseEmbed("Centrum operacyjne SafeKeys", BRAND.accent)
    .setDescription("Szybki podglad na status skrytek, aktywne kody i ostatnie zdarzenia.")
    .addFields(
      {
        name: "Skrytki",
        value: `W systemie: **${lockers.length}**\nKlucz obecny: **${occupiedCount}**\nBrak klucza: **${availableCount}**`,
        inline: true
      },
      {
        name: "Aktywne kody",
        value: `Liczba kodow: **${codes.length}**${nearestExpiry ? `\nNajblizsze wygasniecie: **${formatRelativeExpiry(nearestExpiry.expiresAt)}**` : "\nBrak aktywnych kodow"}`,
        inline: true
      },
      {
        name: "Drzwiczki",
        value: openDoorsCount === 0 ? "Wszystkie domkniete." : `Otwarte: **${openDoorsCount}**`,
        inline: true
      },
      {
        name: "Status operacyjny",
        value: occupiedCount === lockers.length && openDoorsCount === 0 ? "Wszystkie klucze sa na miejscu." : "Czesc skrytek wymaga uwagi.",
        inline: false
      },
      {
        name: "Mapa skrytek",
        value: formatLockerStatus(lockers),
        inline: false
      },
      {
        name: "Ostatnie zdarzenia",
        value: formatRecentLogs(logs),
        inline: false
      }
    );

  return embed;
}

function buildCodesEmbed(codes) {
  return buildBaseEmbed("Aktywne kody dostepu", BRAND.accent)
    .setDescription(formatActiveCodes(codes))
    .setFooter({ text: `Aktywnych kodow: ${codes.length}` });
}

function buildStatusEmbed(lockers) {
  const ready = lockers.every(locker => locker.hasTag);

  return buildBaseEmbed("Status skrytek", ready ? BRAND.success : BRAND.warning)
    .setDescription(formatLockerStatus(lockers))
    .setFooter({
      text: ready ? "Wszystkie klucze sa obecne." : "Wykryto skrytki bez klucza."
    });
}

function buildLogsEmbed(logs) {
  return buildBaseEmbed("Ostatnie zdarzenia SafeKeys", BRAND.neutral)
    .setDescription(formatRecentLogs(logs))
    .setFooter({ text: `Pokazano ${Math.min(logs.length, 8)} z ${logs.length} zdarzen` });
}

function formatRfidUsers(users) {
  if (users.length === 0) {
    return "Brak zarejestrowanych uzytkownikow RFID.";
  }

  return users
    .slice(0, 12)
    .map(user => `• **${user.name}**\nTag: \`${user.tagId}\`\nSkrytki: ${user.allowedLockers.map(locker => `S${locker}`).join(", ")}`)
    .join("\n\n");
}

function buildUsersEmbed(users) {
  return buildBaseEmbed("Uzytkownicy RFID", BRAND.accent)
    .setDescription(formatRfidUsers(users))
    .setFooter({ text: `Uzytkownikow: ${users.length}` });
}

function parseLockerList(input) {
  return [...new Set(String(input)
    .split(",")
    .map(value => Number(value.trim()))
    .filter(value => Number.isInteger(value)))];
}

function buildDashboardComponents() {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CUSTOM_IDS.OVERVIEW)
        .setLabel("Overview")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(CUSTOM_IDS.STATUS)
        .setLabel("Skrytki")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(CUSTOM_IDS.CODES)
        .setLabel("Kody")
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(CUSTOM_IDS.LOGS)
        .setLabel("Logi")
        .setStyle(ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CUSTOM_IDS.OPEN_LOCKER_1)
        .setLabel("Otworz S1")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(CUSTOM_IDS.OPEN_LOCKER_2)
        .setLabel("Otworz S2")
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(CUSTOM_IDS.OPEN_LOCKER_3)
        .setLabel("Otworz S3")
        .setStyle(ButtonStyle.Primary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(CUSTOM_IDS.DEACTIVATE)
        .setLabel("Dezaktywuj kod")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(CUSTOM_IDS.RELEASE_ALL)
        .setLabel("Zwolnij wszystkie")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(CUSTOM_IDS.CLEAR_LOGS)
        .setLabel("Wyczysc logi")
        .setStyle(ButtonStyle.Secondary)
    )
  ];
}

function buildDeactivateModal() {
  return new ModalBuilder()
    .setCustomId(CUSTOM_IDS.DEACTIVATE_MODAL)
    .setTitle("Dezaktywacja kodu")
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId(CUSTOM_IDS.DEACTIVATE_CODE_INPUT)
          .setLabel("4-cyfrowy kod")
          .setPlaceholder("np. 4821")
          .setMinLength(4)
          .setMaxLength(4)
          .setRequired(true)
          .setStyle(TextInputStyle.Short)
      )
    );
}

async function fetchDashboardData(lockerService) {
  const [lockers, codes, logs] = await Promise.all([
    lockerService.getLockers(),
    lockerService.getActiveCodes(),
    lockerService.getLogs()
  ]);

  return { lockers, codes, logs };
}

function getActor(interaction) {
  return `${interaction.user.tag} (${interaction.user.id})`;
}

async function buildDashboardResponse(lockerService, view) {
  const { lockers, codes, logs } = await fetchDashboardData(lockerService);

  switch (view) {
    case CUSTOM_IDS.STATUS:
      return buildStatusEmbed(lockers);
    case CUSTOM_IDS.CODES:
      return buildCodesEmbed(codes);
    case CUSTOM_IDS.LOGS:
      return buildLogsEmbed(logs);
    default:
      return buildOverviewEmbed(lockers, codes, logs);
  }
}

async function executeRemoteOpen(lockerService, locker, actor, source = "discord") {
  return lockerService.openLocker(locker, {
    source,
    actor
  });
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

async function resolveNotificationsChannel(client, channelId) {
  if (!channelId) {
    return null;
  }

  return client.channels.fetch(channelId).catch(() => null);
}

async function replyWithEmbed(interaction, embed, options = {}) {
  await interaction.reply({
    embeds: [embed],
    flags: MessageFlags.Ephemeral,
    ...options
  });
}

async function createDiscordBot(config, lockerService) {
  if (!config.token || !config.clientId) {
    return null;
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds]
  });

  let notificationsChannel = null;

  client.once("clientReady", async readyClient => {
    const scope = await registerCommands(config);
    notificationsChannel = await resolveNotificationsChannel(readyClient, config.notificationsChannelId);
    console.log(`Discord bot zalogowany jako ${readyClient.user.tag} (${scope} commands).`);
  });

  client.on("interactionCreate", async interaction => {
    try {
      if (interaction.isButton()) {
        switch (interaction.customId) {
          case CUSTOM_IDS.OVERVIEW:
          case CUSTOM_IDS.STATUS:
          case CUSTOM_IDS.CODES:
          case CUSTOM_IDS.LOGS: {
            const embed = await buildDashboardResponse(lockerService, interaction.customId);
            await interaction.update({
              embeds: [embed],
              components: buildDashboardComponents()
            });
            return;
          }

          case CUSTOM_IDS.DEACTIVATE: {
            await interaction.showModal(buildDeactivateModal());
            return;
          }

          case CUSTOM_IDS.OPEN_LOCKER_1:
          case CUSTOM_IDS.OPEN_LOCKER_2:
          case CUSTOM_IDS.OPEN_LOCKER_3: {
            const locker = Number(interaction.customId.split(":").pop());
            await executeRemoteOpen(lockerService, locker, getActor(interaction));

            await interaction.update({
              embeds: [
                buildSuccessEmbed(
                  "Wyslano polecenie otwarcia",
                  `Skrytka **S${locker}** otrzymala zdalne polecenie otwarcia.`
                )
              ],
              components: buildDashboardComponents()
            });
            return;
          }

          case CUSTOM_IDS.CLEAR_LOGS: {
            await lockerService.clearLogs({
              source: "discord",
              actor: getActor(interaction)
            });

            await interaction.update({
              embeds: [
                buildSuccessEmbed(
                  "Logi wyczyszczone",
                  "Historia zdarzen zostala usunieta z panelu operacyjnego."
                )
              ],
              components: buildDashboardComponents()
            });
            return;
          }

          case CUSTOM_IDS.RELEASE_ALL: {
            await lockerService.releaseAllLockers({
              source: "discord",
              actor: getActor(interaction)
            });

            await interaction.update({
              embeds: [
                buildSuccessEmbed(
                  "Wyslano polecenie globalne",
                  "Zwolnienie blokady wszystkich skrytek zostalo zakolejkowane."
                )
              ],
              components: buildDashboardComponents()
            });
            return;
          }

          default:
            return;
        }
      }

      if (interaction.isModalSubmit()) {
        if (interaction.customId !== CUSTOM_IDS.DEACTIVATE_MODAL) {
          return;
        }

        const code = interaction.fields.getTextInputValue(CUSTOM_IDS.DEACTIVATE_CODE_INPUT).trim();

        await lockerService.deactivateCode(code, {
          source: "discord",
          actor: getActor(interaction)
        });

        await interaction.reply({
          embeds: [
            buildSuccessEmbed(
              "Kod dezaktywowany",
              `Kod \`${code}\` zostal bezpiecznie dezaktywowany.`
            )
          ],
          components: buildDashboardComponents(),
          flags: MessageFlags.Ephemeral
        });
        return;
      }

      if (!interaction.isChatInputCommand()) {
        return;
      }

      const actor = getActor(interaction);

      switch (interaction.commandName) {
        case "locker-overview": {
          const embed = await buildDashboardResponse(lockerService, CUSTOM_IDS.OVERVIEW);
          await replyWithEmbed(interaction, embed, {
            components: buildDashboardComponents()
          });
          break;
        }

        case "locker-generate": {
          const locker = interaction.options.getInteger("skrytka", true);
          const hours = interaction.options.getInteger("godziny", true);
          const result = await lockerService.generateCode(locker, hours, {
            source: "discord",
            actor
          });

          const embed = buildSuccessEmbed(
            "Kod dostepu gotowy",
            `Wygenerowano kod \`${result.code}\` dla skrytki **S${locker}**.`
          ).addFields(
            {
              name: "Waznosc",
              value: `${hours} h`,
              inline: true
            },
            {
              name: "Wygasa",
              value: formatDate(result.expiresAt),
              inline: true
            },
            {
              name: "Pozostalo",
              value: formatRelativeExpiry(result.expiresAt),
              inline: true
            }
          );

          await replyWithEmbed(interaction, embed);
          break;
        }

        case "locker-status": {
          const lockers = await lockerService.getLockers();
          await replyWithEmbed(interaction, buildStatusEmbed(lockers), {
            components: buildDashboardComponents()
          });
          break;
        }

        case "locker-open": {
          const locker = interaction.options.getInteger("skrytka", true);
          await executeRemoteOpen(lockerService, locker, actor);

          await replyWithEmbed(
            interaction,
            buildSuccessEmbed(
              "Polecenie wyslane",
              `Skrytka **S${locker}** otrzymala zdalne polecenie otwarcia.`
            ),
            {
              components: buildDashboardComponents()
            }
          );
          break;
        }

        case "locker-release-all": {
          await lockerService.releaseAllLockers({
            source: "discord",
            actor
          });

          await replyWithEmbed(
            interaction,
            buildSuccessEmbed(
              "Polecenie globalne wyslane",
              "Zwolnienie blokady wszystkich skrytek zostalo zakolejkowane."
            ),
            {
              components: buildDashboardComponents()
            }
          );
          break;
        }

        case "locker-codes": {
          const codes = await lockerService.getActiveCodes();
          await replyWithEmbed(interaction, buildCodesEmbed(codes), {
            components: buildDashboardComponents()
          });
          break;
        }

        case "locker-users": {
          const users = await lockerService.getRfidUsers();
          await replyWithEmbed(interaction, buildUsersEmbed(users), {
            components: buildDashboardComponents()
          });
          break;
        }

        case "locker-user-add": {
          const name = interaction.options.getString("nazwa", true);
          const tagId = interaction.options.getString("tag", true);
          const allowedLockers = parseLockerList(interaction.options.getString("skrytki", true));
          const user = await lockerService.createRfidUser({
            name,
            tagId,
            allowedLockers
          }, {
            source: "discord",
            actor
          });

          await replyWithEmbed(
            interaction,
            buildSuccessEmbed(
              "Uzytkownik RFID dodany",
              `Dodano **${user.name}** z tagiem \`${user.tagId}\`.`
            ).addFields({
              name: "Skrytki",
              value: user.allowedLockers.map(locker => `S${locker}`).join(", ")
            }),
            {
              components: buildDashboardComponents()
            }
          );
          break;
        }

        case "locker-user-remove": {
          const tagId = interaction.options.getString("tag", true).trim().replace(/\s+/g, "").toUpperCase();
          const users = await lockerService.getRfidUsers();
          const found = users.find(user => user.tagId === tagId);

          if (!found) {
            throw Object.assign(new Error("Nie znaleziono uzytkownika z tym tagiem RFID."), { status: 404 });
          }

          await lockerService.deleteRfidUser(found._id.toString(), {
            source: "discord",
            actor
          });

          await replyWithEmbed(
            interaction,
            buildSuccessEmbed(
              "Uzytkownik RFID usuniety",
              `Usunieto **${found.name}** z tagiem \`${found.tagId}\`.`
            ),
            {
              components: buildDashboardComponents()
            }
          );
          break;
        }

        case "locker-logs": {
          const logs = await lockerService.getLogs();
          await replyWithEmbed(interaction, buildLogsEmbed(logs), {
            components: buildDashboardComponents()
          });
          break;
        }

        case "locker-deactivate": {
          const code = interaction.options.getString("kod", true);
          await lockerService.deactivateCode(code, {
            source: "discord",
            actor
          });

          await replyWithEmbed(
            interaction,
            buildSuccessEmbed(
              "Kod dezaktywowany",
              `Kod \`${code}\` zostal bezpiecznie dezaktywowany.`
            )
          );
          break;
        }

        case "locker-logs-clear": {
          await lockerService.clearLogs({
            source: "discord",
            actor
          });

          await replyWithEmbed(
            interaction,
            buildSuccessEmbed(
              "Logi wyczyszczone",
              "Historia zdarzen zostala usunieta z panelu operacyjnego."
            )
          );
          break;
        }
      }
    } catch (error) {
      const message = error.status && error.status < 500
        ? error.message
        : "Nie udalo sie wykonac komendy. Sprobuj ponownie za chwile.";
      const embed = buildErrorEmbed(message);

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
      } else {
        await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  lockerService.on("log", log => {
    if (!notificationsChannel) {
      return;
    }

    notificationsChannel.send({ embeds: [buildLogEmbed(log)] }).catch(error => {
      console.error("Nie udalo sie wyslac powiadomienia Discord.", error);
    });
  });

  lockerService.on("logs-cleared", payload => {
    if (!notificationsChannel) {
      return;
    }

    notificationsChannel.send({
      embeds: [
        buildBaseEmbed("🧹 Logi wyczyszczone", BRAND.warning)
          .setDescription("Historia zdarzen systemowych zostala wyczyszczona.")
          .addFields({
            name: "Zrodlo",
            value: `${payload.source || "system"}${payload.actor ? ` • ${payload.actor}` : ""}`
          })
      ]
    }).catch(error => {
      console.error("Nie udalo sie wyslac powiadomienia o czyszczeniu logow.", error);
    });
  });

  await client.login(config.token);
  return client;
}

module.exports = {
  createDiscordBot
};
