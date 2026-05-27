const fs = require('fs');
const path = require('path');
// const fetch = require('node-fetch'); // Descomente quando for usar o DALL-E
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// ==========================================
// 📂 CONFIGURAÇÃO DE PASTAS E BANCO DE DADOS
// ==========================================
const stickersDir = path.join(__dirname, 'stickers');
if (!fs.existsSync(stickersDir)) fs.mkdirSync(stickersDir);

const dbFile = path.join(__dirname, 'db.json');
// Cria o banco de dados JSON se não existir
if (!fs.existsSync(dbFile)) {
    fs.writeFileSync(dbFile, JSON.stringify({}));
}

// Funções para manipular o banco de dados JSON
function getDB() {
    return JSON.parse(fs.readFileSync(dbFile, 'utf-8'));
}

function saveDB(data) {
    fs.writeFileSync(dbFile, JSON.stringify(data, null, 2));
}

function salvarFigurinhaParaUsuario(userId, filename) {
    const db = getDB();
    if (!db[userId]) {
        db[userId] = []; // Cria a lista do usuário se ele não existir
    }
    db[userId].push(filename);
    saveDB(db);
}

// ==========================================
// 🤖 INICIALIZAÇÃO DO CLIENTE
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote'
        ]
    },
    webVersionCache: {
        type: 'remote',
        remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
    }
});

let botReady = false;

client.on('qr', (qr) => {
    qrcode.generate(qr, { small: true });
    console.log('📱 Escaneie o QR code acima com o WhatsApp!');
});

client.on('authenticated', () => {
    console.log('🔐 Autenticado com sucesso!');
    console.log('✅ Aguardando carregamento das conversas (evento `ready`)... Isso pode levar alguns segundos.');
});

client.on('auth_failure', (msg) => {
    console.error('❌ Falha de autenticação:', msg);
    botReady = false;
});

client.on('disconnected', (reason) => {
    console.log('📴 Bot desconectado:', reason);
    botReady = false;
});

client.on('error', (error) => {
    console.error('❌ Erro no cliente:', error);
});

client.on('ready', () => {
    botReady = true;
    console.log('🚀 Cliente whatsapp completamente pronto!');
});

client.on('message', async msg => {
    if (!botReady) {
        console.log('⚠️ Bot não está pronto ainda e ignorou uma mensagem.');
        return;
    }

    try {
        const body = msg.body || '';
        // Usa msg.author se for em grupo, senão usa msg.from (chat privado)
        const userId = msg.author || msg.from; 
        
        console.log('📨 Mensagem:', body, '| De:', userId, '| Tem mídia:', msg.hasMedia);
        
        // ==========================================
        // 🆘 COMANDO DE AJUDA
        // ==========================================
        if (body === '!ajuda' || body === '/ajuda') {
            const menuAjuda = `🤖 *Olá! Eu sou o seu Bot de Figurinhas!* 🤖\n\nAqui está a lista de comandos que você pode usar comigo:\n\n*!ajuda* ou */ajuda* - Mostra este menu de informações.\n*/criar* - Envie este comando *junto com uma foto* na legenda para eu transformá-la em figurinha e salvar no seu perfil.\n*!minhasfigs* - Receba de volta todas as figurinhas que você já salvou comigo.\n\n💡 _Dica Extra: Se você me enviar uma imagem sem nenhum comando, eu vou salvá-la automaticamente no seu banco de figurinhas privado!_`;
            await client.sendMessage(msg.from, menuAjuda);
            return;
        }

        // ==========================================
        // 🖼️ COMANDO: ENVIAR MINHAS FIGURINHAS
        // ==========================================
        if (body === '!minhasfigs') {
            const db = getDB();
            const userStickers = db[userId] || [];

            if (userStickers.length === 0) {
                await client.sendMessage(msg.from, 'Você ainda não tem nenhuma figurinha salva comigo! Me envie uma foto com o comando */criar* para começar.');
            } else {
                await client.sendMessage(msg.from, `Enviando suas ${userStickers.length} figurinhas salvas... 🚀`);
                
                for (const file of userStickers) {
                    const filePath = path.join(stickersDir, file);
                    // Verifica se o arquivo realmente existe na pasta antes de enviar
                    if (fs.existsSync(filePath)) {
                        const stickerData = fs.readFileSync(filePath, { encoding: 'base64' });
                        await client.sendMessage(
                            msg.from,
                            new MessageMedia('image/webp', stickerData),
                            { sendMediaAsSticker: true }
                        );
                    }
                }
            }
            return;
        }

        // ==========================================
        // ✂️ COMANDO: CRIAR FIGURINHA MANUALMENTE
        // ==========================================
        if (body.startsWith('/criar') && msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media && media.mimetype.startsWith('image/')) {
                const filename = `sticker_${userId.replace(/[^0-9]/g, '')}_${Date.now()}.webp`;
                
                // Salva o arquivo na pasta
                fs.writeFileSync(path.join(stickersDir, filename), media.data, 'base64');
                
                // Registra no banco de dados para o usuário específico
                salvarFigurinhaParaUsuario(userId, filename);

                await client.sendMessage(msg.from, media, { sendMediaAsSticker: true });
                await client.sendMessage(msg.from, '✅ Figurinha criada e guardada no seu acervo pessoal!');
            } else {
                client.sendMessage(msg.from, '❌ Por favor, envie uma *imagem* junto com o comando /criar.');
            }
            return;
        }

        // ==========================================
        // 📥 SALVAMENTO AUTOMÁTICO DE IMAGENS
        // ==========================================
        if (msg.hasMedia) {
            const media = await msg.downloadMedia();
            if (media && media.mimetype && media.mimetype.startsWith('image/')) {
                const filename = `sticker_${userId.replace(/[^0-9]/g, '')}_${Date.now()}.webp`;
                
                // Salva o arquivo fisicamente
                fs.writeFileSync(path.join(stickersDir, filename), media.data, 'base64');
                
                // Registra silenciosamente no JSON do usuário
                salvarFigurinhaParaUsuario(userId, filename);
            }
        }
    } catch (err) {
        console.error('❌ Erro ao processar mensagem:', err);
    }
});

// Captura exceções não tratadas para evitar que o processo morra silenciosamente
process.on('uncaughtException', (err) => {
    console.error('🔥 Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('🔥 Unhandled Rejection:', reason);
});

client.initialize();
console.log('⏳ Inicializando bot...');