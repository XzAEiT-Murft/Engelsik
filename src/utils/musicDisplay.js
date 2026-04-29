const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');

const PLATFORM_LABELS = {
    youtube: 'YouTube',
    spotify: 'Spotify',
    apple: 'Apple Music',
    amazon: 'Amazon Music'
};

function formatPlatformLabel(platform) {
    if (!platform) {
        return 'YouTube';
    }

    const normalized = String(platform).toLowerCase();
    return PLATFORM_LABELS[normalized] || platform;
}

function formatSongLabel(song) {
    if (!song) {
        return 'Sin titulo';
    }

    return song.artist ? `${song.title} - ${song.artist}` : song.title;
}

function buildSongLink(song) {
    return song?.youtubeUrl || song?.originalUrl || null;
}

function formatDuration(totalSeconds) {
    if (!Number.isFinite(totalSeconds) || totalSeconds < 0) {
        return '?:??';
    }

    const total = Math.floor(totalSeconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;

    if (hours > 0) {
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(
            seconds
        ).padStart(2, '0')}`;
    }

    return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function createProgressBar(current, total) {
    const size = 10;

    if (!Number.isFinite(total) || total <= 0) {
        return '□'.repeat(size);
    }

    const clampedCurrent = Math.max(0, Math.min(current, total));
    const progress = Math.round((clampedCurrent / total) * size);

    return '■'.repeat(progress) + '□'.repeat(size - progress);
}

function buildProgressLine(current, total) {
    const currentSeconds = Math.max(0, Math.floor(current || 0));
    const totalSeconds =
        Number.isFinite(total) && total > 0 ? Math.floor(total) : null;

    return `[${createProgressBar(
        currentSeconds,
        totalSeconds || 0
    )}] ${formatDuration(currentSeconds)} / ${formatDuration(totalSeconds)}`;
}

function buildNowPlayingEmbed(song, options = {}) {
    const currentSeconds = options.currentSeconds || 0;
    const isPaused = options.isPaused || false;
    const link = buildSongLink(song);
    const requestedBy = song?.requestedById
        ? `<@${song.requestedById}>`
        : song?.requestedByName || 'Desconocido';
    const titleLabel = link
        ? `[${formatSongLabel(song)}](${link})`
        : formatSongLabel(song);

    const embed = new EmbedBuilder()
        .setAuthor({ name: 'Engelsik' })
        .setTitle(isPaused ? 'Reproduccion pausada' : 'Reproduciendo')
        .addFields(
            {
                name: '🎵 Titulo',
                value: titleLabel
            },
            {
                name: '👤 Usuario',
                value: requestedBy,
                inline: true
            },
            {
                name: '🌐 Origen',
                value: formatPlatformLabel(song?.source),
                inline: true
            },
            {
                name: '⏱ Progreso',
                value: buildProgressLine(currentSeconds, song?.durationSeconds)
            }
        )
        .setColor(isPaused ? 0xf1c40f : 0x5865f2);

    if (song?.thumbnail) {
        embed.setThumbnail(song.thumbnail);
    }

    return embed;
}

function buildPlaybackControls(guildId, isPaused = false) {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`player-control:${guildId}:back10`)
                .setLabel('⏪ -10s')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`player-control:${guildId}:back5`)
                .setLabel('⏮ -5s')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`player-control:${guildId}:toggle`)
                .setLabel(isPaused ? '▶️ Reanudar' : '⏸️ Pausar')
                .setStyle(isPaused ? ButtonStyle.Success : ButtonStyle.Primary),
            new ButtonBuilder()
                .setCustomId(`player-control:${guildId}:forward5`)
                .setLabel('⏭ +5s')
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`player-control:${guildId}:forward10`)
                .setLabel('⏩ +10s')
                .setStyle(ButtonStyle.Secondary)
        )
    ];
}

module.exports = {
    formatPlatformLabel,
    formatSongLabel,
    buildSongLink,
    formatDuration,
    createProgressBar,
    buildProgressLine,
    buildNowPlayingEmbed,
    buildPlaybackControls
};
