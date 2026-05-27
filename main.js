require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

// ==========================================
// 💳 CONFIGURAÇÃO DA STRIPE
// ==========================================
if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('❌ ERRO: STRIPE_SECRET_KEY e STRIPE_WEBHOOK_SECRET não foram configurados no .env');
    process.exit(1);
}
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; 

// ==========================================
// 📂 CONFIGURAÇÃO DE PASTAS E ESTADOS
// ==========================================
const stickersDir = path.join(__dirname, 'stickers');
if (!fs.existsSync(stickersDir)) fs.mkdirSync(stickersDir);

// Controle de estado para conversas interativas (ex: VIP escolhendo nome da figurinha)
const userStates = new Map(); 

// ==========================================
// 🗄️ BANCO DE DADOS (SQLite3)
// ==========================================
const db = new sqlite3.Database('./bot.db', (err) => {
    if (err) console.error('❌ Erro ao conectar ao banco:', err.message);
    else console.log('🗄️ Banco de dados SQLite conectado com sucesso.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS Users (
        id TEXT PRIMARY KEY,
        is_vip INTEGER DEFAULT 0,
        creations_today INTEGER DEFAULT 0,
        consults_today INTEGER DEFAULT 0,
        last_reset_date TEXT,
        name TEXT,
        email TEXT,
        phone TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS Stickers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT,
        filename TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

// Helpers usando Promises para o banco de dados
const dbGet = (query, params = []) => new Promise((resolve, reject) => db.get(query, params, (err, row) => err ? reject(err) : resolve(row)));
const dbRun = (query, params = []) => new Promise((resolve, reject) => db.run(query, params, function(err) { err ? reject(err) : resolve(this) }));
const dbAll = (query, params = []) => new Promise((resolve, reject) => db.all(query, params, (err, rows) => err ? reject(err) : resolve(rows)));

async function getUser(userId) {
    const today = new Date().toISOString().split('T')[0];
    let user = await dbGet(`SELECT * FROM Users WHERE id = ?`, [userId]);
    
    if (!user) {
        await dbRun(`INSERT INTO Users (id, last_reset_date) VALUES (?, ?)`, [userId, today]);
        user = await dbGet(`SELECT * FROM Users WHERE id = ?`, [userId]);
    } else if (user.last_reset_date !== today) {
        await dbRun(`UPDATE Users SET creations_today = 0, consults_today = 0, last_reset_date = ? WHERE id = ?`, [today, userId]);
        user.creations_today = 0;
        user.consults_today = 0;
        user.last_reset_date = today;
    }
    return user;
}

// ==========================================
// 🤖 INICIALIZAÇÃO DO CLIENTE WHATSAPP
// ==========================================
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote']
    },
    webVersionCache: { type: 'remote', remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html' }
});

let botReady = false;

client.on('qr', (qr) => qrcode.generate(qr, { small: true }));
client.on('authenticated', () => console.log('🔐 WhatsApp Autenticado!'));
client.on('ready', () => { botReady = true; console.log('🚀 Cliente WhatsApp pronto para receber mensagens!'); });

// ==========================================
// 🌐 SERVIDOR EXPRESS (WEBHOOK DA STRIPE)
// ==========================================
const app = express();

// A Stripe precisa do corpo bruto (raw) para validar a assinatura de segurança
app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        // Valida se a requisição realmente veio da Stripe
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error('❌ Erro no Webhook da Stripe:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata.whatsapp_id; // Recupera o ID do WhatsApp

        console.log(`💰 Pagamento aprovado para: ${userId}`);

        // Atualiza banco de dados
        await dbRun(`UPDATE Users SET is_vip = 1 WHERE id = ?`, [userId]);

        // Manda mensagem de boas-vindas pelo WhatsApp
        if (botReady) {
            await client.sendMessage(userId, '🎉 *PAGAMENTO APROVADO!* 🎉\n\nSeja muito bem-vindo ao VIP! O seu acesso ilimitado já está ativo. Digite */sobrevip* para ver seus novos poderes e comece a criar figurinhas épicas!');
        }
    }

    res.json({received: true});
});

