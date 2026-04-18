const { SlashCommandBuilder } = require('discord.js');
const { queues } = require('../../music/player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Pausa la cancion actual'),

    async execute(interaction) {
        const guildId = interaction.guildId;
        const queue = queues.get(guildId);

        if (!queue || !queue.songs.length) {
            return interaction.reply({
                content: 'No hay musica reproduciendose ahora mismo.',
                ephemeral: true
            });
        }

        if (queue.paused) {
            return interaction.reply({
                content: 'La musica ya esta pausada.',
                ephemeral: true
            });
        }

        queue.player.pause(true);
        queue.paused = true;

        return interaction.reply({
            content: '⏸️ Música pausada.'
        });
    }
};
