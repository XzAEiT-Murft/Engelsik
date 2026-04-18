const { SlashCommandBuilder } = require('discord.js');
const { destroyQueue, queues } = require('../../music/player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('quit')
        .setDescription('Desconecta a Engelsik y limpia la cola'),

    async execute(interaction) {
        const guildId = interaction.guildId;

        if (!queues.has(guildId)) {
            return interaction.reply({
                content: 'Engelsik no esta conectado ahora mismo.',
                ephemeral: true
            });
        }

        destroyQueue(guildId);

        return interaction.reply({
            content: '⏹️ Engelsik salió del canal y limpió la cola.'
        });
    }
};
