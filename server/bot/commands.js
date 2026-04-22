const {
  PermissionFlagsBits,
  SlashCommandBuilder
} = require("discord.js");

const commands = [
  new SlashCommandBuilder()
    .setName("locker-overview")
    .setDescription("Pokazuje elegancki przegląd statusu systemu SafeKeys.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("locker-generate")
    .setDescription("Generuje nowy kod dostępu do skrytki.")
    .addIntegerOption(option =>
      option
        .setName("skrytka")
        .setDescription("Numer skrytki")
        .setRequired(true)
        .addChoices(
          { name: "Skrytka 1", value: 1 },
          { name: "Skrytka 2", value: 2 },
          { name: "Skrytka 3", value: 3 }
        ))
    .addIntegerOption(option =>
      option
        .setName("godziny")
        .setDescription("Czas aktywności kodu")
        .setRequired(true)
        .addChoices(
          { name: "2h", value: 2 },
          { name: "4h", value: 4 },
          { name: "6h", value: 6 },
          { name: "8h", value: 8 },
          { name: "12h", value: 12 },
          { name: "24h", value: 24 }
        ))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("locker-status")
    .setDescription("Pokazuje aktualny status skrytek.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("locker-open")
    .setDescription("Zdalnie otwiera wybraną skrytkę.")
    .addIntegerOption(option =>
      option
        .setName("skrytka")
        .setDescription("Numer skrytki do otwarcia")
        .setRequired(true)
        .addChoices(
          { name: "Skrytka 1", value: 1 },
          { name: "Skrytka 2", value: 2 },
          { name: "Skrytka 3", value: 3 }
        ))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("locker-release-all")
    .setDescription("Zwalnia blokadę wszystkich skrytek jednocześnie.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("locker-codes")
    .setDescription("Pokazuje listę aktywnych kodów.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("locker-users")
    .setDescription("Pokazuje liste uzytkownikow RFID i ich uprawnienia.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("locker-user-add")
    .setDescription("Dodaje nowego uzytkownika RFID.")
    .addStringOption(option =>
      option
        .setName("nazwa")
        .setDescription("Nazwa uzytkownika")
        .setRequired(true))
    .addStringOption(option =>
      option
        .setName("tag")
        .setDescription("ID taga RFID")
        .setRequired(true))
    .addStringOption(option =>
      option
        .setName("skrytki")
        .setDescription("Lista skrytek, np. 1,2")
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("locker-user-remove")
    .setDescription("Usuwa uzytkownika RFID po ID taga.")
    .addStringOption(option =>
      option
        .setName("tag")
        .setDescription("ID taga RFID")
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("locker-logs")
    .setDescription("Pokazuje ostatnie zdarzenia systemowe.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("locker-deactivate")
    .setDescription("Dezaktywuje podany kod.")
    .addStringOption(option =>
      option
        .setName("kod")
        .setDescription("4-cyfrowy kod do dezaktywacji")
        .setRequired(true))
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false),

  new SlashCommandBuilder()
    .setName("locker-logs-clear")
    .setDescription("Czyści logi systemowe.")
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
];

module.exports = {
  commandPayloads: commands.map(command => command.toJSON())
};
