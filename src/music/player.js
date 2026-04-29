const prism = require('prism-media');
const ffmpegPath = require('ffmpeg-static');
const {
    joinVoiceChannel,
    entersState,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus
} = require('@discordjs/voice');
const {
    resolvePlayableSong,
    getYtDlp
} = require('../utils/platformResolver');
const {
    buildNowPlayingEmbed,
    buildPlaybackControls
} = require('../utils/musicDisplay');

const queues = new Map();

function logDebug(guildId, message, details) {
    const prefix = `[play][guild:${guildId}] ${message}`;

    if (details === undefined) {
        console.log(prefix);
        return;
    }

    console.log(prefix, details);
}

function clearDisconnectTimeout(queue) {
    if (!queue?.timeout) {
        return;
    }

    clearTimeout(queue.timeout);
    queue.timeout = null;
}

function clearInactivityTimeout(queue) {
    if (!queue?.inactivityTimeout) {
        return;
    }

    clearTimeout(queue.inactivityTimeout);
    queue.inactivityTimeout = null;
}

function stopVoiceChannelMonitor(queue) {
    if (!queue?.voiceChannelInterval) {
        return;
    }

    clearInterval(queue.voiceChannelInterval);
    queue.voiceChannelInterval = null;
}

function stopProgressUpdater(queue) {
    if (!queue?.progressInterval) {
        return;
    }

    clearInterval(queue.progressInterval);
    queue.progressInterval = null;
}

function resetPlaybackProgress(queue) {
    if (!queue) {
        return;
    }

    queue.currentStartedAt = null;
    queue.currentElapsedMs = 0;

    if (queue.songs[0]) {
        queue.songs[0].currentTimeSeconds = 0;
    }
}

function getCurrentProgressSeconds(queue) {
    if (!queue) {
        return 0;
    }

    const elapsedMs =
        queue.currentElapsedMs +
        (queue.currentStartedAt ? Date.now() - queue.currentStartedAt : 0);
    const currentSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
    const totalSeconds = queue.songs[0]?.durationSeconds;
    const clampedSeconds =
        Number.isFinite(totalSeconds) && totalSeconds > 0
            ? Math.min(currentSeconds, totalSeconds)
            : currentSeconds;

    if (queue.songs[0]) {
        queue.songs[0].currentTimeSeconds = clampedSeconds;
    }

    return clampedSeconds;
}

function getVoiceChannel(queue) {
    if (!queue?.guild || !queue.voiceChannelId) {
        return null;
    }

    return queue.guild.channels.cache.get(queue.voiceChannelId) || null;
}

function isUserInBotVoiceChannel(interaction, queue) {
    const memberChannelId = interaction.member?.voice?.channelId;
    const botChannelId = queue?.connection?.joinConfig?.channelId;

    return Boolean(memberChannelId && botChannelId && memberChannelId === botChannelId);
}

function killProcess(queue, guildId) {
    if (!queue?.process || queue.process.killed) {
        if (queue) {
            queue.process = null;
        }
        return;
    }

    try {
        queue.process.kill();
    } catch (error) {
        console.error(
            `[play][guild:${guildId}] Error cerrando el proceso de yt-dlp:`,
            error
        );
    }

    queue.process = null;
}

function buildStreamArgs(song, startTimeSeconds = 0) {
    const args = [song.youtubeUrl, '-f', 'bestaudio[ext=webm]/bestaudio'];

    if (Number.isFinite(startTimeSeconds) && startTimeSeconds > 0) {
        if (!ffmpegPath) {
            throw new Error(
                'No hay ffmpeg disponible para mover la reproduccion.'
            );
        }

        args.push(
            '--downloader',
            'ffmpeg',
            '--downloader-args',
            `ffmpeg_i:-ss ${startTimeSeconds}`,
            '--ffmpeg-location',
            ffmpegPath
        );
    }

    args.push('-o', '-', '--no-playlist');
    return args;
}

