const { SlashCommandBuilder } = require('discord.js');
const { queues } = require('../../music/player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Salta la cancion actual'),

    async execute(interaction) {
        const guildId = interaction.guildId;
        const queue = queues.get(guildId);

        if (!queue || !queue.songs.length) {
            return interaction.reply({
                content: 'No hay ninguna cancion para saltar.',
                ephemeral: true
            });
        }

        queue.paused = false;
        queue.player.stop(true);

        return interaction.reply({
            content: '⏭️ Canción saltada.'
        });
    }
};
