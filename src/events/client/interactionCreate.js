const playCommand = require('../../commands/music/play');
const { handleControlInteraction } = require('../../music/player');

module.exports = {
    name: 'interactionCreate',

    async execute(interaction, client) {
        if (interaction.isAutocomplete()) {
            const command = client.commands.get(interaction.commandName);

            if (!command?.autocomplete) {
                return;
            }

            try {
                await command.autocomplete(interaction, client);
            } catch (error) {
                console.error(error);

                try {
                    await interaction.respond([]);
                } catch {}
            }

            return;
        }

        if (interaction.isButton()) {
            try {
                if (interaction.customId.startsWith('play-select:')) {
                    await playCommand.handleButtonInteraction(interaction, client);
                    return;
                }

                if (interaction.customId.startsWith('player-control:')) {
                    await handleControlInteraction(interaction, client);
                    return;
                }
            } catch (error) {
                console.error(error);

                if (!interaction.replied && !interaction.deferred) {
                    await interaction.reply({
                        content: 'Ocurrio un error manejando ese boton.',
                        ephemeral: true
                    });
                }
            }

            return;
        }

        if (!interaction.isChatInputCommand()) {
            return;
        }

        const command = client.commands.get(interaction.commandName);

        if (!command) {
            return;
        }

        try {
            await command.execute(interaction, client);
        } catch (error) {
            console.error(error);

            if (interaction.deferred || interaction.replied) {
                await interaction.editReply('Ocurrio un error ejecutando el comando.');
            } else {
                await interaction.reply({
                    content: 'Ocurrio un error ejecutando el comando.',
                    ephemeral: true
                });
            }
        }
    }
};
