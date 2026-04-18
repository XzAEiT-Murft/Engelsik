const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { queues } = require('../../music/player');

function formatSongLabel(song) {
    return song.artist ? `${song.title} - ${song.artist}` : song.title;
}

function formatSongLine(index, song) {
    const link = song.youtubeUrl || song.originalUrl || null;
    const label = formatSongLabel(song);

    return link ? `${index}. [${label}](${link})` : `${index}. ${label}`;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Muestra la cola actual'),

    async execute(interaction) {
        const guildId = interaction.guildId;
        const queue = queues.get(guildId);

        if (!queue || !queue.songs.length) {
            return interaction.reply({
                content: 'No hay canciones en cola.',
                ephemeral: true
            });
        }

        const currentSong = queue.songs[0];
        const nextSongs = queue.songs.slice(1);
        const currentLabel = queue.paused ? '⏸️ Pausada:' : '🎵 Reproduciendo:';

        let description = `${currentLabel}\n${formatSongLine(1, currentSong)}`;

        if (nextSongs.length) {
            const nextLines = nextSongs.map(
                (song, index) => formatSongLine(index + 2, song)
            );

            description += `\n\n📃 En cola:\n${nextLines.join('\n')}`;
        } else {
            description += '\n\n📃 En cola:\nNo hay mas canciones en espera.';
        }

        const embed = new EmbedBuilder()
            .setAuthor({ name: 'Engelsik' })
            .setTitle('Cola actual')
            .setDescription(description)
            .setColor(0x2ecc71);

        if (currentSong.thumbnail) {
            embed.setThumbnail(currentSong.thumbnail);
        }

        return interaction.reply({ embeds: [embed] });
    }
};
