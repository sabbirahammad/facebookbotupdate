const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');
const url = require('url');
const Page = require('./Page');
const { sendTypingOn } = require('./facebookService');

// pageId => Set<WebSocket>
const clients = new Map();

function setupWebSocket(httpServer) {
    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', async (request, socket, head) => {
        const { query } = url.parse(request.url, true);
        const token = query.token;
        const pageId = query.pageId;

        if (!token || !pageId) {
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
            return;
        }

        try {
            // ধাপ ১: টোকেনটি ভেরিফাই করুন
            const decoded = jwt.verify(token, process.env.JWT_SECRET);
            const userId = decoded.id;

            // ধাপ ২: পেজের মালিকানা যাচাই করুন
            const page = await Page.findOne({ pageId: pageId, ownerId: userId });
            if (!page) {
                socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
                socket.destroy();
                return;
            }

            // ধাপ ৩: সবকিছু ঠিক থাকলে সংযোগ স্থাপন করুন
            wss.handleUpgrade(request, socket, head, (ws) => {
                ws.userId = userId; // ভবিষ্যতে ব্যবহারের জন্য userId সংরক্ষণ করুন
                wss.emit('connection', ws, request);
            });
        } catch (err) {
            // টোকেন inválid হলে সংযোগ বাতিল করুন
            console.error('WebSocket Auth Error:', err.message);
            socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
            socket.destroy();
        }
    });

    wss.on('connection', (ws, req) => {
        // URL থেকে pageId নিন (যেমন: ws://localhost:3000?pageId=xxxx&token=yyyy)
        const { query } = url.parse(req.url, true);
        const pageId = query.pageId;

        if (pageId) {
            if (!clients.has(pageId)) {
                clients.set(pageId, new Set());
            }
            clients.get(pageId).add(ws);
            ws.pageId = pageId;
        }

        ws.on('close', () => {
            if (ws.pageId && clients.has(ws.pageId)) {
                clients.get(ws.pageId).delete(ws);
            }
        });

        ws.on('message', async (message) => {
            const data = JSON.parse(message);
            if (data.type === 'typing_started') {
                // Send typing indicator to Facebook user
                await sendTypingOn(data.pageId, data.psid);
            }
        });
    });
}

function broadcastToPage(pageId, message) {
    if (clients.has(pageId)) {
        for (const client of clients.get(pageId)) {
            if (client.readyState === client.OPEN) {
                client.send(JSON.stringify(message));
            }
        }
    }
}

module.exports = { setupWebSocket, broadcastToPage };