async function updateNowPlayingMessage(guildId) {
    const queue = queues.get(guildId);

    if (!queue?.nowPlayingMessage || !queue.songs.length) {
        return;
    }

    try {
        await queue.nowPlayingMessage.edit({
            content: '',
            embeds: [
                buildNowPlayingEmbed(queue.songs[0], {
                    currentSeconds: getCurrentProgressSeconds(queue),
                    isPaused: queue.paused
                })
            ],
            components: buildPlaybackControls(guildId, queue.paused)
        });
    } catch (error) {
        logDebug(guildId, 'No pude actualizar el mensaje de reproduccion', {
            error: error.message
        });
        stopProgressUpdater(queue);
        queue.nowPlayingMessage = null;
    }
}

function startProgressUpdater(guildId, options = {}) {
    const queue = queues.get(guildId);

    if (!queue?.nowPlayingMessage || !queue.songs.length) {
        return;
    }

    stopProgressUpdater(queue);

    if (options.immediate) {
        void updateNowPlayingMessage(guildId);
    }

    queue.progressInterval = setInterval(() => {
        void updateNowPlayingMessage(guildId);
    }, 5_000);
}

function setNowPlayingMessage(guildId, message) {
    const queue = queues.get(guildId);

    if (!queue) {
        return;
    }

    queue.nowPlayingMessage = message;

    if (queue.songs.length) {
        startProgressUpdater(guildId);
    }
}

function startEmptyChannelTimeout(guildId) {
    const queue = queues.get(guildId);

    if (!queue || queue.inactivityTimeout) {
        return;
    }

    logDebug(
        guildId,
        'El canal de voz quedo vacio, esperando 30 segundos antes de desconectar'
    );

    queue.inactivityTimeout = setTimeout(() => {
        const refreshedQueue = queues.get(guildId);
        const channel = getVoiceChannel(refreshedQueue);
        const members = channel?.members?.filter(member => !member.user.bot);

        if (!channel || !members || members.size === 0) {
            logDebug(
                guildId,
                'El canal siguio vacio despues de 30 segundos, desconectando Engelsik'
            );
            destroyQueue(guildId);
            return;
        }

        clearInactivityTimeout(refreshedQueue);
    }, 30_000);
}

function monitorVoiceChannelOccupancy(guildId) {
    const queue = queues.get(guildId);
    const channel = getVoiceChannel(queue);

    if (!queue || !channel?.members) {
        return;
    }

    const members = channel.members.filter(member => !member.user.bot);

    if (members.size === 0) {
        startEmptyChannelTimeout(guildId);
        return;
    }

    if (queue.inactivityTimeout) {
        logDebug(
            guildId,
            'Se detectaron usuarios en el canal otra vez, cancelando timeout por inactividad'
        );
        clearInactivityTimeout(queue);
    }
}

function startVoiceChannelMonitor(guildId, queue) {
    if (!queue) {
        return;
    }

    stopVoiceChannelMonitor(queue);
    queue.voiceChannelInterval = setInterval(() => {
        monitorVoiceChannelOccupancy(guildId);
    }, 5_000);

    monitorVoiceChannelOccupancy(guildId);
}

function destroyQueue(guildId, options = {}) {
    const { destroyConnection = true } = options;
    const queue = queues.get(guildId);

    if (!queue) {
        return;
    }

    clearDisconnectTimeout(queue);
    clearInactivityTimeout(queue);
    stopVoiceChannelMonitor(queue);
    stopProgressUpdater(queue);
    resetPlaybackProgress(queue);
    killProcess(queue, guildId);

    if (queue.player) {
        queue.player.removeAllListeners();

        try {
            queue.player.stop(true);
        } catch (error) {
            console.error(
                `[play][guild:${guildId}] Error deteniendo el reproductor:`,
                error
            );
        }
    }

    if (queue.connection) {
        queue.connection.removeAllListeners();

        if (destroyConnection) {
            try {
                queue.connection.destroy();
            } catch (error) {
                console.error(
                    `[play][guild:${guildId}] Error destruyendo la conexion:`,
                    error
                );
            }
        }
    }

    queues.delete(guildId);
}

