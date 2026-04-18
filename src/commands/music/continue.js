const { SlashCommandBuilder } = require('discord.js');
const { queues } = require('../../music/player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('continue')
        .setDescription('Reanuda la cancion pausada'),

    async execute(interaction) {
        const guildId = interaction.guildId;
        const queue = queues.get(guildId);

        if (!queue || !queue.songs.length || !queue.paused) {
            return interaction.reply({
                content: 'No hay ninguna cancion pausada.',
                ephemeral: true
            });
        }

        queue.player.unpause();
        queue.paused = false;

        return interaction.reply({
            content: '▶️ Música reanudada.'
        });
    }
};
