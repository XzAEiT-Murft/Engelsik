const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
    queues,
    logDebug,
    getOrCreateQueue,
    playNextAvailableSong,
    clearDisconnectTimeout,
    destroyQueue
} = require('../../music/player');
const { resolveInput } = require('../../utils/platformResolver');

function formatPlatformLabel(platformLabel) {
    return platformLabel || 'YouTube';
}

function formatCollectionLabel(inputType) {
    return inputType === 'album' ? 'Colección' : 'Playlist';
}

function formatSongLabel(song) {
    return song.artist ? `${song.title} - ${song.artist}` : song.title;
}

function buildSongLink(song) {
    return song.youtubeUrl || song.originalUrl || null;
}

function buildNowPlayingEmbed(song, sourceLabel) {
    const link = buildSongLink(song);
    const embed = new EmbedBuilder()
        .setAuthor({ name: 'Engelsik' })
        .setTitle('Reproduciendo')
        .setDescription(
            link ? `[${formatSongLabel(song)}](${link})` : formatSongLabel(song)
        )
        .addFields({
            name: 'Plataforma de origen',
            value: sourceLabel,
            inline: true
        })
        .setColor(0x5865f2);

    if (song.thumbnail) {
        embed.setThumbnail(song.thumbnail);
    }

    return embed;
}

function buildQueuedEmbed(song, position, sourceLabel) {
    const link = buildSongLink(song);
    const embed = new EmbedBuilder()
        .setAuthor({ name: 'Engelsik' })
        .setTitle('Agregada a la cola')
        .setDescription(
            link ? `[${formatSongLabel(song)}](${link})` : formatSongLabel(song)
        )
        .addFields(
            {
                name: 'Posicion en la cola',
                value: String(position),
                inline: true
            },
            {
                name: 'Plataforma de origen',
                value: sourceLabel,
                inline: true
            }
        )
        .setColor(0xf1c40f);

    if (song.thumbnail) {
        embed.setThumbnail(song.thumbnail);
    }

    return embed;
}

function buildCollectionEmbed(resolvedSongs) {
    const collectionLabel = formatCollectionLabel(resolvedSongs.inputType);
    const embed = new EmbedBuilder()
        .setAuthor({ name: 'Engelsik' })
        .setTitle(`${collectionLabel} agregada`)
        .setColor(0x2ecc71)
        .addFields(
            {
                name: 'Plataforma de origen',
                value: formatPlatformLabel(resolvedSongs.platformLabel),
                inline: true
            },
            {
                name: 'Canciones agregadas',
                value: String(resolvedSongs.length),
                inline: true
            }
        );

    if (resolvedSongs.collectionName) {
        embed.setDescription(resolvedSongs.collectionName);
    }

    if (resolvedSongs.thumbnail) {
        embed.setThumbnail(resolvedSongs.thumbnail);
    }

    return embed;
}

async function handlePlayRequest(interaction) {
    const guildId = interaction.guildId;
    const query = interaction.options.getString('query', true);
    const voiceChannel = interaction.member.voice.channel;

    if (!voiceChannel) {
        return interaction.reply({
            content: 'Debes estar dentro de un canal de voz.',
            ephemeral: true
        });
    }

    await interaction.deferReply();

    try {
        const resolvedSongs = await resolveInput(query);
        const sourceLabel = formatPlatformLabel(resolvedSongs.platformLabel);

        logDebug(guildId, 'Entrada resuelta', {
            platform: resolvedSongs.platform,
            inputType: resolvedSongs.inputType,
            collectionName: resolvedSongs.collectionName,
            count: resolvedSongs.length
        });

        const queue = await getOrCreateQueue(guildId, voiceChannel);
        clearDisconnectTimeout(queue);

        const shouldStartNow = queue.songs.length === 0;
        queue.songs.push(...resolvedSongs);

        if (resolvedSongs.length > 1 || resolvedSongs.inputType !== 'track') {
            const collectionLabel = formatCollectionLabel(
                resolvedSongs.inputType
            );

            if (shouldStartNow) {
                await playNextAvailableSong(guildId);
            }

            return interaction.editReply({
                content: `➕ ${collectionLabel} agregada: ${resolvedSongs.length} canciones`,
                embeds: [buildCollectionEmbed(resolvedSongs)]
            });
        }

        const song = resolvedSongs[0];

        if (shouldStartNow) {
            const currentSong = await playNextAvailableSong(guildId);

            return interaction.editReply({
                embeds: [buildNowPlayingEmbed(currentSong || song, sourceLabel)]
            });
        }

        return interaction.editReply({
            content: `➕ Agregada a la cola: ${formatSongLabel(song)}`,
            embeds: [buildQueuedEmbed(song, queue.songs.length, sourceLabel)]
        });
    } catch (error) {
        console.error(
            `[play][guild:${guildId}] Error ejecutando /play:`,
            error
        );

        if (!queues.get(guildId)?.songs.length) {
            destroyQueue(guildId);
        }

        return interaction.editReply(
            error.userMessage ||
                'No pude reproducir esa cancion. Revisa la URL o intenta con otro nombre.'
        );
    }
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Reproduce una cancion o agrega una playlist a la cola')
        .addStringOption(option =>
            option
                .setName('query')
                .setDescription('Nombre o URL de YouTube, Spotify, Apple o Amazon')
                .setRequired(true)
        ),
    handlePlayRequest,
    execute: handlePlayRequest
};
