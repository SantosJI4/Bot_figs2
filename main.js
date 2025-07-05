const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const { OpenAI } = require('openai');
require('dotenv').config(); // Carrega as variáveis de ambiente do arquivo .env
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const stickersDir = path.join(__dirname, 'stickers');
if (!fs.existsSync(stickersDir)) fs.mkdirSync(stickersDir);

const client = new Client({
    authStrategy: new LocalAuth()
});

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('Escaneie o QR code acima com o WhatsApp!');
});

client.on('ready', () => {
    console.log('Bot está pronto!');
});

client.on('message', async msg => {
    // Comando para enviar todas as figurinhas salvas
    if (msg.body === '!minhasfigs') {
        const files = fs.readdirSync(stickersDir);
        if (files.length === 0) {
            client.sendMessage(msg.from, 'Nenhuma figurinha salva ainda!');
        } else {
            for (const file of files) {
                const stickerData = fs.readFileSync(path.join(stickersDir, file), { encoding: 'base64' });
                await client.sendMessage(
                    msg.from,
                    new MessageMedia('image/webp', stickerData),
                    { sendMediaAsSticker: true }
                );
            }
        }
        return;
    }

    // Comando para criar figurinha a partir de imagem enviada com /criar
    if (msg.body.startsWith('/criar') && msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media.mimetype.startsWith('image/')) {
            const filename = `sticker_${Date.now()}.webp`;
            fs.writeFileSync(path.join(stickersDir, filename), media.data, 'base64');
            await client.sendMessage(msg.from, media, { sendMediaAsSticker: true });
            await client.sendMessage(msg.from, 'Figurinha criada e salva com sucesso!');
        } else {
            client.sendMessage(msg.from, 'Por favor, envie uma imagem junto com o comando /criar.');
        }
        return;
    }

    // Comando para criar figurinha com imagem gerada pelo DALL-E
    if (msg.body.startsWith('/criarimagem')) {
        const prompt = msg.body.replace('/criarimagem', '').trim();
        if (!prompt) {
            client.sendMessage(msg.from, 'Envie o comando assim: /criarimagem descrição da imagem');
            return;
        }
        try {
            client.sendMessage(msg.from, 'Gerando imagem com IA, aguarde...');
            // Gera imagem com DALL-E
          const response = await openai.images.generate({
              prompt: prompt,
              n: 1,
              size: "512x512"
          });
          const imageUrl = response.data[0].url;
            // Baixa a imagem
            const res = await fetch(imageUrl);
            const buffer = await res.buffer();
            const filename = `sticker_${Date.now()}.webp`;
            const outputPath = path.join(stickersDir, filename);
            fs.writeFileSync(outputPath, buffer);
            // Envia como figurinha
            const base64 = buffer.toString('base64');
            await client.sendMessage(
                msg.from,
                new MessageMedia('image/webp', base64),
                { sendMediaAsSticker: true }
            );
            client.sendMessage(msg.from, 'Figurinha criada com sucesso usando DALL-E!');
        } catch (err) {
            console.error(err);
            client.sendMessage(msg.from, 'Erro ao gerar imagem com IA.');
        }
        return;
    }

    // Salva figurinhas recebidas normalmente (sem comando)
    if (msg.hasMedia) {
        const media = await msg.downloadMedia();
        if (media.mimetype.startsWith('image/')) {
            const filename = `sticker_${Date.now()}.webp`;
            fs.writeFileSync(path.join(stickersDir, filename), media.data, 'base64');
            client.sendMessage(msg.from, media, { sendMediaAsSticker: true });
        }
    }
});

client.initialize();