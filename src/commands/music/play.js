const {
    SlashCommandBuilder,
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const {
    queues,
    logDebug,
    getOrCreateQueue,
    playNextAvailableSong,
    clearDisconnectTimeout,
    destroyQueue,
    setNowPlayingMessage
} = require('../../music/player');
const {
    resolveInput,
    searchYouTubeCandidates
} = require('../../utils/platformResolver');
const {
    formatPlatformLabel,
    formatSongLabel,
    buildSongLink,
    formatDuration,
    buildNowPlayingEmbed,
    buildPlaybackControls
} = require('../../utils/musicDisplay');
const {
    searchAutocompleteSuggestions
} = require('../../utils/youtubeAutocomplete');

const SELECTION_TIMEOUT_MS = 20_000;
const pendingSelections = new Map();

function normalizeQuery(query) {
    return query.trim().replace(/^<(.+)>$/, '$1');
}

function isDirectUrl(query) {
    try {
        new URL(normalizeQuery(query));
        return true;
    } catch {
        return false;
    }
}

function formatCollectionLabel(inputType) {
    return inputType === 'album' ? 'Coleccion' : 'Playlist';
}

function cloneResolvedSongs(resolvedSongs, requester) {
    const clonedSongs = resolvedSongs.map(song => ({
        ...song,
        requestedById: requester.id,
        requestedByName: requester.tag
    }));

    clonedSongs.platform = resolvedSongs.platform;
    clonedSongs.platformLabel = resolvedSongs.platformLabel;
    clonedSongs.inputType = resolvedSongs.inputType;
    clonedSongs.collectionName = resolvedSongs.collectionName;
    clonedSongs.thumbnail = resolvedSongs.thumbnail;

    return clonedSongs;
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

function buildSelectionEmbed(query, candidates) {
    const lines = candidates.map((song, index) => {
        const duration = formatDuration(song.durationSeconds);
        const label = song.artist
            ? `${song.title} - ${song.artist}`
            : song.title;

        return `${index + 1}. ${label} (${duration})`;
    });

    return new EmbedBuilder()
        .setAuthor({ name: 'Engelsik' })
        .setTitle('Elige una cancion')
        .setDescription(lines.join('\n'))
        .addFields({
            name: 'Busqueda',
            value: query
        })
        .setFooter({
            text: 'Selecciona una opcion en menos de 20 segundos.'
        })
        .setColor(0x5865f2);
}

function buildSelectionComponents(token, candidates) {
    const rows = [];
    const songButtons = candidates.slice(0, 5).map((song, index) =>
        new ButtonBuilder()
            .setCustomId(`play-select:${token}:${index}`)
            .setLabel(String(index + 1))
            .setStyle(index === 0 ? ButtonStyle.Primary : ButtonStyle.Secondary)
    );

    rows.push(new ActionRowBuilder().addComponents(songButtons));
    rows.push(
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`play-select:${token}:cancel`)
                .setLabel('Cancelar')
                .setStyle(ButtonStyle.Danger)
        )
    );

    return rows;
}

function buildSelectedSongResponse(song) {
    const songs = [song];
    songs.platform = 'youtube';
    songs.platformLabel = 'YouTube';
    songs.inputType = 'track';
    songs.collectionName = null;
    songs.thumbnail = song.thumbnail || null;

    return songs;
}

function cleanupPendingSelection(token) {
    const pendingSelection = pendingSelections.get(token);

    if (!pendingSelection) {
        return;
    }

    clearTimeout(pendingSelection.timeout);
    pendingSelections.delete(token);
}

async function waitForSelection(interaction, query, candidates, guildId) {
    const token = interaction.id;

    await interaction.editReply({
        content: '',
        embeds: [buildSelectionEmbed(query, candidates)],
        components: buildSelectionComponents(token, candidates)
    });

    return new Promise(resolve => {
        const timeout = setTimeout(async () => {
            cleanupPendingSelection(token);

            try {
                await interaction.editReply({
                    content: 'Se cancelo la seleccion por inactividad.',
                    embeds: [],
                    components: []
                });
            } catch (error) {
                logDebug(guildId, 'No pude limpiar la seleccion expirada', {
                    error: error.message
                });
            }

            resolve(null);
        }, SELECTION_TIMEOUT_MS);

        pendingSelections.set(token, {
            userId: interaction.user.id,
            guildId,
            query,
            candidates,
            resolve,
            timeout
        });
    });
}

function buildNowPlayingPayload(guildId, song, options = {}) {
    const embeds = [];

    if (Array.isArray(options.extraEmbeds) && options.extraEmbeds.length) {
        embeds.push(...options.extraEmbeds);
    }

    embeds.push(
        buildNowPlayingEmbed(song, {
            currentSeconds: options.currentSeconds || 0,
            isPaused: options.isPaused || false
        })
    );

    return {
        content: options.content ?? '',
        embeds,
        components: buildPlaybackControls(guildId, options.isPaused || false)
    };
}

