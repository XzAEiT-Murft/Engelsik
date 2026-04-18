const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('help')
        .setDescription('Muestra la lista de comandos disponibles'),

    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setAuthor({ name: 'Engelsik' })
            .setTitle('Comandos disponibles')
            .setDescription(
                [
                    '/play      -> Reproduce o agrega a la cola',
                    '/playlist  -> Agrega playlists o colecciones',
                    '/stop      -> Pausa la canción',
                    '/continue  -> Reanuda la canción',
                    '/skip      -> Salta la canción actual',
                    '/queue     -> Muestra la cola',
                    '/quit      -> Desconecta y limpia la cola',
                    '/help      -> Lista de comandos'
                ].join('\n')
            )
            .setColor(0x5865f2);

        return interaction.reply({ embeds: [embed] });
    }
};
