require('dotenv').config();
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const express = require('express');

if (!process.env.STRIPE_SECRET_KEY || !process.env.STRIPE_WEBHOOK_SECRET) {
    console.error('ERRO: STRIPE_SECRET_KEY e STRIPE_WEBHOOK_SECRET não configurados no .env');
    process.exit(1);
}
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET; 

const stickersDir = path.join(__dirname, 'stickers');
if (!fs.existsSync(stickersDir)) fs.mkdirSync(stickersDir);

const productsDir = path.join(__dirname, 'produtos');
if (!fs.existsSync(productsDir)) fs.mkdirSync(productsDir);

const userStates = new Map(); 

const catalogoProdutos = {
    '1': {
        nome: "Ebooks diversos",
        subcategorias: {
            '1': {
                nome: "Receitas",
                produtos: {
                    '1': { 
                        nome: "Como Fazer um Bolo Perfeito", 
                        preco: 1500, 
                        descricao: "Aprenda confeitaria do zero.",
                        tipoEntrega: "arquivo",
                        payload: "ebooks/receitas/como_fazer_um_bolo.pdf" 
                    }
                }
            },
            '2': {
                nome: "Livros Técnicos",
                produtos: {
                    '1': { 
                        nome: "Clean Code", 
                        preco: 4500, 
                        descricao: "Manual de artesanato de software.",
                        tipoEntrega: "arquivo",
                        payload: "ebooks/livros/clean_code.pdf" 
                    }
                }
            }
        }
    },
    '3': {
        nome: "cybersecurity",
        produtos: {
            produtos: {
                    '1': { 
                        nome: "Hacking com Kali Linux Técnicas práticas para testes de invasão (James Broad  Andrew Bindner [Broad, James])", 
                        preco: 2489, 
                        descricao: "aprenda a usar o Kali Linux para testes de invasão e segurança ofensiva.",
                        tipoEntrega: "arquivo",
                        payload: "cybersecurity/Hacking com Kali Linux Técnicas práticas para testes de invasão (James Broad  Andrew Bindner [Broad, James]).pdf" 
                    },
                    '2': {
                        nome: "Livro - Programação Avançada em Lua assembly",
                        preco: 2489,
                        descricao: "Aprenda a programar em Lua assembly para desenvolvimento de exploits e segurança ofensiva.",
                        tipoEntrega: "arquivo",
                        payload: "cybersecurity/Livro - Programação Avançada em Lua assembly.pdf"
                    }
                }
            }
        },
    '4': {
        nome: "Pendrives de musicas",
        produtos: {
            '1': { 
                nome: "Pendrive 8GB - Top Hits 2026", 
                preco: 1299, 
                descricao: "Melhor playlist do ano, direto no seu pendrive!",
                tipoEntrega: "link", 
                payload: "https://drive.google.com/drive/folders/12OMdWH2GoJEm3a-w4eYC8Y2teY6MZQgL?usp=sharing_eip&ts=6938ba67" 
            },
            '2': { 
                nome: "Pendrive 16GB - Hits 2026", 
                preco: 2489, 
                descricao: "Mais música, mais memória! atualizadinha!",
                tipoEntrega: "link", 
                payload: "https://drive.google.com/drive/folders/12OMdWH2GoJEm3a-w4eYC8Y2teY6MZQgL?usp=sharing_eip&ts=6938ba67" 
            },
            '3': { 
                nome: "Festa junina 2026 - Pendrive 16GB [em alta 🔥]", 
                preco: 1669, 
                descricao: "melhores musicas de festa junina 2026, atualizada com os hits mais tocados do momento!",
                tipoEntrega: "link", 
                payload: "https://drive.google.com/drive/folders/12OMdWH2GoJEm3a-w4eYC8Y2teY6MZQgL?usp=sharing_eip&ts=6938ba67" 
            },
        }
    }
};