async function resolveSongsForRequest(interaction, query, guildId) {
    const normalizedQuery = normalizeQuery(query);

    if (isDirectUrl(normalizedQuery)) {
        return resolveInput(normalizedQuery);
    }

    const candidates = await searchYouTubeCandidates(normalizedQuery, 5);

    if (candidates.length <= 1) {
        return buildSelectedSongResponse(candidates[0]);
    }

    logDebug(guildId, 'Mostrando selector de resultados', {
        query: normalizedQuery,
        count: candidates.length
    });

    return waitForSelection(interaction, normalizedQuery, candidates, guildId);
}

async function handleSelectionButtonInteraction(interaction) {
    const [, token, action] = interaction.customId.split(':');
    const pendingSelection = pendingSelections.get(token);

    if (!pendingSelection) {
        await interaction.reply({
            content: 'Esta seleccion ya expiro.',
            ephemeral: true
        });
        return true;
    }

    if (interaction.user.id !== pendingSelection.userId) {
        await interaction.reply({
            content: 'Solo quien ejecuto /play puede elegir esta opcion.',
            ephemeral: true
        });
        return true;
    }

    cleanupPendingSelection(token);

    if (action === 'cancel') {
        await interaction.update({
            content: 'Seleccion cancelada.',
            embeds: [],
            components: []
        });

        pendingSelection.resolve(null);
        return true;
    }

    const selectedIndex = Number(action);
    const selectedSong = pendingSelection.candidates[selectedIndex];

    if (!selectedSong) {
        await interaction.update({
            content: 'No pude identificar la opcion elegida.',
            embeds: [],
            components: []
        });

        pendingSelection.resolve(null);
        return true;
    }

    logDebug(pendingSelection.guildId, 'Resultado seleccionado manualmente', {
        query: pendingSelection.query,
        selectedIndex,
        title: selectedSong.title
    });

    await interaction.update({
        content: 'Procesando seleccion...',
        embeds: [],
        components: []
    });

    pendingSelection.resolve(buildSelectedSongResponse(selectedSong));
    return true;
}

async function handleAutocomplete(interaction) {
    const focusedValue = interaction.options.getFocused();

    try {
        const suggestions = await searchAutocompleteSuggestions(
            focusedValue,
            12
        );

        await interaction.respond(suggestions.slice(0, 25));
    } catch (error) {
        console.error(
            `[play][guild:${interaction.guildId}] Error en autocomplete /play:`,
            error
        );

        try {
            await interaction.respond([]);
        } catch {}
    }
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
        const resolvedSongs = await resolveSongsForRequest(
            interaction,
            query,
            guildId
        );

        if (!resolvedSongs) {
            return null;
        }

        const queuedSongs = cloneResolvedSongs(resolvedSongs, interaction.user);
        const sourceLabel = formatPlatformLabel(queuedSongs.platformLabel);

        logDebug(guildId, 'Entrada resuelta', {
            platform: queuedSongs.platform,
            inputType: queuedSongs.inputType,
            collectionName: queuedSongs.collectionName,
            count: queuedSongs.length
        });

        const queue = await getOrCreateQueue(guildId, voiceChannel);
        clearDisconnectTimeout(queue);

        const shouldStartNow = queue.songs.length === 0;
        queue.songs.push(...queuedSongs);

        if (queuedSongs.length > 1 || queuedSongs.inputType !== 'track') {
            const collectionLabel = formatCollectionLabel(queuedSongs.inputType);
            let currentSong = null;

            if (shouldStartNow) {
                currentSong = await playNextAvailableSong(guildId);
            }

            const responseMessage = await interaction.editReply(
                currentSong
                    ? buildNowPlayingPayload(guildId, currentSong, {
                          content: `➕ ${collectionLabel} agregada: ${queuedSongs.length} canciones`,
                          extraEmbeds: [buildCollectionEmbed(queuedSongs)]
                      })
                    : {
                          content: `➕ ${collectionLabel} agregada: ${queuedSongs.length} canciones`,
                          embeds: [buildCollectionEmbed(queuedSongs)],
                          components: []
                      }
            );

            if (currentSong) {
                setNowPlayingMessage(guildId, responseMessage);
            }

            return responseMessage;
        }

        const song = queuedSongs[0];

        if (shouldStartNow) {
            const currentSong = await playNextAvailableSong(guildId);
            const responseMessage = await interaction.editReply(
                buildNowPlayingPayload(guildId, currentSong || song)
            );

            setNowPlayingMessage(guildId, responseMessage);
            return responseMessage;
        }

        return interaction.editReply({
            content: `➕ Agregada a la cola: ${formatSongLabel(song)}`,
            embeds: [buildQueuedEmbed(song, queue.songs.length, sourceLabel)],
            components: []
        });
    } catch (error) {
        console.error(`[play][guild:${guildId}] Error ejecutando /play:`, error);

        if (!queues.get(guildId)?.songs.length) {
            destroyQueue(guildId);
        }

        return interaction.editReply({
            content:
                error.userMessage ||
                'No pude reproducir esa cancion. Revisa la URL o intenta con otro nombre.',
            embeds: [],
            components: []
        });
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
                .setAutocomplete(true)
        ),
    autocomplete: handleAutocomplete,
    handleButtonInteraction: handleSelectionButtonInteraction,
    handlePlayRequest,
    execute: handlePlayRequest
};