// Páginas de sucesso/cancelamento
app.get('/sucesso', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Pagamento Aprovado</title></head>
        <body style="text-align: center; padding: 50px; font-family: Arial;">
            <h1>✅ Pagamento Aprovado!</h1>
            <p>Seu acesso VIP foi ativado. Volte ao WhatsApp para começar!</p>
        </body>
        </html>
    `);
});

app.get('/cancelado', (req, res) => {
    res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Pagamento Cancelado</title></head>
        <body style="text-align: center; padding: 50px; font-family: Arial;">
            <h1>❌ Pagamento Cancelado</h1>
            <p>Você pode tentar novamente enviando <strong>/comprarvip Nome | Email | Telefone</strong></p>
        </body>
        </html>
    `);
});

const PORT = process.env.PORT || 80;
app.listen(PORT, '0.0.0.0', () => console.log(`🌐 Servidor Webhook rodando na porta ${PORT}`));
// ==========================================
// 💬 EVENTOS DE MENSAGEM DO WHATSAPP
// ==========================================
client.on('message', async msg => {
    if (!botReady) return;

    try {
        const body = msg.body || '';
        const userId = msg.author || msg.from; 
        const user = await getUser(userId);
        
        // 🔄 MÁQUINA DE ESTADOS (Aguardando resposta do VIP)
        if (userStates.has(userId)) {
            const stateData = userStates.get(userId);
            
            if (stateData.state === 'WAITING_METADATA') {
                let stickerName = "Criado por VIP";
                let stickerAuthor = "Bot do Maurício";

                if (body.toLowerCase() !== 'não' && body.toLowerCase() !== 'nao') {
                    const parts = body.split('|').map(s => s.trim());
                    if (parts[0]) stickerName = parts[0];
                    if (parts[1]) stickerAuthor = parts[1];
                }

                await client.sendMessage(msg.from, '⏳ Processando sua figurinha personalizada...');
                
                const filename = `sticker_vip_${userId.replace(/[^0-9]/g, '')}_${Date.now()}.webp`;
                fs.writeFileSync(path.join(stickersDir, filename), stateData.media.data, 'base64');
                await dbRun(`INSERT INTO Stickers (user_id, filename) VALUES (?, ?)`, [userId, filename]);

                await client.sendMessage(msg.from, stateData.media, { 
                    sendMediaAsSticker: true,
                    stickerName: stickerName,
                    stickerAuthor: stickerAuthor
                });
                await client.sendMessage(msg.from, '✅ Figurinha VIP criada e salva com sucesso!');
                userStates.delete(userId);
                return;
            }
        }

        // 🆘 COMANDOS BÁSICOS
        if (body === '!ajuda' || body === '/ajuda') {
            const menu = `🤖 *Menu do Bot* 🤖\n\n*/criar* [com foto/gif] - Cria figurinha\n*!minhasfigs* - Mostra suas figurinhas salvas\n*/status* - Mostra seus limites diários\n*/sobrevip* - Conheça as vantagens exclusivas\n*/comprarvip* - Assine o plano Premium!`;
            await client.sendMessage(msg.from, menu);
            return;
        }

        if (body === '/sobrevip') {
            const txtVip = `👑 *VANTAGENS DO VIP* 👑\n\n*Usuários Comuns:* 10 criações/dia, 3 consultas e figurinhas estáticas.\n\n*Usuários VIP:* \n♾️ Criações ilimitadas\n♾️ Consultas ilimitadas\n🎬 Criação de Figurinhas Animadas (GIF/Vídeo)\n✍️ Personalização do Nome e Autor da figurinha\n🌍 Acesso ao */figsglobal [numero]* para puxar figurinhas aleatórias do banco!\n\nDigite */comprarvip SeuNome | SeuEmail | SeuTelefone* para se tornar VIP!`;
            await client.sendMessage(msg.from, txtVip);
            return;
        }

        if (body === '/status') {
            if (user.is_vip) {
                await client.sendMessage(msg.from, `👑 *Status VIP Ativo!*\nVocê tem acesso ilimitado a todos os comandos.`);
            } else {
                await client.sendMessage(msg.from, `📊 *Seu Status Diário (Grátis):*\n\n✂️ Criações: ${user.creations_today} / 10\n🖼️ Consultas: ${user.consults_today} / 3\n\nQuer limites infinitos? Digite */sobrevip*`);
            }
            return;
        }

        // 💳 COMPRAR VIP (INTEGRAÇÃO STRIPE)
        if (body.startsWith('/comprarvip')) {
            const args = body.replace('/comprarvip', '').trim().split('|').map(s => s.trim());
            if (args.length < 3) {
                await client.sendMessage(msg.from, '❌ Formato incorreto. Use:\n*/comprarvip Nome | Email | Telefone*');
                return;
            }

            await dbRun(`UPDATE Users SET name = ?, email = ?, phone = ? WHERE id = ?`, [args[0], args[1], args[2], userId]);
            await client.sendMessage(msg.from, '⏳ Gerando seu link de pagamento seguro via Stripe...');

            try {
                const session = await stripe.checkout.sessions.create({
                    payment_method_types: ['card'],
                    line_items: [{
                        price_data: {
                            currency: 'brl',
                            product_data: {
                                name: 'Acesso VIP - Bot de Figurinhas',
                                description: 'Figurinhas e consultas ilimitadas, GIFs, personalização de nome e banco global.',
                            },
                            unit_amount: 990, // R$ 9,90 (em centavos)
                        },
                        quantity: 1,
                    }],
                    mode: 'payment',
                    success_url: process.env.SUCCESS_URL || 'https://bot-giulia-vip.squareweb.app/sucesso',
                    cancel_url: process.env.CANCEL_URL || 'https://bot-giulia-vip.squareweb.app/cancelado',
                    metadata: { whatsapp_id: userId } // Essencial: Salva o ID do usuário para o Webhook
                });

                await client.sendMessage(msg.from, `Prontinho, ${args[0]}! 💳\n\nPague via Cartão ou PIX acessando o link abaixo. Assim que o pagamento for confirmado, seu VIP será ativado automaticamente!\n\n🔗 ${session.url}`);
            } catch (err) {
                console.error('Erro ao gerar link Stripe:', err);
                await client.sendMessage(msg.from, '❌ Erro ao gerar o link de pagamento. Tente novamente mais tarde.');
            }
            return;
        }

        // 🖼️ CONSULTAS DE FIGURINHAS
        if (body === '!minhasfigs') {
            if (!user.is_vip && user.consults_today >= 3) {
                await client.sendMessage(msg.from, '❌ Limite de 3 consultas diárias atingido. Assine o VIP para consultas ilimitadas! (/sobrevip)');
                return;
            }

            const userStickers = await dbAll(`SELECT filename FROM Stickers WHERE user_id = ?`, [userId]);

            if (userStickers.length === 0) {
                await client.sendMessage(msg.from, 'Você ainda não tem figurinhas salvas!');
            } else {
                if (!user.is_vip) await dbRun(`UPDATE Users SET consults_today = consults_today + 1 WHERE id = ?`, [userId]);
                await client.sendMessage(msg.from, `Enviando suas ${userStickers.length} figurinhas... 🚀`);
                
                for (const row of userStickers) {
                    const filePath = path.join(stickersDir, row.filename);
                    if (fs.existsSync(filePath)) {
                        const stickerData = fs.readFileSync(filePath, { encoding: 'base64' });
                        await client.sendMessage(msg.from, new MessageMedia('image/webp', stickerData), { sendMediaAsSticker: true });
                    }
                }
            }
            return;
        }

        // 🌍 BANCO GLOBAL DE FIGURINHAS (VIP)
        if (body.startsWith('/figsglobal')) {
            if (!user.is_vip) {
                await client.sendMessage(msg.from, '👑 Comando exclusivo para VIPs! Digite /sobrevip para saber mais.');
                return;
            }
            const args = body.split(' ');
            let limit = parseInt(args[1]);
            if (isNaN(limit) || limit <= 0) limit = 5;
            if (limit > 30) limit = 30; // Proteção contra spam

            const globalStickers = await dbAll(`SELECT filename FROM Stickers ORDER BY RANDOM() LIMIT ?`, [limit]);
            if (globalStickers.length === 0) {
                await client.sendMessage(msg.from, 'O banco global está vazio!');
                return;
            }

            await client.sendMessage(msg.from, `🌍 Puxando ${globalStickers.length} figurinhas aleatórias do multiverso...`);
            for (const row of globalStickers) {
                const filePath = path.join(stickersDir, row.filename);
                if (fs.existsSync(filePath)) {
                    const stickerData = fs.readFileSync(filePath, { encoding: 'base64' });
                    await client.sendMessage(msg.from, new MessageMedia('image/webp', stickerData), { sendMediaAsSticker: true });
                }
            }
            return;
        }

        // ✂️ CRIAÇÃO DE FIGURINHAS
        if (body.startsWith('/criar') && msg.hasMedia) {
            if (!user.is_vip && user.creations_today >= 10) {
                await client.sendMessage(msg.from, '❌ Você atingiu o limite de 10 figurinhas diárias. Torne-se VIP para criações ilimitadas! (/sobrevip)');
                return;
            }

            const media = await msg.downloadMedia();
            
            if (media && (media.mimetype.startsWith('image/') || media.mimetype.startsWith('video/'))) {
                if (user.is_vip) {
                    userStates.set(userId, { state: 'WAITING_METADATA', media: media });
                    await client.sendMessage(msg.from, '👑 *Criação VIP!*\nDeseja colocar um nome e autor na sua figurinha?\n\nResponda no formato: *Nome da Figurinha | Seu Nome*\nOu responda *Não* para usar o padrão.');
                    return; 
                }

                const filename = `sticker_${userId.replace(/[^0-9]/g, '')}_${Date.now()}.webp`;
                fs.writeFileSync(path.join(stickersDir, filename), media.data, 'base64');
                await dbRun(`INSERT INTO Stickers (user_id, filename) VALUES (?, ?)`, [userId, filename]);
                await dbRun(`UPDATE Users SET creations_today = creations_today + 1 WHERE id = ?`, [userId]);

                await client.sendMessage(msg.from, media, { 
                    sendMediaAsSticker: true,
                    stickerName: "Feito no Bot XYZ",
                    stickerAuthor: "Sua Marca"
                });
                await client.sendMessage(msg.from, '✅ Figurinha criada e guardada!');
            } else {
                await client.sendMessage(msg.from, '❌ Envie uma mídia válida junto com o comando.');
            }
            return;
        }

        // 📥 SALVAMENTO SILENCIOSO
        if (msg.hasMedia && !userStates.has(userId)) {
            const media = await msg.downloadMedia();
            if (media && media.mimetype && media.mimetype.startsWith('image/')) {
                const filename = `sticker_${userId.replace(/[^0-9]/g, '')}_${Date.now()}.webp`;
                fs.writeFileSync(path.join(stickersDir, filename), media.data, 'base64');
                await dbRun(`INSERT INTO Stickers (user_id, filename) VALUES (?, ?)`, [userId, filename]);
            }
        }

    } catch (err) {
        console.error('❌ Erro no processamento da mensagem:', err);
    }
});

process.on('uncaughtException', (err) => console.error('🔥 Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('🔥 Unhandled Rejection:', reason));

client.initialize();
console.log('⏳ Inicializando bot do WhatsApp...');
console.log('✅ Variáveis de ambiente carregadas com sucesso!');
console.log('   - STRIPE_SECRET_KEY:', process.env.STRIPE_SECRET_KEY ? '✔️ Configurada' : '❌ Não configurada');
console.log('   - STRIPE_WEBHOOK_SECRET:', process.env.STRIPE_WEBHOOK_SECRET ? '✔️ Configurada' : '❌ Não configurada');