const db = new sqlite3.Database('./bot.db', (err) => {
    if (err) console.error('Erro ao conectar ao banco:', err.message);
    else console.log('Banco de dados SQLite conectado.');
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
    )`, () => {
        db.run(`ALTER TABLE Stickers ADD COLUMN mimetype TEXT DEFAULT 'image/webp'`, () => {});
    });
});

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
client.on('authenticated', () => console.log('WhatsApp Autenticado!'));
client.on('ready', () => { botReady = true; console.log('Cliente WhatsApp pronto!'); });

const app = express();

app.post('/webhook', express.raw({type: 'application/json'}), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
    } catch (err) {
        console.error('Erro no Webhook da Stripe:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata.whatsapp_id;
        const tipoCompra = session.metadata.tipo_compra;

        if (!botReady) {
            console.log('Bot não está pronto para enviar a mensagem de aprovação.');
            return res.json({received: true});
        }

        if (tipoCompra === 'vip') {
            await dbRun(`UPDATE Users SET is_vip = 1 WHERE id = ?`, [userId]);
            await client.sendMessage(userId, '🎉 *PAGAMENTO APROVADO!* 🎉\n\nSeja muito bem-vindo ao VIP! O seu acesso ilimitado já está ativo. Digite */sobrevip* para ver seus novos poderes!');
        
        } else if (tipoCompra === 'produto') {
            const catId = session.metadata.category_id;
            const subCatId = session.metadata.subcategory_id;
            const prodId = session.metadata.product_id;
            const produto = catalogoProdutos[catId]?.subcategorias[subCatId]?.produtos[prodId];

            if (!produto) {
                 await client.sendMessage(userId, '✅ Pagamento aprovado, mas houve um erro ao localizar seu produto. Chame o suporte!');
                 return res.json({received: true});
            }

            await client.sendMessage(userId, `🎉 *PAGAMENTO APROVADO!* 🎉\n\nAqui está o seu pedido: *${produto.nome}*\nPreparando a entrega...`);

            if (produto.tipoEntrega === 'link') {
                await client.sendMessage(userId, `🔗 *Acesse seu produto aqui:*\n${produto.payload}`);
            } else if (produto.tipoEntrega === 'arquivo') {
                const filePath = path.join(productsDir, produto.payload);
                if (fs.existsSync(filePath)) {
                    const media = MessageMedia.fromFilePath(filePath);
                    await client.sendMessage(userId, media);
                    await client.sendMessage(userId, `📦 *Arquivo entregue com sucesso!* Bom proveito.`);
                } else {
                    console.error(`Arquivo não encontrado: ${filePath}`);
                    await client.sendMessage(userId, '❌ *Erro interno:* O arquivo do seu produto não foi encontrado. Por favor, contate o suporte.');
                }
            }
        }
    }

    res.json({received: true});
});

app.get('/sucesso', (req, res) => res.send('<h1>✅ Pagamento Aprovado!</h1><p>Volte ao WhatsApp.</p>'));
app.get('/cancelado', (req, res) => res.send('<h1>❌ Pagamento Cancelado</h1>'));

const PORT = process.env.PORT || 80;
app.listen(PORT, '0.0.0.0', () => console.log(`Servidor Webhook rodando na porta ${PORT}`));

client.on('message', async msg => {
    if (!botReady) return;

    try {
        const body = msg.body || '';
        const userId = msg.author || msg.from; 
        const user = await getUser(userId);
        
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

                await client.sendMessage(msg.from, '⏳ Processando...');
                const filename = `sticker_vip_${userId.replace(/[^0-9]/g, '')}_${Date.now()}.webp`;
                fs.writeFileSync(path.join(stickersDir, filename), stateData.media.data, 'base64');
                await dbRun(`INSERT INTO Stickers (user_id, filename, mimetype) VALUES (?, ?, ?)`, [userId, filename, stateData.media.mimetype]);

                await client.sendMessage(msg.from, stateData.media, { sendMediaAsSticker: true, stickerName, stickerAuthor });
                await client.sendMessage(msg.from, '✅ Figurinha VIP criada!');
                userStates.delete(userId);
                return;
            }

            if (stateData.state === 'WAITING_CATEGORY_CHOICE') {
                const escolhaCat = body.trim();
                if (escolhaCat.toLowerCase() === 'cancelar') {
                    userStates.delete(userId);
                    await client.sendMessage(msg.from, '🛑 Compra cancelada.');
                    return;
                }

                const categoria = catalogoProdutos[escolhaCat];
                if (!categoria) {
                    await client.sendMessage(msg.from, '❌ Categoria inválida. Digite um número válido ou *cancelar*.');
                    return;
                }

                let menuSub = `📁 *Subcategorias de: ${categoria.nome}* 📁\nResponda com o número da subcategoria:\n\n`;
                for (const [subId, sub] of Object.entries(categoria.subcategorias)) {
                    menuSub += `*[ ${subId} ]* - ${sub.nome}\n`;
                }
                menuSub += `\nPara sair, digite *cancelar*.`;

                userStates.set(userId, { state: 'WAITING_SUBCATEGORY_CHOICE', categoryId: escolhaCat });
                await client.sendMessage(msg.from, menuSub);
                return;
            }

            if (stateData.state === 'WAITING_SUBCATEGORY_CHOICE') {
                const escolhaSub = body.trim();
                if (escolhaSub.toLowerCase() === 'cancelar') {
                    userStates.delete(userId);
                    await client.sendMessage(msg.from, '🛑 Compra cancelada.');
                    return;
                }

                const catId = stateData.categoryId;
                const subcategoria = catalogoProdutos[catId]?.subcategorias[escolhaSub];
                if (!subcategoria) {
                    await client.sendMessage(msg.from, '❌ Subcategoria inválida. Digite um número válido ou *cancelar*.');
                    return;
                }

                let menuProdutos = `🛍️ *Produtos em: ${subcategoria.nome}* 🛍️\nResponda com o número do produto:\n\n`;
                for (const [prodId, prod] of Object.entries(subcategoria.produtos)) {
                    menuProdutos += `*[ ${prodId} ]* - ${prod.nome}\n💰 R$ ${(prod.preco / 100).toFixed(2)}\n📝 ${prod.descricao}\n\n`;
                }
                menuProdutos += `Para sair, digite *cancelar*.`;

                userStates.set(userId, { state: 'WAITING_PRODUCT_CHOICE', categoryId: catId, subcategoryId: escolhaSub });
                await client.sendMessage(msg.from, menuProdutos);
                return;
            }

            if (stateData.state === 'WAITING_PRODUCT_CHOICE') {
                const escolhaProd = body.trim();
                if (escolhaProd.toLowerCase() === 'cancelar') {
                    userStates.delete(userId);
                    await client.sendMessage(msg.from, '🛑 Compra cancelada.');
                    return;
                }

                const catId = stateData.categoryId;
                const subCatId = stateData.subcategoryId;
                const produto = catalogoProdutos[catId]?.subcategorias[subCatId]?.produtos[escolhaProd];

                if (!produto) {
                    await client.sendMessage(msg.from, '❌ Produto inválido. Digite um número válido ou *cancelar*.');
                    return;
                }

                await client.sendMessage(msg.from, `⏳ Gerando link de pagamento para: *${produto.nome}*...`);

                try {
                    const session = await stripe.checkout.sessions.create({
                        line_items: [{
                            price_data: { currency: 'brl', product_data: { name: produto.nome, description: produto.descricao }, unit_amount: produto.preco },
                            quantity: 1,
                        }],
                        mode: 'payment',
                        success_url: process.env.SUCCESS_URL || 'https://bot-giulia-vip.squareweb.app/sucesso',
                        cancel_url: process.env.CANCEL_URL || 'https://bot-giulia-vip.squareweb.app/cancelado',
                        metadata: { 
                            whatsapp_id: userId, 
                            tipo_compra: 'produto', 
                            category_id: catId, 
                            subcategory_id: subCatId, 
                            product_id: escolhaProd 
                        }
                    });

                    await client.sendMessage(msg.from, `🛒 *Pedido gerado!*\n\nProduto: ${produto.nome}\nValor: R$ ${(produto.preco / 100).toFixed(2)}\n\nPague via Cartão ou PIX no link abaixo:\n🔗 ${session.url}`);
                    userStates.delete(userId);
                } catch (err) {
                    await client.sendMessage(msg.from, '❌ Erro ao processar o pagamento.');
                    userStates.delete(userId);
                }
                return;
            }
        }

        if (body === '!ajuda' || body === '/ajuda') {
            await client.sendMessage(msg.from, `🤖 *Menu do Bot*\n\n*/criar* [foto/gif] - Cria figurinha\n*!minhasfigs* - Suas figurinhas\n*/status* - Limites diários\n*/comprar* - Loja de Produtos\n*/sobrevip* - Vantagens VIP\n*/comprarvip* - Assinar VIP`);
            return;
        }

        if (body === '/sobrevip') {
            await client.sendMessage(msg.from, `👑 *VANTAGENS DO VIP*\n♾️ Criações e consultas ilimitadas\n🎬 GIFs e Vídeos\n✍️ Personalização de nome e autor\n🌍 /figsglobal [numero]\n\nDigite */comprarvip Nome | Email | Telefone*`);
            return;
        }

        if (body === '/status') {
            if (user.is_vip) await client.sendMessage(msg.from, `👑 *Status VIP Ativo!*`);
            else await client.sendMessage(msg.from, `📊 *Seu Status (Grátis):*\n✂️ Criações: ${user.creations_today} / 10\n🖼️ Consultas: ${user.consults_today} / 3`);
            return;
        }

        if (body === '/comprar' || body === '!comprar') {
            let menuCategorias = `🛍️ *LOJA DO BOT - CATEGORIAS* 🛍️\nResponda com o *número* da categoria desejada:\n\n`;
            for (const [catId, cat] of Object.entries(catalogoProdutos)) {
                menuCategorias += `*[ ${catId} ]* - ${cat.nome}\n`;
            }
            menuCategorias += `\nPara sair, digite *cancelar*.`;
            
            userStates.set(userId, { state: 'WAITING_CATEGORY_CHOICE' });
            await client.sendMessage(msg.from, menuCategorias);
            return;
        }

        if (body.startsWith('/comprarvip')) {
            const args = body.replace('/comprarvip', '').trim().split('|').map(s => s.trim());
            if (args.length < 3) {
                await client.sendMessage(msg.from, '❌ Use: */comprarvip Nome | Email | Telefone*');
                return;
            }

            await dbRun(`UPDATE Users SET name = ?, email = ?, phone = ? WHERE id = ?`, [args[0], args[1], args[2], userId]);
            await client.sendMessage(msg.from, '⏳ Gerando seu link via Stripe...');

            try {
                const session = await stripe.checkout.sessions.create({
                    line_items: [{
                        price_data: { currency: 'brl', product_data: { name: 'Acesso VIP', description: 'Figurinhas ilimitadas' }, unit_amount: 1199 },
                        quantity: 1,
                    }],
                    mode: 'payment',
                    success_url: process.env.SUCCESS_URL || 'https://bot-giulia-vip.squareweb.app/sucesso',
                    cancel_url: process.env.CANCEL_URL || 'https://bot-giulia-vip.squareweb.app/cancelado',
                    metadata: { whatsapp_id: userId, tipo_compra: 'vip' } 
                });
                await client.sendMessage(msg.from, `Prontinho, ${args[0]}! 💳\nPague no link abaixo:\n🔗 ${session.url}`);
            } catch (err) {
                await client.sendMessage(msg.from, '❌ Erro ao gerar link de pagamento.');
            }
            return;
        }

       if (body === '!minhasfigs') {
            if (!user.is_vip && user.consults_today >= 3) {
                await client.sendMessage(msg.from, '❌ Limite de 3 consultas. Assine o VIP! (/sobrevip)');
                return;
            }

            try {
                const userStickers = await dbAll(`SELECT filename, mimetype FROM Stickers WHERE user_id = ?`, [userId]);
                if (!userStickers || userStickers.length === 0) {
                    await client.sendMessage(msg.from, '⚠️ Nenhuma figurinha salva.');
                } else {
                    if (!user.is_vip) await dbRun(`UPDATE Users SET consults_today = consults_today + 1 WHERE id = ?`, [userId]);
                    await client.sendMessage(msg.from, `Enviando ${userStickers.length} figurinhas... 🚀`);
                    
                    for (const row of userStickers) {
                        const filePath = path.join(stickersDir, row.filename);
                        if (fs.existsSync(filePath)) {
                            const stickerData = fs.readFileSync(filePath, { encoding: 'base64' });
                            let tipoMidia = row.mimetype || 'image/jpeg'; 
                            if (tipoMidia === 'image/webp' && !stickerData.startsWith('UklGR')) tipoMidia = 'image/jpeg'; 
                            
                            const media = new MessageMedia(tipoMidia, stickerData);
                            await client.sendMessage(msg.from, media, { sendMediaAsSticker: true, stickerName: "Minhas Figs", stickerAuthor: "Bot" }).catch(() => {});
                        }
                    }
                }
            } catch (dbErr) {
                await client.sendMessage(msg.from, '❌ Erro interno.');
            }
            return;
        }

        if (body.startsWith('/figsglobal')) {
            if (!user.is_vip) {
                await client.sendMessage(msg.from, '👑 Exclusivo para VIPs!');
                return;
            }
            
            let limit = parseInt(body.split(' ')[1]);
            if (isNaN(limit) || limit <= 0) limit = 5;
            if (limit > 30) limit = 30; 

            try {
                const globalStickers = await dbAll(`SELECT filename, mimetype FROM Stickers ORDER BY RANDOM() LIMIT ?`, [limit]);
                if (!globalStickers || globalStickers.length === 0) {
                    await client.sendMessage(msg.from, '🌍 Banco de dados vazio.');
                    return;
                }

                await client.sendMessage(msg.from, `🌍 Puxando ${globalStickers.length} figurinhas aleatórias...`);
                for (const row of globalStickers) {
                    const filePath = path.join(stickersDir, row.filename);
                    if (fs.existsSync(filePath)) {
                        const stickerData = fs.readFileSync(filePath, { encoding: 'base64' });
                        let tipoMidia = row.mimetype || 'image/jpeg'; 
                        if (tipoMidia === 'image/webp' && !stickerData.startsWith('UklGR')) tipoMidia = 'image/jpeg'; 
                        
                        const media = new MessageMedia(tipoMidia, stickerData);
                        await client.sendMessage(msg.from, media, { sendMediaAsSticker: true, stickerName: "Global", stickerAuthor: "Bot VIP" }).catch(() => {});
                    }
                }
            } catch (dbErr) {
                await client.sendMessage(msg.from, '❌ Erro ao buscar figs globais.');
            }
            return;
        }

        if (body.startsWith('/criar') && msg.hasMedia) {
            if (!user.is_vip && user.creations_today >= 10) {
                await client.sendMessage(msg.from, '❌ Limite de 10 figurinhas diárias atingido.');
                return;
            }

            const media = await msg.downloadMedia();
            if (media && (media.mimetype.startsWith('image/') || media.mimetype.startsWith('video/'))) {
                if (user.is_vip) {
                    userStates.set(userId, { state: 'WAITING_METADATA', media: media });
                    await client.sendMessage(msg.from, '👑 *Criação VIP!*\nResponda: *Nome | Autor*\nOu responda *Não* para padrão.');
                    return; 
                }

                const filename = `sticker_${userId.replace(/[^0-9]/g, '')}_${Date.now()}.webp`;
                fs.writeFileSync(path.join(stickersDir, filename), media.data, 'base64');
                await dbRun(`INSERT INTO Stickers (user_id, filename, mimetype) VALUES (?, ?, ?)`, [userId, filename, media.mimetype]);
                await dbRun(`UPDATE Users SET creations_today = creations_today + 1 WHERE id = ?`, [userId]);

                await client.sendMessage(msg.from, media, { sendMediaAsSticker: true, stickerName: "Bot", stickerAuthor: "Sua Marca" });
                await client.sendMessage(msg.from, '✅ Figurinha criada!');
            } else {
                await client.sendMessage(msg.from, '❌ Envie uma mídia válida.');
            }
            return;
        }

        if (msg.hasMedia && !userStates.has(userId)) {
            const media = await msg.downloadMedia();
            if (media && media.mimetype && media.mimetype.startsWith('image/')) {
                const filename = `sticker_${userId.replace(/[^0-9]/g, '')}_${Date.now()}.webp`;
                fs.writeFileSync(path.join(stickersDir, filename), media.data, 'base64');
                await dbRun(`INSERT INTO Stickers (user_id, filename, mimetype) VALUES (?, ?, ?)`, [userId, filename, media.mimetype]);
                await dbRun(`UPDATE Users SET creations_today = creations_today + 1 WHERE id = ?`, [userId]);
            }
        }

    } catch (err) {
        console.error('Erro:', err);
    }
});

process.on('uncaughtException', (err) => console.error('Uncaught Exception:', err));
process.on('unhandledRejection', (reason) => console.error('Unhandled Rejection:', reason));

client.initialize();
console.log('Inicializando bot...');