function scheduleDisconnect(guildId) {
    const queue = queues.get(guildId);

    if (!queue) {
        return;
    }

    clearDisconnectTimeout(queue);

    logDebug(
        guildId,
        'La cola quedo vacia, esperando 30 segundos antes de desconectar'
    );

    queue.timeout = setTimeout(() => {
        logDebug(guildId, 'Timeout alcanzado, desconectando Engelsik');
        destroyQueue(guildId);
    }, 30_000);
}

async function startCurrentSong(guildId, options = {}) {
    const queue = queues.get(guildId);

    if (!queue || !queue.songs.length) {
        scheduleDisconnect(guildId);
        return null;
    }

    const currentSong = queue.songs[0];
    const startTimeSeconds = Math.max(
        0,
        Math.floor(options.startTimeSeconds || 0)
    );

    clearDisconnectTimeout(queue);
    stopProgressUpdater(queue);
    queue.ignoreNextIdle = Boolean(options.controlledRestart);
    killProcess(queue, guildId);
    resetPlaybackProgress(queue);
    queue.currentElapsedMs = startTimeSeconds * 1000;
    currentSong.currentTimeSeconds = startTimeSeconds;

    queue.paused = false;
    await resolvePlayableSong(currentSong, guildId);

    const ytDlp = await getYtDlp();
    const ytDlpExecution = ytDlp.exec(buildStreamArgs(currentSong, startTimeSeconds), {
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const ytDlpProcess = ytDlpExecution.ytDlpProcess;

    if (!ytDlpProcess?.stdout) {
        queue.ignoreNextIdle = false;
        throw new Error('No se pudo obtener stdout del proceso de yt-dlp.');
    }

    queue.process = ytDlpProcess;

    ytDlpExecution.on('close', code => {
        logDebug(guildId, 'Proceso de yt-dlp finalizado', {
            code,
            song: currentSong.title
        });
    });

    ytDlpExecution.on('error', error => {
        console.error(
            `[play][guild:${guildId}] yt-dlp emitio un error:`,
            error
        );
    });

    ytDlpProcess.stdout.removeAllListeners('data');

    const opusStream = ytDlpProcess.stdout.pipe(new prism.opus.WebmDemuxer());

    opusStream.on('error', error => {
        console.error(
            `[play][guild:${guildId}] Error en el demuxer de audio:`,
            error
        );
    });

    logDebug(guildId, 'Stream creado', {
        url: currentSong.youtubeUrl,
        pid: ytDlpProcess.pid,
        startTimeSeconds
    });

    const resource = createAudioResource(opusStream, {
        inputType: StreamType.Opus,
        inlineVolume: true
    });

    queue.connection.subscribe(queue.player);
    queue.currentStartedAt = Date.now();
    queue.player.play(resource);

    return currentSong;
}

async function playNextAvailableSong(guildId) {
    const queue = queues.get(guildId);

    if (!queue) {
        return null;
    }

    while (queue.songs.length > 0) {
        try {
            return await startCurrentSong(guildId);
        } catch (error) {
            queue.ignoreNextIdle = false;

            const failedSong = queue.songs.shift();

            console.error(
                `[play][guild:${guildId}] Error iniciando la cancion ${
                    failedSong?.title || '(desconocida)'
                }:`,
                error
            );

            killProcess(queue, guildId);
        }
    }

    scheduleDisconnect(guildId);
    return null;
}

async function handleIdle(guildId) {
    const queue = queues.get(guildId);

    if (!queue) {
        return;
    }

    if (queue.ignoreNextIdle) {
        queue.ignoreNextIdle = false;
        logDebug(guildId, 'Idle ignorado durante reinicio controlado');
        return;
    }

    const finishedSong = queue.songs.shift();

    queue.paused = false;
    stopProgressUpdater(queue);
    resetPlaybackProgress(queue);
    killProcess(queue, guildId);

    logDebug(guildId, 'Reproductor en idle', {
        finishedSong: finishedSong?.title || null,
        remaining: queue.songs.length
    });

    if (queue.songs.length > 0) {
        await playNextAvailableSong(guildId);
        return;
    }

    scheduleDisconnect(guildId);
}

function handlePlayerPlaying(guildId) {
    const queue = queues.get(guildId);

    if (!queue) {
        return;
    }

    if (!queue.currentStartedAt && queue.songs.length) {
        queue.currentStartedAt = Date.now();
    }

    queue.ignoreNextIdle = false;
    queue.paused = false;

    logDebug(guildId, 'Reproductor en playing', {
        song: queue.songs[0]?.title || null
    });

    if (queue.nowPlayingMessage) {
        startProgressUpdater(guildId, { immediate: true });
    }
}

function handlePlayerPaused(guildId) {
    const queue = queues.get(guildId);

    if (!queue) {
        return;
    }

    if (queue.currentStartedAt) {
        queue.currentElapsedMs += Date.now() - queue.currentStartedAt;
        queue.currentStartedAt = null;
    }

    queue.paused = true;
    stopProgressUpdater(queue);

    logDebug(guildId, 'Reproductor en paused', {
        song: queue.songs[0]?.title || null
    });

    if (queue.nowPlayingMessage) {
        void updateNowPlayingMessage(guildId);
    }
}

async function restartCurrentSongAt(guildId, targetSeconds) {
    const queue = queues.get(guildId);

    if (!queue?.songs.length) {
        throw new Error('No hay ninguna cancion reproduciendose.');
    }

    if (queue.controlLock) {
        throw new Error('Espera a que termine la accion anterior.');
    }

    queue.controlLock = true;

    try {
        logDebug(guildId, 'Reiniciando stream en un nuevo punto', {
            targetSeconds
        });

        return await startCurrentSong(guildId, {
            startTimeSeconds: targetSeconds,
            controlledRestart: true
        });
    } catch (error) {
        queue.ignoreNextIdle = false;
        throw error;
    } finally {
        queue.controlLock = false;
    }
}

async function seekCurrentSong(guildId, deltaSeconds) {
    const queue = queues.get(guildId);

    if (!queue?.songs.length) {
        throw new Error('No hay ninguna cancion reproduciendose.');
    }

    await resolvePlayableSong(queue.songs[0], guildId);

    const currentTimeSeconds = getCurrentProgressSeconds(queue);
    const durationSeconds = queue.songs[0].durationSeconds;
    const maxTimeSeconds =
        Number.isFinite(durationSeconds) && durationSeconds > 1
            ? durationSeconds - 1
            : Infinity;
    const targetSeconds = Math.max(
        0,
        Math.min(Math.round(currentTimeSeconds + deltaSeconds), maxTimeSeconds)
    );

    if (targetSeconds === currentTimeSeconds) {
        return queue.songs[0];
    }

    logDebug(guildId, 'Aplicando seek manual', {
        from: currentTimeSeconds,
        to: targetSeconds,
        deltaSeconds
    });

    return restartCurrentSongAt(guildId, targetSeconds);
}

async function handleControlInteraction(interaction) {
    const [, customGuildId, action] = interaction.customId.split(':');

    if (!interaction.guildId || interaction.guildId !== customGuildId) {
        await interaction.reply({
            content: 'Ese control ya no corresponde a este servidor.',
            ephemeral: true
        });
        return true;
    }

    const queue = queues.get(customGuildId);

    if (!queue || !queue.songs.length) {
        await interaction.reply({
            content: 'No hay ninguna cancion reproduciendose ahora mismo.',
            ephemeral: true
        });
        return true;
    }

    if (
        queue.nowPlayingMessage &&
        interaction.message.id !== queue.nowPlayingMessage.id
    ) {
        await interaction.reply({
            content: 'Usa el mensaje de reproduccion mas reciente.',
            ephemeral: true
        });
        return true;
    }

    if (!isUserInBotVoiceChannel(interaction, queue)) {
        await interaction.reply({
            content: 'Debes estar en el mismo canal de voz que Engelsik.',
            ephemeral: true
        });
        return true;
    }

    queue.nowPlayingMessage = interaction.message;
    await interaction.deferUpdate();

    try {
        if (action === 'toggle') {
            if (queue.paused) {
                queue.player.unpause();
            } else {
                queue.player.pause(true);
            }
        } else if (action === 'back10') {
            await seekCurrentSong(customGuildId, -10);
        } else if (action === 'back5') {
            await seekCurrentSong(customGuildId, -5);
        } else if (action === 'forward5') {
            await seekCurrentSong(customGuildId, 5);
        } else if (action === 'forward10') {
            await seekCurrentSong(customGuildId, 10);
        }

        await updateNowPlayingMessage(customGuildId);
    } catch (error) {
        console.error(
            `[play][guild:${customGuildId}] Error manejando controles de reproduccion:`,
            error
        );

        try {
            await interaction.followUp({
                content:
                    error.message ||
                    'No pude aplicar ese control de reproduccion.',
                ephemeral: true
            });
        } catch {}
    }

    return true;
}

function attachQueueListeners(guildId, queue) {
    queue.connection.on(VoiceConnectionStatus.Disconnected, () => {
        logDebug(guildId, 'Conexion de voz desconectada');
        destroyQueue(guildId, { destroyConnection: false });
    });

    queue.connection.on('stateChange', () => {
        monitorVoiceChannelOccupancy(guildId);
    });

    queue.player.on(AudioPlayerStatus.Playing, () => {
        handlePlayerPlaying(guildId);
    });

    queue.player.on(AudioPlayerStatus.Paused, () => {
        handlePlayerPaused(guildId);
    });

    queue.player.on(AudioPlayerStatus.Idle, () => {
        void handleIdle(guildId);
    });

    queue.player.on('error', error => {
        console.error(
            `[play][guild:${guildId}] Error del reproductor:`,
            error
        );
    });
}

async function createQueue(guildId, voiceChannel) {
    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: true
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
    logDebug(guildId, 'Conexion lista');

    const player = createAudioPlayer({
        behaviors: {
            noSubscriber: NoSubscriberBehavior.Pause
        }
    });

    const queue = {
        connection,
        player,
        process: null,
        songs: [],
        timeout: null,
        inactivityTimeout: null,
        voiceChannelInterval: null,
        paused: false,
        voiceChannelId: voiceChannel.id,
        guild: voiceChannel.guild,
        nowPlayingMessage: null,
        progressInterval: null,
        currentStartedAt: null,
        currentElapsedMs: 0,
        ignoreNextIdle: false,
        controlLock: false
    };

    attachQueueListeners(guildId, queue);
    queues.set(guildId, queue);
    startVoiceChannelMonitor(guildId, queue);

    return queue;
}

async function getOrCreateQueue(guildId, voiceChannel) {
    const existingQueue = queues.get(guildId);

    if (!existingQueue) {
        return createQueue(guildId, voiceChannel);
    }

    const currentChannelId = existingQueue.connection?.joinConfig?.channelId;
    const canMoveBot =
        existingQueue.songs.length === 0 &&
        existingQueue.player?.state?.status === AudioPlayerStatus.Idle;

    if (
        existingQueue.connection?.state?.status ===
        VoiceConnectionStatus.Destroyed
    ) {
        destroyQueue(guildId, { destroyConnection: false });
        return createQueue(guildId, voiceChannel);
    }

    if (currentChannelId && currentChannelId !== voiceChannel.id) {
        if (canMoveBot) {
            destroyQueue(guildId);
            return createQueue(guildId, voiceChannel);
        }

        throw new Error(
            'Debes estar en el mismo canal de voz que Engelsik para usar la cola.'
        );
    }

    existingQueue.guild = voiceChannel.guild;
    existingQueue.voiceChannelId = voiceChannel.id;
    startVoiceChannelMonitor(guildId, existingQueue);

    return existingQueue;
}

module.exports = {
    queues,
    logDebug,
    getOrCreateQueue,
    playNextAvailableSong,
    scheduleDisconnect,
    clearDisconnectTimeout,
    destroyQueue,
    setNowPlayingMessage,
    handleControlInteraction
};
